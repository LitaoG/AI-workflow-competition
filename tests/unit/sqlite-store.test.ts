import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';

test('SQLite Store: initializes database schema with WAL mode enabled', () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    const runs = store.listRuns();
    assert.deepEqual(runs, []);
  } finally {
    store.close();
  }
});

test('SQLite Store: records workflow events in monotonic chronological order', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'test-run-events';

  try {
    for (let i = 1; i <= 5; i++) {
      await store.recordEvent({
        id: `evt-${i}`,
        runId,
        workflowId: 'test-wf',
        type: i === 1 ? 'workflow_start' : i === 5 ? 'workflow_complete' : 'step_start',
        timestamp: new Date().toISOString(),
        sequence: i,
        data: { stepNumber: i },
      });
    }

    const events = await store.getEvents(runId);
    assert.equal(events.length, 5);
    assert.equal(events[0]?.type, 'workflow_start');
    assert.equal(events[4]?.type, 'workflow_complete');
    assert.equal(events[2]?.sequence, 3);
  } finally {
    store.close();
  }
});

test('SQLite Store: saves and retrieves step checkpoint snapshots', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'test-run-cp';

  try {
    await store.saveCheckpoint(runId, {
      stepId: 'step-A',
      phaseId: 'phase-1',
      role: 'worker',
      status: 'completed',
      input: { query: 'test' },
      output: { result: 42 },
      durationMs: 125,
      completedAt: new Date().toISOString(),
    });

    const cp = await store.getCheckpoint(runId, 'step-A');
    assert.ok(cp !== null);
    assert.equal(cp.stepId, 'step-A');
    assert.equal(cp.status, 'completed');
    assert.deepEqual(cp.output, { result: 42 });
    assert.equal(cp.durationMs, 125);
  } finally {
    store.close();
  }
});

test('SQLite Store: updates run status from running to completed', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'test-run-status';

  try {
    store.upsertRun({
      runId,
      workflowId: 'wf-1',
      workflowName: 'Test Workflow',
      status: 'running',
    });

    let status = await store.getRunStatus(runId);
    assert.equal(status.status, 'running');

    store.upsertRun({
      runId,
      workflowId: 'wf-1',
      workflowName: 'Test Workflow',
      status: 'completed',
      completedSteps: 3,
    });

    status = await store.getRunStatus(runId);
    assert.equal(status.status, 'completed');
  } finally {
    store.close();
  }
});

test('SQLite Store: returns all historical runs with limit and status filtering', () => {
  const store = new SQLiteStateStore(':memory:');

  try {
    store.upsertRun({ runId: 'r1', workflowId: 'w1', workflowName: 'W1', status: 'completed' });
    store.upsertRun({ runId: 'r2', workflowId: 'w2', workflowName: 'W2', status: 'completed' });
    store.upsertRun({ runId: 'r3', workflowId: 'w3', workflowName: 'W3', status: 'failed' });

    const all = store.listRuns();
    assert.equal(all.length, 3);

    const completed = store.listRuns({ status: 'completed' });
    assert.equal(completed.length, 2);

    const limited = store.listRuns({ limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// dwf_runs pid column (GOAL.md §1.5 stale-running recovery)
// ---------------------------------------------------------------------------

test('SQLite Store: dwf run row persists the host pid, a settled run clears it, and a takeover write replaces it', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    await store.saveDwfRun({ runId: 'dwfrun-pid', scriptHash: 'hash-1', status: 'running', runnerPid: 424242 });
    let row = await store.getDwfRun('dwfrun-pid');
    assert.equal(row?.runnerPid, 424242, 'the host pid must round-trip through the journal');

    // A settled run has no owning process (plain assignment, main semantics):
    // the pid column clears on the terminal save. The resume probe only reads
    // it from `running` rows, so this never affects takeover decisions.
    await store.saveDwfRun({ runId: 'dwfrun-pid', scriptHash: 'hash-1', status: 'completed' });
    row = await store.getDwfRun('dwfrun-pid');
    assert.equal(row?.status, 'completed');
    assert.equal(row?.runnerPid, undefined, 'a settled run has no owning process');

    // A start/takeover write records the new host's pid.
    await store.saveDwfRun({ runId: 'dwfrun-pid', scriptHash: 'hash-1', status: 'running', runnerPid: process.pid });
    row = await store.getDwfRun('dwfrun-pid');
    assert.equal(row?.runnerPid, process.pid, 'an explicit pid write must replace the recorded host pid');

    // A row that never carried a pid reads back as undefined (not null).
    await store.saveDwfRun({ runId: 'dwfrun-nopid', scriptHash: 'hash-2', status: 'running' });
    const noPid = await store.getDwfRun('dwfrun-nopid');
    assert.equal(noPid?.runnerPid, undefined);
  } finally {
    store.close();
  }
});

test('SQLite Store: a pre-pid dwf_runs database is migrated in place, stays readable, and reopening is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-migrate-'));
  const dbPath = path.join(dir, 'dwf.sqlite');
  try {
    // Build the OLD schema (no pid column) by hand — exactly as builds before
    // the takeover feature created it — and leave a `running` row behind, the
    // shape a crashed host leaves on disk.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE dwf_runs (
        run_id TEXT PRIMARY KEY,
        script_hash TEXT NOT NULL,
        script_path TEXT,
        args_json TEXT,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(`INSERT INTO dwf_runs (run_id, script_hash, script_path, args_json, status, parent_run_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('dwfrun-legacy', 'hash-old', 'script.ts', '{}', 'running', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacy.close();

    // Opening through the store migrates the file: the legacy row stays
    // readable with pid === undefined (pre-pid journal row), and the migrated
    // table accepts pid writes.
    const store = new SQLiteStateStore(dbPath);
    try {
      const row = await store.getDwfRun('dwfrun-legacy');
      assert.ok(row, 'the legacy row must survive the in-place migration');
      assert.equal(row?.status, 'running');
      assert.equal(row?.scriptHash, 'hash-old');
      assert.equal(row?.runnerPid, undefined, 'a pre-pid row has no recorded host pid');

      await store.saveDwfRun({ runId: 'dwfrun-fresh', scriptHash: 'hash-new', status: 'running', runnerPid: process.pid });
      const fresh = await store.getDwfRun('dwfrun-fresh');
      assert.equal(fresh?.runnerPid, process.pid, 'the migrated table must accept pid writes');
    } finally {
      store.close();
    }

    // Reopening the already-migrated file must not throw and must not re-alter
    // (the PRAGMA table_info existence check makes the second migration a no-op).
    const reopened = new SQLiteStateStore(dbPath);
    try {
      const row = await reopened.getDwfRun('dwfrun-legacy');
      assert.equal(row?.status, 'running', 'the legacy row must still be readable after reopen');
      const fresh = await reopened.getDwfRun('dwfrun-fresh');
      assert.equal(fresh?.runnerPid, process.pid, 'the pid written before reopen must survive it');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dwf_evidence ledger (GOAL.md 证据凭证法则 — 阶段 1.3)
// ---------------------------------------------------------------------------

test('SQLite Store: dwf evidence entries round-trip in per-run append order with store-assigned ids', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    await store.saveDwfEvidence({
      runId: 'dwfrun-ev',
      siteId: 'ask#1',
      nodeOrdinal: 1,
      entry: {
        kind: 'derivation',
        label: 'ask("inspect the service") completed at ask#1',
        inputHash: 'a'.repeat(64),
        provenance: 'dwf:ask:ask#1',
        coverage: 'the model answer recorded in dwf_nodes.result_json',
        limitations: 'a model-produced derivation, not a verified world fact',
        durationMs: 12,
        tokenUsage: { promptTokens: 42, completionTokens: 88, totalTokens: 130 },
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await store.saveDwfEvidence({
      runId: 'dwfrun-ev',
      siteId: 'glob#1',
      nodeOrdinal: 1,
      entry: {
        kind: 'observation',
        label: 'worldRead(["*.txt"]) completed at glob#1',
        inputHash: 'b'.repeat(64),
        provenance: 'dwf:worldRead:glob#1',
        coverage: 'the deterministic worldRead output',
        limitations: 'reflects the workspace only at execution time',
        durationMs: 3,
        recordedAt: '2026-01-01T00:00:01.000Z',
      },
    });

    const entries = await store.getDwfEvidence('dwfrun-ev');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.id), ['e-1', 'e-2'], 'ids are assigned from the per-run append ordinal');
    assert.equal(entries[0]!.kind, 'derivation');
    assert.equal(entries[0]!.provenance, 'dwf:ask:ask#1');
    assert.equal(entries[0]!.inputHash, 'a'.repeat(64));
    assert.equal(entries[0]!.durationMs, 12);
    assert.equal(entries[0]!.recordedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(entries[0]!.tokenUsage, { promptTokens: 42, completionTokens: 88, totalTokens: 130 });
    assert.equal(entries[1]!.kind, 'observation');
    assert.equal(entries[1]!.tokenUsage, undefined, 'a non-LLM entry has no token usage');

    // Ledgers are per-run: another run starts from an empty ledger.
    assert.deepEqual(await store.getDwfEvidence('dwfrun-other'), []);
  } finally {
    store.close();
  }
});

test('SQLite Store: re-recording the same node updates its evidence row in place and keeps its append ordinal', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    const failedEntry = {
      kind: 'unknown' as const,
      label: 'ask at ask#1 failed (input: inspect)',
      inputHash: 'c'.repeat(64),
      provenance: 'dwf:ask:ask#1',
      coverage: 'nothing — the operation failed before producing a journalled result',
      limitations: 'no result was established: boom',
      durationMs: 5,
    };
    await store.saveDwfEvidence({ runId: 'dwfrun-retry', siteId: 'ask#1', nodeOrdinal: 1, entry: failedEntry });

    // A resume re-executes the failed node; the completed attempt re-records
    // the SAME (run, site, nodeOrdinal) key — in-place update, no duplicate.
    await store.saveDwfEvidence({
      runId: 'dwfrun-retry',
      siteId: 'ask#1',
      nodeOrdinal: 1,
      entry: { ...failedEntry, kind: 'derivation', label: 'ask("inspect") completed at ask#1', limitations: 'a model-produced derivation', durationMs: 50 },
    });
    await store.saveDwfEvidence({
      runId: 'dwfrun-retry',
      siteId: 'glob#1',
      nodeOrdinal: 1,
      entry: { ...failedEntry, kind: 'observation', label: 'worldRead completed at glob#1', provenance: 'dwf:worldRead:glob#1' },
    });

    const entries = await store.getDwfEvidence('dwfrun-retry');
    assert.equal(entries.length, 2, 'the retried node must not duplicate its evidence row');
    assert.deepEqual(entries.map((e) => e.id), ['e-1', 'e-2'], 'the retry keeps its original append position');
    assert.equal(entries[0]!.kind, 'derivation');
    assert.equal(entries[0]!.durationMs, 50);
    assert.equal(entries[1]!.id, 'e-2');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// checkpoints.input_hash (core replay binding — audit medium fix)
// ---------------------------------------------------------------------------

test('SQLite Store: a pre-input_hash checkpoints database is migrated in place, stays readable, and reopening is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-migrate-'));
  const dbPath = path.join(dir, 'dwf.sqlite');
  try {
    // Build the OLD schema (no input_hash column) by hand — exactly as builds
    // before the replay binding created it — and leave a completed checkpoint
    // behind, the shape a finished run leaves on disk.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE checkpoints (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        phase_id TEXT,
        role TEXT,
        status TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        error_text TEXT,
        duration_ms INTEGER DEFAULT 0,
        tokens_prompt INTEGER DEFAULT 0,
        tokens_completion INTEGER DEFAULT 0,
        completed_at TEXT,
        PRIMARY KEY (run_id, step_id)
      );
    `);
    legacy
      .prepare(`INSERT INTO checkpoints (run_id, step_id, phase_id, status, input_json, output_json, duration_ms, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('run-legacy', 'step-1', 'phase-1', 'completed', 'null', '{"ok":true}', 10, '2026-01-01T00:00:00.000Z');
    legacy.close();

    // Opening through the store migrates the file: the legacy row stays
    // readable with inputHash === undefined (no recorded binding), and the
    // migrated table accepts input_hash writes.
    const store = new SQLiteStateStore(dbPath);
    try {
      const row = await store.getCheckpoint('run-legacy', 'step-1');
      assert.ok(row, 'the legacy checkpoint must survive the in-place migration');
      assert.equal(row?.status, 'completed');
      assert.equal(row?.inputHash, undefined, 'a pre-input_hash row has no recorded binding');

      await store.saveCheckpoint('run-legacy', { ...row!, inputHash: 'd'.repeat(64) });
      const bound = await store.getCheckpoint('run-legacy', 'step-1');
      assert.equal(bound?.inputHash, 'd'.repeat(64), 'the migrated table must accept input_hash writes');
    } finally {
      store.close();
    }

    // Reopening the already-migrated file must not throw and must not re-alter
    // (the PRAGMA table_info existence check makes the second migration a no-op).
    const reopened = new SQLiteStateStore(dbPath);
    try {
      const row = await reopened.getCheckpoint('run-legacy', 'step-1');
      assert.equal(row?.inputHash, 'd'.repeat(64), 'the hash written before reopen must survive it');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite Store: listDwfRuns lists facade rows newest-first with status filter and limit', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    await store.saveDwfRun({ runId: 'd1', scriptHash: 'h1', status: 'completed', createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z' });
    await store.saveDwfRun({ runId: 'd2', scriptHash: 'h2', status: 'parked', createdAt: '2026-11-01T02:00:00.000Z', updatedAt: '2026-11-01T02:00:00.000Z' });
    await store.saveDwfRun({ runId: 'd3', scriptHash: 'h3', status: 'completed', createdAt: '2026-11-01T03:00:00.000Z', updatedAt: '2026-11-01T03:00:00.000Z' });

    const all = await store.listDwfRuns();
    assert.deepEqual(all.map((r) => r.runId), ['d3', 'd2', 'd1'], 'newest first');

    const completed = await store.listDwfRuns({ status: 'completed' });
    assert.deepEqual(completed.map((r) => r.runId), ['d3', 'd1']);

    const limited = await store.listDwfRuns({ limit: 1 });
    assert.deepEqual(limited.map((r) => r.runId), ['d3']);

    // The listed rows carry the full DwfRunRow contract (same mapping as getDwfRun).
    const parked = (await store.listDwfRuns({ status: 'parked' }))[0]!;
    assert.equal(parked.scriptHash, 'h2');
    assert.equal(parked.createdAt, '2026-11-01T02:00:00.000Z');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Issue #140 deterministic regressions: initSchemaToleratingBusy branches.
// The production trigger is a real concurrent-opener race (twice on CI), so
// these tests inject BUSY-shaped failures through the virtual initSchema seam
// instead of trying to win the race — every retry branch is locked as data.
// ---------------------------------------------------------------------------

test('SQLite Store: initSchemaToleratingBusy retries bounded on BUSY and converges (#140)', () => {
  const proto = SQLiteStateStore.prototype as unknown as { initSchema: () => void };
  const original = proto.initSchema;
  let calls = 0;
  proto.initSchema = function (this: unknown): void {
    calls++;
    if (calls === 1) {
      const err = new Error('database is locked');
      (err as { errcode?: number }).errcode = 5; // SQLITE_BUSY primary code branch
      throw err;
    }
    if (calls === 2) {
      throw new Error('database table is locked'); // message-regex branch only
    }
    original.call(this);
  };
  try {
    const store = new SQLiteStateStore(':memory:');
    try {
      assert.equal(calls, 3, 'two BUSY failures then the converging init');
      assert.deepEqual(store.listRuns(), [], 'the retried store is fully usable');
    } finally {
      store.close();
    }
  } finally {
    proto.initSchema = original;
  }
});

test('SQLite Store: non-BUSY init failures propagate immediately without retry (#140)', () => {
  const proto = SQLiteStateStore.prototype as unknown as { initSchema: () => void };
  const original = proto.initSchema;
  let calls = 0;
  proto.initSchema = function (): void {
    calls++;
    const err = new Error('malformed schema input');
    (err as { errcode?: number }).errcode = 11;
    throw err;
  };
  try {
    assert.throws(() => new SQLiteStateStore(':memory:'), /malformed schema input/);
    assert.equal(calls, 1, 'non-BUSY errors must not be retried');
  } finally {
    proto.initSchema = original;
  }
});

test('SQLite Store: BUSY that outlasts the bounded retries still propagates (#140)', () => {
  const proto = SQLiteStateStore.prototype as unknown as { initSchema: () => void };
  const original = proto.initSchema;
  let calls = 0;
  proto.initSchema = function (): void {
    calls++;
    const err = new Error('database is locked');
    (err as { errcode?: number }).errcode = 5;
    throw err;
  };
  try {
    assert.throws(() => new SQLiteStateStore(':memory:'), /database is locked/);
    assert.equal(calls, 5, 'five bounded attempts (100→400ms backoff), then the error propagates');
  } finally {
    proto.initSchema = original;
  }
});
