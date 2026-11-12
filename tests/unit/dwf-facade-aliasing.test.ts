/**
 * 9001 facade siting (canonical pass1 minimal subset): a facade callable may only ever
 * appear as the direct callee of a call — aliasing, method extraction, destructuring,
 * argument passing and bind/call/apply reify the callable and desync the static site
 * table from the execution order the journal and replay are keyed on.
 *
 * Message text is the canonical FACADE_SITING wording, verbatim modulo the name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../src/dwf/compile.js';

const OFFICIAL_9001 = (name: string) =>
  `facade function '${name}' may only be called directly; taking a reference to it defeats site identity (journal and replay key off call sites)`;

function diag9001(source: string) {
  const r = analyzeFacadeScript(source);
  return { r, hit: r.diagnostics.find((d) => d.code === 9001) };
}

// ---- ① facade callable assigned to a variable ----

test('9001 ①: const f = agent (bare facade function alias)', () => {
  const { r, hit } = diag9001('const f = agent;\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
  assert.equal(hit!.category, 'facade-misuse');
  assert.equal(hit!.message, OFFICIAL_9001('agent'));
  assert.equal(hit!.line, 1);
});

test('9001 ①: const f = p.ask (method extraction from an actor)', () => {
  const { r, hit } = diag9001('const p = agent("planner");\nconst f = p.ask;\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
  assert.equal(hit!.message, OFFICIAL_9001('p.ask'));
});

test('9001 ①: namespace aliases (const f = files / const w = world)', () => {
  for (const [src, name] of [
    ['const f = files;\nreturn null;', 'files'],
    ['const w = world;\nreturn null;', 'world'],
  ] as Array<[string, string]>) {
    const { r, hit } = diag9001(src);
    assert.equal(r.ok, false, src);
    assert.ok(hit, `${src}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(hit!.message, OFFICIAL_9001(name));
  }
});

test('9001 ①: hole/escalate/workflow/phase aliases are flagged too', () => {
  for (const name of ['hole', 'escalate', 'workflow', 'phase']) {
    const { r, hit } = diag9001(`const f = ${name};\nreturn null;`);
    assert.equal(r.ok, false, name);
    assert.ok(hit, `${name}: ${JSON.stringify(r.diagnostics)}`);
  }
});

test('9001 ①: destructuring extraction const { ask } = p (canonical pass1 form)', () => {
  const { r, hit } = diag9001('const p = agent("planner");\nconst { ask } = p;\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
  assert.equal(hit!.message, OFFICIAL_9001('ask'));
});

// ---- ② facade callable passed as an argument ----

test('9001 ②: a facade callable passed as an argument', () => {
  const { r, hit } = diag9001('const take = (fn: () => unknown) => fn();\ntake(agent);\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
  assert.equal(hit!.message, OFFICIAL_9001('agent'));
});

test('9001 ②: an extracted facade method passed as an argument', () => {
  const { r, hit } = diag9001('const p = agent("planner");\nconst take = (fn: unknown) => fn;\ntake(p.ask);\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
  assert.equal(hit!.message, OFFICIAL_9001('p.ask'));
});

test('9001 ②: a facade callable handed where a thunk is expected', () => {
  const { r, hit } = diag9001('fanout.parallel([agent]);\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
});

// ---- ③ .bind / .call / .apply on a facade callable ----

test('9001 ③: .bind / .call / .apply on a facade callable', () => {
  const cases: Array<[string, string]> = [
    ['const bound = agent.bind(null);\nreturn null;', 'agent'],
    ['agent.call(null, "x");\nreturn null;', 'agent'],
    ['const p = agent("planner");\np.ask.apply(null, ["x"]);\nreturn null;', 'p.ask'],
    ['const p = agent("planner");\nconst g = p.ask.bind(p);\nreturn null;', 'p.ask'],
    ['const g = files.read.bind(files);\nreturn null;', 'files.read'],
  ];
  for (const [src, name] of cases) {
    const { r, hit } = diag9001(src);
    assert.equal(r.ok, false, src);
    assert.ok(hit, `${src}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(hit!.message, OFFICIAL_9001(name), src);
  }
});

// ---- fail-closed: a wrapped callee is refused (lowering only sites bare callees) ----

test('9001: a wrapped callee ((agent)("x")) is refused, not waved through', () => {
  const { r, hit } = diag9001('(agent)("x");\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(hit, JSON.stringify(r.diagnostics));
});

// ---- negative controls: legal call patterns must stay clean ----

test('9001 negative controls: legal facade call patterns stay clean', () => {
  const clean = [
    'const p = agent("planner");\nconst r = await p.ask<string>("hi");\nreturn r;',
    'phase("P");\nlog("m");\nreport({ a: 1 });\nreturn null;',
    'const t = budget.total;\nconst s = budget.spent();\nreturn { t, s };',
    'const p = agent("planner");\nawait sessions.waitAny([p.ask("a")]);\nreturn null;',
    'fanout.parallel([() => agent("a").ask("t")]);\nreturn null;',
    'const id = run.id;\nconst m = args["mode"];\nreturn { id, m };',
    'const g = await files.glob("src/**/*.ts");\nreturn g;',
    'const n = agent.name;\nreturn n;',
    // aliasing the ACTOR value is fine — site identity keys off ask call sites
    'const p = agent("planner");\nconst q = p;\nconst r = await q.ask<string>("x");\nreturn r;',
    // a user-defined ask method is not a facade member
    'const obj = { ask: (x: string) => x };\nconst f = obj.ask;\nreturn f("u");',
  ];
  for (const src of clean) {
    const r = analyzeFacadeScript(src);
    assert.equal(r.ok, true, `${src}: ${JSON.stringify(r.diagnostics)}`);
  }
});

test('9001 does not disturb the site table for legal scripts', () => {
  const r = analyzeFacadeScript(
    'phase("A");\nconst p = agent("planner");\nconst r2 = await p.ask<string>("x");\nawait world.run("node", ["--version"]);\nreturn r2;',
  );
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const kinds = r.sites.map((s) => s.kind);
  assert.ok(kinds.includes('ask') && kinds.includes('actor') && kinds.includes('worldRun'), kinds.join(','));
  assert.deepEqual(r.actors, ['planner']);
});

test('9001 maps back to author line numbers (prelude subtracted)', () => {
  const { hit } = diag9001('return null;\nconst f = agent;');
  assert.ok(hit);
  assert.equal(hit!.line, 2);
});
