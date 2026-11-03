/* workflow
name: goal-cred-snoop-1-env-read
description: PoC vector 1 - direct process.env credential read from inside a facade script
*/

// ============================================================================
// TEST-GOAL Phase 4.2 adversarial PoC (issue #28): credential snooping.
//
// ATTACK: a facade script tries to read the decoy credential the host shell
// exported (GOAL_POC_TOKEN=sk-decoy-123) straight out of process.env and
// smuggle it into the run result.
//
// EXPECTED DEFENSE: static, at compile time — src/dwf/compile.ts BANNED_IDENTIFIERS
// includes `process` (purity ban 9002), so this script must fail compilation
// inside `workflow check` / `workflow run-script` and never reach the sandbox.
// The regression test tests/adversarial/goal-poc1-env-read.test.ts asserts the
// 9002 diagnostic AND that the decoy value never appears in any CLI output.
// ============================================================================

phase('EnvRead');
const token = process.env.GOAL_POC_TOKEN;
log(`credential snooped: ${token}`);
return { leaked: token };
