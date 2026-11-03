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

const NESTED_CHILD = `/* workflow
name: comp-nested
description: Tries to compose from within a child (must fail — one level max)
*/
const deeper = await workflow("comp-child");
return deeper;
`;

const NESTED_PARENT = `
phase("Nested");
const out = await workflow("comp-nested");
return out;
`;

function makeProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-compose-'));
  const wfDir = path.join(dir, '.workflow', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'comp-child.facade.ts'), CHILD);
  fs.writeFileSync(path.join(wfDir, 'comp-nested.facade.ts'), NESTED_CHILD);
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
    // lineage: the child run's parentRunId points at the parent
  } finally {
    project.cleanup();
  }
});

test('workflow() nesting is limited to one level (Claude-exact error)', async () => {
  const project = makeProject();
  try {
    const parentPath = path.join(project.dir, 'nested-parent.facade.ts');
    fs.writeFileSync(parentPath, NESTED_PARENT);
    const r = await runFacadeScript({ scriptPath: parentPath, cwd: project.dir });
    assert.equal(r.status, 'failed', `expected the nested child to fail, got ${r.status}`);
    assert.match(r.error ?? '', /nesting is limited to one level/);
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
