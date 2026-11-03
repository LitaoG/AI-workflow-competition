/**
 * AIMD concurrency governor (P2) — one bucket per registered provider, completing the
 * three-layer concurrency model (ask seat gate → run seat gate → process governor in
 * ZCode). Additive Increase after consecutive successes, Multiplicative Decrease on
 * failures, Retry-After cooldown honoured, idle reset. Providers without signals
 * (mock) never trip it.
 *
 * The engine consults the governor before dispatching an ask to a routed provider and
 * reports the outcome afterwards; a held ask waits FIFO like the seat gate.
 */
import { providerRegistry } from '../agent/provider.js';
import { parseRetryAfterMs } from './attempt-classifier.js';

export interface AimdOptions {
  /** Concurrency ceiling per provider (default 8). */
  maxPerProvider?: number;
  /** Consecutive successes before +1 additive increase (default 4). */
  increaseAfter?: number;
  /** Multiplicative decrease factor on failure (default 0.75). */
  decreaseFactor?: number;
  /** Idle minutes before a bucket resets to max (default 5). */
  idleResetMinutes?: number;
}

interface Bucket {
  /** Current allowed concurrency for this provider. */
  limit: number;
  /** In-flight asks charged to this bucket. */
  inFlight: number;
  /** Consecutive successes since the last decrease. */
  successes: number;
  /** Unix ms when a Retry-After cooldown ends (0 = none). */
  cooldownUntil: number;
  /** Scheduled wakeup for a cooling bucket (so waiters don't sleep forever). */
  cooldownTimer?: ReturnType<typeof setTimeout>;
  /** Last activity, for idle reset. */
  lastUsedAt: number;
  waiters: Array<() => void>;
}

export class AimdGovernor {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly increaseAfter: number;
  private readonly decreaseFactor: number;
  private readonly idleResetMs: number;

  constructor(options: AimdOptions = {}) {
    this.max = options.maxPerProvider ?? 8;
    this.increaseAfter = options.increaseAfter ?? 4;
    this.decreaseFactor = options.decreaseFactor ?? 0.75;
    this.idleResetMs = (options.idleResetMinutes ?? 5) * 60_000;
  }

  /** Wait until the provider's bucket has a free slot, then charge it. FIFO per bucket. */
  async acquire(providerId: string): Promise<void> {
    const bucket = this.bucketFor(providerId);
    this.resetIfIdle(bucket);
    while (true) {
      const now = Date.now();
      const cooling = bucket.cooldownUntil > now;
      if (!cooling && bucket.inFlight < bucket.limit) {
        bucket.inFlight++;
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

  /** Report an ask outcome: success → additive increase path; failure → multiplicative decrease. */
  release(providerId: string, outcome: 'success' | 'failure', retryAfterMs?: number): void {
    const bucket = this.buckets.get(providerId);
    if (!bucket) return;
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    bucket.lastUsedAt = Date.now();
    if (outcome === 'success') {
      bucket.successes++;
      if (bucket.successes >= this.increaseAfter && bucket.limit < this.max) {
        bucket.limit++;
        bucket.successes = 0;
      }
    } else {
      bucket.successes = 0;
      bucket.limit = Math.max(1, Math.floor(bucket.limit * this.decreaseFactor));
      if (retryAfterMs && retryAfterMs > 0) {
        bucket.cooldownUntil = Date.now() + retryAfterMs;
      }
    }
    this.drain(bucket);
  }

  /** Current snapshot for doctor / tests. */
  snapshot(): Array<{ providerId: string; limit: number; inFlight: number; cooldownUntil: number }> {
    return [...this.buckets.entries()].map(([providerId, b]) => ({
      providerId,
      limit: b.limit,
      inFlight: b.inFlight,
      cooldownUntil: b.cooldownUntil,
    }));
  }

  private bucketFor(providerId: string): Bucket {
    let bucket = this.buckets.get(providerId);
    if (!bucket) {
      bucket = { limit: this.max, inFlight: 0, successes: 0, cooldownUntil: 0, lastUsedAt: Date.now(), waiters: [] };
      this.buckets.set(providerId, bucket);
    }
    return bucket;
  }

  private resetIfIdle(bucket: Bucket): void {
    if (bucket.inFlight === 0 && bucket.lastUsedAt > 0 && Date.now() - bucket.lastUsedAt > this.idleResetMs) {
      bucket.limit = this.max;
      bucket.successes = 0;
      bucket.cooldownUntil = 0;
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

/** Registered-provider guard reused by the engine (kept here for one import site). */
export function knownProviders(): string[] {
  return providerRegistry.list();
}
