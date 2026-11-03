import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { ReplayEngine } from '../../src/state/replay.js';
import { RunNotFoundError } from '../../src/core/error.js';

test('Replay Engine: resumes failed run from first failed step, skipping completed steps', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'run-replay-1';

  try {
    await store.saveCheckpoint(runId, {
      stepId: 'step-1',
      phaseId: 'p1',
      status: 'completed',
      input: {},
      output: { data: 'step 1 output' },
      durationMs: 50,
      tokens: { prompt: 100, completion: 50 },
    });

    await store.saveCheckpoint(runId, {
      stepId: 'step-2',
      phaseId: 'p1',
      status: 'failed',
      input: { data: 'step 1 output' },
      error: 'Network timeout',
      durationMs: 120,
    });

    const engine = new ReplayEngine(store);
    const plan = await engine.analyzeRun(runId, ['step-1', 'step-2', 'step-3']);

    assert.equal(plan.resumable, true);
    assert.equal(plan.firstFailedStepId, 'step-2');
    assert.deepEqual(plan.stepsToSkip, ['step-1']);
    assert.deepEqual(plan.stepsToExecute, ['step-2', 'step-3']);
    assert.deepEqual(plan.cachedOutputs['step-1'], { data: 'step 1 output' });
    assert.equal(plan.tokensSavedEstimate, 150);
  } finally {
    store.close();
  }
});

test('Replay Engine: verifies zero token re-expenditure for replayed steps', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'run-replay-tokens';

  try {
    await store.saveCheckpoint(runId, {
      stepId: 'heavy-llm-step',
      phaseId: 'p1',
      status: 'completed',
      input: {},
      output: { summary: 'long report' },
      durationMs: 3500,
      tokens: { prompt: 2500, completion: 1500 },
    });

    await store.saveCheckpoint(runId, {
      stepId: 'downstream-failing-step',
      phaseId: 'p2',
      status: 'failed',
      input: {},
      error: 'SyntaxError',
      durationMs: 20,
    });

    const engine = new ReplayEngine(store);
    const plan = await engine.analyzeRun(runId, ['heavy-llm-step', 'downstream-failing-step']);

    assert.deepEqual(plan.stepsToSkip, ['heavy-llm-step']);
    assert.equal(plan.tokensSavedEstimate, 4000);
  } finally {
    store.close();
  }
});

test('Replay Engine: resume from specific step with --step option', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'run-replay-step';

  try {
    await store.saveCheckpoint(runId, {
      stepId: 'step-A',
      phaseId: 'p1',
      status: 'completed',
      input: {},
      output: 'A',
      durationMs: 10,
    });
    await store.saveCheckpoint(runId, {
      stepId: 'step-B',
      phaseId: 'p1',
      status: 'completed',
      input: {},
      output: 'B',
      durationMs: 10,
    });

    const engine = new ReplayEngine(store);
    const plan = await engine.analyzeRun(runId, ['step-A', 'step-B', 'step-C'], {
      startStepId: 'step-B',
    });

    assert.deepEqual(plan.stepsToSkip, ['step-A']);
    assert.deepEqual(plan.stepsToExecute, ['step-B', 'step-C']);
  } finally {
    store.close();
  }
});

test('Replay Engine: throws RunNotFoundError when run-id does not exist', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    const engine = new ReplayEngine(store);
    await assert.rejects(
      async () => {
        await engine.analyzeRun('unknown-run-id', ['step-1']);
      },
      (err: any) => {
        assert.ok(err instanceof RunNotFoundError);
        return true;
      }
    );
  } finally {
    store.close();
  }
});

test('Replay Engine: --force-recompute invalidates cached checkpoint and re-executes', async () => {
  const store = new SQLiteStateStore(':memory:');
  const runId = 'run-force-recompute';

  try {
    await store.saveCheckpoint(runId, {
      stepId: 'step-cached',
      phaseId: 'p1',
      status: 'completed',
      input: {},
      output: { value: 1 },
      durationMs: 10,
    });

    const engine = new ReplayEngine(store);
    const plan = await engine.analyzeRun(runId, ['step-cached'], {
      forceRecompute: true,
    });

    assert.deepEqual(plan.stepsToSkip, []);
    assert.deepEqual(plan.stepsToExecute, ['step-cached']);
  } finally {
    store.close();
  }
});
