import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../../../src/agent/rpc.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import type { LLMProvider } from '../../../src/types.js';

const requests: string[] = [];
const slowProvider: LLMProvider = {
  id: 'stall-test',
  name: 'Slow stall test provider',
  async generate(request) {
    requests.push(request.messages[request.messages.length - 1]?.content ?? '');
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { content: '{"ok":true}', model: 'slow-test', latencyMs: 120 };
  },
};
providerRegistry.register(slowProvider);

/** Permissive schema for untyped asks: keeps the runtime on the JSON path without shaping it. */
const passthrough = {
  parse: (data: unknown) => data,
  safeParse: (data: unknown) => ({ success: true as const, data }),
};

test('stallMs retries with a (Retry N) marker and throws StallError', async () => {
  requests.length = 0;
  await assert.rejects(
    () => agent('slow').ask('do the thing', passthrough, { providerId: 'stall-test', stallMs: 20, maxRetries: 2 }),
    /stalled — no progress for 20ms/
  );
  assert.equal(requests.length, 2, 'one initial attempt + one retry');
  assert.match(requests[0]!, /do the thing/);
  assert.match(requests[1]!, /\(Retry 1 after no progress for 20ms — continue the task\.\)/);
  assert.equal((requests[1]!.match(/\(Retry 1/g) ?? []).length, 1, 'the marker does not accumulate');
});

test('stallMs=0 disables the stall clock', async () => {
  const reply = await agent('slow').ask('do the thing', passthrough, { providerId: 'stall-test', stallMs: 0, maxRetries: 1 });
  assert.deepEqual(reply, { ok: true });
});