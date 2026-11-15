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
  const roundAsks = agents.map((a) => a.ask('round ' + round + ' ping'));
  try {
    await Promise.all(roundAsks);
    answered += agents.length;
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown };
    capped = true;
    capName = typeof e?.name === 'string' ? e.name : '';
    capMessage = typeof e?.message === 'string' ? e.message : String(err);
    // Promise.all rejects on the FIRST failure and abandons its siblings: at the
    // cap-boundary round the under-cap asks' ok replies are still crossing the
    // pipe when the script returns, so the done-time in-flight sentinel net
    // (child-main.ts getPending) races the pipe and intermittently fails the
    // run — the script-level twin of the sessions.waitAny loser exemption
    // (comp Issue #17). Drain the round before returning, mirroring the
    // budget-stop philosophy: "In-flight agents will complete; their results
    // are preserved."
    await Promise.allSettled(roundAsks);
  }
}
return { answered, capped, capName, capMessage };
