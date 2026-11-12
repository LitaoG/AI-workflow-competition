/**
 * Swarm dispatch policy (Issue #140): the single source for the
 * concurrency window and the swarm agent cap the engine enforces.
 *
 * The window formula follows the canonical multi-agent runtime design:
 *   min(16, max(2, cores − 2))
 * overridable, in priority order, by an explicit option and then the
 * AI_WORKFLOW_MAX_CONCURRENT_AGENTS environment variable. Invalid overrides
 * (non-numeric, zero, negative) fall back to the formula instead of poisoning
 * the seat gate with NaN (a NaN cap compares false against every counter and
 * silently disables the limit).
 *
 * The agent cap is the whole-run circuit breaker for swarm-style task loops
 * (agent cap 1000 熔断) — the engine throws WorkflowAgentCapError at it.
 */

/** Whole-run swarm agent cap (agent cap 1000 熔断). */
export const SWARM_AGENT_CAP = 1000;

import { availableParallelism } from 'node:os';

export function resolveAskConcurrency(explicit?: number): number {
  const candidate = firstPositiveInt(explicit) ?? firstPositiveInt(readEnvConcurrency());
  if (candidate !== undefined) return candidate;
  return Math.min(16, Math.max(2, availableParallelism() - 2));
}

function readEnvConcurrency(): number | undefined {
  const raw = process.env.AI_WORKFLOW_MAX_CONCURRENT_AGENTS;
  if (raw === undefined || raw === '') return undefined;
  return Number(raw);
}

function firstPositiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
