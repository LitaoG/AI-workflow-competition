/**
 * Retry orchestrator (ODW 剩余项，配合 attempt-classifier + AIMD governor):
 * the policy brain sitting ABOVE the classifier. The classifier says what one
 * thrown error MEANS; the orchestrator owns the POLICY STATE across attempts —
 * a circuit breaker so a dead provider is not hammered by every subsequent
 * ask, and a total attempt budget for the ask. Callers (the engine's failover
 * chain) enforce per-provider/chain sequencing via canAttempt + the exposed
 * limits, and read the wait from decide().
 *
 * Responsibilities, split cleanly:
 *   attempt-classifier.ts → meaning of ONE error (category/backoff/Retry-After)
 *   retry-orchestrator.ts → state + policy ACROSS attempts (this file)
 *   engine failover loop  → chain order and sequencing
 *
 * Deterministic: no clock, no randomness — inject `now` for tests.
 */

import { classifyFailure, Classification, FailureCategory } from './attempt-classifier.js';

export interface RetryOrchestratorPolicy {
  /** Consecutive failures on one provider before its circuit opens (default 3). */
  circuitThreshold?: number;
  /** How long an open circuit refuses attempts (default 60s). */
  circuitCooldownMs?: number;
  /** Engine-level attempts allowed per provider before the chain moves on (default 1 — the rpc layer already retries within a provider). */
  maxAttemptsPerProvider?: number;
  /** Total engine-level attempts for one ask across the whole chain (default 6). */
  maxTotalAttempts?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

export type OrchestratorAction = 'retry' | 'give-up';

export interface OrchestratorDecision {
  action: OrchestratorAction;
  /** Backoff before the next attempt (already includes Retry-After when present). */
  waitMs: number;
  /** Human-readable reason — surfaced as a dwf_failover event field. */
  reason: string;
  classification: Classification;
}

interface ProviderState {
  consecutiveFailures: number;
  circuitOpenUntil: number;
}

export class RetryOrchestrator {
  readonly limits: {
    circuitThreshold: number;
    circuitCooldownMs: number;
    maxAttemptsPerProvider: number;
    maxTotalAttempts: number;
  };

  private readonly now: () => number;
  private readonly states = new Map<string, ProviderState>();
  private totalAttempts = 0;

  constructor(policy: RetryOrchestratorPolicy = {}) {
    this.limits = {
      circuitThreshold: policy.circuitThreshold ?? 3,
      circuitCooldownMs: policy.circuitCooldownMs ?? 60_000,
      maxAttemptsPerProvider: policy.maxAttemptsPerProvider ?? 1,
      maxTotalAttempts: policy.maxTotalAttempts ?? 6,
    };
    this.now = policy.now ?? Date.now;
  }

  /** Circuit check + total budget — call BEFORE spending an attempt. */
  canAttempt(providerId: string): { allowed: boolean; reason?: string } {
    if (this.totalAttempts >= this.limits.maxTotalAttempts) {
      return { allowed: false, reason: `total attempt budget exhausted (${this.limits.maxTotalAttempts})` };
    }
    const st = this.states.get(providerId);
    if (st && st.circuitOpenUntil > this.now()) {
      return {
        allowed: false,
        reason: `circuit open for "${providerId}" until ${new Date(st.circuitOpenUntil).toISOString()} after ${st.consecutiveFailures} consecutive failures`,
      };
    }
    return { allowed: true };
  }

  /**
   * Record one failed attempt and classify the next move: retry (circuit
   * closed, failure was retryable) or give up (non-retryable, or the circuit
   * just opened from consecutive failures). Total/per-provider budgets are
   * enforced by canAttempt + the caller's counters.
   */
  decide(providerId: string, attempt: number, err: unknown): OrchestratorDecision {
    this.totalAttempts += 1;
    const classification: Classification = classifyFailure(err, attempt);
    const st = this.states.get(providerId) ?? { consecutiveFailures: 0, circuitOpenUntil: 0 };

    if (!classification.retryable) {
      st.consecutiveFailures += 1;
      this.states.set(providerId, st);
      return {
        action: 'give-up',
        waitMs: 0,
        reason: `${classification.category} failure is not retryable`,
        classification,
      };
    }

    st.consecutiveFailures += 1;
    this.states.set(providerId, st);
    if (st.consecutiveFailures >= this.limits.circuitThreshold) {
      st.circuitOpenUntil = this.now() + this.limits.circuitCooldownMs;
      return {
        action: 'give-up',
        waitMs: classification.backoffMs,
        reason: `circuit opened for "${providerId}" after ${st.consecutiveFailures} consecutive failures (cooldown ${this.limits.circuitCooldownMs}ms)`,
        classification,
      };
    }
    return {
      action: 'retry',
      waitMs: classification.backoffMs,
      reason: `${classification.category} — may retry "${providerId}" (attempt ${attempt + 2})`,
      classification,
    };
  }

  /** A completed round-trip closes the circuit and resets the failure streak. */
  recordSuccess(providerId: string): void {
    this.states.set(providerId, { consecutiveFailures: 0, circuitOpenUntil: 0 });
  }

  /** True when the provider's circuit is currently open (skip it in failover chains). */
  isCircuitOpen(providerId: string): boolean {
    const st = this.states.get(providerId);
    return st !== undefined && st.circuitOpenUntil > this.now();
  }

  /** Engine-level attempts spent so far across all providers (telemetry). */
  get attemptsSpent(): number {
    return this.totalAttempts;
  }
}

/** Classify an unknown error — re-exported so callers keep one import. */
export { classifyFailure };
export type { Classification, FailureCategory };
