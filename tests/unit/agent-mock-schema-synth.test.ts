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
