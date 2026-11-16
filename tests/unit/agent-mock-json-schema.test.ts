import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { agent } from '../../src/agent/rpc.js';
import { isSchemaValidationError, type DomainError } from '../../src/domain/errors.js';

// Issue #53: the mockResponse fast path used to return plain JSON-Schema-shaped
// canned values UNVALIDATED (the branch only honored schemas with a `parse`
// method) — a structurally violating response (missing required field, enum
// violation, wrong type) masqueraded as a completed step with exit 0. The fast
// path now enforces the same output contract as production through the same
// JSON-Schema→zod converter the dwf compile path uses.

// The two-arg `{ schema, mockResponse }` form is a runtime capability shim on
// ask() (detection is a capability probe, not a TS overload), so the tests
// narrow the callable explicitly instead of bending the public signature.
type CannedAsk = (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;

function cannedAsk(name: string): CannedAsk {
  return agent(name).ask as unknown as CannedAsk;
}

const SEVERITY_SCHEMA = {
  type: 'object',
  properties: { severity: { type: 'string', enum: ['P1', 'P2', 'P3'] } },
  required: ['severity'],
};

test('mock fast path: type+enum violation throws SchemaValidationError (issue #53 repro)', async () => {
  const ask = cannedAsk('Inspector');
  await assert.rejects(
    ask('Analyze', { schema: SEVERITY_SCHEMA, mockResponse: { severity: 123 } }),
    (err: unknown) => {
      assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got: ${String(err)}`);
      return true;
    },
  );
});

test('mock fast path: enum violation throws SchemaValidationError', async () => {
  const ask = cannedAsk('Inspector');
  await assert.rejects(
    ask('Analyze', { schema: SEVERITY_SCHEMA, mockResponse: { severity: 'P9' } }),
    (err: unknown) => {
      assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got: ${String(err)}`);
      return true;
    },
  );
});

test('mock fast path: missing required field throws SchemaValidationError', async () => {
  const ask = cannedAsk('Inspector');
  await assert.rejects(
    ask('Analyze', { schema: SEVERITY_SCHEMA, mockResponse: {} }),
    (err: unknown) => {
      assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got: ${String(err)}`);
      return true;
    },
  );
});

test('mock fast path: nested property violation throws SchemaValidationError', async () => {
  const ask = cannedAsk('Reporter');
  await assert.rejects(
    ask('Report', {
      schema: {
        type: 'object',
        properties: {
          report: {
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          },
        },
        required: ['report'],
      },
      mockResponse: { report: { count: 'many' } },
    }),
    (err: unknown) => {
      assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got: ${String(err)}`);
      return true;
    },
  );
});

test('mock fast path: compliant mockResponse passes through unchanged (zero regression)', async () => {
  const ask = cannedAsk('Inspector');
  const res = await ask('Analyze', { schema: SEVERITY_SCHEMA, mockResponse: { severity: 'P2' } });
  assert.deepEqual(res, { severity: 'P2' });
});

test('mock fast path: object without JSON-Schema markers stays a direct pass-through', async () => {
  // A schema object carrying none of the JSON-Schema markers is not claimed by
  // the guard — it keeps the historical pass-through semantics instead of
  // pretending to validate what it cannot interpret.
  const ask = cannedAsk('Freeform');
  const canned = { anything: 'goes', nested: { ok: true } };
  const res = await ask('Freeform ask', { schema: { note: 'advisory only' }, mockResponse: canned });
  assert.deepEqual(res, canned);
});

test('mock fast path: structural validator (zod) branch unchanged', async () => {
  const ask = cannedAsk('ZodAgent');
  const res = await ask('Compute', { schema: z.object({ count: z.number() }), mockResponse: { count: 42 } });
  assert.deepEqual(res, { count: 42 });
  await assert.rejects(
    ask('Compute', { schema: z.object({ count: z.number() }), mockResponse: { count: 'many' } }),
    (err: unknown) => {
      // zod's own parse throws its ZodError on the fast path — unchanged by #53.
      assert.ok(!isSchemaValidationError((err as DomainError)));
      assert.ok(err instanceof Error);
      return true;
    },
  );
});
