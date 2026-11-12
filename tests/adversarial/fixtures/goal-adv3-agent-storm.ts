/**
 * goal-adv3 (scheduling storm): 64 subagents created up front, each ask()ed once,
 * all in flight concurrently via Promise.all (run with maxConcurrency 4, the CLI
 * default, to mirror the live ADV run).
 *
 * Expected defense (src/dwf/engine.ts:418-431 withAskSeat FIFO seat gate +
 * src/dwf/governor.ts AIMD bucket): the run completes, all 64 asks execute exactly
 * once, dispatch bounded by the seat; mock never trips AIMD (governor.ts:4).
 *
 * (Return-value observability: see goal-adv2-glob-caught.ts note.)
 */
phase('storm');
const agents = Array.from({ length: 64 }, (_, i) => agent('swarm-' + i, { provider: 'mock' }));
const results = await Promise.all(agents.map((a, i) => a.ask('storm report #' + i)));
return { answered: results.length };
