/* workflow
name: goal-cred-snoop-2-worldrun
description: PoC vector 2 - side-channel credential readback via world.run subprocess env
*/

// ============================================================================
// TEST-GOAL Phase 4.2 adversarial PoC (issue #28): credential snooping.
//
// ATTACK: the facade script cannot touch process.env itself (vector 1 is
// statically banned), so it delegates to a grandchild process through
// world.run and asks the OS for the env instead:
//   node -e 'console.log("TOKEN=" + process.env.GOAL_POC_TOKEN)'
// plus a full dump of the key names the grandchild actually received, so the
// pentest report can show exactly which env keys cross the sandbox boundary.
//
// EXPECTED DEFENSE (two layers):
// 1. NAME whitelist — the grandchild is spawned by FacadeEngine.spawnCaptured
//    (src/dwf/engine.ts) with envAllowlist [GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
//    GIT_DIR, GIT_WORK_TREE, NODE_ENV] on top of the platform base; and the
//    sandbox child itself gets buildSandboxEnv() (src/dwf/runner.ts) — a
//    whitelisted AND value-masked env. GOAL_POC_TOKEN is in neither list, so
//    the decoy never crosses the boundary by NAME: TOKEN=undefined.
// 2. VALUE redaction at the source — engine.ts resolve() passes stdout/stderr
//    through redactText (src/dwf/redact.ts) before the script or the journal
//    ever sees them: any `TOKEN=<value>` KV shape becomes TOKEN=***REDACTED***.
//
// The regression test tests/adversarial/goal-poc2-worldrun.test.ts asserts the
// decoy value appears in NO output, and that the grandchild env key dump shows
// the decoy key absent.
// ============================================================================

phase('WorldRunSideChannel');
const res = await world.run('node', [
  '-e',
  'console.log("TOKEN=" + String(process.env.GOAL_POC_TOKEN)); console.log("ENV_KEYS=" + JSON.stringify(Object.keys(process.env).sort()))',
]);
log(`world.run exit=${res.exitCode}`);
log(`world.run stdout: ${res.stdout}`);
report({ step: 'worldrun-sidechannel', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr });
return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
