/**
 * (Issue #140): the engine-level trigger for the swarm
 * token-budget drop-slot. The budget is enforced at ask-entry granularity —
 * in-flight asks complete and account their spend ("in-flight agents will
 * complete; their results are preserved"), and every ask that ENTERS after the
 * spend rejects with WorkflowBudgetExceededError. The child realm's __swarm
 * converts exactly that rejection into a dropped null slot (child-main.ts);
 * ordinary failures still reject the swarm.
 *
 * Drives the same host-call frames the child realm sends, with the swarm flag
 * the swarm engine path consumes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { CallFrame, makeEngine, makeRespond, makeStore } from './test-helpers.js';

const respond = makeRespond('swarm-budget-mock');

const actorFrame = (id: number): CallFrame => ({ t: 'call', id, op: 'createActor', siteId: 'actor#1', payload: ['swarmer', null] });
const askFrame = (id: number, siteId: string, actor: unknown, prompt: string): CallFrame => ({
  t: 'call', id, op: 'ask', siteId, payload: [actor, prompt, null, true],
});

test('asks entering after the budget is spent reject with WorkflowBudgetExceededError (the swarm drop-slot trigger)', async () => {
  const prober: LLMProvider = {
    id: 'dwf-swarm-budget-provider',
    name: 'Swarm budget provider',
    async generate(): Promise<LLMResponse> {
      return respond('ok');
    },
  };
  providerRegistry.register(prober);
  const previous = providerRegistry.get().id;
  providerRegistry.setDefault(prober.id);
  const store = makeStore();
  try {
    const engine = makeEngine('dwfrun-swarm-budget-drop', store, { budgetTotal: 1 });
    const actor = await engine.handleCall(actorFrame(1));
    // Task 1 runs live and accounts its spend (2 tokens ≥ the total of 1).
    await engine.handleCall(askFrame(2, 'swarm#1', actor, 'first task'));
    // Every ask entering now hits the entry pre-check and rejects at the
    // engine boundary — the precondition __swarm's drop-slot conversion and
    // the summary log line ride on.
    const second = engine.handleCall(askFrame(3, 'swarm#1', actor, 'second task'));
    const third = engine.handleCall(askFrame(4, 'swarm#1', actor, 'third task'));
    // Domain errors are tagged plain objects (domain algebra), not Error
    // instances — match on the message and the rebuilt error name.
    const budgetRejection = async (p: Promise<unknown>): Promise<void> => {
      await assert.rejects(p, (e: { message?: string; details?: { errorName?: string } }) =>
        /budget/i.test(String(e?.message)) && e?.details?.errorName === 'WorkflowBudgetExceededError');
    };
    await budgetRejection(second);
    await budgetRejection(third);
  } finally {
    providerRegistry.setDefault(previous);
    store.close();
  }
});
