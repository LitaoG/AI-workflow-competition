/**
 * AIMD concurrency governor (P2/#37) — the four-layer discipline verified by the
 * adversarial AIMD regression suites:
 *
 *   Layer 1 — bucket key `${providerId}/${modelId}`: actors bound to a model
 *     (Issue #38) get their own bucket; unbound actors share the provider's
 *     self-map bucket (key = providerId alone, the legacy shape).
 *   Layer 2 — epoch batch damping (a 429 only judges the cap it was admitted
 *     under — old-epoch signals damp without shrinking) + the lastGood/lastBad
 *     two-tier decrease: a 429 ABOVE the proven watermark falls back to it
 *     (recording lastBad, no multiplicative penalty); at or below it the cap
 *     multiplies by 0.75 (recording lastBad = the old cap and CLEARIING
 *     lastGood — it was just falsified and the new cap is unproven). Successes
 *     only count toward the streak in their admission epoch, and only a
 *     COMPLETED streak proves lastGood.
 *   Layer 3 — initial (the starting point AND the idle-reset landing point,
 *     default concurrency D) vs growthLimit (the auto-growth ceiling, raised
 *     by run registration via registerRunBound and re-derived by ONE retune
 *     routine from the active run bounds — run start, run exit and the seed
 *     path all funnel through it): growth waits for waiters > 0 and tops out
 *     at growthLimit.
 *   Layer 4 — outcome classes from the attempt classifier: throttled (rate
 *     limits — cap verdicts), transient (stall/timeout/5xx/network — clears
 *     the streak, never moves the cap), ended (AbortError / permanent
 *     failures — inFlight accounting ONLY; an aborted ask is never a success
 *     and never judges the cap), success (additive path). Per-attempt slots:
 *     each retry loop iteration re-acquires, so no held slot spans retries.
 *
 * Retry-After cooldown honoured; idle reset forgets learned caps back to
 * `initial` (idempotent — a clean bucket does not re-flip the epoch).
 */
import { parseRetryAfterMs } from '../agent/attempt-classifier.js';

export interface AimdOptions {
  /** Starting-point concurrency per key, D (default 8) — also the idle-reset landing point. */
  maxPerProvider?: number;
  /** Consecutive (current-epoch) successes before +1 additive increase (default 4). */
  increaseAfter?: number;
  /** Multiplicative decrease factor on failure (default 0.75). */
  decreaseFactor?: number;
  /** Idle minutes before a bucket resets to initial (default 5). */
  idleResetMinutes?: number;
}

/**
 * Ask outcome classes (Issue #37 layer 4). 'failure' is kept as an alias for
 * 'throttled' — the historical call shape meant "a rate-limit verdict".
 */
export type AimdOutcome = 'success' | 'throttled' | 'transient' | 'ended' | 'failure';

export interface AimdReleaseOptions {
  modelId?: string;
  retryAfterMs?: number;
}

export interface AimdAcquireOptions {
  modelId?: string;
  /** The calling run's identity — keys the per-run growth bound. */
  runId?: string;
  /** The calling run's concurrency bound — raises the bucket's growthLimit. */
  runBound?: number;
}

interface Bucket {
  key: string;
  /** Starting point and idle-reset landing point (default concurrency D). */
  initial: number;
  /** Auto-growth ceiling; ≥ initial. Derived from active run bounds. */
  growthLimit: number;
  /** Current allowed concurrency for this key. */
  limit: number;
  inFlight: number;
  successStreak: number;
  epoch: number;
  /** Admission epoch of each in-flight ask, FIFO — shift() pairs each outcome with its admission. */
  admittedEpochs: number[];
  lastGood?: number;
  lastBad?: number;
  lastThrottledAt: number;
  cooldownUntil: number;
  cooldownTimer?: ReturnType<typeof setTimeout>;
  lastUsedAt: number;
  waiters: Array<() => void>;
  /** Per-run concurrency bounds registered against this key (runId → bound). */
  runBounds: Map<string, number>;
}

export class AimdGovernor {
  private readonly buckets = new Map<string, Bucket>();
  private readonly initial: number;
  private readonly increaseAfter: number;
  private readonly decreaseFactor: number;
  private readonly idleResetMs: number;

  constructor(options: AimdOptions = {}) {
    this.initial = options.maxPerProvider ?? 8;
    this.increaseAfter = options.increaseAfter ?? 4;
    this.decreaseFactor = options.decreaseFactor ?? 0.75;
    this.idleResetMs = (options.idleResetMinutes ?? 5) * 60_000;
  }

  /** Bucket key: provider/model granularity when the ask carries a model (layer 1). */
  static keyFor(providerId: string, modelId?: string): string {
    return modelId === undefined || modelId === '' ? providerId : `${providerId}/${modelId}`;
  }

  /** Wait until the key's bucket has a free slot, then charge it. FIFO per bucket. */
  async acquire(providerId: string, opts: AimdAcquireOptions = {}): Promise<void> {
    const bucket = this.bucketFor(providerId, opts.modelId);
    if (opts.runId !== undefined && opts.runBound !== undefined) {
      this.registerRunBoundOn(bucket, opts.runId, opts.runBound);
    }
    this.resetIfIdle(bucket);
    while (true) {
      const now = Date.now();
      const cooling = bucket.cooldownUntil > now;
      if (!cooling && bucket.inFlight < bucket.limit) {
        bucket.inFlight++;
        bucket.admittedEpochs.push(bucket.epoch);
        bucket.lastUsedAt = now;
        return;
      }
      if (cooling) {
        // nothing else will drain this bucket — wake the waiters when the cooldown ends
        const remaining = bucket.cooldownUntil - now;
        if (remaining > 0 && !bucket.cooldownTimer) {
          bucket.cooldownTimer = setTimeout(() => {
            bucket.cooldownTimer = undefined;
            this.drain(bucket);
          }, remaining + 5);
          // deliberately referenced: while waiters are parked on a bounded cooldown,
          // this timer is the only thing keeping the event loop alive for them
        }
      }
      await new Promise<void>((resolve) => bucket.waiters.push(resolve));
    }
  }

  /** Report an ask outcome (layer 4 classes). */
  release(providerId: string, outcome: AimdOutcome, opts: AimdReleaseOptions | number = {}): void {
    const modelId = typeof opts === 'number' ? undefined : opts.modelId;
    const retryAfterMs = typeof opts === 'number' ? opts : opts.retryAfterMs;
    const bucket = this.buckets.get(AimdGovernor.keyFor(providerId, modelId));
    if (!bucket) return;
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    const admittedEpoch = bucket.admittedEpochs.shift();
    bucket.lastUsedAt = Date.now();
    const cls = outcome === 'failure' ? 'throttled' : outcome;

    if (cls === 'success') {
      // layer 2: only a current-epoch success counts toward the streak — an
      // old-epoch success proves the OLD (already cut) cap, not this one.
      if (admittedEpoch !== undefined && admittedEpoch === bucket.epoch) {
        bucket.successStreak++;
        if (bucket.successStreak >= this.increaseAfter) {
          // a completed streak proves this cap sustainable — record it before growing
          if (bucket.lastGood === undefined || bucket.limit > bucket.lastGood) bucket.lastGood = bucket.limit;
          bucket.successStreak = 0;
          // layer 3: grow only under demand, and never past the growthLimit
          if (bucket.waiters.length > 0 && bucket.limit < bucket.growthLimit) {
            bucket.limit = Math.min(bucket.growthLimit, bucket.limit + 1);
          }
        }
      }
    } else if (cls === 'throttled') {
      bucket.successStreak = 0;
      bucket.lastThrottledAt = Date.now();
      if (retryAfterMs !== undefined && retryAfterMs > 0) {
        bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + retryAfterMs);
      }
      // layer 2: only a 429 from the current generation judges the cap
      if (admittedEpoch !== undefined && admittedEpoch === bucket.epoch) {
        const previous = bucket.limit;
        if (bucket.lastGood !== undefined && bucket.limit > bucket.lastGood) {
          // probing above the proven watermark: fall back to it, no multiplicative penalty
          bucket.lastBad = previous;
          bucket.limit = bucket.lastGood;
        } else {
          bucket.limit = Math.max(1, Math.floor(bucket.limit * this.decreaseFactor));
          bucket.lastBad = previous;
          // the watermark was just falsified and the new cap is unproven
          bucket.lastGood = undefined;
        }
        // flip even when the value didn't change: the batch gets exactly one verdict
        bucket.epoch++;
      }
    } else if (cls === 'transient') {
      // stall/timeout/5xx/network: the provider is NOT at a concurrency wall —
      // clear the streak, keep the cap.
      bucket.successStreak = 0;
    }
    // 'ended': inFlight accounting only — an aborted or permanently-failed ask
    // is never a success and never judges the cap (canonical `ended` semantics).
    this.drain(bucket);
  }

  /**
   * Register (or update) a run's concurrency bound against a key — the
   * canonical growthLimit derivation: max(2D, the largest bound among the
   * in-flight runs using this key). A RAISED bound also seeds the cap toward
   * it (skipped within the idle window after any throttle — seeding into a
   * wall just re-loses a batch); a LOWERED bound pulls the cap down on the
   * spot so a big run's learned cap never leaks to later default runs.
   */
  registerRunBound(providerId: string, runId: string, runBound: number, modelId?: string): void {
    const bucket = this.bucketFor(providerId, modelId);
    this.registerRunBoundOn(bucket, runId, runBound);
  }

  /** The run settled — its bound leaves every bucket's derivation (one retune per key). */
  retireRun(runId: string): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.runBounds.delete(runId)) this.retune(bucket);
    }
  }

  /** Current snapshot for doctor / tests. */
  snapshot(): Array<{
    providerId: string;
    key: string;
    initial: number;
    growthLimit: number;
    limit: number;
    inFlight: number;
    waiters: number;
    cooldownUntil: number;
    epoch: number;
    lastGood?: number;
    lastBad?: number;
    lastThrottledAt: number;
  }> {
    return [...this.buckets.values()].map((b) => ({
      providerId: b.key.includes('/') ? b.key.slice(0, b.key.indexOf('/')) : b.key,
      key: b.key,
      initial: b.initial,
      growthLimit: b.growthLimit,
      limit: b.limit,
      inFlight: b.inFlight,
      waiters: b.waiters.length,
      cooldownUntil: b.cooldownUntil,
      epoch: b.epoch,
      lastGood: b.lastGood,
      lastBad: b.lastBad,
      lastThrottledAt: b.lastThrottledAt,
    }));
  }

  private bucketFor(providerId: string, modelId?: string): Bucket {
    const key = AimdGovernor.keyFor(providerId, modelId);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        initial: this.initial,
        growthLimit: this.initial,
        limit: this.initial,
        inFlight: 0,
        successStreak: 0,
        epoch: 0,
        admittedEpochs: [],
        lastThrottledAt: 0,
        cooldownUntil: 0,
        lastUsedAt: Date.now(),
        waiters: [],
        runBounds: new Map(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private registerRunBoundOn(bucket: Bucket, runId: string, runBound: number): void {
    const previous = bucket.runBounds.get(runId);
    if (previous === runBound) return;
    bucket.runBounds.set(runId, runBound);
    const derived = this.deriveGrowthLimit(bucket);
    const raised = derived > bucket.growthLimit;
    this.retune(bucket);
    if (raised) this.seed(bucket, derived);
  }

  /** Layer 3's single retune routine — run registration, run exit and seed all land here. */
  private retune(bucket: Bucket): void {
    const next = this.deriveGrowthLimit(bucket);
    bucket.growthLimit = Math.max(bucket.initial, next);
    if (bucket.limit <= bucket.growthLimit) return;
    // lower the cap on the spot (canonical setGrowthLimit): a big run's learned
    // cap must not leak to later default runs until the idle reset.
    bucket.limit = bucket.growthLimit;
    if (bucket.lastGood !== undefined && bucket.lastGood > bucket.limit) bucket.lastGood = bucket.limit;
    bucket.successStreak = 0;
    bucket.epoch++;
  }

  private deriveGrowthLimit(bucket: Bucket): number {
    let maxBound = 0;
    for (const bound of bucket.runBounds.values()) maxBound = Math.max(maxBound, bound);
    if (bucket.runBounds.size === 0) return bucket.initial;
    return Math.max(2 * bucket.initial, maxBound);
  }

  /** Seeding: jump the cap toward a raised bound instead of climbing K-success steps. */
  private seed(bucket: Bucket, target: number): void {
    const next = Math.min(bucket.growthLimit, Math.floor(target));
    if (next <= bucket.limit) return;
    if (
      bucket.lastThrottledAt !== 0 &&
      Date.now() - bucket.lastThrottledAt < this.idleResetMs
    ) {
      return; // recently throttled: climbing normally beats re-charging a wall
    }
    bucket.limit = next;
    bucket.lastGood = undefined; // the seed point is a new start, not a probe above the watermark
    bucket.lastBad = undefined;
    bucket.successStreak = 0;
    bucket.epoch++;
  }

  private resetIfIdle(bucket: Bucket): void {
    if (bucket.inFlight === 0 && bucket.lastUsedAt > 0 && Date.now() - bucket.lastUsedAt > this.idleResetMs) {
      bucket.limit = bucket.initial;
      bucket.successStreak = 0;
      bucket.cooldownUntil = 0;
      bucket.lastGood = undefined;
      bucket.lastBad = undefined;
      bucket.lastThrottledAt = 0;
      bucket.admittedEpochs = [];
      bucket.epoch++;
      // stamp the reset itself so one idle stretch flips the epoch exactly once
      bucket.lastUsedAt = Date.now();
    }
  }

  private drain(bucket: Bucket): void {
    while (bucket.waiters.length > 0) {
      const next = bucket.waiters.shift()!;
      next();
    }
  }
}

/** Shared governor instance — one per process, across runs (matches ZCode's process-level governor). */
export const aimdGovernor = new AimdGovernor();

/**
 * True when the provider signals rate-limit pressure (used by the engine to pick the
 * Retry-After cooldown). Providers that don't model it simply report failure.
 */
export function retryAfterFromError(err: unknown): number | undefined {
  // G6 fix: shares the single parser (bare numbers are seconds, not ms —
  // 'Retry-After: 30' must freeze the bucket for 30s, not 30ms).
  return parseRetryAfterMs((err as Error)?.message ?? '');
}
