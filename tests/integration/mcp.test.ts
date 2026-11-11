import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCPClientManager } from '../../src/mcp/client.js';
import { BuiltinWorkflowMCPServer } from '../../src/mcp/server.js';
import { toolRegistry } from '../../src/mcp/registry.js';

// Resolved at runtime: tests execute from dist/tests/integration/ → repo root is three levels up.
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');

test('MCP Integration: ToolRegistry registers and retrieves namespaced tools', () => {
  toolRegistry.register('test-server', {
    name: 'custom_tool',
    description: 'Custom test tool',
    inputSchema: { type: 'object' },
  });

  const tool = toolRegistry.get('test-server', 'custom_tool');
  assert.ok(tool !== undefined);
  assert.equal(tool.toolName, 'custom_tool');
  assert.equal(tool.serverName, 'test-server');

  const all = toolRegistry.listAll();
  assert.ok(all.some((t) => t.toolName === 'custom_tool'));
});

test('MCP Integration: MCPClientManager mock mode lists tools and executes calls in <20ms', async () => {
  const manager = new MCPClientManager(true);
  const start = Date.now();

  const tools = await manager.listTools('test-server');
  assert.ok(tools.length > 0);
  assert.equal(tools[0]?.name, 'mock_file_read');

  const callResult: any = await manager.callTool('test-server', 'mock_file_read', { path: '/tmp/test.txt' });
  const elapsed = Date.now() - start;

  assert.ok(callResult.mockResult.includes('mock_file_read'));
  assert.ok(elapsed < 20);
});

test('MCP Integration: BuiltinWorkflowMCPServer initializes cleanly', () => {
  const server = new BuiltinWorkflowMCPServer();
  assert.ok(server !== null);
});

test('MCP Integration: BuiltinWorkflowMCPServer executes real tools via InMemoryTransport', async () => {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.start(serverTransport);

  const client = new Client(
    { name: 'test-mcp-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  // 1. Verify Tool Catalog
  const toolList = await client.listTools();
  const toolNames = toolList.tools.map((t) => t.name);
  assert.ok(toolNames.includes('workflow_probe'));
  assert.ok(toolNames.includes('workflow_run'));
  assert.ok(toolNames.includes('workflow_inspect'));
  assert.ok(toolNames.includes('workflow_replay'));
  assert.ok(toolNames.includes('workflow_graph'));

  // 2. Call workflow_probe
  const probeRes: any = await client.callTool({
    name: 'workflow_probe',
    arguments: {},
  });
  assert.ok(!probeRes.isError);
  const probeData = JSON.parse(probeRes.content[0].text);
  assert.ok(probeData.system);
  assert.ok(probeData.git);
  assert.ok(probeData.toolchain);

  // 3. Clean up
  await client.close();
});

// ---------------------------------------------------------------------------
// Facade-script tool face (GOAL.md 阶段 7.2): workflow_run_script /
// workflow_inspect_run / workflow_get_run. Shared helpers live at the bottom.
// ---------------------------------------------------------------------------

/** Fake, self-made token shape — nothing here is a real credential. */
const FAKE_GITHUB_TOKEN = 'ghp_0123456789abcdefghij0123456789abcd';

/** Minimal facade script: one ask (deterministic mock provider), one report. */
const FACADE_RUN_SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

/**
 * A world.run whose output mimics `git remote -v` with an embedded URL password
 * and an echoed token, plus an args-injected secret logged via log() — the log
 * path is NOT redacted at the engine source, so it can only be clean in a tool
 * response if the response-level redaction fires.
 */
const FACADE_LEAK_SCRIPT = `
phase('Leak');
const out = await world.run("node", ["-e", "process.stdout.write('remote: https://alice:pat-123456@github.com/org/repo.git\\\\ntoken=${FAKE_GITHUB_TOKEN}\\\\n');"]);
log('args token: ' + String(args.apiKey ?? ''));
return { exitCode: out.exitCode, stdout: out.stdout };
`;

function facadeTempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-mcp-facade-'));
  return {
    dir,
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

async function connectInMemoryServer(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.start(serverTransport);
  const client = new Client({ name: 'test-mcp-facade-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

function firstText(res: { content: Array<{ type: string; text: string }> }): string {
  return res.content[0].text;
}

test('MCP Integration: workflow_run_script executes a facade script over stdio and reports per-site summaries', async () => {
  const ws = facadeTempWorkspace();
  const scriptPath = path.join(ws.dir, 'run.facade.ts');
  fs.writeFileSync(scriptPath, FACADE_RUN_SCRIPT);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, 'bin', 'workflow.js'), 'mcp', 'serve'],
  });
  const client = new Client({ name: 'test-mcp-stdio-client', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);

    // Catalog: the legacy seven plus the three facade tools are all exposed.
    const catalog = await client.listTools();
    const names = catalog.tools.map((t) => t.name);
    for (const expected of [
      'workflow_run',
      'workflow_probe',
      'workflow_inspect',
      'workflow_replay',
      'workflow_graph',
      'workflow_script_check',
      'workflow_script_run',
      'workflow_run_script',
      'workflow_inspect_run',
      'workflow_get_run',
    ]) {
      assert.ok(names.includes(expected), `catalog missing ${expected}: ${names.join(', ')}`);
    }

    const res: any = await client.callTool(
      {
        name: 'workflow_run_script',
        arguments: {
          scriptPath,
          cwd: ws.dir,
          dbPath: path.join(ws.dir, 'journal.db'),
          runTimeoutMs: 120000,
          approvedCommands: ['node'],
        },
      },
      undefined,
      { timeout: 180000 },
    );
    assert.ok(!res.isError, `run_script failed: ${firstText(res)}`);
    const payload = JSON.parse(firstText(res));
    assert.equal(payload.status, 'completed', JSON.stringify(payload));
    assert.ok(String(payload.runId).startsWith('dwfrun-'), `unexpected runId: ${payload.runId}`);
    assert.equal((payload.value as { healthStatus: string }).healthStatus, 'HEALTHY');
    assert.equal(payload.stats.asks, 1);

    // Per-site summary: the ask site is journalled with status + duration.
    const sites = payload.sites as Array<{ siteId: string; ordinal: number; kind: string; status: string; durationMs: number }>;
    assert.ok(Array.isArray(sites) && sites.length >= 1, `expected site summaries, got: ${JSON.stringify(payload.sites)}`);
    const askSite = sites.find((s) => s.kind === 'ask');
    assert.ok(askSite, `no ask site in the summary: ${JSON.stringify(sites)}`);
    assert.ok(askSite.siteId.length > 0);
    assert.equal(askSite.status, 'completed');
    assert.ok(typeof askSite.durationMs === 'number' && askSite.durationMs >= 0);

    // quiet defaults to true: no event log rides on the response.
    assert.ok(!('events' in payload), 'quiet response must not carry the event log');
  } finally {
    await client.close();
    ws.cleanup();
  }
});

test('MCP Integration: workflow_inspect_run returns the run row, the site table and the evidence summary', async () => {
  const { client, cleanup } = await connectInMemoryServer();
  const ws = facadeTempWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'run.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_RUN_SCRIPT);
    const dbPath = path.join(ws.dir, 'journal.db');

    const runRes: any = await client.callTool({
      name: 'workflow_run_script',
      arguments: { scriptPath, cwd: ws.dir, dbPath },
    });
    assert.ok(!runRes.isError, firstText(runRes));
    const run = JSON.parse(firstText(runRes));
    assert.equal(run.status, 'completed');

    const inspectRes: any = await client.callTool({
      name: 'workflow_inspect_run',
      arguments: { runId: run.runId, dbPath },
    });
    assert.ok(!inspectRes.isError, firstText(inspectRes));
    const payload = JSON.parse(firstText(inspectRes));
    assert.equal(payload.run.runId, run.runId);
    assert.equal(payload.run.status, 'completed');
    // The raw 64-hex script hash matches the shared sensitive-value shape
    // (whole-value hex 32-64), so the response-level mask replaces it by design.
    assert.ok(typeof payload.run.scriptHash === 'string' && payload.run.scriptHash.length > 0);
    assert.equal(payload.run.scriptPath, scriptPath);

    const nodes = payload.nodes as Array<{ siteId: string; kind: string; status: string; durationMs: number; result: unknown }>;
    const askNode = nodes.find((n) => n.kind === 'ask');
    assert.ok(askNode, `no ask node in the site table: ${JSON.stringify(nodes)}`);
    assert.equal(askNode.status, 'completed');
    assert.deepEqual(askNode.result, { healthStatus: 'HEALTHY' });

    assert.ok(payload.evidence.total >= 1, `expected evidence entries, got ${JSON.stringify(payload.evidence)}`);
    assert.ok(Array.isArray(payload.evidence.latest) && payload.evidence.latest.length >= 1);
    assert.ok(payload.evidence.latest[0].kind, 'evidence entries must carry their kind');
    assert.ok(payload.evidence.byKind, 'evidence summary must break down by kind');

    // Unknown run → tagged error body ({ tag, message }), not a thrown string.
    const missing: any = await client.callTool({
      name: 'workflow_inspect_run',
      arguments: { runId: 'dwfrun-missing', dbPath },
    });
    assert.ok(missing.isError);
    const errBody = JSON.parse(firstText(missing));
    assert.equal(errBody.tag, 'StorageError');
    assert.ok(typeof errBody.message === 'string' && errBody.message.length > 0);
  } finally {
    ws.cleanup();
    await cleanup();
  }
});

test('MCP Integration: workflow_get_run reports journal short-circuit stats in the runner accounting', async () => {
  const { client, cleanup } = await connectInMemoryServer();
  const ws = facadeTempWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'run.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_RUN_SCRIPT);
    const dbPath = path.join(ws.dir, 'journal.db');

    const firstRes: any = await client.callTool({
      name: 'workflow_run_script',
      arguments: { scriptPath, cwd: ws.dir, dbPath },
    });
    assert.ok(!firstRes.isError, firstText(firstRes));
    const first = JSON.parse(firstText(firstRes));
    assert.equal(first.stats.asks, 1);
    assert.equal(first.stats.replayHits, 0);

    const statsRes: any = await client.callTool({
      name: 'workflow_get_run',
      arguments: { runId: first.runId, dbPath },
    });
    assert.ok(!statsRes.isError, firstText(statsRes));
    const stats = JSON.parse(firstText(statsRes));
    assert.equal(stats.runId, first.runId);
    assert.equal(stats.status, 'completed');
    // Same accounting as the runner stats for a fresh run.
    assert.equal(stats.stats.asks, first.stats.asks);
    assert.equal(stats.stats.replayHits, first.stats.replayHits);
    assert.equal(stats.stats.worldRuns, 0);
    assert.equal(stats.stats.amendHits, 0);
    assert.equal(stats.stats.diverged, 0);

    // Resume the run (zero-cost replay leg via the existing script_run face):
    // the journal now holds one replay hit while the ask count stays at one.
    const resumeRes: any = await client.callTool({
      name: 'workflow_script_run',
      arguments: { scriptPath, cwd: ws.dir, dbPath, resumeRunId: first.runId },
    });
    assert.ok(!resumeRes.isError, firstText(resumeRes));
    const resume = JSON.parse(firstText(resumeRes));
    assert.equal(resume.status, 'completed');
    assert.equal(resume.stats.replayHits, 1);

    const statsAfterRes: any = await client.callTool({
      name: 'workflow_get_run',
      arguments: { runId: first.runId, dbPath },
    });
    const statsAfter = JSON.parse(firstText(statsAfterRes));
    assert.equal(statsAfter.stats.asks, 1, 'the resumed journal keeps a single ask total');
    assert.equal(statsAfter.stats.replayHits, resume.stats.replayHits, 'get_run must agree with the runner replay accounting');

    // Unknown run → tagged error body.
    const missing: any = await client.callTool({
      name: 'workflow_get_run',
      arguments: { runId: 'dwfrun-nope', dbPath },
    });
    assert.ok(missing.isError);
    assert.equal(JSON.parse(firstText(missing)).tag, 'StorageError');
  } finally {
    ws.cleanup();
    await cleanup();
  }
});

test('MCP Integration: credential samples in script output, logs and args are masked in every facade-tool response', async () => {
  const { client, cleanup } = await connectInMemoryServer();
  const ws = facadeTempWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'leak.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_LEAK_SCRIPT);
    const dbPath = path.join(ws.dir, 'journal.db');

    // quiet: false — the event log rides along, including the raw dwf_log line,
    // so the response-level redaction is exercised for real.
    const runRes: any = await client.callTool({
      name: 'workflow_run_script',
      arguments: { scriptPath, cwd: ws.dir, dbPath, args: { apiKey: FAKE_GITHUB_TOKEN }, quiet: false, approvedCommands: ['node'] },
    });
    assert.ok(!runRes.isError, firstText(runRes));
    const runText = firstText(runRes);
    const run = JSON.parse(runText);
    assert.equal(run.status, 'completed', JSON.stringify(run));

    assert.ok(!runText.includes(FAKE_GITHUB_TOKEN), 'raw token survived into the run_script response!');
    assert.ok(!runText.includes('pat-123456'), 'raw URL password survived into the run_script response!');
    assert.ok(runText.includes('://***:***@github.com/org/repo.git'), 'expected the masked URL form');
    assert.ok(runText.includes('***REDACTED***'), 'expected masked credential values');
    assert.ok((run.value as { stdout: string }).stdout.includes('token=***REDACTED***'));
    assert.ok(run.events.total >= 1, 'quiet:false must carry the event log');

    // The journal read-back path masks too: args (journalled raw) and node results.
    const inspectRes: any = await client.callTool({
      name: 'workflow_inspect_run',
      arguments: { runId: run.runId, dbPath },
    });
    assert.ok(!inspectRes.isError, firstText(inspectRes));
    const inspectText = firstText(inspectRes);
    const inspect = JSON.parse(inspectText);
    const inspectNodes = inspect.nodes as Array<{ kind: string; status: string }>;
    assert.ok(inspectNodes.some((n) => n.kind === 'worldRun'), 'the worldRun site must be in the journal');
    assert.ok(!inspectText.includes(FAKE_GITHUB_TOKEN), 'raw token survived into the inspect_run response!');
    assert.ok(!inspectText.includes('pat-123456'), 'raw URL password survived into the inspect_run response!');
    assert.ok(inspectText.includes('***REDACTED***'));
  } finally {
    ws.cleanup();
    await cleanup();
  }
});

