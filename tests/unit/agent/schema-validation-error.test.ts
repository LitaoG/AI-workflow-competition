/**
 * Issue #110: `agent().ask()` throws the REAL SchemaValidationError — an
 * Error instance (instanceof works, stack exists) carrying the rawText the
 * caller paid for and the zod field paths. This is the DoD repro case from
 * the issue: a provider that always returns schema-invalid JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../../../src/agent/rpc.js';
import { SchemaValidationError } from '../../../src/agent/schema-validation-error.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { isSchemaValidationError } from '../../../src/domain/errors.js';
import type { LLMProvider, LLMResponse } from '../../../src/types.js';
import { z } from 'zod';

test('schema-invalid asks throw an Error-instance SchemaValidationError with rawText and zodErrors', async () => {
  const provider: LLMProvider = {
    id: 'issue-110-provider',
    name: 'Issue 110 provider',
    async generate(): Promise<LLMResponse> {
      // Valid JSON, wrong shape — the repair loop burns its budget on it.
      return {
        content: '{"nope": 42}',
        model: 'issue-110-mock',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 0,
      };
    },
  };
  providerRegistry.register(provider);
  const previous = providerRegistry.get().id;
  providerRegistry.setDefault(provider.id);
  try {
    const client = agent('issue-110-agent');
    const schema = z.object({ name: z.string() });
    await assert.rejects(
      client.ask('give me a name', schema, { maxRetries: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError, 'instanceof SchemaValidationError (Issue #110)');
        assert.ok(err instanceof Error, 'instanceof Error');
        const e = err as SchemaValidationError;
        assert.equal(e.name, 'SchemaValidationError');
        assert.ok(typeof e.stack === 'string' && e.stack.length > 0, 'the error carries a stack');
        assert.ok(e.rawText.includes('"nope"'), 'rawText holds the last raw model output');
        assert.equal(e.attemptCount, 2);
        assert.ok(e.zodErrors.length > 0, 'zodErrors present');
        assert.deepEqual(e.zodErrors[0]!.path, ['name'], 'the failing field path is recoverable');
        // the domain algebra duality is preserved
        assert.equal(e.tag, 'SchemaValidationError');
        assert.ok(isSchemaValidationError(e), 'the tag predicate still accepts the class instance');
        assert.equal((e.details as { issueCount?: number }).issueCount, e.zodErrors.length);
        return true;
      },
    );
  } finally {
    providerRegistry.setDefault(previous);
  }
});
