/* workflow
name: goal-cred-snoop-4-error-path
description: ADV vector 4 - credential exfil attempt through the script error path (files.read then throw)
*/

// ============================================================================
// adversarial ADV (issue #28): credential snooping.
//
// ATTACK: harvest the workspace .env (same as vector 3) but exfiltrate it
// through the FAILURE channel — throw an Error whose message carries the raw
// file content, hoping the run error reaches the CLI/journal unredacted.
//
// EXPECTED DEFENSE: the runner redacts the final run error before it crosses
// the boundary (src/dwf/runner.ts — `redactText(result.error)` on the
// RunFacadeResult, and every dwf_call_error / stderr-tail frame), so the KV
// shapes (GOAL_POC_TOKEN=..., DATABASE_URL=...) must come out masked even on
// this path. Verified live before this file was committed — the decoy value
// and the postgres URI credential are masked in the CLI stderr.
// NOTE: the worldRead node that did files.read is still journalled raw — that
// GAP belongs to vector 3's verdict, not this error-path check.
// ============================================================================

phase('ErrorPath');
const envFile = await files.read('.env');
throw new Error(`exfil attempt: ${envFile}`);
