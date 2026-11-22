import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-mock-routing-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

const ENV_FAST = 'AI_WORKFLOW_FAST_PROVIDER';
const ENV_DEEP = 'AI_WORKFLOW_DEEP_PROVIDER';

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('mock: runFacadeScript(--mock) never mutates the host process.env — provider overrides ride the engine options (Issue #252)', async () => {
  await withEnv({ [ENV_FAST]: 'fast-real-provider', [ENV_DEEP]: undefined }, async () => {
    const ws = makeWorkspace();
    try {
      const scriptPath = path.join(ws.dir, 'probe.facade.ts');
      fs.writeFileSync(scriptPath, `
log("env probe");
return { ok: true };
`);
      const before = { fast: process.env[ENV_FAST], deep: process.env[ENV_DEEP] };
      // The old implementation mutated process.env synchronously in the
      // runFacadeScript prologue, so the very first check after the call is
      // already the discriminator — no sleeps needed.
      const run = runFacadeScript({ scriptPath, cwd: ws.dir, mock: true });
      assert.equal(process.env[ENV_FAST], before.fast, 'env must be untouched immediately after the call starts');
      assert.equal(process.env[ENV_DEEP], before.deep, 'env must be untouched immediately after the call starts');
      await run;
      assert.equal(process.env[ENV_FAST], before.fast, 'env must be untouched after the run completes');
      assert.equal(process.env[ENV_DEEP], before.deep, 'env must be untouched after the run completes');
    } finally {
      ws.cleanup();
    }
  });
});

test('mock: --mock beats an unregistered AI_WORKFLOW_FAST_PROVIDER sentinel — routing reaches resolveRoutedProvider through the options chain (Issue #252)', async () => {
  await withEnv({ [ENV_FAST]: 'ghost-unregistered-provider', [ENV_DEEP]: undefined }, async () => {
    const ws = makeWorkspace();
    try {
      const scriptPath = path.join(ws.dir, 'ask.facade.ts');
      fs.writeFileSync(scriptPath, `
phase("Probe");
const reply = await agent("env-probe").ask("ping the health of the service");
return { reply };
`);
      // If the routerOptions chain is broken, the unregistered env sentinel
      // wins the tier routing and resolveRoutedProvider throws AgentError —
      // the run fails loudly instead of silently falling back to the registry
      // default.
      const r = await runFacadeScript({ scriptPath, cwd: ws.dir, mock: true });
      assert.equal(r.status, 'completed', r.error);
      const value = r.value as { reply: string };
      assert.ok(typeof value.reply === 'string' && value.reply.length > 0, 'the mock ask completed');
    } finally {
      ws.cleanup();
    }
  });
});

test('mock: concurrent runs with different mock config never cross-pollinate process.env (Issue #252)', async () => {
  await withEnv({ [ENV_FAST]: 'concurrent-sentinel', [ENV_DEEP]: undefined }, async () => {
    const ws = makeWorkspace();
    try {
      const mockScript = path.join(ws.dir, 'mock-run.facade.ts');
      fs.writeFileSync(mockScript, `
log("mock run");
return { mode: "mock" };
`);
      const plainScript = path.join(ws.dir, 'plain-run.facade.ts');
      fs.writeFileSync(plainScript, `
log("plain run");
return { mode: "plain" };
`);
      const before = process.env[ENV_FAST];
      const [mockRun, plainRun] = await Promise.all([
        runFacadeScript({ scriptPath: mockScript, cwd: ws.dir, mock: true }),
        runFacadeScript({ scriptPath: plainScript, cwd: ws.dir, dbPath: path.join(ws.dir, 'plain.sqlite') }),
      ]);
      assert.equal(mockRun.status, 'completed', mockRun.error);
      assert.equal(plainRun.status, 'completed', plainRun.error);
      assert.equal(process.env[ENV_FAST], before, 'concurrent runs must leave the host env exactly as they found it');
    } finally {
      ws.cleanup();
    }
  });
});
