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

/**
 * Windows-tolerant temp-dir removal: retries briefly on the EBUSY file-lock
 * window. Deliberately a HELPER, not a `finally` body — a `return` inside
 * `finally` is an abrupt completion that silently overrides any exception the
 * guarded try threw (including AssertionError → swallowed failures report as
 * pass; Issue #36, family of upstream #312). The helper's `return` only exits
 * the helper, so test assertion failures always propagate.
 */
function rmTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

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

/** Read the first SSE frames then hang up (the stream is infinite by design). */
function httpGetSseHead(port: number, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
        if (body.includes('event: state')) {
          req.destroy();
          resolve(body);
        }
      });
      res.on('error', () => resolve(body)); // destroyed mid-stream — the head is enough
    });
    req.on('error', () => resolve(req.destroyed ? '' : undefined as never));
    setTimeout(() => resolve(''), 5000);
  });
}

test('live server serves the Studio SPA, the snapshot API and SSE event frames', async () => {
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
      // /state: the StudioSnapshot JSON (the one projection the SPA renders)
      const state = await httpGetJson(live.port, '/state');
      assert.equal(state.status, 200);
      const snap = JSON.parse(state.body) as {
        mode: string;
        run: { runId: string; status: string };
        stats: { nodeCount: number; replayHits: number };
        graph: { phases: Array<{ name: string }>; nodes: Array<{ id: string; type: string; status: string }> };
        events: Array<{ type: string }>;
        openQuestion: unknown;
        artifacts: unknown[];
      };
      assert.equal(snap.mode, 'live');
      assert.equal(snap.run.runId, run.runId);
      assert.equal(snap.run.status, 'completed');
      assert.equal(snap.stats.nodeCount, 2);
      assert.equal(snap.graph.phases[0]?.name, 'Inspect');
      assert.ok(snap.graph.nodes.some((n) => n.type === 'agent' && n.status === 'completed'));
      assert.ok(snap.events.some((e) => e.type === 'dwf_ask_start'));
      assert.equal(snap.openQuestion, null);

      // /: the Studio SPA shell (single-file, live mode → SSE client)
      const shell = await httpGetJson(live.port, '/');
      assert.equal(shell.status, 200);
      assert.ok(shell.body.includes('AI-Workflow Studio'), 'shell must be the Studio');
      assert.ok(shell.body.includes('EventSource'), 'live shell must stream over SSE');
      assert.ok(shell.body.includes('window.__STUDIO__'), 'snapshot must be embedded');

      // /events: SSE frames — a `state` snapshot arrives with journal events
      const sseHead = await httpGetSseHead(live.port, '/events');
      assert.ok(sseHead.includes('event: state'), 'SSE must push state frames');
      assert.ok(sseHead.includes('dwf_'), 'SSE must push raw journal events');

      // ?run= override keeps 404 semantics for unknown ids
      const missing = await httpGetJson(live.port, '/state?run=dwfrun-nope');
      assert.equal(missing.status, 404);
    } finally {
      await live.close();
      store.close();
    }
  } finally {
    rmTempDir(dir);
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

/** POST a JSON body and read back status + parsed JSON. */
function httpPostJson(
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(body || '{}') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('A2UI POST endpoints (/api/answer, /api/fill) validate input and reach the wired resume actions', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const calls: Array<{ kind: string; runId: string; id: string; text: string }> = [];
  const live = await startLiveServer(store, 'dwfrun-a2ui', 0, '127.0.0.1', {
    answer: async (runId, questionId, text) => {
      calls.push({ kind: 'answer', runId, id: questionId, text });
      return { ok: true, message: 'answered', childRunId: 'dwfrun-child' };
    },
    fill: async (runId, holeName, body) => {
      calls.push({ kind: 'fill', runId, id: holeName, text: body });
      return { ok: true, message: 'filled' };
    },
  });
  try {
    // Happy paths — the action receives the bound runId and the form fields.
    const answer = await httpPostJson(live.port, '/api/answer', { questionId: 'q-1', text: 'Proceed with option A' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { ok: true, message: 'answered', childRunId: 'dwfrun-child' });

    const fill = await httpPostJson(live.port, '/api/fill', { holeName: 'approval', body: 'LGTM — ship it' });
    assert.equal(fill.status, 200);
    assert.deepEqual(fill.json, { ok: true, message: 'filled' });

    assert.deepEqual(calls, [
      { kind: 'answer', runId: 'dwfrun-a2ui', id: 'q-1', text: 'Proceed with option A' },
      { kind: 'fill', runId: 'dwfrun-a2ui', id: 'approval', text: 'LGTM — ship it' },
    ]);

    // Validation: blank required fields must 400 without reaching the action.
    const blankAnswer = await httpPostJson(live.port, '/api/answer', { questionId: '  ', text: 'x' });
    assert.equal(blankAnswer.status, 400);
    assert.ok(String(blankAnswer.json.message).includes('questionId and text are required'));
    const blankFill = await httpPostJson(live.port, '/api/fill', { holeName: '', body: 'x' });
    assert.equal(blankFill.status, 400);
    assert.ok(String(blankFill.json.message).includes('holeName and body are required'));
    assert.equal(calls.length, 2, 'rejected bodies must not reach the resume actions');

    // Malformed JSON body → 400, never a crash.
    const malformed = await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: live.port, path: '/api/answer', method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(body || '{}') }));
        },
      );
      req.on('error', reject);
      req.end('{broken');
    });
    assert.equal(malformed.status, 400);
  } finally {
    await live.close();
    store.close();
  }
});

test('A2UI POST endpoints answer 501 when the server was started without resume actions', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const live = await startLiveServer(store, 'dwfrun-noactions', 0);
  try {
    const res = await httpPostJson(live.port, '/api/answer', { questionId: 'q-1', text: 'x' });
    assert.equal(res.status, 501);
    assert.equal(res.json.ok, false);
    assert.ok(String(res.json.message).includes('A2UI resume actions are not wired'));
  } finally {
    await live.close();
    store.close();
  }
});
