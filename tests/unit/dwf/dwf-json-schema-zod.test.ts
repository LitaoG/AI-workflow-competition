import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodFromJsonSchema } from '../../../src/dwf/json-schema-zod.js';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';

test('object schema: required + optional + strip unknown keys', () => {
  const zod = zodFromJsonSchema({
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      note: { type: 'string' },
    },
    required: ['name'],
  });
  const parsed = zod.safeParse({ name: 'x', count: 3, extra: 'stripped' });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data, { name: 'x', count: 3 });
  assert.equal(zod.safeParse({ count: 1 }).success, false, 'missing required name fails');
});

test('enum schema accepts members and rejects others', () => {
  const zod = zodFromJsonSchema({ enum: ['LOW', 'MEDIUM', 'HIGH'] });
  assert.equal(zod.safeParse('LOW').success, true);
  assert.equal(zod.safeParse('CRITICAL').success, false);
});

test('array + nested object + boolean', () => {
  const zod = zodFromJsonSchema({
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      ok: { type: 'boolean' },
    },
    required: ['items', 'ok'],
  });
  const parsed = zod.safeParse({ items: [{ id: 'a' }, { id: 'b' }], ok: true });
  assert.equal(parsed.success, true);
  assert.equal(zod.safeParse({ items: [], ok: 'yes' }).success, false);
});

test('JSDoc descriptions are preserved as zod .describe()', () => {
  const zod = zodFromJsonSchema({ type: 'string', description: 'The incident identifier.' });
  assert.equal(zod.description, 'The incident identifier.');
});

test('nullable unions', () => {
  const zod = zodFromJsonSchema({ type: ['string', 'null'] });
  assert.equal(zod.safeParse(null).success, true);
  assert.equal(zod.safeParse('x').success, true);
  assert.equal(zod.safeParse(5).success, false);
});

test('numeric enum schema accepts members and rejects others (including string forms)', () => {
  const zod = zodFromJsonSchema({ enum: [1, 2, 3] });
  assert.equal(zod.safeParse(2).success, true);
  assert.equal(zod.safeParse(5).success, false);
  assert.equal(zod.safeParse('2').success, false, 'numeric enums stay numeric');
});

test('anyOf union schema passes each branch through', () => {
  const zod = zodFromJsonSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] });
  assert.equal(zod.safeParse('x').success, true);
  assert.equal(zod.safeParse(7).success, true);
  assert.equal(zod.safeParse(true).success, false);
});

test('recursive anyOf schema via $ref/definitions converts through z.lazy and validates nested data', () => {
  const zod = zodFromJsonSchema({
    $ref: '#/definitions/Tree',
    definitions: {
      Tree: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { $ref: '#/definitions/Tree' } }],
      },
    },
  });
  assert.equal(zod.safeParse('leaf').success, true);
  assert.equal(zod.safeParse(['a', ['b', 'c'], []]).success, true);
  assert.equal(zod.safeParse(42).success, false);
  assert.equal(zod.safeParse({ nope: true }).success, false);
});

test('root self-reference ($ref: "#") resolves lazily', () => {
  const zod = zodFromJsonSchema({
    type: 'object',
    properties: { id: { type: 'string' }, child: { $ref: '#' } },
    required: ['id'],
  });
  assert.equal(zod.safeParse({ id: 'a' }).success, true);
  assert.equal(zod.safeParse({ id: 'a', child: { id: 'b', child: { id: 'c' } } }).success, true);
  assert.equal(zod.safeParse({ id: 'a', child: { nope: 1 } }).success, false, 'nested levels still honor the schema');
});

test('alignment with schema-synth: synthesized string-enum schema converts and validates', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<V>("hi");
return v;
interface V { riskLevel: "LOW" | "MEDIUM" | "HIGH"; note?: string; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const schema = r.sites.find((s) => s.kind === 'ask')!.schema as Parameters<typeof zodFromJsonSchema>[0];
  const zod = zodFromJsonSchema(schema);
  assert.equal(zod.safeParse({ riskLevel: 'LOW' }).success, true);
  assert.equal(zod.safeParse({ riskLevel: 'LOW', note: 'fine', extra: 1 }).success, true, 'unknown keys are stripped');
  assert.equal(zod.safeParse({ riskLevel: 'CRITICAL' }).success, false);
});

test('alignment with schema-synth: numeric literal union round-trips as a numeric enum', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<V>("hi");
return v;
interface V { severity: 1 | 2 | 3; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const schema = r.sites.find((s) => s.kind === 'ask')!.schema as Parameters<typeof zodFromJsonSchema>[0];
  assert.deepEqual((schema as { properties: { severity: { enum?: number[] } } }).properties.severity.enum, [1, 2, 3]);
  const zod = zodFromJsonSchema(schema);
  assert.equal(zod.safeParse({ severity: 2 }).success, true);
  assert.equal(zod.safeParse({ severity: 4 }).success, false);
  assert.equal(zod.safeParse({ severity: '2' }).success, false);
});

test('alignment with schema-synth: anyOf union (string | number) round-trips', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<V>("hi");
return v;
interface V { id: string | number; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const schema = r.sites.find((s) => s.kind === 'ask')!.schema as Parameters<typeof zodFromJsonSchema>[0];
  const zod = zodFromJsonSchema(schema);
  assert.equal(zod.safeParse({ id: 'a-1' }).success, true);
  assert.equal(zod.safeParse({ id: 42 }).success, true);
  assert.equal(zod.safeParse({ id: true }).success, false);
});
