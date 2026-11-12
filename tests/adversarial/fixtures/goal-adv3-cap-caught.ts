/**
 * goal-adv3 (breaker, caught): 64 agents x 20 rounds = 1280 attempted asks — past the
 * engine's 1000-call cap (src/dwf/engine.ts:124, 286-294). Expected defense: ask #1001
 * rejects with WorkflowAgentCapError (catchable); the run survives and returns the cap
 * observation as its value.
 *
 * Realm note: the child rebuilds host errors in the OUTER context (child-main.ts:263-267),
 * so inside the vm realm `err instanceof Error` is false (different Error constructor) —
 * read name/message off the caught value structurally, as below.
 *
 * (Return-value observability: see goal-adv2-glob-caught.ts note.)
 */
phase('storm');
const agents = Array.from({ length: 64 }, (_, i) => agent('swarm-' + i, { provider: 'mock' }));
let answered = 0;
let capped = false;
let capName = '';
let capMessage = '';
for (let round = 0; round < 20 && !capped; round++) {
  try {
    await Promise.all(agents.map((a) => a.ask('round ' + round + ' ping')));
    answered += agents.length;
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown };
    capped = true;
    capName = typeof e?.name === 'string' ? e.name : '';
    capMessage = typeof e?.message === 'string' ? e.message : String(err);
  }
}
return { answered, capped, capName, capMessage };
