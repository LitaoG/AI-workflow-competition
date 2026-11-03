import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { isDomainError } from '../../../src/domain/errors.js';

test('recursive interface yields the precise recursion diagnostic, not the generic depth cap', () => {
  const r = analyzeFacadeScript(`
const tree = await agent("surveyor").ask<TreeNode>("outline the tree");
return tree;

interface TreeNode {
  /** Node label. */
  label: string;
  children: TreeNode[];
}
`);
  assert.equal(r.ok, false);
  const rec = r.diagnostics.find((d) => d.code === 9015);
  assert.ok(rec, JSON.stringify(r.diagnostics));
  assert.equal(rec!.tag, 'CompileError');
  assert.equal(rec!.category, 'schema-synth');
  assert.match(rec!.message, /^recursive type at site ask#\d+: TreeNode$/);
  assert.ok(!r.diagnostics.some((d) => d.message.includes('nests deeper than')), 'must not degrade to the generic depth-cap message');
  // diagnostics speak the domain's Tagged Error Algebra
  assert.ok(isDomainError(rec), 'a facade diagnostic is a valid domain CompileError value');
  // site naming stays the incumbent ask#N, and the diagnostic cites exactly it
  const askSite = r.sites.find((s) => s.kind === 'ask');
  assert.equal(askSite!.siteId, 'ask#1');
  assert.ok(rec!.message.includes(`at site ${askSite!.siteId}`), rec!.message);
  // recursion fails loudly: no schema is attached to the ask site
  assert.equal(askSite!.schema, undefined);
  // the diagnostic points at the recursive reference (`children`, author line 8)
  assert.equal(rec!.line, 8);
});

test('depth cap behavior does not regress for deep acyclic nesting (generic 9005, not 9015)', () => {
  const names = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
  const body = names
    .map((n, i) => (i === names.length - 1 ? `interface ${n} { leaf: string; }` : `interface ${n} { v: ${names[i + 1]}; }`))
    .join('\n');
  const r = analyzeFacadeScript(`
const deep = await agent("x").ask<L1>("deep");
return deep;
${body}
`);
  assert.equal(r.ok, false);
  const cap = r.diagnostics.find((d) => d.code === 9005);
  assert.ok(cap, JSON.stringify(r.diagnostics));
  assert.match(cap!.message, /nests deeper than 8 levels/);
  assert.ok(!r.diagnostics.some((d) => d.code === 9015), 'no false recursion on acyclic deep nesting');
});

test('a named type reused across sibling properties is not a false recursion (seen-set is path-scoped)', () => {
  const r = analyzeFacadeScript(`
const order = await agent("x").ask<Order>("describe the order");
return order;

interface Address { city: string; }
interface Order { ship: Address; bill: Address; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const props = (r.sites.find((s) => s.kind === 'ask')!.schema as { properties: Record<string, { type?: string }> }).properties;
  assert.ok(props.ship && props.bill, 'both Address properties resolved');
});

test('mutual recursion names the re-entered type and the ask site', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<A>("hi");
return v;

interface A { b: B; }
interface B { a: A; }
`);
  assert.equal(r.ok, false);
  const rec = r.diagnostics.find((d) => d.code === 9015);
  assert.ok(rec, JSON.stringify(r.diagnostics));
  assert.match(rec!.message, /^recursive type at site ask#1: A$/);
});

test('a self-referential alias through a nullable union is still diagnosed as recursion', () => {
  const r = analyzeFacadeScript(`
const list = await agent("x").ask<LinkedList>("walk the list");
return list;

type LinkedList = { value: string; next: LinkedList | null };
`);
  assert.equal(r.ok, false);
  const rec = r.diagnostics.find((d) => d.code === 9015);
  assert.ok(rec, JSON.stringify(r.diagnostics));
  assert.match(rec!.message, /^recursive type at site ask#1: LinkedList$/);
});

test('every diagnostic channel speaks the domain CompileError tag', () => {
  // channel 1: TS type errors; channel 2: authorization rules; schema-synth: recursion
  const tsError = analyzeFacadeScript('const n: number = "oops";\nreturn n;');
  assert.equal(tsError.ok, false);
  const purity = analyzeFacadeScript('const t = Date.now();\nreturn t;');
  assert.equal(purity.ok, false);
  const recursion = analyzeFacadeScript(`
const v = await agent("x").ask<R>("hi");
return v;
interface R { next: R; }
`);
  assert.equal(recursion.ok, false);
  for (const d of [...tsError.diagnostics, ...purity.diagnostics, ...recursion.diagnostics]) {
    assert.equal(d.tag, 'CompileError', JSON.stringify(d));
    assert.ok(isDomainError(d), JSON.stringify(d));
  }
});
