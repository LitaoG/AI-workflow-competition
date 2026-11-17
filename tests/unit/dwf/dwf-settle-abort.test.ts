/**
 * Issue #107: settle aborts in-flight asks (phenomenon B). The gated
 * provider honors the signal the engine passes down, so abortInFlight
 * unwinds the round trips, empties the controller registry, and wakes seat
 * waiters straight into their (already aborted) asks — nothing bills past
 * the settle point. The abort is observable via dwf_inflight_abort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { CallFrame, makeEngine, makeRespond, makeStore } from './test-helpers.js';

const respond = makeRespond('settle-abort-mock');

const actorFrame = (id: number): CallFrame => ({ t: 'call', id, op: 'createActor', siteId: 'actor#1', payload: ['settler', null] });
const askFrame = (id: number, actor: unknown, prompt: string): CallFrame => ({
  t: 'call', id, op: 'ask', siteId: 'swarm#1', payload: [actor, prompt, null, true],
});

/** Gated provider: 'stall' prompts park until the signal aborts them. */
function gatedProvider(): LLMProvider & { started: number } {
  return {
    id: 'settle-abort-provider',
    name: 'Settle abort provider',
    started: 0,
    async generate(request: LLMRequest): Promise<LLMResponse> {
      this.started += 1;
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('stall')) {
        await new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) return reject(abortErr());
          request.signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
        });
      }
      return respond('ok');
    },
  };
}

function abortErr(): Error {
  const e = new Error('aborted by settle');
  e.name = 'AbortError';
  return e;
}

test('abortInFlight unwinds gated asks, empties the registry, and wakes seat waiters', async () => {
  const provider = gatedProvider();
  providerRegistry.register(provider);
  const previous = providerRegistry.get().id;
  providerRegistry.setDefault(provider.id);
  const store = makeStore();
  const events: Array<{ type: string; data?: { aborted?: number } }> = [];
  try {
    const engine = makeEngine('dwfrun-settle-abort', store, {
      maxConcurrency: 1,
      onEvent: (e) => events.push(e as never),
    });
    const actor = await engine.handleCall(actorFrame(1));
    // seat 1: in-flight gated ask; seat 2: queued waiter behind it
    const first = engine.handleCall(askFrame(2, actor, 'stall please')) as Promise<unknown>;
    const second = engine.handleCall(askFrame(3, actor, 'stall too')) as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 30));

    engine.abortInFlight();

    const settle = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'resolved';
      } catch (err) {
        return (err as Error).name === 'AbortError' ? 'aborted' : `other:${String((err as Error).message).slice(0, 40)}`;
      }
    };
    const [firstOutcome, secondOutcome] = await Promise.all([settle(first), settle(second)]);
    assert.equal(firstOutcome, 'aborted', 'the in-flight gated ask unwound as an AbortError');
    assert.equal(secondOutcome, 'aborted', 'the seat waiter unwound as an AbortError too');
    assert.equal(provider.started, 1, 'only the first ask ever reached the provider — the waiter was rejected at the rpc pre-flight check without billing');
    const abortEvent = events.find((e) => e.type === 'dwf_inflight_abort');
    assert.ok(abortEvent, 'the abort is observable');
    assert.equal(abortEvent!.data?.aborted, 2, 'both controllers counted');
    assert.ok(engine.inFlightSize() === 0, 'the controller registry is empty');
  } finally {
    providerRegistry.setDefault(previous);
    store.close();
  }
});
