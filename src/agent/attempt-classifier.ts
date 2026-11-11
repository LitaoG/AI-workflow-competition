/**
 * Attempt classifier (borrowed from Open Dynamic Workflow's attempt-classifier):
 * one place decides what a thrown provider error MEANS for the retry loop —
 * rate limits back off, transient network faults retry fast, auth failures and
 * cancellations are fatal. Message-driven because our providers throw plain Errors.
 */
export type FailureCategory = 'rate_limit' | 'transient' | 'auth' | 'quota' | 'invalid_request' | 'cancelled' | 'fatal';

export interface Classification {
  category: FailureCategory;
  /** Whether the ask loop may retry this failure. */
  retryable: boolean;
  /** Suggested wait before the next attempt (exponential in the attempt number). */
  backoffMs: number;
  /** Parsed Retry-After hint, when the provider signalled one. */
  retryAfterMs?: number;
}

const RATE_LIMIT = /\b429\b|throttl|rate[._-]?limit|too many requests|quota exceeded|capacity/i;
const TRANSIENT = /timeout|timed?\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|network|fetch failed|\b502\b|\b503\b|\b504\b|overloaded|temporarily/i;
const AUTH = /api key|unauthorized|\b401\b|\b403\b|forbidden|invalid credentials|signature/i;
const QUOTA = /quota exceeded|insufficient quota|billing|credit|usage limit/i;
const INVALID_REQUEST = /invalid_request|invalid model|malformed request|unsupported parameter/i;

export function classifyFailure(err: unknown, attempt: number): Classification {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  // Stall: no progress within stallMs — transient by definition (retry with a
  // fresh transcript, Claude's restart semantics in atomic-call form).
  if (err instanceof Error && err.name === 'StallError') {
    return { category: 'transient', retryable: true, backoffMs: Math.min(250 * 2 ** attempt, 4000) };
  }
  // Cancellations are never retried — the caller asked for the stop.
  if (err instanceof Error && err.name === 'AbortError') {
    return { category: 'cancelled', retryable: false, backoffMs: 0 };
  }

  const retryAfterMs = parseRetryAfterMs(message);

  if (QUOTA.test(message)) {
    // G7 (ZCode model-error policy): quota is a POLICY STOP, not a retryable
    // rate-limit — the user can act on it (top up, wait for reset) and a 429-style
    // retry storm must never freeze the shared bucket.
    return { category: 'quota', retryable: false, backoffMs: 0 };
  }
  if (INVALID_REQUEST.test(message)) {
    return { category: 'invalid_request', retryable: false, backoffMs: 0 };
  }
  if (RATE_LIMIT.test(message)) {
    const backoffMs = retryAfterMs ?? Math.min(500 * 2 ** attempt, 8000);
    return { category: 'rate_limit', retryable: true, backoffMs, retryAfterMs };
  }
  if (TRANSIENT.test(message)) {
    const backoffMs = retryAfterMs ?? Math.min(250 * 2 ** attempt, 4000);
    return { category: 'transient', retryable: true, backoffMs, retryAfterMs };
  }
  if (AUTH.test(message)) {
    return { category: 'auth', retryable: false, backoffMs: 0 };
  }
  // Unrecognized messages stay FATAL/give-up (the retry-orchestrator contract):
  // a message-based classifier cannot tell an unknown provider PROTOCOL code from
  // a genuine logic error, and give-up is the storm-safe default. ZCode's
  // unknown-code-9-retries assumes a code table we do not have (documented
  // divergence in claude-code-workflow-internals.md).
  return { category: 'fatal', retryable: false, backoffMs: 0 };
}

/**
 * G6 fix: the single Retry-After parser for the whole engine (attempt-classifier AND
 * the AIMD governor must agree). A bare number defaults to SECONDS (the HTTP
 * Retry-After convention); 'ms'/'s' suffixes are honoured explicitly.
 */
export function parseRetryAfterMs(message: string): number | undefined {
  const m = /retry[- ]after[:\s]*(\d+)\s*(ms|s|sec|seconds)?/i.exec(message);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (!m[2]) return n * 1000; // bare number = seconds (HTTP convention)
  return m[2].startsWith('m') ? n : n * 1000;
}

/** Sleep for the backoff; abort-aware so a cancel during the wait stops immediately. */
export function backoffSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('ask cancelled');
      e.name = 'AbortError';
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const e = new Error('ask cancelled');
      e.name = 'AbortError';
      reject(e);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
