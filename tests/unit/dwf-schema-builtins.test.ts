/**
 * Schema hardening (9002 REJECTED_BUILTINS + MAX_UNION_MEMBERS=100):
 * builtins whose instances are not JSON-serializable are refused by constructor name
 * through the existing schema diagnostic channel, and the union cap aligns with the
 * MAX_UNION=100 value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../src/dwf/compile.js';

function askDiag(typeText: string) {
  return analyzeFacadeScript(`const v = await agent("x").ask<${typeText}>("p");\nreturn v;`);
}

const NON_GENERIC = [
  'Date', 'RegExp', 'Error', 'ArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];
const GENERIC = ['Map<string, number>', 'Set<string>', 'WeakMap<object, number>', 'WeakSet<object>', 'Promise<string>'];

test('9005: REJECTED_BUILTINS are refused by name at ask<T>', () => {
  for (const t of [...NON_GENERIC, ...GENERIC]) {
    const r = askDiag(t);
    assert.equal(r.ok, false, `${t}: ${JSON.stringify(r.diagnostics)}`);
    const hit = r.diagnostics.find((d) => d.code === 9005 && d.category === 'schema-synth');
    assert.ok(hit, `${t}: expected a 9005 schema-synth diagnostic, got ${JSON.stringify(r.diagnostics)}`);
    const baseName = t.split('<')[0]!.trim();
    assert.ok(hit!.message.includes(baseName), `${t}: message should name the builtin, got "${hit!.message}"`);
  }
});

test('9005: Date nested in arrays / properties / unions is refused too', () => {
  for (const t of ['Date[]', '{ when: Date }', 'string | Date']) {
    const r = askDiag(t);
    assert.equal(r.ok, false, `${t}: ${JSON.stringify(r.diagnostics)}`);
    assert.ok(
      r.diagnostics.some((d) => d.code === 9005 && d.message.includes('Date')),
      `${t}: expected a 9005 naming Date, got ${JSON.stringify(r.diagnostics)}`,
    );
  }
});

test('MAX_UNION aligned to 100: a 60-member literal union synthesizes, 101 refuses', () => {
  const members = (n: number) => Array.from({ length: n }, (_, i) => `'u${i}'`).join(' | ');
  const fine = askDiag(members(60));
  assert.equal(fine.ok, true, JSON.stringify(fine.diagnostics));
  const over = askDiag(members(101));
  assert.equal(over.ok, false);
  assert.ok(
    over.diagnostics.some((d) => d.code === 9005 && d.message.includes('exceeds 100')),
    JSON.stringify(over.diagnostics),
  );
});

test('schema synthesis stays clean for plain serializable shapes', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<Verdict>("p");
return v;
interface Verdict { ok: boolean; score: number; tags: string[]; note?: string; level: "LOW" | "HIGH"; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const site = r.sites.find((s) => s.kind === 'ask');
  assert.ok(site?.schema, 'schema synthesized');
});
