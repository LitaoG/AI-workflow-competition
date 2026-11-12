/**
 * (Issue #126): complex TypeScript types in `ask<T>` become
 * Draft-07 JSON Schema, and the Zod validator built from that schema accepts what
 * the type allows and rejects what it does not.
 *
 * Every case runs three checks: (1) the synthesized schema matches the expected
 * one (`required` and `enum` compared as sets); (2) the schema only uses Draft-07
 * keywords with valid values; (3) `zodFromJsonSchema` accepts the valid samples
 * and rejects the invalid ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { zodFromJsonSchema } from '../../../src/dwf/json-schema-zod.js';

type Json = Record<string, unknown>;
type ZodInput = Parameters<typeof zodFromJsonSchema>[0];

/** Compile a one-ask script and return the schema synthesized for `ask<typeText>`. */
function synth(typeText: string, declarations = ''): Json {
  const r = analyzeFacadeScript(`const v = await agent("x").ask<${typeText}>("q");\nreturn v;\n${declarations}`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const site = r.sites.find((s) => s.kind === 'ask');
  assert.ok(site?.schema, `no schema for ask<${typeText}>`);
  return site.schema as Json;
}

/** Compile a one-ask script that must fail, and return its diagnostic messages. */
function synthFails(typeText: string, declarations = ''): string[] {
  const r = analyzeFacadeScript(`const v = await agent("x").ask<${typeText}>("q");\nreturn v;\n${declarations}`);
  assert.equal(r.ok, false, `ask<${typeText}> should not compile`);
  return r.diagnostics.map((d) => `${d.code} ${d.message}`);
}

/** Sort `required` and `enum` everywhere: their order carries no meaning. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] = (key === 'required' || key === 'enum') && Array.isArray(value)
      ? [...value].sort((a, b) => String(a).localeCompare(String(b)))
      : normalize(value);
  }
  return out;
}

const DRAFT07_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

/** The Draft-07 keywords this synthesizer may emit, each with a valid value. */
function assertDraft07(node: unknown, at = '$'): void {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${at} must be a schema object`);
  const schema = node as Json;
  for (const [key, value] of Object.entries(schema)) {
    const where = `${at}.${key}`;
    switch (key) {
      case 'type': {
        const list = Array.isArray(value) ? value : [value];
        assert.ok(list.length > 0 && list.every((t) => typeof t === 'string' && DRAFT07_TYPES.has(t)), `${where}: ${JSON.stringify(value)}`);
        assert.equal(new Set(list).size, list.length, `${where} repeats a type`);
        break;
      }
      case 'properties':
        assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${where} must be an object`);
        for (const [name, sub] of Object.entries(value as Json)) assertDraft07(sub, `${where}.${name}`);
        break;
      case 'required': {
        assert.ok(Array.isArray(value) && value.every((v) => typeof v === 'string'), `${where} must list strings`);
        assert.equal(new Set(value as string[]).size, (value as string[]).length, `${where} repeats a name`);
        for (const name of value as string[]) assert.ok(name in ((schema.properties as Json | undefined) ?? {}), `${where}: "${name}" is not a property`);
        break;
      }
      case 'items':
        if (Array.isArray(value)) value.forEach((sub, i) => assertDraft07(sub, `${where}[${i}]`));
        else assertDraft07(value, where);
        break;
      case 'additionalItems':
        if (typeof value !== 'boolean') assertDraft07(value, where);
        break;
      case 'minItems':
      case 'maxItems':
        assert.ok(Number.isInteger(value) && (value as number) >= 0, `${where} must be a non-negative integer`);
        break;
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${where} must be a non-empty array`);
        assert.equal(new Set((value as unknown[]).map((v) => JSON.stringify(v))).size, (value as unknown[]).length, `${where} repeats a value`);
        break;
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', `${where} must be a boolean`);
        break;
      case 'description':
        assert.equal(typeof value, 'string', `${where} must be a string`);
        break;
      case 'anyOf':
        assert.ok(Array.isArray(value) && value.length > 0, `${where} must be a non-empty array`);
        (value as unknown[]).forEach((sub, i) => assertDraft07(sub, `${where}[${i}]`));
        break;
      default:
        assert.fail(`${where}: "${key}" is not a Draft-07 keyword this synthesizer may emit`);
    }
  }
  if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number') {
    assert.ok(schema.minItems <= schema.maxItems, `${at}: minItems is above maxItems`);
  }
}

/** All three checks for one type. */
function check(schema: Json, expected: Json, valid: unknown[], invalid: unknown[]): void {
  assert.deepEqual(normalize(schema), normalize(expected));
  assertDraft07(schema);
  const zod = zodFromJsonSchema(schema as ZodInput);
  for (const sample of valid) assert.equal(zod.safeParse(sample).success, true, `should accept ${JSON.stringify(sample)}`);
  for (const sample of invalid) assert.equal(zod.safeParse(sample).success, false, `should reject ${JSON.stringify(sample)}`);
}

const USER = 'interface User { id: number; name: string; }';
const PAGE = 'interface Page<T> { items: T[]; total: number; next: string | null; }';
const TODO = 'interface Todo { id: number; title: string; done: boolean; note?: string; }';
const userSchema: Json = {
  type: 'object',
  properties: { id: { type: 'number' }, name: { type: 'string' } },
  additionalProperties: false,
  required: ['id', 'name'],
};
const pageOf = (items: Json): Json => ({
  type: 'object',
  properties: { items: { type: 'array', items }, total: { type: 'number' }, next: { type: ['string', 'null'] } },
  additionalProperties: false,
  required: ['items', 'total', 'next'],
});
const todoProps: Json = { id: { type: 'number' }, title: { type: 'string' }, done: { type: 'boolean' }, note: { type: 'string' } };

test('a generic interface is synthesized for its type argument (Page<User>)', () => {
  check(
    synth('Page<User>', `${USER}\n${PAGE}`),
    pageOf(userSchema),
    [{ items: [{ id: 1, name: 'a' }], total: 1, next: null }, { items: [], total: 0, next: 'cursor-2' }],
    [{ items: [{ id: '1', name: 'a' }], total: 1, next: null }, { items: [], total: 0 }, { items: [{ id: 1 }], total: 1, next: null }],
  );
});

test('nested generics expand all the way down (Result<Page<User>>)', () => {
  check(
    synth('Result<Page<User>>', `${USER}\n${PAGE}\ninterface Result<T> { ok: boolean; data: T; }`),
    { type: 'object', properties: { ok: { type: 'boolean' }, data: pageOf(userSchema) }, additionalProperties: false, required: ['ok', 'data'] },
    [{ ok: true, data: { items: [{ id: 1, name: 'a' }], total: 1, next: null } }],
    [{ ok: true, data: { items: [{ id: 1, name: 2 }], total: 1, next: null } }, { ok: 'yes', data: { items: [], total: 0, next: null } }],
  );
});

test('utility types: Partial, Required, Readonly, Pick and Omit', () => {
  const object = (properties: Json, required?: string[]): Json => ({
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required ? { required } : {}),
  });
  const { id, title } = todoProps as Record<string, Json>;
  check(synth('Partial<Todo>', TODO), object(todoProps), [{}, { title: 't' }], [{ id: 'x' }]);
  check(
    synth('Required<Todo>', TODO),
    object(todoProps, ['id', 'title', 'done', 'note']),
    [{ id: 1, title: 't', done: false, note: 'n' }],
    [{ id: 1, title: 't', done: false }],
  );
  check(synth('Readonly<Todo>', TODO), object(todoProps, ['id', 'title', 'done']), [{ id: 1, title: 't', done: true }], [{ id: 1, title: 't' }]);
  check(synth(`Pick<Todo, 'id' | 'title'>`, TODO), object({ id, title }, ['id', 'title']), [{ id: 1, title: 't' }], [{ id: 1 }]);
  check(synth(`Omit<Todo, 'note' | 'done'>`, TODO), object({ id, title }, ['id', 'title']), [{ id: 1, title: 't' }], [{ title: 't' }]);
});

test('a Record over literal keys becomes an object with exactly those keys', () => {
  check(
    synth(`Record<'low' | 'high', number>`),
    { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, additionalProperties: false, required: ['low', 'high'] },
    [{ low: 1, high: 9 }],
    [{ low: 1 }, { low: 1, high: 'x' }],
  );
});

test('an intersection of object types is one object with the merged properties', () => {
  const declarations = 'interface Base { id: number; }\ninterface Extra { note?: string; }';
  check(
    synth('Base & Extra & { tags: string[] }', declarations),
    {
      type: 'object',
      properties: { id: { type: 'number' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
      required: ['id', 'tags'],
    },
    [{ id: 1, tags: [] }, { id: 1, note: 'n', tags: ['a'] }],
    [{ id: 1 }, { id: 1, tags: [1] }],
  );
  const branded = synthFails(`string & { __brand: 'Email' }`);
  assert.ok(branded.some((m) => m.startsWith('9005') && m.includes('an intersection must join plain object types')), branded.join('\n'));
});

test('tuples keep their positions and length (Draft-07 items array)', () => {
  const s = { type: 'string' };
  const n = { type: 'number' };
  check(synth('[string, number]'), { type: 'array', items: [s, n], minItems: 2, maxItems: 2, additionalItems: false }, [['a', 1]], [['a'], ['a', 1, 2], [1, 'a'], 'a']);
  check(synth('[string, number?]'), { type: 'array', items: [s, n], minItems: 1, maxItems: 2, additionalItems: false }, [['a'], ['a', 1]], [[], ['a', 'b'], ['a', 1, 2]]);
  check(synth('[string, ...number[]]'), { type: 'array', items: [s], minItems: 1, additionalItems: n }, [['a'], ['a', 1, 2]], [[], ['a', 'b'], [1]]);
  check(synth('readonly [x: number, y: number]'), { type: 'array', items: [n, n], minItems: 2, maxItems: 2, additionalItems: false }, [[1, 2]], [[1], [1, '2']]);
  check(
    synth('Span', 'interface Span { label: string; range: [number, number]; }'),
    {
      type: 'object',
      properties: { label: s, range: { type: 'array', items: [n, n], minItems: 2, maxItems: 2, additionalItems: false } },
      additionalProperties: false,
      required: ['label', 'range'],
    },
    [{ label: 'a', range: [1, 2] }],
    [{ label: 'a', range: [1] }, { label: 'a', range: [1, 2, 3] }],
  );
  const leadingRest = synthFails('[...string[], number]');
  assert.ok(leadingRest.some((m) => m.startsWith('9005') && m.includes('rest element before its last position')), leadingRest.join('\n'));
});

test('readonly arrays, nullable fields, literal unions and JSDoc descriptions', () => {
  check(synth('readonly string[]'), { type: 'array', items: { type: 'string' } }, [[], ['a']], [[1]]);
  check(synth('ReadonlyArray<number>'), { type: 'array', items: { type: 'number' } }, [[1, 2]], [['1']]);
  check(
    synth('Ticket', [
      'interface Ticket {',
      '  /** How urgent the ticket is. */',
      "  level: 'low' | 'high';",
      '  owner: string | null;',
      '  score: 1 | 2 | 3;',
      '}',
    ].join('\n')),
    {
      type: 'object',
      properties: {
        level: { enum: ['low', 'high'], description: 'How urgent the ticket is.' },
        owner: { type: ['string', 'null'] },
        score: { enum: [1, 2, 3] },
      },
      additionalProperties: false,
      required: ['level', 'owner', 'score'],
    },
    [{ level: 'low', owner: null, score: 3 }, { level: 'high', owner: 'ann', score: 1 }],
    [{ level: 'mid', owner: null, score: 3 }, { level: 'low', owner: null, score: 4 }, { level: 'low', score: 1 }],
  );
});
