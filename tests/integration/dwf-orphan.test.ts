import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { hashScriptSource } from '../../src/dwf/compile.js';
import { executeStop } from '../../src/cli/commands/stop.js';

const SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-orphan-'));
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

/** Plant an orphaned 'running' row owned by a process that no longer exists. */
function plantOrphan(ws: { dir: string; dbPath: string }, scriptPath: string, scriptText: string): void {
  const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
  try {
    store.saveDwfRun({
      runId: 'dwfrun-orphan-test',
      scriptHash: hashScriptSource(scriptText),
      scriptPath,
      argsJson: '{}',
      status: 'running',
      runnerPid: 999_999_999, // nobody owns this pid
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

test('orphaned running row converges on resume — the run completes instead of refusing', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    plantOrphan(ws, scriptPath, SCRIPT);

    // Before the fix this refused with "is already running — stop it before resuming".
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, resumeRunId: 'dwfrun-orphan-test' });
    assert.equal(r.status, 'completed', `orphan resume must converge and complete: ${r.error}`);

    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const row = await store.getDwfRun('dwfrun-orphan-test');
      assert.equal(row?.status, 'completed');
      assert.equal(row?.runnerPid, undefined, 'a settled run has no owning process');
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('a run owned by a LIVE process is genuinely running — resume still refuses', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      store.saveDwfRun({
        runId: 'dwfrun-live-test',
        scriptHash: hashScriptSource(SCRIPT),
        scriptPath,
        argsJson: '{}',
        status: 'running',
        runnerPid: process.ppid, // the test runner's parent process — alive
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } finally {
      store.close();
    }

    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, resumeRunId: 'dwfrun-live-test' });
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /already running \(pid/);
  } finally {
    ws.cleanup();
  }
});

test('stop converges an orphaned row and unlocks resume', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    plantOrphan(ws, scriptPath, SCRIPT);

    const exit = await executeStop('dwfrun-orphan-test', { dbPath: ws.dbPath });
    assert.equal(exit, 0);

    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const row = await store.getDwfRun('dwfrun-orphan-test');
      assert.equal(row?.status, 'stopped');
    } finally {
      store.close();
    }

    // Doors unlocked: resume proceeds and completes.
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, resumeRunId: 'dwfrun-orphan-test' });
    assert.equal(r.status, 'completed', r.error);
  } finally {
    ws.cleanup();
  }
});
