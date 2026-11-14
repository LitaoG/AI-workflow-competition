/**
 * Cross-engine benchmark mission (deliverable 4): ONE facade script that both
 * engines compile, lower and execute in-process against scripted fake models.
 *
 * Facade surface: the two engines' COMMON SUBSET only —
 *   agent(name), .ask (untyped), phase(literal), report(item), log(text)
 *   + plain TS (Promise.all, JSON.parse, array/string methods).
 * Deliberately NOT used (the two engines' semantics for them diverge):
 *   hole / typed ask<T> / escalate / fanout.* / sessions.* / artifact.* / world.*.
 *
 * Agent-name discipline: every agent() name is a compile-time literal and every
 * actor is held in a direct const (official facade siting rejects computed
 * names, and rejects .ask through a re-typed array element — both verified
 * during authoring; direct receiver calls pass both compilers).
 *
 * Multi-role adversarial topology:
 *   phase Plan        -> planner ask (scripted model replies with plan JSON)
 *   phase Research    -> 4-way researcher fanout (Promise.all), staggered
 *                        scripted latencies for the fanout decomposition
 *   phase CrossExamine-> adversarial round: each researcher challenges a
 *                        neighbour's finding (4-way fanout again)
 *   phase Verify      -> adversarial verifier with a script-level
 *                        malformed-JSON self-heal loop: the scripted model
 *                        returns bad JSON on rounds 1-2 and a legal JSON object
 *                        on round 3; the script re-asks up to 3 rounds.
 *
 * The scripted fake model (tests/cross-engine/scripted-model.mjs — driver-side
 * on the official engine, provider-side on ours) keys its deterministic replies
 * off the `key=value` markers embedded in these instructions, so both engines
 * see byte-identical model behavior. Final phase (Verify) holds the closing
 * report/log/return because both engines require every phase to contain an ask.
 */

phase('Plan');
const planner = agent('planner');
const planRaw = await planner.ask('mission=pool-outage step=plan round=1 produce the investigation plan');
const plan = JSON.parse(planRaw);
log('plan accepted: steps=' + plan.steps.length + ' owner=' + plan.owner);
report({ phase: 'Plan', steps: plan.steps, owner: plan.owner });

phase('Research');
const r1 = agent('researcher-1');
const r2 = agent('researcher-2');
const r3 = agent('researcher-3');
const r4 = agent('researcher-4');
const findings = await Promise.all([
  r1.ask('mission=pool-outage step=research round=1 target=logs'),
  r2.ask('mission=pool-outage step=research round=1 target=metrics'),
  r3.ask('mission=pool-outage step=research round=1 target=deploys'),
  r4.ask('mission=pool-outage step=research round=1 target=incidents'),
]);
log('research complete: findings=' + findings.length);
report({ phase: 'Research', findingCount: findings.length });

phase('CrossExamine');
const challenges = await Promise.all([
  r1.ask('mission=pool-outage step=cross round=2 target=metrics evidence=' + findings[1].slice(0, 48)),
  r2.ask('mission=pool-outage step=cross round=2 target=deploys evidence=' + findings[2].slice(0, 48)),
  r3.ask('mission=pool-outage step=cross round=2 target=incidents evidence=' + findings[3].slice(0, 48)),
  r4.ask('mission=pool-outage step=cross round=2 target=logs evidence=' + findings[0].slice(0, 48)),
]);
log('cross-examination complete: challenges=' + challenges.length);
report({ phase: 'CrossExamine', challengeCount: challenges.length });

phase('Verify');
const verifier = agent('verifier');
let verdict: { approve: boolean; riskScore: number; rejected: string[]; notes: string } | null = null;
let healRounds = 0;
for (let attempt = 1; attempt <= 3; attempt++) {
  healRounds = attempt;
  const raw = await verifier.ask(
    'mission=pool-outage step=verify round=' + attempt + ' findings=' + findings.length + ' challenges=' + challenges.length,
  );
  try {
    verdict = JSON.parse(raw);
    break;
  } catch {
    log('verifier round ' + attempt + ': malformed JSON - re-asking');
  }
}
if (verdict === null) {
  log('verifier exhausted 3 rounds without valid JSON');
}
report({ phase: 'Verify', verdict, healRounds });
log('mission complete: healRounds=' + healRounds);

return {
  plan,
  findingCount: findings.length,
  challengeCount: challenges.length,
  verdict,
  healRounds,
};
