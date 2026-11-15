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
  // Issue #29（Linux CI 取证）：原 Promise.all 早退拒绝 —— round 内 ask #1001 先拒绝时，
  // 其余 63 个在途请求被结构性抛下（未观察、未 await），脚本随即 return，子进程的
  // 「未 await 门」逮个正着。该竞态被平台时序掩盖：Windows 上 mock 回复聚成一批、
  // 全部送达后才走到检查（恒过），Linux 上 err 先到、脚本先行（恒炸）。
  // allSettled 观察每一个 ask —— 满足引擎的严格 await 契约，cap 检测语义不变。
  const results = await Promise.allSettled(agents.map((a) => a.ask('round ' + round + ' ping')));
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) {
    const e = (rejected as PromiseRejectedResult).reason as { name?: unknown; message?: unknown };
    capped = true;
    capName = typeof e?.name === 'string' ? e.name : '';
    capMessage = typeof e?.message === 'string' ? e.message : String(e ?? rejected.reason);
  } else {
    answered += agents.length;
  }
}
return { answered, capped, capName, capMessage };
