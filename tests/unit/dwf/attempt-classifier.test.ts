import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, backoffSleep } from '../../../src/dwf/attempt-classifier.js';
import { agent } from '../../../src/agent/rpc.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { z } from 'zod';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';

test('classifyFailure: rate_limit backoff, transient retryable, auth fatal, cancelled never retried', () => {
  const rate = classifyFailure(new Error('HTTP 429: too many requests'), 0);
  assert.equal(rate.category, 'rate_limit');
  assert.equal(rate.retryable, true);
  assert.equal(rate.backoffMs, 500);

  const rateSecond = classifyFailure(new Error('HTTP 429: too many requests'), 2);
  assert.equal(rateSecond.backoffMs, 2000, 'exponential in attempt');

  const transient = classifyFailure(new Error('ECONNRESET socket hang up'), 1);
  assert.equal(transient.category, 'transient');
  assert.equal(transient.retryable, true);

  const auth = classifyFailure(new Error('401 Unauthorized: invalid api key'), 0);
  assert.equal(auth.category, 'auth');
  assert.equal(auth.retryable, false);

  const aborted = classifyFailure(Object.assign(new Error('ask cancelled'), { name: 'AbortError' }), 0);
  assert.equal(aborted.category, 'cancelled');
  assert.equal(aborted.retryable, false);

  const hinted = classifyFailure(new Error('throttled; Retry-After: 3s'), 0);
  assert.equal(hinted.retryAfterMs, 3000, 'seconds parsed to ms');
});

test('backoffSleep is abort-aware', async () => {
  const controller = new AbortController();
  const sleeping = backoffSleep(5000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => sleeping, (e: Error) => e.name === 'AbortError');
});

test('rpc retry loop: a provider throwing 429 twice then succeeding recovers via backoff', async () => {
  let calls = 0;
  const flaky: LLMProvider = {
    id: 'dwf-flaky-429',
    name: 'Flaky provider',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls++;
      if (calls <= 2) throw new Error('HTTP 429: too many requests');
      return { content: JSON.stringify({ ok: true }), model: 'flaky', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1 };
    },
  };
  providerRegistry.register(flaky);
  const reply = await agent('resilient').ask<{ ok: boolean }>('say ok', z.object({ ok: z.boolean() }), { providerId: 'dwf-flaky-429', maxRetries: 4 });
  assert.deepEqual(reply, { ok: true });
  assert.equal(calls, 3, 'two rate-limited attempts, then success');
});

test('rpc retry loop: auth failures fail immediately without burning attempts', async () => {
  let calls = 0;
  const badAuth: LLMProvider = {
    id: 'dwf-bad-auth',
    name: 'Bad auth provider',
    async generate(): Promise<LLMResponse> {
      calls++;
      throw new Error('401 Unauthorized: invalid api key');
    },
  };
  providerRegistry.register(badAuth);
  await assert.rejects(
    () => agent('doomed').ask('x', z.object({}), { providerId: 'dwf-bad-auth', maxRetries: 4 }),
    /401 Unauthorized/,
  );
  assert.equal(calls, 1, 'auth failures are fatal on the first attempt');
});
