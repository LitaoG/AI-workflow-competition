import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BuiltinWorkflowMCPServer } from '../../src/mcp/server.js';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_EXAMPLE = path.join(REPO_ROOT, 'skills', 'ai-workflow', 'examples', 'review.facade.ts');

const RUN_SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

interface HostPair {
  client: Client;
  cleanup: () => Promise<void>;
}

async function connectServer(): Promise<HostPair> {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.start(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-mcp-script-'));
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

test('MCP: facade script tools are exposed in the catalog', async () => {
  const { client, cleanup } = await connectServer();
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('workflow_script_check'), `catalog missing check: ${names}`);
    assert.ok(names.includes('workflow_script_run'), 'catalog missing run');
  } finally {
    await cleanup();
  }
});

test('MCP: workflow_script_check reports clean and dirty scripts', async () => {
  const { client, cleanup } = await connectServer();
  const ws = tempWorkspace();
  try {
    const cleanPath = path.join(ws.dir, 'clean.facade.ts');
    fs.writeFileSync(cleanPath, RUN_SCRIPT);

    // Issue #194 P2: the check face is bounded by the declared cwd — the
    // workspace is declared and the script is named relative to it.
    const clean = await client.callTool({
      name: 'workflow_script_check',
      arguments: { scriptPath: 'clean.facade.ts', cwd: ws.dir },
    });
    const cleanText = JSON.parse((clean.content as Array<{ text: string }>)[0]!.text);
    assert.equal(cleanText.ok, true, JSON.stringify(cleanText.diagnostics));
    assert.deepEqual(cleanText.phases, ['Inspect']);

    const dirtyPath = path.join(ws.dir, 'dirty.facade.ts');
    fs.writeFileSync(dirtyPath, 'const t = Date.now();\nreturn t;');
    const dirty = await client.callTool({
      name: 'workflow_script_check',
      arguments: { scriptPath: 'dirty.facade.ts', cwd: ws.dir },
    });
    const dirtyText = JSON.parse((dirty.content as Array<{ text: string }>)[0]!.text) as {
      ok: boolean;
      diagnostics: Array<{ code: number; category: string }>;
    };
    assert.equal(dirtyText.ok, false);
    assert.ok(
      dirtyText.diagnostics.some((d) => d.code === 9002 && d.category === 'purity-ban'),
      `expected a purity-ban diagnostic, got: ${JSON.stringify(dirtyText.diagnostics)}`,
    );
  } finally {
    ws.cleanup();
    await cleanup();
  }
});

test('MCP: workflow_script_run executes and resumes at zero asks', async () => {
  const { client, cleanup } = await connectServer();
  const ws = tempWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'run.facade.ts');
    fs.writeFileSync(scriptPath, RUN_SCRIPT);

    const first = await client.callTool({
      name: 'workflow_script_run',
      arguments: { scriptPath, cwd: ws.dir, dbPath: path.join(ws.dir, 'j.db') },
    });
    const firstText = JSON.parse((first.content as Array<{ text: string }>)[0]!.text);
    assert.equal(firstText.status, 'completed', JSON.stringify(firstText));
    assert.equal((firstText.value as { healthStatus: string }).healthStatus, 'HEALTHY');
    assert.equal(firstText.stats.asks, 1);
    assert.ok(firstText.resumeHint.includes(firstText.runId));

    const second = await client.callTool({
      name: 'workflow_script_run',
      arguments: {
        scriptPath,
        cwd: ws.dir,
        dbPath: path.join(ws.dir, 'j.db'),
        resumeRunId: firstText.runId,
      },
    });
    const secondText = JSON.parse((second.content as Array<{ text: string }>)[0]!.text);
    assert.equal(secondText.status, 'completed');
    assert.deepEqual(secondText.value, firstText.value);
    assert.equal(secondText.stats.asks, 0, 'resume must replay at zero asks');
    assert.equal(secondText.stats.replayHits, 1);
  } finally {
    ws.cleanup();
    await cleanup();
  }
});

test('MCP: the skill example script stays facade-clean (doc guard)', async () => {
  const { client, cleanup } = await connectServer();
  try {
    const result = await client.callTool({
      name: 'workflow_script_check',
      arguments: { scriptPath: SKILL_EXAMPLE },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    assert.equal(parsed.ok, true, `skill example rotted: ${JSON.stringify(parsed.diagnostics)}`);
    assert.ok(parsed.phases.includes('Verify'));
  } finally {
    await cleanup();
  }
});
