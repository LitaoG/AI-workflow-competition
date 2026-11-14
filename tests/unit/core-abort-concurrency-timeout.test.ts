import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow } from '../../src/core/workflow.js';
import type { StepDefinition } from '../../src/types.js';
import { actionStep, fanOutStep } from '../../src/core/step.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('Core Workflow: abort() reports status "aborted" (never "completed") and emits workflow_aborted', async () => {
  const wf = new Workflow({ name: 'AbortStatusWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  wf.addStep(
    actionStep({
      id: 'slow-1',
      name: 'Slow One',
      phaseId: 'p1',
      action: async () => {
        await delay(250);
        return { ok: true };
      },
    })
  );
  wf.addStep(
    actionStep({
      id: 'slow-2',
      name: 'Slow Two',
      phaseId: 'p1',
      action: async () => {
        await delay(250);
        return { ok: true };
      },
    })
  );

  let abortedEvent = false;
  wf.on('workflow_aborted' as never, () => {
    abortedEvent = true;
  });

  const timer = setTimeout(() => wf.abort('user requested'), 30);
  const { status } = await wf.run();
  clearTimeout(timer);

  assert.equal(status, 'aborted', 'an aborted run must report aborted, not completed');
  assert.ok(abortedEvent, 'workflow_aborted event must be emitted');
});

test('Core Workflow: abort() cancels in-flight steps through the active batch signal', async () => {
  const wf = new Workflow({ name: 'AbortInFlightWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  let sawAbort = false;
  wf.addStep(
    actionStep({
      id: 'in-flight',
      name: 'In Flight',
      phaseId: 'p1',
      action: async (_input, ctx) => {
        // Cooperate with cancellation: resolve as soon as the signal fires.
        return await new Promise<boolean>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve(true);
          });
        });
      },
    })
  );

  const timer = setTimeout(() => wf.abort('user requested'), 30);
  const { status } = await wf.run();
  clearTimeout(timer);

  assert.ok(sawAbort, 'the in-flight step must observe the abort through its context signal');
  assert.equal(status, 'aborted');
});

test('Core Workflow: maxConcurrency caps the batch (and stays parallel without one)', async () => {
  const track = () => {
    let concurrent = 0;
    let peak = 0;
    return {
      async run(): Promise<void> {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await delay(40);
        concurrent--;
      },
      get peak(): number {
        return peak;
      },
    };
  };

  // No cap: all ready steps launch at once (the pre-existing behavior).
  const uncapped = track();
  const wfA = new Workflow({ name: 'UncappedWorkflow' });
  wfA.addPhase({ id: 'p1', name: 'Phase 1' });
  for (let i = 1; i <= 4; i++) {
    wfA.addStep(actionStep({ id: `s${i}`, name: `S${i}`, phaseId: 'p1', action: uncapped.run }));
  }
  const a = await wfA.run();
  assert.equal(a.status, 'completed');
  assert.equal(uncapped.peak, 4, 'without maxConcurrency all ready steps run in parallel');

  // Cap 2: the pool may never exceed two in-flight steps.
  const capped = track();
  const wfB = new Workflow({ name: 'CappedWorkflow' });
  wfB.addPhase({ id: 'p1', name: 'Phase 1' });
  for (let i = 1; i <= 4; i++) {
    wfB.addStep(actionStep({ id: `s${i}`, name: `S${i}`, phaseId: 'p1', action: capped.run }));
  }
  const b = await wfB.run({ maxConcurrency: 2 });
  assert.equal(b.status, 'completed');
  assert.ok(capped.peak <= 2, `maxConcurrency 2 must cap in-flight steps (peak was ${capped.peak})`);
  assert.ok(capped.peak >= 2, 'the cap must still allow parallelism up to the limit');
});

test('Core Workflow: StepDefinition.timeoutMs fails a hanging step instead of hanging the run', async () => {
  const wf = new Workflow({ name: 'TimeoutWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  wf.addStep(
    actionStep({
      id: 'hangs',
      name: 'Hangs Forever',
      phaseId: 'p1',
      // Ignores ctx.signal on purpose: an uncooperative runner must still be
      // failed by the timeout race, not just signalled.
      action: async () => {
        await delay(5_000);
        return { ok: true };
      },
      timeoutMs: 80,
    })
  );

  const started = Date.now();
  await assert.rejects(
    () => wf.run(),
    (err: unknown) => err instanceof Error && err.message.includes('timeoutMs'),
    'the timeout must fail the step with a timeout error',
  );
  assert.ok(Date.now() - started < 2_000, 'the run must fail at the deadline, not wait out the hanging step');
});

test('Core Workflow: fanOutStep starts no new items after a worker failure', async () => {
  const started: number[] = [];
  const wf = new Workflow({ name: 'FanOutGhostWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  wf.addStep(
    fanOutStep<number, number>({
      id: 'fan',
      name: 'Fan',
      phaseId: 'p1',
      itemsProvider: () => [1, 2, 3, 4, 5],
      // concurrency 3 + first item fails: on the fixed build the pool is
      // bounded to the 3 already-pulled items ([1,2,3]); the pre-fix build
      // kept pulling and produced [1,2,3,4,5] — this test discriminates.
      concurrency: 3,
      worker: async (item) => {
        started.push(item);
        if (item === 1) throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 30));
        return item;
      },
    }) as StepDefinition
  );

  await assert.rejects(() => wf.run(), /boom/);
  assert.deepEqual(started, [1, 2, 3], 'items beyond the in-flight pool must never start (no ghost workers)');
});

test('Core Workflow: forward cross-phase dependency fails at validation, not mid-run deadlock', async () => {
  const wf = new Workflow({ name: 'CrossPhaseForwardWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  wf.addPhase({ id: 'p2', name: 'Phase 2' });
  wf.addStep(actionStep({ id: 'early', name: 'Early', phaseId: 'p1', dependsOn: ['late'], action: async () => ({ ok: true }) }));
  wf.addStep(actionStep({ id: 'late', name: 'Late', phaseId: 'p2', action: async () => ({ ok: true }) }));

  await assert.rejects(
    () => wf.run(),
    /LATER phase/,
    'a phase-1 step depending on a phase-2 step must fail fast at validation',
  );
});

test('Core Workflow: junk maxConcurrency values fall back to uncapped, not a zero-worker hang', async () => {
  const wf = new Workflow({ name: 'JunkCapWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  wf.addStep(actionStep({ id: 's1', name: 'S1', phaseId: 'p1', action: async () => ({ ok: true }) }));
  const a = await wf.run({ maxConcurrency: Number.NaN });
  assert.equal(a.status, 'completed', 'NaN cap must not livelock the phase loop');
  const wf2 = new Workflow({ name: 'ZeroCapWorkflow' });
  wf2.addPhase({ id: 'p1', name: 'Phase 1' });
  wf2.addStep(actionStep({ id: 's1', name: 'S1', phaseId: 'p1', action: async () => ({ ok: true }) }));
  const b = await wf2.run({ maxConcurrency: 0 });
  assert.equal(b.status, 'completed', 'zero cap must degrade to uncapped, not zero workers');
});
