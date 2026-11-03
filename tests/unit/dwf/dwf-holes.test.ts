import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';

const CLEAN = `
phase("Survey");
const survey = await agent("inspector").ask<Survey>("inspect the service");
const decision = await hole<Decision>("decide-remediation", \`survey: \${JSON.stringify(survey)}\`);
return { survey, decision };

interface Survey { healthStatus: string; }
interface Decision { action: string; }
`;

test('hole sites carry name, type-arg presence and stable site ids', () => {
  const r = analyzeFacadeScript(CLEAN);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const hole = r.sites.find((s) => s.kind === 'hole');
  assert.ok(hole);
  assert.equal(hole!.holeName, 'decide-remediation');
  assert.equal(hole!.typed, true);
  // hole participates in the site sequence between its neighbours
  const kinds = r.sites.map((s) => s.kind);
  assert.deepEqual(kinds, ['phase', 'ask', 'actor', 'hole']);
});

test('hole rules: literal name, unique among holes and phases, explicit type arg', () => {
  const r1 = analyzeFacadeScript('const x = await hole<Decision>(String(args.n));\nreturn x;\ninterface Decision { a: string; }');
  assert.ok(r1.diagnostics.some((d) => d.code === 9003), 'non-literal name must be a literal-rule diagnostic');

  const r2 = analyzeFacadeScript(`
const a = await hole<D>("same");
const b = await hole<D>("same");
return a;
interface D { x: string; }
`);
  assert.ok(r2.diagnostics.some((d) => d.code === 9013), 'duplicate hole name must fail');

  const r3 = analyzeFacadeScript(`
phase("same");
const a = await hole<D>("same");
return a;
interface D { x: string; }
`);
  assert.ok(r3.diagnostics.some((d) => d.code === 9013), 'hole name colliding with a phase must fail');

  const r4 = analyzeFacadeScript('const a = await hole("no-type");\nreturn a;');
  assert.ok(r4.diagnostics.some((d) => d.code === 9010), 'missing type argument must fail');
});

test('hole inside a fan-out callback is diagnostic 9012', () => {
  const r = analyzeFacadeScript(`
const items = ["a", "b"];
const out = items.map(async (i) => {
  const v = await hole<D>("inner-" + i);
  return v;
});
return out;
interface D { x: string; }
`);
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === 9012), JSON.stringify(r.diagnostics));
});

test('a hole outside fan-outs in plain control flow is allowed', () => {
  const r = analyzeFacadeScript(`
for (const step of ["one"]) {
  log(step);
}
const a = await hole<D>("tail");
return a;
interface D { x: string; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});
