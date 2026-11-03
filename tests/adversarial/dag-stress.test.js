import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, defineWorkflow } from '../../dist/src/core/workflow.js';
import { actionStep } from '../../dist/src/core/step.js';
import { CircularDependencyError, MissingDependencyError } from '../../dist/src/core/error.js';

test('DAG Stress: 50-level nested diamond dependency graph completes validation and execution in topological order', async () => {
  const wf = new Workflow({ name: 'Diamond50Workflow' });
  wf.addPhase({ id: 'phase-diamond', name: '50-Level Diamond Phase' });

  const executionOrder = [];

  // Root node
  wf.addStep(
    actionStep({
      id: 'diamond-L0',
      name: 'Diamond Level 0 Root',
      phaseId: 'phase-diamond',
      action: async () => {
        executionOrder.push('diamond-L0');
        return { level: 0 };
      },
    })
  );

  let prevJoinId = 'diamond-L0';
  const NUM_LEVELS = 50;

  for (let i = 1; i <= NUM_LEVELS; i++) {
    const leftId = `diamond-L${i}-left`;
    const rightId = `diamond-L${i}-right`;
    const joinId = `diamond-L${i}-join`;
    const expectedPrev = prevJoinId;

    wf.addStep(
      actionStep({
        id: leftId,
        name: `Diamond Level ${i} Left`,
        phaseId: 'phase-diamond',
        dependsOn: [expectedPrev],
        action: async (input, ctx) => {
          assert.ok(ctx.getOutput(expectedPrev), `Dependency ${expectedPrev} must be completed before ${leftId}`);
          executionOrder.push(leftId);
          return { level: i, branch: 'left' };
        },
      })
    );

    wf.addStep(
      actionStep({
        id: rightId,
        name: `Diamond Level ${i} Right`,
        phaseId: 'phase-diamond',
        dependsOn: [expectedPrev],
        action: async (input, ctx) => {
          assert.ok(ctx.getOutput(expectedPrev), `Dependency ${expectedPrev} must be completed before ${rightId}`);
          executionOrder.push(rightId);
          return { level: i, branch: 'right' };
        },
      })
    );

    wf.addStep(
      actionStep({
        id: joinId,
        name: `Diamond Level ${i} Join`,
        phaseId: 'phase-diamond',
        dependsOn: [leftId, rightId],
        action: async (input, ctx) => {
          assert.ok(ctx.getOutput(leftId), `Dependency ${leftId} must be completed before ${joinId}`);
          assert.ok(ctx.getOutput(rightId), `Dependency ${rightId} must be completed before ${joinId}`);
          executionOrder.push(joinId);
          return { level: i, joined: true };
        },
      })
    );

    prevJoinId = joinId;
  }

  // 1 root + 50 * 3 = 151 steps
  assert.equal(wf.getAllSteps().length, 151);

  // Validate graph
  const validateStart = Date.now();
  assert.doesNotThrow(() => wf.validate());
  const validateDuration = Date.now() - validateStart;
  assert.ok(validateDuration < 100, `Graph validation should be fast (took ${validateDuration}ms)`);

  // Run graph
  const runStart = Date.now();
  const { status, context } = await wf.run({ mockMode: true });
  const runDuration = Date.now() - runStart;

  assert.equal(status, 'completed');
  assert.equal(executionOrder.length, 151);
  assert.equal(executionOrder[0], 'diamond-L0');
  assert.equal(executionOrder[executionOrder.length - 1], `diamond-L${NUM_LEVELS}-join`);
  assert.deepEqual(context.getOutput(`diamond-L${NUM_LEVELS}-join`), { level: 50, joined: true });
});

test('DAG Stress: 200-level deep diamond dependency graph (601 steps) validates without stack overflow', () => {
  const wf = new Workflow({ name: 'Diamond200Validation' });
  wf.addPhase({ id: 'p1', name: 'P1' });

  wf.addStep(
    actionStep({
      id: 'root',
      name: 'Root',
      phaseId: 'p1',
      action: async () => ({ ok: true }),
    })
  );

  let prevJoin = 'root';
  for (let i = 1; i <= 200; i++) {
    const left = `d-L${i}-left`;
    const right = `d-L${i}-right`;
    const join = `d-L${i}-join`;

    wf.addStep(actionStep({ id: left, name: left, phaseId: 'p1', dependsOn: [prevJoin], action: async () => ({}) }));
    wf.addStep(actionStep({ id: right, name: right, phaseId: 'p1', dependsOn: [prevJoin], action: async () => ({}) }));
    wf.addStep(actionStep({ id: join, name: join, phaseId: 'p1', dependsOn: [left, right], action: async () => ({}) }));

    prevJoin = join;
  }

  assert.equal(wf.getAllSteps().length, 601);

  const start = Date.now();
  assert.doesNotThrow(() => wf.validate());
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `200-level diamond validation should finish in <200ms (took ${elapsed}ms)`);
});

test('DAG Stress: Wide fan-out (1 root -> 100 parallel workers -> 1 aggregator)', async () => {
  const wf = new Workflow({ name: 'WideFanoutWorkflow' });
  wf.addPhase({ id: 'fanout-phase', name: 'Fanout Phase' });

  wf.addStep(
    actionStep({
      id: 'root-producer',
      name: 'Root Producer',
      phaseId: 'fanout-phase',
      action: async () => ({ baseMultiplier: 2 }),
    })
  );

  const workerIds = [];
  for (let i = 1; i <= 100; i++) {
    const workerId = `worker-${String(i).padStart(3, '0')}`;
    workerIds.push(workerId);
    wf.addStep(
      actionStep({
        id: workerId,
        name: `Worker ${i}`,
        phaseId: 'fanout-phase',
        dependsOn: ['root-producer'],
        action: async (input, ctx) => {
          const root = ctx.getOutput('root-producer');
          return { workerIndex: i, result: i * root.baseMultiplier };
        },
      })
    );
  }

  wf.addStep(
    actionStep({
      id: 'aggregator',
      name: 'Aggregator',
      phaseId: 'fanout-phase',
      dependsOn: workerIds,
      action: async (input, ctx) => {
        let totalSum = 0;
        for (const wid of workerIds) {
          const out = ctx.getOutput(wid);
          assert.ok(out, `Output for ${wid} must exist`);
          totalSum += out.result;
        }
        return { totalSum, workerCount: workerIds.length };
      },
    })
  );

  assert.equal(wf.getAllSteps().length, 102);

  const { status, context } = await wf.run({ mockMode: true });
  assert.equal(status, 'completed');

  // Sum of 2 * (1 + 2 + ... + 100) = 2 * (100 * 101 / 2) = 10100
  const aggOutput = context.getOutput('aggregator');
  assert.equal(aggOutput.workerCount, 100);
  assert.equal(aggOutput.totalSum, 10100);
});

test('DAG Stress: 10x10 Grid Lattice DAG with multi-path convergence', async () => {
  const wf = new Workflow({ name: 'LatticeGridWorkflow' });
  wf.addPhase({ id: 'grid-phase', name: 'Grid Phase' });

  // 10x10 lattice where node(r, c) depends on node(r-1, c) and node(r, c-1)
  const ROWS = 10;
  const COLS = 10;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = `node_${r}_${c}`;
      const deps = [];
      if (r > 0) deps.push(`node_${r - 1}_${c}`);
      if (c > 0) deps.push(`node_${r}_${c - 1}`);

      wf.addStep(
        actionStep({
          id,
          name: id,
          phaseId: 'grid-phase',
          dependsOn: deps,
          action: async (input, ctx) => {
            let sum = 1;
            if (r > 0) sum += ctx.getOutput(`node_${r - 1}_${c}`).val;
            if (c > 0) sum += ctx.getOutput(`node_${r}_${c - 1}`).val;
            return { r, c, val: sum };
          },
        })
      );
    }
  }

  assert.equal(wf.getAllSteps().length, 100);
  assert.doesNotThrow(() => wf.validate());

  const { status, context } = await wf.run({ mockMode: true });
  assert.equal(status, 'completed');
  const finalNode = context.getOutput(`node_${ROWS - 1}_${COLS - 1}`);
  assert.ok(finalNode.val > 0);
});

test('DAG Stress: Deliberate Direct Self-Loop (A -> A) throws CircularDependencyError', () => {
  const wf = new Workflow({ name: 'SelfLoopWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'step-A',
      name: 'Step A',
      phaseId: 'p1',
      dependsOn: ['step-A'],
      action: async () => ({}),
    })
  );

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError, 'Must be instance of CircularDependencyError');
      assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
      assert.deepEqual(err.cycle, ['step-A']);
      assert.ok(err.message.includes('Circular dependency detected'));
      return true;
    }
  );
});

test('DAG Stress: Deliberate 2-Node Immediate Cycle (A -> B -> A) throws CircularDependencyError', () => {
  const wf = new Workflow({ name: 'TwoNodeCycleWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'step-A',
      name: 'Step A',
      phaseId: 'p1',
      dependsOn: ['step-B'],
      action: async () => ({}),
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-B',
      name: 'Step B',
      phaseId: 'p1',
      dependsOn: ['step-A'],
      action: async () => ({}),
    })
  );

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
      assert.ok(err.cycle.includes('step-A'));
      assert.ok(err.cycle.includes('step-B'));
      return true;
    }
  );
});

test('DAG Stress: Deliberate 3-Node Cycle (A -> B -> C -> A) throws CircularDependencyError', () => {
  const wf = new Workflow({ name: 'ThreeNodeCycleWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  wf.addStep(
    actionStep({
      id: 'step-A',
      name: 'Step A',
      phaseId: 'p1',
      dependsOn: ['step-C'],
      action: async () => ({}),
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-B',
      name: 'Step B',
      phaseId: 'p1',
      dependsOn: ['step-A'],
      action: async () => ({}),
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-C',
      name: 'Step C',
      phaseId: 'p1',
      dependsOn: ['step-B'],
      action: async () => ({}),
    })
  );

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
      assert.equal(err.cycle.length, 3);
      assert.ok(err.cycle.includes('step-A'));
      assert.ok(err.cycle.includes('step-B'));
      assert.ok(err.cycle.includes('step-C'));
      return true;
    }
  );
});

test('DAG Stress: 100-Node Large Circular Chain terminates cleanly without stack overflow or infinite loop', () => {
  const wf = new Workflow({ name: 'LargeCycle100Workflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });

  const COUNT = 100;
  for (let i = 0; i < COUNT; i++) {
    const currentId = `node-${i}`;
    const prevId = `node-${(i - 1 + COUNT) % COUNT}`; // 0 depends on 99, 1 depends on 0, etc.
    wf.addStep(
      actionStep({
        id: currentId,
        name: currentId,
        phaseId: 'p1',
        dependsOn: [prevId],
        action: async () => ({}),
      })
    );
  }

  assert.equal(wf.getAllSteps().length, COUNT);

  const start = Date.now();
  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
      assert.equal(err.cycle.length, COUNT);
      return true;
    }
  );
  const duration = Date.now() - start;
  assert.ok(duration < 100, `Cycle detection on 100 nodes should be fast (took ${duration}ms)`);
});

test('DAG Stress: Cycle embedded deep within a 50-level diamond graph is detected and isolated', () => {
  const wf = new Workflow({ name: 'EmbeddedCycleDiamond' });
  wf.addPhase({ id: 'p1', name: 'P1' });

  wf.addStep(actionStep({ id: 'root', name: 'Root', phaseId: 'p1', action: async () => ({}) }));

  let prevJoin = 'root';
  for (let i = 1; i <= 50; i++) {
    const left = `d-L${i}-left`;
    const right = `d-L${i}-right`;
    const join = `d-L${i}-join`;

    // Deliberate cyclic back-edge from L35-join back to L15-left
    const leftDeps = [prevJoin];
    if (i === 15) {
      leftDeps.push('d-L35-join');
    }

    wf.addStep(actionStep({ id: left, name: left, phaseId: 'p1', dependsOn: leftDeps, action: async () => ({}) }));
    wf.addStep(actionStep({ id: right, name: right, phaseId: 'p1', dependsOn: [prevJoin], action: async () => ({}) }));
    wf.addStep(actionStep({ id: join, name: join, phaseId: 'p1', dependsOn: [left, right], action: async () => ({}) }));

    prevJoin = join;
  }

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
      // Root and nodes prior to L15 should NOT be in the cycle
      assert.ok(!err.cycle.includes('root'), 'Root is before cycle and should not be in cycle');
      assert.ok(!err.cycle.includes('d-L1-left'), 'L1 is before cycle and should not be in cycle');
      // Nodes between L15 and L35 should be in the cycle
      assert.ok(err.cycle.includes('d-L15-left'));
      assert.ok(err.cycle.includes('d-L35-join'));
      return true;
    }
  );
});

test('DAG Stress: Disjoint multiple cycles alongside valid DAG subcomponents', () => {
  const wf = new Workflow({ name: 'DisjointCyclesWorkflow' });
  wf.addPhase({ id: 'p1', name: 'P1' });

  // Valid DAG path: V1 -> V2 -> V3
  wf.addStep(actionStep({ id: 'v1', name: 'V1', phaseId: 'p1', action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'v2', name: 'V2', phaseId: 'p1', dependsOn: ['v1'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'v3', name: 'V3', phaseId: 'p1', dependsOn: ['v2'], action: async () => ({}) }));

  // Cycle 1: c1_a -> c1_b -> c1_a
  wf.addStep(actionStep({ id: 'c1_a', name: 'C1_A', phaseId: 'p1', dependsOn: ['c1_b'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'c1_b', name: 'C1_B', phaseId: 'p1', dependsOn: ['c1_a'], action: async () => ({}) }));

  // Cycle 2: c2_a -> c2_b -> c2_c -> c2_a
  wf.addStep(actionStep({ id: 'c2_a', name: 'C2_A', phaseId: 'p1', dependsOn: ['c2_c'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'c2_b', name: 'C2_B', phaseId: 'p1', dependsOn: ['c2_a'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'c2_c', name: 'C2_C', phaseId: 'p1', dependsOn: ['c2_b'], action: async () => ({}) }));

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      // Valid nodes must not be listed in cycle
      assert.ok(!err.cycle.includes('v1'));
      assert.ok(!err.cycle.includes('v2'));
      assert.ok(!err.cycle.includes('v3'));
      // All cyclic nodes must be identified
      assert.ok(err.cycle.includes('c1_a'));
      assert.ok(err.cycle.includes('c1_b'));
      assert.ok(err.cycle.includes('c2_a'));
      assert.ok(err.cycle.includes('c2_b'));
      assert.ok(err.cycle.includes('c2_c'));
      return true;
    }
  );
});

test('DAG Stress: Diamond with mutual cross-dependency between parallel branches', () => {
  const wf = new Workflow({ name: 'MutualCrossDependency' });
  wf.addPhase({ id: 'p1', name: 'P1' });

  wf.addStep(actionStep({ id: 'root', name: 'Root', phaseId: 'p1', action: async () => ({}) }));
  // Left branch depends on Right branch, and Right branch depends on Left branch
  wf.addStep(actionStep({ id: 'branch-left', name: 'Left', phaseId: 'p1', dependsOn: ['root', 'branch-right'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'branch-right', name: 'Right', phaseId: 'p1', dependsOn: ['root', 'branch-left'], action: async () => ({}) }));
  wf.addStep(actionStep({ id: 'join', name: 'Join', phaseId: 'p1', dependsOn: ['branch-left', 'branch-right'], action: async () => ({}) }));

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof CircularDependencyError);
      assert.ok(err.cycle.includes('branch-left'));
      assert.ok(err.cycle.includes('branch-right'));
      assert.ok(!err.cycle.includes('root'));
      return true;
    }
  );
});

test('DAG Stress: Missing dependency reference throws MissingDependencyError before cyclic detection', () => {
  const wf = new Workflow({ name: 'MissingDepWorkflow' });
  wf.addPhase({ id: 'p1', name: 'P1' });

  wf.addStep(
    actionStep({
      id: 'step-1',
      name: 'Step 1',
      phaseId: 'p1',
      dependsOn: ['ghost-step-404'],
      action: async () => ({}),
    })
  );

  assert.throws(
    () => wf.validate(),
    (err) => {
      assert.ok(err instanceof MissingDependencyError);
      assert.equal(err.code, 'MISSING_DEPENDENCY');
      assert.ok(err.message.includes('ghost-step-404'));
      return true;
    }
  );
});
