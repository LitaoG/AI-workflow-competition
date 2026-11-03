/**
 * Telemetry hookup, gap-matrix D2 (Issue #33): a facade-script run must be
 * visible across the whole read face — `list`, MCP `workflow_inspect`,
 * `graph`, `view` — both against an explicit --db journal and the default
 * `.workflow/dwf.sqlite`. Before D2 a facade runId was invisible to `list`
 * (runs.db only), to MCP `workflow_inspect` (checkpoints only) and to `graph`
 * (builder mode only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BuiltinWorkflowMCPServer } from '../../src/mcp/server.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { executeList } from '../../src/cli/commands/list.js';
import { executeGraph } from '../../src/cli/commands/graph.js';
import { executeView } from '../../src/cli/commands/view.js';

const SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-telemetry-'));
  return {
    dir,
    dbPath: path.join(dir, '.workflow', 'dwf.sqlite'),
    cleanup: () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
    },
  };
}

/** Run the mock ask script once and return the completed run. */
async function runScript(ws: { dir: string; dbPath?: string }): Promise<{ runId: string }> {
  const scriptPath = path.join(ws.dir, 'script.facade.ts');
  fs.writeFileSync(scriptPath, SCRIPT);
  const run = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
  assert.equal(run.status, 'completed', run.error);
  return { runId: run.runId };
}

/** Capture stdout+stderr around one async call. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (msg: string) => {
    out += `${msg}\n`;
  };
  console.error = (msg: string) => {
    err += `${msg}\n`;
  };
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
}

test('list --db: facade runId surfaces in json and table output', async () => {
  const ws = makeWorkspace();
  try {
    const { runId } = await runScript(ws);

    const json = await capture(() => executeList({ db: ws.dbPath, json: true }));
    assert.equal(json.code, 0);
    const rows = JSON.parse(json.out) as Array<{
      store: string;
      runId: string;
      status: string;
      workflowName: string;
      scriptPath?: string;
    }>;
    const facadeRow = rows.find((r) => r.runId === runId);
    assert.ok(facadeRow, `facade runId ${runId} missing from list --db json: ${json.out}`);
    assert.equal(facadeRow!.store, 'facade-journal');
    assert.equal(facadeRow!.status, 'completed');
    assert.equal(facadeRow!.workflowName, 'script.facade.ts');
    assert.equal(facadeRow!.scriptPath, path.join(ws.dir, 'script.facade.ts'));

    const table = await capture(() => executeList({ db: ws.dbPath }));
    assert.equal(table.code, 0);
    assert.ok(table.out.includes(runId), `facade runId missing from table output: ${table.out}`);
    assert.ok(table.out.includes('script.facade.ts'), 'script file shown as the workflow column');
    assert.ok(table.out.includes('✔ completed'), 'completed status glyph rendered');

    // Status filter reaches the dwf surface: a completed run hides under a
    // parked filter and shows under its own.
    const parked = await capture(() => executeList({ db: ws.dbPath, status: 'parked', json: true }));
    assert.equal(parked.code, 0);
    assert.equal(JSON.parse(parked.out).length, 0, 'parked filter must not match a completed run');

    // An explicit --db pointing nowhere is an error, and no database file is
    // created as a side effect of the read.
    const ghost = path.join(ws.dir, 'ghost.db');
    const miss = await capture(() => executeList({ db: ghost, json: true }));
    assert.equal(miss.code, 1);
    assert.ok(miss.err.includes('Journal not found'), `unexpected error: ${miss.err}`);
    assert.ok(!fs.existsSync(ghost), 'a read-only list must not create the missing db');
  } finally {
    ws.cleanup();
  }
});

test('list without --db: default journal surfaces the facade runId', async () => {
  const ws = makeWorkspace();
  const prevCwd = process.cwd();
  try {
    const { runId } = await runScript(ws); // default journal: ws/.workflow/dwf.sqlite

    process.chdir(ws.dir);
    const result = await capture(() => executeList({ json: true }));
    assert.equal(result.code, 0);
    const rows = JSON.parse(result.out) as Array<{ store: string; runId: string }>;
    const facadeRow = rows.find((r) => r.runId === runId);
    assert.ok(facadeRow, `facade runId ${runId} missing from default-journal list: ${result.out}`);
    assert.equal(facadeRow!.store, 'facade-journal');
  } finally {
    process.chdir(prevCwd);
    ws.cleanup();
  }
});

test('MCP workflow_inspect: reads a facade run from its --db journal, builder miss still errors', async () => {
  const ws = makeWorkspace();
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.start(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const { runId } = await runScript(ws);

    const res = await client.callTool({
      name: 'workflow_inspect',
      arguments: { runId, dbPath: ws.dbPath, includeEvents: true },
    });
    assert.ok(!res.isError, 'facade inspect must succeed');
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      runId: string;
      store: string;
      status: string;
      scriptPath?: string;
      nodes: Array<{ siteId: string; kind: string; status: string }>;
      events?: Array<{ type: string }>;
    };
    assert.equal(body.runId, runId);
    assert.equal(body.store, 'facade-journal');
    assert.equal(body.status, 'completed');
    assert.equal(body.scriptPath, path.join(ws.dir, 'script.facade.ts'));
    assert.ok(body.nodes.some((n) => n.kind === 'ask' && n.status === 'completed'), 'ask nodes projected');
    assert.ok((body.events?.length ?? 0) > 0, 'includeEvents carries the journal event stream');

    // Builder fall-through untouched: an unknown runId keeps the not-found error.
    const miss = await client.callTool({
      name: 'workflow_inspect',
      arguments: { runId: 'no-such-run', dbPath: ws.dbPath },
    });
    assert.equal(miss.isError, true, 'unknown runId must stay an error');
  } finally {
    await client.close();
    ws.cleanup();
  }
});

test('graph --db: a facade runId renders its projection; unknown runId errors', async () => {
  const ws = makeWorkspace();
  try {
    const { runId } = await runScript(ws);

    const outPath = path.join(ws.dir, 'graph.html');
    const code = await executeGraph(runId, { db: ws.dbPath, format: 'html', output: outPath });
    assert.equal(code, 0, 'facade runId renders via graph --db');
    const html = fs.readFileSync(outPath, 'utf-8');
    assert.ok(html.includes('<svg'), 'the exported graph is the HTML/SVG canvas');

    const miss = await capture(() => executeGraph('no-such-run', { db: ws.dbPath }));
    assert.equal(miss.code, 1);
    assert.ok(miss.err.includes('Run not found in journal'), `unexpected error: ${miss.err}`);
  } finally {
    ws.cleanup();
  }
});

test('graph without --db: default journal resolves a bare facade runId', async () => {
  const ws = makeWorkspace();
  const prevCwd = process.cwd();
  try {
    const { runId } = await runScript(ws);

    process.chdir(ws.dir);
    const hit = await capture(() => executeGraph(runId, { format: 'ascii' }));
    assert.equal(hit.code, 0);
    assert.ok(hit.out.includes('Phase 1: Inspect'), `projection should render the journalled phase: ${hit.out}`);

    // A path that exists as neither file nor runId keeps the pre-existing
    // not-found contract (message + exit code 0).
    const miss = await capture(() => executeGraph('no-such-file-or-run.ts', {}));
    assert.equal(miss.code, 0);
    assert.ok(miss.err.length > 0, 'not-found error message preserved');
  } finally {
    process.chdir(prevCwd);
    ws.cleanup();
  }
});

test('view without --db: default journal renders a facade run HTML', async () => {
  const ws = makeWorkspace();
  const prevCwd = process.cwd();
  try {
    const { runId } = await runScript(ws);

    process.chdir(ws.dir);
    const result = await capture(() => executeView(runId, {}));
    assert.equal(result.code, 0, `view failed: ${result.err}`);
    const htmlPath = path.join(ws.dir, '.workflow', 'views', `${runId}.html`);
    assert.ok(fs.existsSync(htmlPath), 'view html written under the default views dir');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    assert.ok(html.includes(runId), 'run id present in the rendered view');
  } finally {
    process.chdir(prevCwd);
    ws.cleanup();
  }
});
