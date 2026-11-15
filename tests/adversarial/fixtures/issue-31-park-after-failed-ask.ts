/**
 * Issue #31 (2026-11-15, park deadlock) attack fixture: a doomed ask fails
 * (its provider always throws an unrecognized message → classifier fatal,
 * non-retryable, NOT a policy stop), the script CATCHES the rejection and
 * proceeds to a hole.
 *
 * Before the fix the failed ask leaked the runner's inFlightAsks slot: the
 * success-only dwf_ask_complete (ask-executor.ts) never fired and the runner's
 * dwf_node_failed decrement required cancelled:true, so engineIdle() stayed
 * false forever, maybePark's first guard returned, the 10s fallback never
 * armed, and the run hung to the whole-run killTimer as `failed` —
 * fillHoleAndRun then refused it (only parked runs are fillable).
 *
 * After the fix the run parks at the hole; the fill fork replays the
 * journalled failure (replayed:true — the counter's exclusion case) into the
 * catch and completes through the spliced body.
 *
 * Numbering note: an older, CLOSED issue also carried #31 (the ADV4
 * microtask-escape preseed, 2026-11-02); this fixture tracks the NEW open
 * issue #31 (park deadlock) — the two files' "Issue #31" references are
 * unrelated.
 *
 * (Return-value observability: the parked run's value is the park envelope,
 * so the catch observation rides the FILL fork's return value — the spliced
 * body closes over the script's bindings.)
 */
phase('doomed');
let doomedAskFailed = false;
let doomedFailureName = '';
try {
  const verdict = await agent('doomed-agent', { provider: 'doomed-fail-test' }).ask<Verdict>('produce the verdict');
  log('unexpected success: ' + JSON.stringify(verdict));
} catch (err) {
  const e = err as { name?: unknown; message?: unknown };
  if (!doomedAskFailed) {
    doomedAskFailed = true;
    doomedFailureName = typeof e?.name === 'string' ? e.name : '';
  }
}
phase('park');
const answer = await hole<string>('await-human', 'awaiting a human fill');
return { doomedAskFailed, doomedFailureName, answer };

interface Verdict { verdict: string; }
