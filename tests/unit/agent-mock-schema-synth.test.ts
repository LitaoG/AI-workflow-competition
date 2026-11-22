import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MockProvider, synthesizeMockFromSchema } from '../../src/agent/mock-provider.js';

test('MockProvider: synthesizeMockFromSchema generates valid mock data for various JSON schema types', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
      retries: { type: 'integer', minimum: 0 },
      success: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      nested: {
        type: 'object',
        properties: {
          subField: { type: 'string' },
        },
      },
    },
    required: ['id', 'status', 'retries', 'success', 'tags', 'nested'],
  };

  const synthesized = synthesizeMockFromSchema(schema) as Record<string, unknown>;
  assert.equal(typeof synthesized.id, 'string');
  assert.equal(synthesized.status, 'ACTIVE');
  assert.equal(typeof synthesized.retries, 'number');
  assert.equal(synthesized.success, true);
  assert.ok(Array.isArray(synthesized.tags));
  assert.equal(typeof (synthesized.nested as Record<string, unknown>).subField, 'string');

  // Verify against Zod schema
  const ZodSchema = z.object({
    id: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    retries: z.number().int().min(0),
    success: z.boolean(),
    tags: z.array(z.string()),
    nested: z.object({
      subField: z.string(),
    }),
  });

  const parsed = ZodSchema.safeParse(synthesized);
  assert.ok(parsed.success, `Zod validation failed: ${JSON.stringify(parsed)}`);
});

test('MockProvider: synthesizeMockFromSchema supports complex nested objects and arrays', () => {
  const customSchema = {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      totalAmount: { type: 'number' },
      isDelivered: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            quantity: { type: 'integer' },
          },
          required: ['sku', 'quantity'],
        },
      },
    },
    required: ['orderId', 'totalAmount', 'isDelivered', 'items'],
  };

  const synthesized = synthesizeMockFromSchema(customSchema) as any;
  assert.ok(synthesized.orderId);
  assert.equal(typeof synthesized.totalAmount, 'number');
  assert.equal(typeof synthesized.isDelivered, 'boolean');
  assert.ok(Array.isArray(synthesized.items));
  assert.ok(synthesized.items.length > 0);
  assert.ok(synthesized.items[0].sku);
  assert.equal(typeof synthesized.items[0].quantity, 'number');

  const ZodOrderSchema = z.object({
    orderId: z.string(),
    totalAmount: z.number(),
    isDelivered: z.boolean(),
    items: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int(),
      }),
    ),
  });

  const parsed = ZodOrderSchema.safeParse(synthesized);
  assert.ok(parsed.success, `Zod validation failed: ${JSON.stringify(parsed)}`);
});

// Issue #267: canned actor/keyword routing must not shadow typed asks. Live
// observation (run dwfrun-mwrsjrih-fd97a0): actor "board-reviewer" routed to
// safetyJson() whose keys are completely disjoint from the asked schema — the
// ask failed schema validation 3× and killed the run. The disjoint guard
// routes such asks to synthesizeMockFromSchema instead.
test('MockProvider: a typed ask whose canned routing is disjoint from the schema gets schema-synthesized', async () => {
  const mock = new MockProvider();
  const boardSchema = {
    type: 'object',
    properties: {
      looksRenderable: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['looksRenderable', 'reason'],
  };
  const prompt = `One sentence: is the board renderable?\n\nRespond with a single JSON object matching exactly this schema:\n${JSON.stringify(boardSchema)}`;
  // "board-reviewer" trips the /reviewer/ canned branch → safetyJson() —
  // keys (approved, safetyScore, …) are disjoint from the asked schema.
  const res = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "board-reviewer".' },
      { role: 'user', content: prompt },
    ],
  });
  const json = JSON.parse(res.content);
  assert.equal(typeof json.looksRenderable, 'boolean', 'disjoint canned must be replaced by a schema-shaped object');
  assert.equal(typeof json.reason, 'string', 'schema-synthesized string field present');
  assert.ok(!('safetyScore' in json), 'the canned safety body must not survive');
  const BoardSchema = z.object({ looksRenderable: z.boolean(), reason: z.string() });
  assert.ok(BoardSchema.safeParse(json).success, 'synthesized body validates against the asked schema');
});

test('MockProvider: a typed ask whose canned body overlaps the schema keys keeps the canned body verbatim', async () => {
  const mock = new MockProvider();
  // "approved" IS a safetyJson() key → overlap → the demo-parity canned body
  // must survive untouched (byte-identical demo output is a hard constraint).
  const schema = {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      extraField: { type: 'string' },
    },
    required: ['approved', 'extraField'],
  };
  const prompt = `Audit this.\n\nRespond with a single JSON object matching exactly this schema:\n${JSON.stringify(schema)}`;
  const res = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "board-reviewer".' },
      { role: 'user', content: prompt },
    ],
  });
  const json = JSON.parse(res.content);
  assert.equal(json.approved, true, 'canned safety body kept (keys overlap)');
  assert.equal(json.safetyScore, 0.98, 'canned body is verbatim, not synthesized');
});

test('MockProvider: an untyped ask keeps the canned routing with no schema probe', async () => {
  const mock = new MockProvider();
  const res = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "board-reviewer".' },
      { role: 'user', content: 'One sentence: is the board renderable?' },
    ],
  });
  const json = JSON.parse(res.content);
  assert.equal(json.policyCompliance, 'PASS', 'no schema extracted → canned safety body unchanged');
});

test('MockProvider: lead-architect with custom schema does not collide with hardcoded planJson', async () => {
  const mock = new MockProvider();
  const customStepSchema = {
    type: 'object',
    properties: {
      stepName: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['stepName', 'notes'],
  };

  const prompt = `Setup project.\n\nRespond with a single JSON object matching exactly this schema:\n${JSON.stringify(customStepSchema)}`;
  const res = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "lead-architect".' },
      { role: 'user', content: prompt },
    ],
  });

  const json = JSON.parse(res.content);
  assert.equal(typeof json.stepName, 'string');
  assert.equal(typeof json.notes, 'string');

  const StepSchema = z.object({
    stepName: z.string(),
    notes: z.string(),
  });
  assert.ok(StepSchema.safeParse(json).success);
});
