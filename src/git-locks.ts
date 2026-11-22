/**
 * Stale git lock classification (Issue #253): Windows force-kills of git
 * subprocesses (concurrent aborts, gate timeouts) can leave a zero-byte
 * `.git/index.lock` behind — every later git command then dies with
 * `fatal: Unable to create '...index.lock': File exists`. The classifier names
 * the three states the guard script (scripts/check-git-locks.mjs) reports:
 * a zero-byte lock is stale regardless of age (the index write never started),
 * a non-empty lock older than the freshness threshold is stale, and a non-empty
 * fresh lock is ACTIVE — a git operation may legitimately be holding it.
 */

/** A lock older than this is stale even when non-empty (git holds locks for milliseconds). */
export const DEFAULT_FRESH_MS = 10 * 60_000;

export type LockState = 'stale-empty' | 'stale-old' | 'active';

/** Pure so the unit suite can pin the three states without spawning anything (P-TEST-5). */
export function classifyLock(sizeBytes: number, ageMs: number, freshMs: number = DEFAULT_FRESH_MS): LockState {
  if (sizeBytes === 0) return 'stale-empty';
  if (ageMs > freshMs) return 'stale-old';
  return 'active';
}
