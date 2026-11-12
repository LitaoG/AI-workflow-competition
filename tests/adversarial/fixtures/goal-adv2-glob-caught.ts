/**
 * goal-adv2 (caught form): same 3000-file bomb; the script catches the rejection and
 * returns it as the run value.
 *
 * Expected defense: the cap surfaces as a catchable Promise rejection carrying the
 * cap message — the run survives and completes.
 *
 * (Observability note: script-level log()/report() content is dropped by the child
 * realm — child-main.ts:95-96 forwards the lowered site id (lower.ts:137-141) as the
 * payload — so these PoCs carry their observations in the run's RETURN VALUE, which
 * survives intact: runner.ts:431 finish({status:'completed', value: frame.value}).)
 */
phase('bomb');
try {
  const all = await files.glob('*.txt');
  return { matched: all.length };
} catch (err) {
  return { caught: err instanceof Error ? err.message : String(err) };
}
