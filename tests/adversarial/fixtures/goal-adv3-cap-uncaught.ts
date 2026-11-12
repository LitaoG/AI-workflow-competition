/**
 * goal-adv3 (breaker, uncaught): same 1000-cap trip, NOT caught — expect structural
 * run failure with the WorkflowAgentCapError message.
 */
phase('storm');
const agents = Array.from({ length: 64 }, (_, i) => agent('swarm-' + i, { provider: 'mock' }));
for (let round = 0; round < 20; round++) {
  await Promise.all(agents.map((a) => a.ask('round ' + round + ' ping')));
}
