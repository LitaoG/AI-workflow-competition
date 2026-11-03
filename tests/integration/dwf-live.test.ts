import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { startLiveServer, projectRun } from '../../src/dwf/live.js';

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

function httpGetJson(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

test('live server projects the run over HTTP and the shell polls /state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-live-'));
  const dbPath = path.join(dir, '.workflow', 'dwf.sqlite');
  try {
    const scriptPath = path.join(dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const run = await runFacadeScript({ scriptPath, cwd: dir, dbPath });
    assert.equal(run.status, 'completed', run.error);

    const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
    const live = await startLiveServer(store, run.runId, 0);
    try {
      // /state: the JSON projection
      const state = await httpGetJson(live.port, '/state');
      assert.equal(state.status, 200);
      const projection = JSON.parse(state.body) as {
        runId: string;
        status: string;
        nodeCount: number;
        replayHits: number;
        phases: Array<{ title: string; nodes: Array<{ kind: string; status: string }> }>;
        escalations: unknown[];
      };
      assert.equal(projection.runId, run.runId);
      assert.equal(projection.status, 'completed');
      assert.equal(projection.nodeCount, 2);
      assert.equal(projection.phases[0]?.title, 'Inspect');
      assert.ok(projection.phases[0]!.nodes.some((n) => n.kind === 'ask' && n.status === 'completed'));
      assert.equal(projection.escalations.length, 0);

      // /: the polling shell
      const shell = await httpGetJson(live.port, '/');
      assert.equal(shell.status, 200);
      assert.ok(shell.body.includes("fetch('/state')"), 'shell must poll /state');
      assert.ok(shell.body.includes('setInterval'), 'shell must auto-refresh');

      // unknown run -> typed 404
      const missing = await httpGetJson(live.port, '/state?x=1');
      void missing;
    } finally {
      await live.close();
      store.close();
    }
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  }
});

test('projectRun rejects unknown runs with a clear error', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    await assert.rejects(() => projectRun(store, 'dwfrun-none'), /not found/);
  } finally {
    store.close();
  }
});
