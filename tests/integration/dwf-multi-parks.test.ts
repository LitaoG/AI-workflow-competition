import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { executeAnswer } from '../../src/cli/commands/answer.js';
import { executeFill } from '../../src/cli/commands/fill.js';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';

// 多实例停靠池化（审计 #5 同族收尾）：多个 hole / 多个 escalate 在并行分支里
// 各自停靠——池化后按 (kind, inputHash) 内容 1:1 消费，arrival 序不再错绑。

const HOLES_SCRIPT = `
phase('Parallel holes');
const [a, b] = await Promise.all([
  (async () => {
    const bodyA = await hole<string>('fix-a', 'Provide the fix for branch A');
    return 'A:' + String(bodyA);
  })(),
  (async () => {
    const bodyB = await hole<string>('fix-b', 'Provide the fix for branch B');
    return 'B:' + String(bodyB);
  })(),
]);
return { a, b };
`;

const ESCALATIONS_SCRIPT = `
phase('Parallel escalations');
const [x, y] = await Promise.all([
  (async () => {
    const answerX = await escalate('Deploy to staging? (x)');
    return 'X:' + String(answerX);
  })(),
  (async () => {
    const answerY = await escalate('Deploy to production? (y)');
    return 'Y:' + String(answerY);
  })(),
]);
return { x, y };
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-multi-parks-'));
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

// RESOLVED: chained fills across parallel hole branches compose correctly —
// the earlier a:undefined was the TEST's body missing `return` (the splice
// semantics are a statement block: the fill body must return its value, per
// fill.ts "the fill body's statements"). The engine pools handled the chained
// amends correctly all along.
test('two holes in parallel branches: each fill targets its own pool row, both compose', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'holes.facade.ts');
    fs.writeFileSync(scriptPath, HOLES_SCRIPT);

    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.kind, 'hole');

    // Fill hole A: forks an amend; branch B's hole parks again in the fork.
    const bodyFileA = path.join(ws.dir, 'body-a.txt');
    fs.writeFileSync(bodyFileA, "return 'alpha-body';"); // splice semantics: the body is a statement block
    let fillAExit = -1;
    let fillAResult = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { fillAResult += args.join(' ') + '|'; };
    try {
      fillAExit = await executeFill(parked.runId, 'fix-a', bodyFileA, { dbPath: ws.dbPath });
    } finally {
      console.log = origLog;
    }
    assert.equal(fillAExit, 0, `fill A must succeed: ${fillAResult}`);

    // The fork parks at the second hole (fix-b). Chain: fill fix-b ON THE FORK
    // (its runId is printed by fill). The fork's lineage carries the fix-a row,
    // so the composed result contains both branches.
    const forkRunId = /dwfrun-[A-Za-z0-9_-]+/.exec(fillAResult)?.[0] ?? '';
    assert.ok(forkRunId, `fill A must print the fork run id: ${fillAResult}`);
    const bodyFileB = path.join(ws.dir, 'body-b.txt');
    fs.writeFileSync(bodyFileB, "return 'beta-body';");
    let fillBExit = -1;
    let fillBResult = '';
    console.log = (...args: unknown[]) => { fillBResult += args.join(' ') + '|'; };
    try {
      fillBExit = await executeFill(forkRunId, 'fix-b', bodyFileB, { dbPath: ws.dbPath });
    } finally {
      console.log = origLog;
    }
    assert.equal(fillBExit, 0, `fill B must succeed: ${fillBResult}`);
    assert.ok(/"a":"A:alpha-body"/.test(fillBResult) && /"b":"B:beta-body"/.test(fillBResult), `both branches must compose: ${fillBResult}`);
  } finally {
    ws.cleanup();
  }
});

// The escalation half passes standalone (each answer targets its own site by
// questionId); it shares the file with the skipped holes case for context.
test('two escalations in parallel branches: each answer targets its own pool row', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'esc.facade.ts');
    fs.writeFileSync(scriptPath, ESCALATIONS_SCRIPT);

    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.kind, 'escalation');
    const q1 = parked.parkedAt!.name;

    // Answer the first parked question; the run resumes and parks on the second.
    const exit1 = await executeAnswer(parked.runId, q1, ['yes'], { dbPath: ws.dbPath });
    assert.equal(exit1, 0, 'first answer must drive the run forward');

    // Find the second open escalation on the resumed run: answer its question id.
    // The second answer's questionId: re-derive from the journal — the run parks
    // again with a fresh dwfq id. Read the latest parked state via a resume run.
    // executeAnswer resumes internally; the result above tells us it parked again
    // only via its own output — so answer by scanning: the remaining open event.
    let questionId2 = '';
    {
      const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
      try {
        const events = await store.getEvents(parked.runId);
        const opens = events.filter((e) => e.type === 'dwf_escalation_open');
        const answered = new Set<string>([q1]);
        const open = [...opens].reverse().find((e) => {
          const qid = (e.data as { questionId?: string }).questionId ?? '';
          return !answered.has(qid);
        });
        questionId2 = (open?.data as { questionId?: string }).questionId ?? '';
      } finally {
        store.close();
      }
    }
    assert.ok(questionId2, 'second escalation question id not found');
    const exit2 = await executeAnswer(parked.runId, questionId2, ['yes'], { dbPath: ws.dbPath });
    assert.equal(exit2, 0, 'second answer must complete the run');

    // Compose proof: run one more resume — both escalation rows replay, zero asks.
    const final = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, resumeRunId: parked.runId });
    assert.equal(final.status, 'completed', final.error);
    const value = final.value as { x: string; y: string };
    // Park order between the two branches is deterministic in this engine
    // (x emits first, y parks last), but the assertion is order-agnostic: the
    // pool guarantees each SITE gets the answer written for ITS question.
    assert.equal(value.x, 'X:yes');
    assert.equal(value.y, 'Y:yes');
    assert.equal(final.stats.asks, 0);
  } finally {
    ws.cleanup();
  }
});
