import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

const CHILD = `/* workflow
name: comp-child
description: Child workflow composed by a parent
*/
phase("Child work");
const reading = await agent("child-scout").ask<Answer>("inspect health report of the service");
return { childSaw: reading.healthStatus };
interface Answer { healthStatus: string; }
`;

const PARENT = `
phase("Parent");
const child = await workflow("comp-child");
return { fromChild: child };
`;

const GRANDCHILD = `/* workflow
name: comp-grandchild
description: Third level of the composition probe
*/
// Issue #62: the depth-3 leaf carries a provider ask so a nested resume has
// something to re-bill when the lineage import fails at depth >= 2.
const reading = await agent("inspector").ask<Answer>("inspect health report of service A");
return { level: "grandchild", value: 3, survey: reading.healthStatus };
interface Answer { healthStatus: string; }
`;

const MIDDLE = `/* workflow
name: comp-middle
description: Second level of the composition probe
*/
const grandchild = await workflow("comp-grandchild");
return { level: "middle", child: grandchild };
`;

const THREE_LEVEL_ROOT = `
phase("Root");
const middle = await workflow("comp-middle");
return { level: "root", child: middle };
`;

const CYCLE_A = `/* workflow
name: comp-cycle-a
description: Cycle probe A
*/
const b = await workflow("comp-cycle-b");
return b;
`;

const CYCLE_B = `/* workflow
name: comp-cycle-b
description: Cycle probe B
*/
const a = await workflow("comp-cycle-a");
return a;
`;

const CYCLE_ROOT = `
const out = await workflow("comp-cycle-a");
return out;
`;

function depthWorkflow(level: number): string {
  const body = level < 6 ? `const next = await workflow("comp-depth-${level + 1}");\nreturn next;` : 'return { level: 6 };';
  return `/* workflow
name: comp-depth-${level}
description: Depth probe level ${level}
*/
${body}
`;
}

function makeProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-compose-'));
  const wfDir = path.join(dir, '.workflow', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const files: Record<string, string> = {
    'comp-child.facade.ts': CHILD,
    'comp-grandchild.facade.ts': GRANDCHILD,
    'comp-middle.facade.ts': MIDDLE,
    'comp-cycle-a.facade.ts': CYCLE_A,
    'comp-cycle-b.facade.ts': CYCLE_B,
  };
  for (let level = 1; level <= 6; level += 1) files[`comp-depth-${level}.facade.ts`] = depthWorkflow(level);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(wfDir, name), source);
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('workflow() composes a saved workflow as a child run (own runId, value returned)', async () => {
  const project = makeProject();
  try {
    const parentPath = path.join(project.dir, 'parent.facade.ts');
    fs.writeFileSync(parentPath, PARENT);
    const r = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, { fromChild: { childSaw: 'HEALTHY' } });
  } finally {
    project.cleanup();
  }
});

test('workflow() composes three levels and threads the value back up', async () => {
  const project = makeProject();
  try {
    const rootPath = path.join(project.dir, 'three-level.facade.ts');
    fs.writeFileSync(rootPath, THREE_LEVEL_ROOT);
    const r = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, {
      level: 'root',
      child: { level: 'middle', child: { level: 'grandchild', value: 3, survey: 'HEALTHY' } },
    });
  } finally {
    project.cleanup();
  }
});

test('workflow() rejects a composition cycle and names the full chain', async () => {
  const project = makeProject();
  try {
    const rootPath = path.join(project.dir, 'cycle.facade.ts');
    fs.writeFileSync(rootPath, CYCLE_ROOT);
    const r = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir });
    assert.equal(r.status, 'failed', `expected a cycle failure, got ${r.status}`);
    assert.match(r.error ?? '', /cycle detected/);
    assert.match(r.error ?? '', /comp-cycle-a -> comp-cycle-b -> comp-cycle-a/);
  } finally {
    project.cleanup();
  }
});

test('workflow() enforces the bounded nesting depth and names the full chain', async () => {
  const project = makeProject();
  try {
    const rootPath = path.join(project.dir, 'depth.facade.ts');
    fs.writeFileSync(rootPath, `
const out = await workflow("comp-depth-1");
return out;
`);
    const r = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir });
    assert.equal(r.status, 'failed', `expected a depth failure, got ${r.status}`);
    assert.match(r.error ?? '', /nesting depth limit reached \(5\)/);
    assert.match(
      r.error ?? '',
      /comp-depth-1 -> comp-depth-2 -> comp-depth-3 -> comp-depth-4 -> comp-depth-5 -> comp-depth-6/
    );
  } finally {
    project.cleanup();
  }
});

test('workflow() refuses unknown names with the registry listed', async () => {
  const project = makeProject();
  try {
    const parentPath = path.join(project.dir, 'unknown.facade.ts');
    fs.writeFileSync(parentPath, `
const out = await workflow("no-such-workflow");
return out;
`);
    const r = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir });
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /could not resolve "no-such-workflow"/);
    assert.match(r.error ?? '', /comp-child/, 'the error lists registered names');
  } finally {
    project.cleanup();
  }
});

test('composition re-entry replays the child subtree at zero provider calls (Issue #35)', async () => {
  const project = makeProject();
  try {
    const parentPath = path.join(project.dir, 'parent.facade.ts');
    fs.writeFileSync(parentPath, PARENT);
    const first = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir });
    assert.equal(first.status, 'completed', first.error);
    // The child executed live: its ask is rebroadcast into the parent's stats.
    assert.equal(first.stats.asks, 1);

    // Resuming the parent re-invokes workflow("comp-child") (the composition
    // op is a live host call, not a journalled parent node). The child run
    // imports its own prior journal — same parent lineage, same script hash —
    // and replays every node at zero provider calls (Issue #35).
    const second = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', second.error);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'the re-entered child must replay from its journal, not re-bill');
    // Imported-cache hits count as amend hits (engine semantics: the warm
    // entry came from a PRIOR run's journal, not this run's own stream).
    assert.ok(second.stats.amendHits >= 1, `expected imported-cache hits, got ${second.stats.amendHits}`);
  } finally {
    project.cleanup();
  }
});

test('an edited child workflow runs live — no stale replay across the composition boundary (Issue #35)', async () => {
  const project = makeProject();
  try {
    const parentPath = path.join(project.dir, 'parent.facade.ts');
    fs.writeFileSync(parentPath, PARENT);
    const first = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir });
    assert.equal(first.status, 'completed', first.error);

    // Editing the child script changes its sha256: the cache-import lookup
    // matches on the script hash and finds nothing — the child runs live
    // again (documented diverge behavior, mirroring the amend contract).
    const childPath = path.join(project.dir, '.workflow', 'workflows', 'comp-child.facade.ts');
    fs.writeFileSync(childPath, CHILD + '\n// edited: diverge probe\n');
    const second = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', second.error);
    assert.equal(second.stats.asks, 1, 'the edited child must run live, not replay the stale journal');
  } finally {
    project.cleanup();
  }
});

test('composition re-entry replays nested (depth >= 2) subtrees at zero provider calls (Issue #62)', async () => {
  const project = makeProject();
  try {
    const rootPath = path.join(project.dir, 'three-level.facade.ts');
    fs.writeFileSync(rootPath, THREE_LEVEL_ROOT);
    const first = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir });
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.stats.asks, 1, 'the depth-3 grandchild ask executes live on the fresh run');

    // Resuming the root re-enters workflow("comp-middle") — that re-entry
    // imports the prior middle journal (#35). The grandchild the middle then
    // re-invokes used to find NO prior run: its old parent is the PRIOR
    // middle run — a sibling of the new middle under the shared root, never
    // on the upward parentRunId chain — so the whole grandchild subtree
    // re-billed its ask on every resume (Issue #62). The recursive
    // correspondence imports it too.
    const second = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', second.error);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'the depth-3 grandchild must replay from its imported journal, not re-bill');
  } finally {
    project.cleanup();
  }
});

test('sibling composition call sites replay their OWN subtrees on resume — per-site isolation kept (Issues #62/#124)', async () => {
  const project = makeProject();
  try {
    const rootPath = path.join(project.dir, 'two-sites.facade.ts');
    fs.writeFileSync(rootPath, `
phase("Two sites");
const a = await workflow("comp-middle");
const b = await workflow("comp-middle");
return { a, b };
`);
    const first = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir });
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.stats.asks, 2, 'each call site runs its grandchild ask live');

    const second = await runFacadeScript({ scriptPath: rootPath, cwd: project.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', second.error);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'both call sites replay their own subtrees — no cross-import, nothing re-billed');
  } finally {
    project.cleanup();
  }
});
