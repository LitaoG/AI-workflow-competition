import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../../../src/agent/rpc.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { z } from 'zod';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';

/** Provider that fails with a chosen error a chosen number of times, then succeeds. */
function makeFailingProvider(id: string, failTimes: number, error: Error): LLMProvider {
  let calls = 0;
  return {
    id,
    name: id,
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      calls++;
      if (calls <= failTimes) throw error;
      return { content: '{"ok":true}', model: id, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1 };
    },
  };
}

test('retry policy: a fatal-category failure retries when the policy opts it in', async () => {
  // A plain Error classifies as fatal (not retryable by default) — but the policy
  // explicitly allows retrying fatal failures (e.g. provider bugs worth one re-roll).
  providerRegistry.register(makeFailingProvider('dwf-policy-fatal', 1, new Error('provider returned garbage frame')));
  const reply = await agent('policy-opt-in').ask<{ ok: boolean }>('say ok', z.object({ ok: z.boolean() }), {
    providerId: 'dwf-policy-fatal',
    maxRetries: 3,
    retryPolicy: { retryOn: ['fatal'], backoffMs: 1 },
  });
  assert.deepEqual(reply, { ok: true }, 'the policy allowed the fatal failure to retry');
});

test('retry policy: transient failures stay retryable and respect policy.maxRetries', async () => {
  providerRegistry.register(makeFailingProvider('dwf-policy-transient', 2, new Error('ECONNRESET socket hang up')));
  await assert.rejects(
    () => agent('policy-capped').ask('x', z.object({}), { providerId: 'dwf-policy-transient', maxRetries: 5, retryPolicy: { maxRetries: 2, backoffMs: 1 } }),
    /ECONNRESET/,
    'policy.maxRetries=2 caps the loop even though the caller allowed 5',
  );
});
