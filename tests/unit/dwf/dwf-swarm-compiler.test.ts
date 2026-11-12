/**
 * (Issue #134): `swarm<T>(agents, tasks)` at the compiler and
 * lowering layers — one ask site shared by every task, schema synthesis from the
 * type argument, and the 9001/9004 misuse guards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { lowerFacadeScript } from '../../../src/dwf/lower.js';

function compile(body: string) {
  return analyzeFacadeScript(`${body}\nreturn null;`);
}

test('swarm records one ask site per call, in source order, interleaved with ask sites', () => {
  const r = compile(`
const a = await swarm([agent("x")], ["one", "two"]);
const b = await agent("y").ask("solo");
const c = await swarm([agent("z")], ["three"]);
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const asks = r.sites.filter((s) => s.kind === 'ask');
  assert.deepEqual(
    asks.map((s) => s.siteId),
    // agent() calls inside the swarm arguments take their own actor slots from
    // the same counter, so the ask sites land on 1/3/5.
    ['swarm#1', 'ask#3', 'swarm#5'],
    'swarm and ask draw from the same site counter',
  );
});

test('swarm<T> synthesizes the schema from its type argument; untyped swarm has none', () => {
  const typed = compile(`const a = await swarm<Pair>([agent("x")], ["t1"]);
type Pair = [string, number];`);
  assert.equal(typed.ok, true, JSON.stringify(typed.diagnostics));
  const site = typed.sites.find((s) => s.siteId === 'swarm#1');
  assert.ok(site?.schema, 'typed swarm carries a schema');
  assert.deepEqual(site.schema, { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2, additionalItems: false });

  const untyped = compile(`const a = await swarm([agent("x")], ["t1"]);`);
  assert.equal(untyped.ok, true, JSON.stringify(untyped.diagnostics));
  const bare = untyped.sites.find((s) => s.siteId === 'swarm#1');
  assert.ok(bare, 'the untyped swarm still registers its site');
  assert.equal(bare.schema, undefined, 'untyped swarm synthesizes no schema');
});

test('swarm misuse: non-direct calls are 9001, shadowing is 9004', () => {
  const aliased = compile('const f = swarm;\nawait f([agent("x")], ["t1"]);');
  assert.equal(aliased.ok, false);
  const notCalled = aliased.diagnostics.find((d) => d.code === 9001);
  assert.ok(notCalled, `9001 for the aliased swarm: ${JSON.stringify(aliased.diagnostics)}`);

  // Same misuse class the existing facade names lock for `const log = 3` (9004).
  const shadowed = compile('const swarm = 3;');
  assert.equal(shadowed.ok, false);
  assert.ok(shadowed.diagnostics.some((d) => d.code === 9004), `9004 for shadowing swarm: ${JSON.stringify(shadowed.diagnostics)}`);
});

test('lowering rewrites swarm(...) into __swarm(siteId, agents, tasks, schemaJson|null)', () => {
  const typed = lowerFacadeScript(`const a = await swarm<Pair>([agent("x")], ["t1", "t2"]);
type Pair = [string, number];`);
  assert.equal(typed.analysis.ok, true, JSON.stringify(typed.analysis.diagnostics));
  const call = typed.js.match(/__swarm\(([^;]+)\);/);
  assert.ok(call, `the lowered call is present: ${typed.js}`);
  // Parse the stringified arguments back out of the emitted source.
  const parts = call![1]!.match(/("(?:[^"\\]|\\.)*"|\[.*?\]|null)/g) ?? [];
  const schemaArg = parts[parts.length - 1]!;
  const schema = JSON.parse(JSON.parse(schemaArg));
  assert.deepEqual(schema, { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2, additionalItems: false });
  assert.match(typed.js, /["']swarm#1["']/, 'the site id rides as the first argument');
  assert.match(typed.js, /\["t1", "t2"\]/, 'the tasks literal is passed through');

  const untyped = lowerFacadeScript(`const a = await swarm([agent("x")], ["t1"]);`);
  assert.equal(untyped.analysis.ok, true, JSON.stringify(untyped.analysis.diagnostics));
  assert.match(untyped.js, /__swarm\(\s*["']swarm#1["']\s*,.*null\s*\)/s, 'an untyped swarm lowers with a null schema');
});
