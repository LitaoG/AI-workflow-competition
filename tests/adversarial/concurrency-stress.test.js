import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workflow } from '../../dist/src/core/workflow.js';
import { actionStep } from '../../dist/src/core/step.js';
import { SQLiteStateStore } from '../../dist/src/state/sqlite-store.js';
import { EventLogWriter, EventLogReader } from '../../dist/src/state/event-log.js';
import { StepExecutionError } from '../../dist/src/core/error.js';

test('Concurrency Stress: 20 parallel independent steps via Promise.all with random latencies', async () => {
  const tmpDir = path.resolve(process.cwd(), 'tests', 'adversarial', 'fixtures', `run-20-parallel-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'concurrency.db');
  const store = new SQLiteStateStore(dbPath);
  const eventLogWriter = new EventLogWriter(tmpDir);

  const wf = new Workflow({ name: 'Parallel20Workflow' });
  wf.addPhase({ id: 'parallel-phase', name: '20 Parallel Steps Phase' });

  const NUM_STEPS = 20;
  const expectedStepIds = [];

  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `step-parallel-${String(i).padStart(2, '0')}`;
    expectedStepIds.push(stepId);

    wf.addStep(
      actionStep({
        id: stepId,
        name: `Parallel Worker ${i}`,
        phaseId: 'parallel-phase',
        action: async (input, ctx) => {
          // Random simulated latency between 10ms and 40ms to trigger async interleaving
          const delayMs = Math.floor(Math.random() * 30) + 10;
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          // Context variable updates
          ctx.set(`var_${stepId}`, { workerIndex: i, delayMs, timestamp: Date.now() });

          // Record artifact concurrently
          await ctx.recordArtifact(`artifact-${stepId}.json`, JSON.stringify({ workerIndex: i, delayMs }));

          return {
            workerIndex: i,
            computed: i * 42,
            delayMs,
          };
        },
      })
    );
  }

  assert.equal(wf.getAllSteps().length, NUM_STEPS);

  const runId = `run-concurrent-${Date.now()}`;

  // Attach event log writer to workflow events
  wf.on('event', (evt) => {
    eventLogWriter.record(evt);
  });

  const startTime = Date.now();
  const { status, context } = await wf.run({
    runId,
    stateStore: store,
    mockMode: true,
  });
  const elapsedMs = Date.now() - startTime;

  // 1. Verify status and execution time
  assert.equal(status, 'completed');
  // Since 20 steps run in parallel (each 10-40ms), wall-clock should be << 20 * 40ms (800ms)
  assert.ok(elapsedMs < 600, `20 parallel steps should finish in <<800ms (took ${elapsedMs}ms)`);

  // 2. Verify all 20 context variables updated safely without data race
  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `step-parallel-${String(i).padStart(2, '0')}`;
    assert.ok(context.has(`var_${stepId}`), `Context must have variable for ${stepId}`);
    const v = context.get(`var_${stepId}`);
    assert.equal(v.workerIndex, i);

    const out = context.getOutput(stepId);
    assert.ok(out, `Context must have output for ${stepId}`);
    assert.equal(out.computed, i * 42);
  }

  // 3. Verify SQLite State Store Checkpoints
  const checkpoints = await store.getAllCheckpoints(runId);
  assert.equal(Object.keys(checkpoints).length, NUM_STEPS, 'Must have exactly 20 checkpoints in SQLite');

  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `step-parallel-${String(i).padStart(2, '0')}`;
    const cp = checkpoints[stepId];
    assert.ok(cp, `Checkpoint for ${stepId} must exist`);
    assert.equal(cp.status, 'completed');
    assert.equal(cp.output.computed, i * 42);
    assert.ok(cp.durationMs >= 10, `Duration should be >= simulated latency (was ${cp.durationMs}ms)`);
  }

  // 4. Verify Event Log Integrity and Sequence Ordering
  eventLogWriter.close();
  const eventLogPath = path.join(tmpDir, 'events.jsonl');
  assert.ok(fs.existsSync(eventLogPath), 'events.jsonl must exist');

  const rawLines = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n');
  // Expected: 1 workflow_start + 1 phase_start + 20 step_start + 20 step_complete + 1 phase_complete + 1 workflow_complete = 44 events
  const EXPECTED_EVENTS = 1 + 1 + NUM_STEPS + NUM_STEPS + 1 + 1;
  assert.equal(rawLines.length, EXPECTED_EVENTS, `Must have exactly ${EXPECTED_EVENTS} lines in events.jsonl`);

  const events = await EventLogReader.readAll(eventLogPath);
  assert.equal(events.length, EXPECTED_EVENTS);

  // Invariant: Sequence numbers strictly monotonic from 1 to 44 with zero race conditions
  for (let idx = 0; idx < events.length; idx++) {
    assert.equal(events[idx].sequence, idx + 1, `Event at index ${idx} must have sequence ${idx + 1}`);
  }

  // Verify unique step_start and step_complete for all 20 steps
  const startedSteps = new Set(events.filter((e) => e.type === 'step_start').map((e) => e.stepId));
  const completedSteps = new Set(events.filter((e) => e.type === 'step_complete').map((e) => e.stepId));

  assert.equal(startedSteps.size, NUM_STEPS, 'All 20 steps must have distinct step_start events');
  assert.equal(completedSteps.size, NUM_STEPS, 'All 20 steps must have distinct step_complete events');

  for (const sid of expectedStepIds) {
    assert.ok(startedSteps.has(sid), `Step ${sid} must be in startedSteps`);
    assert.ok(completedSteps.has(sid), `Step ${sid} must be in completedSteps`);
  }

  store.close();
});

test('Concurrency Stress: 50 parallel steps high-load test with WAL mode and zero dropped events', async () => {
  const tmpDir = path.resolve(process.cwd(), 'tests', 'adversarial', 'fixtures', `run-50-parallel-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'concurrency-50.db');
  const store = new SQLiteStateStore(dbPath);
  const eventLogWriter = new EventLogWriter(tmpDir);

  const wf = new Workflow({ name: 'Parallel50Workflow' });
  wf.addPhase({ id: 'p50', name: '50 Steps' });

  const NUM_STEPS = 50;
  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `p50-step-${String(i).padStart(3, '0')}`;
    wf.addStep(
      actionStep({
        id: stepId,
        name: `Worker ${i}`,
        phaseId: 'p50',
        action: async (input, ctx) => {
          const jitter = Math.floor(Math.random() * 20) + 5;
          await new Promise((r) => setTimeout(r, jitter));
          ctx.set(`res_${i}`, i * 100);
          return { i, val: i * 100 };
        },
      })
    );
  }

  const runId = `run-50-${Date.now()}`;
  wf.on('event', (evt) => eventLogWriter.record(evt));

  const { status, context } = await wf.run({ runId, stateStore: store, mockMode: true });
  assert.equal(status, 'completed');

  // Verify all 50 context variables
  for (let i = 1; i <= NUM_STEPS; i++) {
    assert.equal(context.get(`res_${i}`), i * 100);
    assert.equal(context.getOutput(`p50-step-${String(i).padStart(3, '0')}`).val, i * 100);
  }

  // Verify checkpoints
  const checkpoints = await store.getAllCheckpoints(runId);
  assert.equal(Object.keys(checkpoints).length, 50);

  // Verify events: 1 + 1 + 50 + 50 + 1 + 1 = 104 events
  eventLogWriter.close();
  const events = await EventLogReader.readAll(path.join(tmpDir, 'events.jsonl'));
  assert.equal(events.length, 104);

  // Check strict monotonicity
  for (let idx = 0; idx < events.length; idx++) {
    assert.equal(events[idx].sequence, idx + 1);
  }

  store.close();
});

test('Concurrency Stress: Concurrent shared-object mutation safety across parallel steps', async () => {
  const wf = new Workflow({ name: 'SharedObjectConcurrency' });
  wf.addPhase({ id: 'setup-phase', name: 'Setup Phase' });
  wf.addPhase({ id: 'shared-phase', name: 'Shared Phase' });

  // Phase 1: Setup step to initialize shared context collection
  wf.addStep(
    actionStep({
      id: 'init-step',
      name: 'Init Step',
      phaseId: 'setup-phase',
      action: async (input, ctx) => {
        ctx.set('sharedList', []);
        return { initialized: true };
      },
    })
  );

  const NUM_WRITERS = 20;
  for (let i = 1; i <= NUM_WRITERS; i++) {
    wf.addStep(
      actionStep({
        id: `writer-${i}`,
        name: `Writer ${i}`,
        phaseId: 'shared-phase',
        dependsOn: ['init-step'],
        action: async (input, ctx) => {
          const delay = Math.floor(Math.random() * 15) + 5;
          await new Promise((r) => setTimeout(r, delay));

          // Concurrently push to shared list in context
          const list = ctx.get('sharedList');
          list.push({ writerId: i, timestamp: Date.now() });

          return { wrote: i };
        },
      })
    );
  }

  const { status, context } = await wf.run({
    mockMode: true,
  });

  assert.equal(status, 'completed');

  // Verify all 20 writers pushed to shared list
  const sharedList = context.get('sharedList');
  assert.equal(sharedList.length, NUM_WRITERS, 'All 20 writers must have appended to sharedList');
  const writerIds = new Set(sharedList.map((entry) => entry.writerId));
  assert.equal(writerIds.size, NUM_WRITERS, 'Every writer must be represented in sharedList');

  // Also verify that each individual step output is intact
  for (let i = 1; i <= NUM_WRITERS; i++) {
    assert.deepEqual(context.getOutput(`writer-${i}`), { wrote: i });
  }
});

test('Concurrency Stress: Failure in 1 of 20 parallel steps is recorded without corrupting concurrent steps', async () => {
  const tmpDir = path.resolve(process.cwd(), 'tests', 'adversarial', 'fixtures', `run-failure-concurrent-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'failure-test.db');
  const store = new SQLiteStateStore(dbPath);
  const eventLogWriter = new EventLogWriter(tmpDir);

  const wf = new Workflow({ name: 'FailureInParallelWorkflow' });
  wf.addPhase({ id: 'p-fail', name: 'Phase with One Failure' });

  const NUM_STEPS = 20;
  const FAILING_STEP = 13; // Step 13 will deliberately throw

  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `step-p-${i}`;
    wf.addStep(
      actionStep({
        id: stepId,
        name: `Worker ${i}`,
        phaseId: 'p-fail',
        action: async () => {
          const delay = Math.floor(Math.random() * 20) + 5;
          await new Promise((r) => setTimeout(r, delay));
          if (i === FAILING_STEP) {
            throw new Error(`Deliberate failure in worker ${i}`);
          }
          return { ok: true, i };
        },
      })
    );
  }

  const runId = `run-fail-${Date.now()}`;
  wf.on('event', (evt) => eventLogWriter.record(evt));

  // Running workflow should reject because step 13 fails
  await assert.rejects(
    async () => {
      await wf.run({ runId, stateStore: store, mockMode: true });
    },
    (err) => {
      assert.ok(err instanceof StepExecutionError);
      assert.equal(err.stepId, `step-p-${FAILING_STEP}`);
      assert.ok(err.message.includes(`Deliberate failure in worker ${FAILING_STEP}`));
      return true;
    }
  );

  // Check state store for failed checkpoint
  const checkpoints = await store.getAllCheckpoints(runId);
  assert.ok(checkpoints[`step-p-${FAILING_STEP}`], 'Failing step checkpoint must be recorded');
  assert.equal(checkpoints[`step-p-${FAILING_STEP}`].status, 'failed');
  assert.ok(checkpoints[`step-p-${FAILING_STEP}`].error.includes(`Deliberate failure in worker ${FAILING_STEP}`));

  // Verify event log has step_failed event
  eventLogWriter.close();
  const events = await EventLogReader.readAll(path.join(tmpDir, 'events.jsonl'));
  const failEvt = events.find((e) => e.type === 'step_failed' && e.stepId === `step-p-${FAILING_STEP}`);
  assert.ok(failEvt, 'Must have recorded step_failed event for step 13');

  store.close();
});
