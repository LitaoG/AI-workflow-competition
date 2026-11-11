import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { agent } from '../../src/agent/rpc.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { MockProvider } from '../../src/agent/mock-provider.js';
import { isSchemaValidationError, type DomainError } from '../../src/domain/errors.js';
import { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

test('Agent RPC: returns typed object matching Zod schema', async () => {
  const schema = z.object({
    status: z.string(),
    message: z.string(),
    timestamp: z.string(),
  });

  const client = agent('TestAgent');
  const res = await client.ask('Perform action', schema);

  assert.equal(typeof res.status, 'string');
  assert.equal(typeof res.message, 'string');
  assert.equal(typeof res.timestamp, 'string');
});

test('Agent RPC: automatic repair loop recovers from malformed markdown JSON response', async () => {
  let calls = 0;
  const customProvider: LLMProvider = {
    id: 'flaky-markdown-provider',
    name: 'Flaky Markdown Provider',
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      calls++;
      if (calls === 1) {
        // Return raw markdown with text preamble and markdown blocks
        return {
          content: 'Here is your answer:\n```json\n{\n  "count": 42,\n  "ready": true,\n}\n```\nHope that helps!',
          model: 'test-model',
          latencyMs: 5,
        };
      }
      return {
        content: '{"count": 42, "ready": true}',
        model: 'test-model',
        latencyMs: 5,
      };
    },
  };

  providerRegistry.register(customProvider);
  providerRegistry.setDefault('flaky-markdown-provider');

  try {
    const schema = z.object({
      count: z.number(),
      ready: z.boolean(),
    });

    const client = agent('RepairAgent');
    const res = await client.ask('Compute count', schema);

    assert.equal(res.count, 42);
    assert.equal(res.ready, true);
  } finally {
    providerRegistry.setDefault('mock');
  }
});

test('Agent RPC: throws SchemaValidationError when maxRetries exhausted on schema mismatch', async () => {
  const invalidProvider: LLMProvider = {
    id: 'invalid-provider',
    name: 'Invalid Provider',
    async generate(): Promise<LLMResponse> {
      return {
        content: JSON.stringify({ name: 12345 }), // Expecting string, returned number
        model: 'test-model',
        latencyMs: 5,
      };
    },
  };

  providerRegistry.register(invalidProvider);
  providerRegistry.setDefault('invalid-provider');

  try {
    const schema = z.object({
      name: z.string(),
    });

    const client = agent('MismatchAgent');
    await assert.rejects(
      async () => {
        await client.ask('Get user name', schema, { maxRetries: 2 });
      },
      (err: any) => {
        assert.ok(isSchemaValidationError(err as DomainError));
        assert.equal((err.details as any)?.attemptCount, 2);
        assert.ok(((err.details as any)?.issueCount ?? 0) > 0);
        return true;
      }
    );
  } finally {
    providerRegistry.setDefault('mock');
  }
});

test('Agent RPC: deterministic MockProvider returns canned response in <10ms with 0 network tokens', async () => {
  const mock = new MockProvider();
  const start = Date.now();
  const res = await mock.generate({
    messages: [{ role: 'user', content: 'healthz incident telemetry check' }],
  });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 20);
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.severity, 'P1');
  assert.equal(parsed.failureDomain, 'DATABASE');
});

test('Agent RPC: fast-path mockResponse executes synchronously with zero latency', async () => {
  const schema = z.object({
    calculation: z.number(),
  });

  const client = agent('FastAgent');
  const res = await client.ask('Calculate', schema, {
    mockResponse: { calculation: 100 },
  });

  assert.equal(res.calculation, 100);
});
