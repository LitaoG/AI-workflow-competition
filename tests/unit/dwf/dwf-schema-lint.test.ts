import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintJsonSchema } from '../../../src/dwf/schema-lint.js';
import { zodFromJsonSchema } from '../../../src/dwf/json-schema-zod.js';

const kinds = (issues: ReturnType<typeof lintJsonSchema>): string[] => issues.map((i) => i.kind);

test('a synthesized-style schema lints clean', () => {
  const issues = lintJsonSchema({
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      verdict: { enum: ['LOW', 'HIGH'] },
      note: { type: ['string', 'null'] },
    },
    required: ['name', 'count', 'tags', 'verdict'],
    additionalProperties: false,
  });
  assert.deepEqual(issues, []);
});

test('required key absent from properties with additionalProperties:false is unsatisfiable', () => {
  const issues = lintJsonSchema({
    type: 'object',
    properties: {},
    required: ['nope'],
    additionalProperties: false,
  });
  assert.deepEqual(kinds(issues), ['unsatisfiable']);
  assert.match(issues[0]!.message, /"nope".*additionalProperties is false/);
});

test('the same required key stays satisfiable when extra keys are allowed', () => {
  // Explicit true and an absent keyword both permit the extra key.
  assert.deepEqual(lintJsonSchema({ type: 'object', properties: {}, required: ['nope'] }), []);
  assert.deepEqual(
    lintJsonSchema({ type: 'object', properties: {}, required: ['nope'], additionalProperties: true }),
    [],
  );
});

test('empty enum and empty anyOf are unsatisfiable', () => {
  assert.deepEqual(kinds(lintJsonSchema({ enum: [] })), ['unsatisfiable']);
  assert.deepEqual(kinds(lintJsonSchema({ anyOf: [] })), ['unsatisfiable']);
});

test('enum members that contradict the declared type are unsatisfiable', () => {
  assert.deepEqual(kinds(lintJsonSchema({ type: 'string', enum: [1, 2] })), ['unsatisfiable']);
  assert.deepEqual(lintJsonSchema({ type: 'string', enum: ['a', 'b'] }), []);
  assert.deepEqual(lintJsonSchema({ type: ['string', 'null'], enum: [null, 'a'] }), []);
});

test('anyOf is unsatisfiable only when every branch is', () => {
  assert.deepEqual(
    kinds(
      lintJsonSchema({
        anyOf: [{ type: 'object', properties: {}, required: ['a'], additionalProperties: false }, { enum: [] }],
      }),
    ),
    ['unsatisfiable'],
  );
  assert.deepEqual(
    lintJsonSchema({
      anyOf: [{ type: 'object', properties: {}, required: ['a'], additionalProperties: false }, { type: 'string' }],
    }),
    [],
  );
});

test('structural violations are invalid, not unsatisfiable', () => {
  for (const bad of [
    { type: 'wat' },
    { type: [] },
    { type: 'object', properties: [] },
    { type: 'object', required: 'name' },
    { type: 'object', required: [1] },
    { type: 'object', enum: 'nope' },
  ]) {
    const issues = lintJsonSchema(bad);
    assert.ok(issues.length > 0, `expected issues for ${JSON.stringify(bad)}`);
    assert.ok(issues.every((i) => i.kind === 'invalid'), `expected only invalid for ${JSON.stringify(bad)}`);
  }
});

test('a nested violation carries its property path', () => {
  const issues = lintJsonSchema({
    type: 'object',
    properties: { nested: { type: 'object', properties: { item: { type: 'wat' } } } },
  });
  assert.deepEqual(kinds(issues), ['invalid']);
  assert.equal(issues[0]!.path, 'properties.nested.properties.item.type');
});

test('unresolved $ref is invalid; recursive refs terminate', () => {
  assert.deepEqual(kinds(lintJsonSchema({ $ref: '#/definitions/Missing' })), ['invalid']);
  assert.deepEqual(
    lintJsonSchema({
      type: 'object',
      properties: { tree: { $ref: '#/definitions/Node' } },
      definitions: { Node: { type: 'object', properties: { child: { $ref: '#/definitions/Node' } } } },
    }),
    [],
  );
});

test('regression: zod conversion silently accepts the unusable schema the lint rejects', () => {
  const unusable = { type: 'object', properties: {}, required: ['nope'], additionalProperties: false };
  // The pre-fix behavior this guard exists to stop: a subagent reply "{}" (or even
  // {nope:1}, stripped) validates against z.object({}), so the contract is a lie.
  const zod = zodFromJsonSchema(unusable);
  assert.equal(zod.safeParse({}).success, true);
  assert.equal(zod.safeParse({ nope: 1 }).success, true);
  // The lint refuses it before dispatch.
  assert.deepEqual(kinds(lintJsonSchema(unusable)), ['unsatisfiable']);
});