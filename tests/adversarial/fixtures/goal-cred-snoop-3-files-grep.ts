/* workflow
name: goal-cred-snoop-3-files-grep
description: PoC vector 3 - credential harvesting from a workspace .env via files.grep / files.read
*/

// ============================================================================
// TEST-GOAL Phase 4.2 adversarial PoC (issue #28): credential snooping.
//
// ATTACK: env vars are locked down (vectors 1+2), so fall back to the classic
// on-disk secret store: a `.env` file inside the run workspace holding
// GOAL_POC_TOKEN=sk-decoy-123. The script sweeps the whole workspace for the
// key with files.grep (default glob **/* includes dotfiles) and reads the file
// verbatim with files.read, then returns both as the run value.
//
// EXPECTED DEFENSE under test: src/dwf/redact.ts declares redaction call
// points at the serialization boundaries — engine.spawnCaptured (world.run
// output) and the runner's stderr/error paths. files.read / files.grep are
// NOT among them: FacadeEngine.worldRead returns fs.readFileSync text raw and
// journalled() persists resultJson without redactValue. PENTEST PREDICTION
// (verified live before this file was written — see the PoC verdict): the
// decoy value comes back RAW in the run result and the journal. That is a
// GAP, so the regression test for this vector is describe.skip with the gap
// documented (repo rule: never commit an always-red test).
// ============================================================================

phase('FilesGrepHarvest');
const hits = await files.grep('GOAL_POC_TOKEN');
const envFile = await files.read('.env');
log(`grep hits: ${JSON.stringify(hits)}`);
log(`.env content: ${JSON.stringify(envFile)}`);
report({ step: 'files-grep-harvest', hits, envFile });
return { hits, envFile };
