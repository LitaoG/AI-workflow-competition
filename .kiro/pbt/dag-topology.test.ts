/**
 * (Issue #155): Kahn machinery invariants over
 * fc-generated DAGs. `Workflow.validate()` is the Kahn implementation
 * (src/core/workflow.ts): a dependency graph validates exactly when a
 * topological order exists, and every failure names its cause.
 *
 * Properties (pure test增量 — the implementation is untouched):
 *   A. an acyclic graph (edges point forward only) always validates;
 *   B. a mutual dependency pair is always a detected cycle, and the reported
 *      cyclic set consists of real node ids;
 *   C. a dependency on an unknown id always fails with MissingDependencyError.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fc from 'fast-check';

import { Workflow } from '../../dist/src/core/workflow.js';
import { actionStep } from '../../dist/src/core/step.js';
import { CircularDependencyError, MissingDependencyError } from '../../dist/src/core/error.js';

interface DagSpec {
  /** Edge list: [dependent, dependency] over node indexes, dependent > dependency. */
  edges: Array<[number, number]>;
  size: number;
}

const dagArb: fc.Arbitrary<DagSpec> = fc
  .nat({ max: 11 })
  .chain((size) =>
    fc.array(fc.tuple(fc.nat({ max: Math.max(size - 1, 0) }), fc.nat({ max: Math.max(size - 1, 0) })), { maxLength: 24 }).map((raw) => ({
      size,
      edges: raw
        .filter(([a, b]) => a !== b)
        .map(([a, b]) => (a > b ? ([a, b] as [number, number]) : ([b, a] as [number, number]))),
    })),
  )
  .filter((spec) => spec.size >= 1);

function buildWorkflow(spec: DagSpec, extraEdges: Array<[number, number]> = []): Workflow {
  const wf = new Workflow({ name: 'PbtDagWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase 1' });
  const deps = new Map<number, string[]>();
  for (const [dependent, dependency] of [...spec.edges, ...extraEdges]) {
    const list = deps.get(dependent) ?? [];
    list.push(`s${dependency}`);
    deps.set(dependent, list);
  }
  for (let i = 0; i < spec.size; i++) {
    wf.addStep(
      actionStep({
        id: `s${i}`,
        name: `step ${i}`,
        phaseId: 'p1',
        dependsOn: deps.get(i),
        action: async () => 'ok',
      }),
    );
  }
  return wf;
}

test('property: an acyclic DAG (forward edges only) always validates', () => {
  const prop = fc.property(dagArb, (spec) => {
    const wf = buildWorkflow(spec);
    wf.validate(); // must not throw
  });
  assert.equal(fc.assert(prop, { numRuns: 200 }), undefined);
});

test('property: a mutual dependency pair is always a detected cycle naming real node ids', () => {
  const prop = fc.property(
    dagArb.filter((spec) => spec.size >= 2),
    (spec) => {
      const wf = buildWorkflow(spec, [
        [0, spec.size - 1],
        [spec.size - 1, 0],
      ]);
      try {
        wf.validate();
        assert.fail('a mutual dependency pair must be rejected as a cycle');
      } catch (err) {
        assert.ok(err instanceof CircularDependencyError, `expected CircularDependencyError, got ${String(err)}`);
        const cyclic = (err as CircularDependencyError).cycle ?? [];
        assert.ok(cyclic.length > 0, 'the cycle report names the stuck nodes');
        for (const id of cyclic) {
          assert.match(id, /^s\d+$/, 'every reported cyclic id is a node of the graph');
        }
      }
    },
  );
  assert.equal(fc.assert(prop, { numRuns: 200 }), undefined);
});

test('property: a dependency on an unknown id always fails with MissingDependencyError', () => {
  const prop = fc.property(dagArb, fc.nat({ max: 5 }), (spec, ghostIndex) => {
    const wf = buildWorkflow(spec, [[0, spec.size + ghostIndex]] as Array<[number, number]>);
    assert.throws(
      () => wf.validate(),
      (err: unknown) => err instanceof MissingDependencyError,
      `the ghost dependency s${spec.size + ghostIndex} must be reported`,
    );
  });
  assert.equal(fc.assert(prop, { numRuns: 200 }), undefined);
});
