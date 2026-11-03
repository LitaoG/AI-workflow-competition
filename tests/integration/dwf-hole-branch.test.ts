import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { executeAnswer } from '../../src/cli/commands/answer.js';

// 分支级 hole 停靠 (branch-level hole parking): a hole inside ONE branch of a
// Promise.all parks only that branch — the sibling branch drains to the
// journal first, the run then parks, and a resume (after `answer`) composes
// the drained sibling's journalled result with the hole's answer at zero
// provider cost for the drained part. This test LOCKS those semantics.

const SCRIPT = `
phase('Parallel');
const [health, decision] = await Promise.all([
  (async () => {
    const h = await agent('inspector').ask<Health>('inspect health report of the service');
    report({ health: h.healthStatus });
    return h;
  })(),
  (async () => escalate('Branch-level parking check: approve?'))(),
]);
return { healthStatus: health.healthStatus, decision };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-hole-branch-'));
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

test('a hole in one Promise.all branch parks only after the sibling branch drains to the journal', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.kind, 'escalation', 'the hole-branch escalates and parks');
    assert.match(parked.parkedAt?.prompt ?? '', /Branch-level parking check/);

    // The SIBLING branch drained BEFORE the park: its ask is journalled complete.
    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const nodes = await store.getDwfNodes(parked.runId);
      const ask = nodes.find((n) => n.kind === 'ask');
      assert.ok(ask, 'sibling ask must be journalled before the park');
      assert.equal(ask!.status, 'completed');
      assert.match(ask!.resultJson ?? '', /HEALTHY/);
    } finally {
      store.close();
    }

    // Answer the escalation, then resume: the drained sibling ask replays at
    // zero cost and the hole's branch resolves with the answer.
    const answerExit = await executeAnswer(parked.runId, parked.parkedAt!.name, ['yes'], { dbPath: ws.dbPath });
    assert.equal(answerExit, 0, 'answer must complete the run');

    const resumed = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      resumeRunId: parked.runId,
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    const value = resumed.value as { healthStatus: string; decision: string };
    assert.equal(value.healthStatus, 'HEALTHY', 'the sibling result must compose with the answer');
    assert.equal(value.decision, 'yes');
    assert.equal(resumed.stats.asks, 0, 'both drained nodes replay at zero provider cost');
    assert.equal(resumed.stats.replayHits, 2, 'ask + escalation replay from the journal');
  } finally {
    ws.cleanup();
  }
});
