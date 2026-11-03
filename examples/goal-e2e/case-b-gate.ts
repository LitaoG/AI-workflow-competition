/* workflow
name: case-b-gate
description: Case B (goal-e2e): a must-fail type gate runs via world.run, the run parks on the real escalate() primitive, and `workflow answer` from another terminal resumes it to completion.
*/

// Gate step: typecheck a scratch file that carries a DELIBERATE type error, so
// this gate must fail. The command name ("node") is a compile-time string
// literal — it lands in the run's approved command set; everything runtime-
// dependent stays in the args array (facade rule: fixed argv, never a shell).
phase("Gate");
const gate = await world.run(
  "node",
  ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--pretty", "false", "examples/goal-e2e/scratch/bad.ts"],
  { timeoutMs: 120000 },
);
log(`gate exit code: ${gate.exitCode}`);
const firstError = gate.stdout.split("\n").find((l) => l.includes("error TS")) ?? "";
log(`first diagnostic: ${firstError}`);

// A healthy gate would end the run here without human attention.
if (gate.exitCode === 0) {
  return { case: "B", gate: "passed (unexpected - scratch file is broken)", escalated: false };
}

// The gate failed: park the run on the real escalation primitive until the run
// owner answers from another terminal:
//   node bin/workflow.js answer <runId> <questionId> "<text>"
phase("Escalate");
const answer = await escalate(
  `Case B gate FAILED: tsc exited ${gate.exitCode} on examples/goal-e2e/scratch/bad.ts (${firstError || "no diagnostic captured"}). Reply "approve: <how to proceed>" to let the flow continue, or "reject" to stop it.`,
);
log(`owner answered: ${answer}`);

// Post-approval step: on the resumed run this site is NEW (not journalled), so
// it executes live — proving the flow really continued past the park.
phase("Resume");
const verify = await world.run("node", ["-e", "console.log('case-b: gate recovered, flow complete')"], { timeoutMs: 30000 });
log(`verify exit code: ${verify.exitCode}, stdout: ${verify.stdout.trim()}`);

return {
  case: "B",
  gateExit: gate.exitCode,
  firstDiagnostic: firstError,
  ownerAnswer: answer,
  verifyExit: verify.exitCode,
  verifyStdout: verify.stdout.trim(),
};
