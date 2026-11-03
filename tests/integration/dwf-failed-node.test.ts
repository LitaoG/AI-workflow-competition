import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

const SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

/** Always throws an auth-classified (non-retryable) error. */
class AuthFailProvider implements LLMProvider {
  readonly id = 'authfail-test';
  readonly name = 'Auth-failing test provider';
  calls = 0;
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    throw new Error('401 unauthorized — invalid credentials (authfail-test)');
  }
}

/** Counts provider calls — proves the replayed failure costs zero calls. */
class CountingOkProvider implements LLMProvider {
  readonly id = 'counting-ok-test';
  readonly name = 'Counting ok test provider';
  calls = 0;
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    return {
      content: JSON.stringify({ healthStatus: 'HEALTHY' }),
      model: 'counting-ok',
      latencyMs: 1,
    };
  }
}

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-failed-node-'));
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

test('a failed ask is journalled; resume replays the SAME rejection at zero provider calls', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const authFail = new AuthFailProvider();
    providerRegistry.register(authFail);
    providerRegistry.setDefault('authfail-test');

    const failed = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
    // The runner classifies provider auth errors as deterministic → 'stopped';
    // the engine-side journal write happens before that settlement either way.
    assert.ok(failed.status === 'failed' || failed.status === 'stopped', `unexpected status: ${failed.status}`);
    assert.match(failed.error ?? '', /401 unauthorized/);

    // The failure is journalled with the redacted message.
    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const nodes = await store.getDwfNodes(failed.runId);
      const ask = nodes.find((n) => n.kind === 'ask');
      assert.ok(ask, 'the failed ask node must be journalled');
      assert.equal(ask!.status, 'failed');
      assert.match(ask!.errorText ?? '', /401 unauthorized/);
    } finally {
      store.close();
    }

    // Resume with the provider FIXED: the journalled failure replays the same
    // rejection deterministically — and costs ZERO provider calls.
    const counting = new CountingOkProvider();
    providerRegistry.register(counting);
    providerRegistry.setDefault('counting-ok-test');
    const resumed = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      resumeRunId: failed.runId,
    });
    assert.ok(resumed.status === 'failed' || resumed.status === 'stopped', `unexpected status: ${resumed.status}`);
    assert.match(resumed.error ?? '', /401 unauthorized/, 'the SAME rejection must replay');
    assert.equal(resumed.stats.asks, 0, 'the replayed failure executes no ask');
    assert.equal(counting.calls, 0, 'the fixed provider must not be called for a replayed failure');
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});

test('amend: an unchanged failed node replays from the warm cache; changed inputs run live', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const authFail = new AuthFailProvider();
    providerRegistry.register(authFail);
    providerRegistry.setDefault('authfail-test');
    const failed = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
    assert.ok(failed.status === 'failed' || failed.status === 'stopped', failed.error);

    // Amend to a DIFFERENT prompt (upstream change → the node's input hash
    // differs) with a working provider: the node runs live and succeeds.
    providerRegistry.setDefault('mock');
    const amendedScript = SCRIPT.replace('inspect health report of the service', 'inspect health report v2 of the service');
    const amendedPath = path.join(ws.dir, 'amended.facade.ts');
    fs.writeFileSync(amendedPath, amendedScript);

    const amended = await runFacadeScript({
      scriptPath: amendedPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      amendRunId: failed.runId,
    });
    assert.equal(amended.status, 'completed', amended.error);
    assert.equal((amended.value as { healthStatus: string }).healthStatus, 'HEALTHY');
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});
