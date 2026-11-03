import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SQLiteStateStore } from '../../dist/src/state/sqlite-store.js';
import { ReplayEngine } from '../../dist/src/state/replay.js';
import { Workflow, defineWorkflow } from '../../dist/src/core/workflow.js';
import { RunNotFoundError } from '../../dist/src/core/error.js';

const TEST_DIR = path.join(process.cwd(), 'tests', 'adversarial', 'fixtures', 'replay-stress');

function setupCleanDir(subDir) {
  const dir = path.join(TEST_DIR, subDir);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Replay Stress 1: Confirm WAL mode and O(1) indexed checkpoint lookup via node:sqlite', async () => {
  const testDir = setupCleanDir('sqlite-wal-benchmark');
  const dbPath = path.join(testDir, 'test-wal.db');
  const store = new SQLiteStateStore(dbPath);

  // 1. Verify WAL mode is active
  // @ts-ignore - access underlying db
  const journalModeRow = store.db.prepare('PRAGMA journal_mode;').get();
  assert.equal(journalModeRow.journal_mode.toLowerCase(), 'wal', 'SQLite database must be configured with WAL journal mode');

  // 2. Verify query plan uses PRIMARY KEY index (O(1) lookup)
  // @ts-ignore
  const planRows = store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM checkpoints WHERE run_id = ? AND step_id = ?;').all('run-1', 'step-1');
  const planDetail = planRows.map((r) => r.detail).join('; ');
  assert.ok(
    planDetail.includes('USING PRIMARY KEY') || planDetail.includes('USING INDEX'),
    `Query plan must use indexed primary key lookup, got: ${planDetail}`
  );

  // 3. Insert 1,000 checkpoints to stress benchmark lookup speed
  const runId = 'stress-run-1000';
  for (let i = 1; i <= 1000; i++) {
    await store.saveCheckpoint(runId, {
      stepId: `step-${i}`,
      phaseId: `phase-${Math.floor(i / 100)}`,
      role: 'worker',
      status: i % 10 === 0 ? 'failed' : 'completed',
      input: { param: `input-${i}` },
      output: { result: `output-${i}` },
      tokens: { prompt: 100 + i, completion: 50 + i },
      durationMs: 10,
    });
  }

  // 4. Benchmark random lookups across 1,000 checkpoints
  const sampleSteps = [1, 50, 100, 250, 500, 750, 999, 1000].map((n) => `step-${n}`);
  const latencies = [];

  for (const stepId of sampleSteps) {
    const t0 = performance.now();
    const cp = await store.getCheckpoint(runId, stepId);
    const elapsed = performance.now() - t0;
    latencies.push(elapsed);

    assert.ok(cp !== null, `Step ${stepId} must be retrieved`);
    assert.equal(cp.stepId, stepId);
  }

  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  // O(1) indexed memory/SSD SQLite lookup should be well under 1ms per item
  assert.ok(avgLatency < 5.0, `Average checkpoint lookup latency must be O(1) (<5ms), got ${avgLatency.toFixed(3)}ms`);

  store.close();
});

test('Replay Stress 2: Step-level skipping with 0 re-tokens and 0 runner invocations for skipped steps', async () => {
  const testDir = setupCleanDir('token-expenditure');
  const dbPath = path.join(testDir, 'resumption.db');
  const store = new SQLiteStateStore(dbPath);
  const runId = 'run-fail-and-resume';

  let step1Calls = 0;
  let step2Calls = 0;
  let step3Calls = 0;
  let step4Calls = 0;

  let tokensExpended = 0;

  const createWorkflow = (failStep3) =>
    defineWorkflow({
      name: 'ResumptionTestWorkflow',
      phases: [
        { id: 'phase-1', name: 'Phase 1' },
        { id: 'phase-2', name: 'Phase 2' },
      ],
      steps: [
        {
          id: 'step-1',
          name: 'Step 1',
          phaseId: 'phase-1',
          execute: async (_ctx, _input) => {
            step1Calls++;
            tokensExpended += 150;
            return { data: 'step-1-done' };
          },
        },
        {
          id: 'step-2',
          name: 'Step 2',
          phaseId: 'phase-1',
          dependsOn: ['step-1'],
          execute: async (_ctx, input) => {
            step2Calls++;
            tokensExpended += 200;
            return { data: 'step-2-done', from: input };
          },
        },
        {
          id: 'step-3',
          name: 'Step 3',
          phaseId: 'phase-2',
          dependsOn: ['step-2'],
          execute: async (_ctx, input) => {
            step3Calls++;
            if (failStep3) {
              tokensExpended += 50;
              throw new Error('Simulated transient failure on Step 3');
            }
            tokensExpended += 300;
            return { data: 'step-3-done', from: input };
          },
        },
        {
          id: 'step-4',
          name: 'Step 4',
          phaseId: 'phase-2',
          dependsOn: ['step-3'],
          execute: async (_ctx, input) => {
            step4Calls++;
            tokensExpended += 120;
            return { data: 'step-4-done', from: input };
          },
        },
      ],
    });

  // RUN 1: Fails on Step 3
  const wf1 = createWorkflow(true);
  let errorCaught = false;
  try {
    const res1 = await wf1.run({ runId, stateStore: store, mockMode: true });
    if (res1.status === 'failed') errorCaught = true;
  } catch (err) {
    errorCaught = true;
  }
  assert.ok(errorCaught, 'First run must fail on Step 3');
  assert.equal(step1Calls, 1, 'Step 1 ran once in Run 1');
  assert.equal(step2Calls, 1, 'Step 2 ran once in Run 1');
  assert.equal(step3Calls, 1, 'Step 3 attempted once in Run 1');
  assert.equal(step4Calls, 0, 'Step 4 never reached in Run 1');
  const tokensInRun1 = tokensExpended;
  assert.equal(tokensInRun1, 150 + 200 + 50);

  // Check state store checkpoints
  const cp1 = await store.getCheckpoint(runId, 'step-1');
  const cp2 = await store.getCheckpoint(runId, 'step-2');
  const cp3 = await store.getCheckpoint(runId, 'step-3');
  const cp4 = await store.getCheckpoint(runId, 'step-4');

  assert.equal(cp1?.status, 'completed');
  assert.equal(cp2?.status, 'completed');
  assert.equal(cp3?.status, 'failed');
  assert.equal(cp4, null);

  // RUN 2: Resumed with bug fixed (failStep3 = false)
  // Reset counters to measure only Run 2 operations
  step1Calls = 0;
  step2Calls = 0;
  step3Calls = 0;
  step4Calls = 0;
  tokensExpended = 0;

  const skippedEvents = [];
  const wf2 = createWorkflow(false);
  wf2.on('step_skipped', (evt) => skippedEvents.push(evt.stepId));

  const res2 = await wf2.run({ runId, stateStore: store, mockMode: true });
  assert.equal(res2.status, 'completed', 'Second run must complete successfully');

  // EMPIRICAL VERIFICATION OF REQUIREMENTS:
  // 1. Step-1 and Step-2 were SKIPPED
  assert.deepEqual(skippedEvents.sort(), ['step-1', 'step-2']);
  assert.equal(step1Calls, 0, 'CRITICAL: Step 1 runner MUST NOT be called in resumed run!');
  assert.equal(step2Calls, 0, 'CRITICAL: Step 2 runner MUST NOT be called in resumed run!');

  // 2. Step-3 and Step-4 EXECUTED
  assert.equal(step3Calls, 1, 'Step 3 must execute and succeed in resumed run');
  assert.equal(step4Calls, 1, 'Step 4 must execute and succeed in resumed run');

  // 3. ZERO re-tokens expended on skipped steps!
  // Only step 3 (300) and step 4 (120) tokens were expended in run 2
  assert.equal(tokensExpended, 300 + 120, 'Zero tokens expended on skipped steps (only 420 for steps 3 and 4)');

  store.close();
});

test('Replay Stress 3: ReplayEngine analyzeRun and startStepId selective replay', async () => {
  const testDir = setupCleanDir('replay-engine-plan');
  const dbPath = path.join(testDir, 'plan.db');
  const store = new SQLiteStateStore(dbPath);
  const runId = 'plan-test-run';

  await store.saveCheckpoint(runId, {
    stepId: 'step-a',
    status: 'completed',
    output: { a: 1 },
    tokens: { prompt: 100, completion: 50 },
  });
  await store.saveCheckpoint(runId, {
    stepId: 'step-b',
    status: 'completed',
    output: { b: 2 },
    tokens: { prompt: 200, completion: 100 },
  });
  await store.saveCheckpoint(runId, {
    stepId: 'step-c',
    status: 'failed',
    error: 'network error',
    tokens: { prompt: 50, completion: 0 },
  });
  await store.saveCheckpoint(runId, {
    stepId: 'step-d',
    status: 'pending',
  });

  const replayEngine = new ReplayEngine(store);

  // Normal resumption from failed
  const plan1 = await replayEngine.analyzeRun(runId, ['step-a', 'step-b', 'step-c', 'step-d']);
  assert.deepEqual(plan1.stepsToSkip, ['step-a', 'step-b']);
  assert.deepEqual(plan1.stepsToExecute, ['step-c', 'step-d']);
  assert.equal(plan1.firstFailedStepId, 'step-c');
  assert.equal(plan1.tokensSavedEstimate, 150 + 300); // 450 tokens saved!

  // Selective resume from step-b (even though step-b was completed)
  const plan2 = await replayEngine.analyzeRun(runId, ['step-a', 'step-b', 'step-c', 'step-d'], {
    startStepId: 'step-b',
  });
  assert.deepEqual(plan2.stepsToSkip, ['step-a']);
  assert.deepEqual(plan2.stepsToExecute, ['step-b', 'step-c', 'step-d']);
  assert.equal(plan2.tokensSavedEstimate, 150);

  // Force recompute all
  const plan3 = await replayEngine.analyzeRun(runId, ['step-a', 'step-b', 'step-c', 'step-d'], {
    forceRecompute: true,
  });
  assert.deepEqual(plan3.stepsToSkip, []);
  assert.deepEqual(plan3.stepsToExecute, ['step-a', 'step-b', 'step-c', 'step-d']);
  assert.equal(plan3.tokensSavedEstimate, 0);

  // Non-existent run throws RunNotFoundError
  await assert.rejects(
    async () => replayEngine.analyzeRun('ghost-run-404', ['step-a']),
    RunNotFoundError
  );

  store.close();
});
