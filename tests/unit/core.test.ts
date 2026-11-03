import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, computeStepCheckpointHash } from '../../src/core/workflow.js';
import { actionStep, gateStep } from '../../src/core/step.js';
import { StepExecutionError, CircularDependencyError } from '../../src/core/error.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';

test('Core Workflow: executes single step workflow to completion', async () => {
  const wf = new Workflow({ name: 'SingleStepWorkflow' });
  wf.addPhase({ id: 'phase-1', name: 'Phase One' });
  wf.addStep(
    actionStep({
      id: 'step-1',
      name: 'Step One',
      phaseId: 'phase-1',
      action: async (_input, ctx) => {
        ctx.set('executed', true);
        return { ok: true };
      },
    })
  );

  const { status, context } = await wf.run();
  assert.equal(status, 'completed');
  assert.equal(context.get('executed'), true);
  assert.deepEqual(context.getOutput('step-1'), { ok: true });
});

test('Core Workflow: topologically sorts and executes multi-step linear dependency chain', async () => {
  const executionOrder: string[] = [];
  const wf = new Workflow({ name: 'LinearDependencyWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'step-A',
      name: 'Step A',
      phaseId: 'p1',
      action: async () => {
        executionOrder.push('A');
        return { valueA: 10 };
      },
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-B',
      name: 'Step B',
      phaseId: 'p1',
      dependsOn: ['step-A'],
      action: async (input: any) => {
        executionOrder.push('B');
        return { valueB: input.valueA + 20 };
      },
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-C',
      name: 'Step C',
      phaseId: 'p1',
      dependsOn: ['step-B'],
      action: async (input: any) => {
        executionOrder.push('C');
        return { valueC: input.valueB * 2 };
      },
    })
  );

  const { status, context } = await wf.run();
  assert.equal(status, 'completed');
  assert.deepEqual(executionOrder, ['A', 'B', 'C']);
  assert.deepEqual(context.getOutput('step-C'), { valueC: 60 });
});

test('Core Workflow: executes parallel independent steps concurrently via Promise.all', async () => {
  const wf = new Workflow({ name: 'ParallelWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Parallel Phase' });

  // Concurrency is asserted by execution-window overlap, not by a wall-clock total:
  // under Promise.all the second step must START before the first one FINISHES. A
  // hard elapsed-time threshold (<120ms) flakes on a loaded box (timer delay + CI
  // contention pushed 50ms sleeps past it), while overlap holds under load and still
  // fails if the engine ever degrades to sequential execution (no overlap then).
  const windows: Array<{ id: string; start: number; end: number }> = [];
  const trackedStep = (id: string, name: string, result: Record<string, boolean>) =>
    actionStep({
      id,
      name,
      phaseId: 'p1',
      action: async () => {
        const start = Date.now();
        await new Promise((res) => setTimeout(res, 80));
        windows.push({ id, start, end: Date.now() });
        return result;
      },
    });

  wf.addStep(trackedStep('step-p1', 'Parallel 1', { p1: true }));
  wf.addStep(trackedStep('step-p2', 'Parallel 2', { p2: true }));

  const { status, context } = await wf.run();

  assert.equal(status, 'completed');
  assert.deepEqual(context.getOutput('step-p1'), { p1: true });
  assert.deepEqual(context.getOutput('step-p2'), { p2: true });
  assert.equal(windows.length, 2, 'both steps ran');
  const overlap = windows.some((a) => windows.some((b) => b !== a && b.start < a.end && a.start < b.end));
  assert.ok(overlap, `step execution windows must overlap under Promise.all (got: ${JSON.stringify(windows)})`);
});

test('Core Workflow: halts workflow on step failure', async () => {
  const wf = new Workflow({ name: 'FailingWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'fail-step',
      name: 'Failing Step',
      phaseId: 'p1',
      action: async () => {
        throw new Error('Fatal step failure');
      },
    })
  );

  wf.addStep(
    actionStep({
      id: 'downstream-step',
      name: 'Downstream Step',
      phaseId: 'p1',
      dependsOn: ['fail-step'],
      action: async () => {
        return { reached: true };
      },
    })
  );

  await assert.rejects(
    async () => {
      await wf.run();
    },
    (err: any) => {
      assert.ok(err instanceof StepExecutionError);
      assert.equal(err.stepId, 'fail-step');
      return true;
    }
  );
});

test('Core Workflow: detects circular dependency and throws CircularDependencyError', () => {
  const wf = new Workflow({ name: 'CycleWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'node-A',
      name: 'Node A',
      phaseId: 'p1',
      dependsOn: ['node-B'],
      action: async () => {},
    })
  );

  wf.addStep(
    actionStep({
      id: 'node-B',
      name: 'Node B',
      phaseId: 'p1',
      dependsOn: ['node-A'],
      action: async () => {},
    })
  );

  assert.throws(
    () => {
      wf.validate();
    },
    (err: any) => {
      assert.ok(err instanceof CircularDependencyError);
      return true;
    }
  );
});

test('Core Workflow: deterministic shell gate passes when command exits 0', async () => {
  const wf = new Workflow({ name: 'GateWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    gateStep({
      id: 'gate-pass',
      name: 'Passing Gate',
      phaseId: 'p1',
      command: 'node -e "process.exit(0)"',
    })
  );

  const { status, context } = await wf.run();
  assert.equal(status, 'completed');
  const gateOut: any = context.getOutput('gate-pass');
  assert.equal(gateOut.success, true);
  assert.equal(gateOut.exitCode, 0);
});

test('Core Workflow: deterministic shell gate captures non-zero exit code and stderr', async () => {
  const wf = new Workflow({ name: 'GateFailWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    gateStep({
      id: 'gate-fail',
      name: 'Failing Gate',
      phaseId: 'p1',
      command: 'node -e "console.error(\\\"boom\\\"); process.exit(42)"',
    })
  );

  await assert.rejects(
    async () => {
      await wf.run();
    },
    (err: any) => {
      assert.ok(err instanceof StepExecutionError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Checkpoint replay binding (audit medium fix): a checkpoint is only served
// when the producing (step definition, input) pair hashes to the recorded
// inputHash — a stale or legacy checkpoint re-executes, fail-safe.
// ---------------------------------------------------------------------------

test('Core Workflow: checkpoint hash is canonical (key-order insensitive) and sensitive to definition and input changes', async () => {
  const step = actionStep({
    id: 'step-1',
    name: 'Step One',
    phaseId: 'p1',
    action: async () => ({ ok: true }),
  });
  const base = computeStepCheckpointHash(step, { a: 1, b: 2 });

  // Canonical serialization: object key ORDER carries no meaning…
  assert.equal(computeStepCheckpointHash(step, { b: 2, a: 1 }), base, 'key order must not change the hash');
  // …but the VALUE does, and so does every bound definition field.
  assert.notEqual(computeStepCheckpointHash(step, { a: 1, b: 3 }), base, 'a changed input must change the hash');
  assert.notEqual(computeStepCheckpointHash({ ...step, name: 'Renamed' }, { a: 1, b: 2 }), base, 'a renamed step must change the hash');
  assert.notEqual(computeStepCheckpointHash({ ...step, timeoutMs: 5 }, { a: 1, b: 2 }), base, 'a changed timeout must change the hash');
  assert.notEqual(computeStepCheckpointHash({ ...step, dependsOn: ['other'] }, { a: 1, b: 2 }), base, 'changed dependencies must change the hash');

  // Dependency ORDER is not semantics — the same set hashes identically.
  assert.equal(
    computeStepCheckpointHash({ ...step, dependsOn: ['a', 'b'] }, undefined),
    computeStepCheckpointHash({ ...step, dependsOn: ['b', 'a'] }, undefined),
  );
});

test('Core Workflow: unchanged steps replay from the checkpoint; edited definitions and legacy rows re-execute fail-safe', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    let executions = 0;
    const skipped: unknown[] = [];
    const mkWf = (name: string): Workflow => {
      const wf = new Workflow({ name: 'CkptBindingWorkflow' });
      wf.addPhase({ id: 'p1', name: 'Phase One' });
      wf.addStep(
        actionStep({
          id: 'step-1',
          name,
          phaseId: 'p1',
          action: async () => {
            executions++;
            return { n: executions };
          },
        })
      );
      wf.on('step_skipped', (e) => skipped.push(e));
      return wf;
    };

    const run1 = await mkWf('Step One').run({ runId: 'ckpt-run', stateStore: store });
    assert.equal(run1.status, 'completed');
    assert.equal(executions, 1);
    assert.equal(skipped.length, 0);

    // Completely unchanged: the short-circuit hits, zero duplicate execution.
    const run2 = await mkWf('Step One').run({ runId: 'ckpt-run', stateStore: store });
    assert.equal(run2.status, 'completed');
    assert.equal(executions, 1, 'an unchanged (definition, input) pair must replay, not re-execute');
    assert.equal(skipped.length, 1, 'the replay is announced as step_skipped');

    // Legacy row without a recorded hash: unverifiable → re-execute (no crash).
    const cached = await store.getCheckpoint('ckpt-run', 'step-1');
    assert.ok(cached?.inputHash, 'the fresh checkpoint must carry the binding hash');
    await store.saveCheckpoint('ckpt-run', { ...cached, inputHash: undefined });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...msg: unknown[]) => {
      warnings.push(msg.map(String).join(' '));
    };
    try {
      const run3 = await mkWf('Step One').run({ runId: 'ckpt-run', stateStore: store });
      assert.equal(run3.status, 'completed');
      assert.equal(executions, 2, 'a legacy checkpoint without a hash must re-execute (fail-safe)');
      assert.ok(warnings.some((w) => w.includes('no inputHash (legacy row)')), 'the legacy miss must be logged');

      // Edited step definition (name): the hash mismatches → real re-execution.
      const run4 = await mkWf('Step One EDITED').run({ runId: 'ckpt-run', stateStore: store });
      assert.equal(run4.status, 'completed');
      assert.equal(executions, 3, 'an edited step definition must NOT be served from the old checkpoint');
      assert.ok(warnings.some((w) => w.includes('inputHash mismatch')), 'the mismatch must be logged');
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    store.close();
  }
});

test('Core Workflow: a changed dependency output changes the input and forces the dependent step to re-execute', async () => {
  const store = new SQLiteStateStore(':memory:');
  try {
    let depExec = 0;
    let consumerExec = 0;
    const mkWf = (): Workflow => {
      const wf = new Workflow({ name: 'InputBindingWorkflow' });
      wf.addPhase({ id: 'p1', name: 'Phase One' });
      wf.addStep(
        actionStep({
          id: 'dep',
          name: 'Dep',
          phaseId: 'p1',
          action: async () => {
            depExec++;
            return { v: 1 };
          },
        })
      );
      wf.addStep(
        actionStep({
          id: 'consumer',
          name: 'Consumer',
          phaseId: 'p1',
          dependsOn: ['dep'],
          action: async (input) => {
            consumerExec++;
            return { got: (input as { v: number }).v };
          },
        })
      );
      return wf;
    };

    const run1 = await mkWf().run({ runId: 'input-run', stateStore: store });
    assert.equal(run1.status, 'completed');
    assert.equal(depExec, 1);
    assert.equal(consumerExec, 1);

    // Simulate an upstream world change: the dep's recorded OUTPUT changes
    // while its own (definition, input) binding stays valid — the dep replays,
    // the consumer's input differs, and the input-bound hash forces a real
    // re-execution with the new value.
    const depCkpt = await store.getCheckpoint('input-run', 'dep');
    assert.ok(depCkpt);
    await store.saveCheckpoint('input-run', { ...depCkpt, output: { v: 2 } });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...msg: unknown[]) => {
      warnings.push(msg.map(String).join(' '));
    };
    try {
      const run2 = await mkWf().run({ runId: 'input-run', stateStore: store });
      assert.equal(run2.status, 'completed');
      assert.equal(depExec, 1, 'the dep binding still holds — it replays');
      assert.equal(consumerExec, 2, 'the consumer re-executes: its input changed');
      assert.deepEqual(run2.context.getOutput('consumer'), { got: 2 }, 'the re-execution sees the changed input');
      assert.ok(warnings.some((w) => w.includes('inputHash mismatch')));
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    store.close();
  }
});
