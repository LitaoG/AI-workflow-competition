/**
 * Checkpoint replay binding — a core checkpoint is only served when the
 * producing (step definition, input) pair hashes to the recorded inputHash.
 * Moved verbatim from workflow.ts; the workflow module re-exports the
 * historical surface (tests import computeStepCheckpointHash from there).
 */
import { createHash } from 'node:crypto';
import type { StepDefinition } from '../types.js';
import { redactValue } from '../dwf/redact.js';

// ---------------------------------------------------------------------------
// Checkpoint replay binding — a checkpoint is only served when the producing
// (step definition, input) pair hashes to the recorded inputHash (audit fix:
// the short-circuit used to key on stepId alone and served stale results)
// ---------------------------------------------------------------------------

/** The serializable identity fields of a {@link StepDefinition} bound into the replay hash. */
interface StepHashDescriptor {
  id: string;
  name: string;
  phaseId: string;
  type: string;
  role?: string;
  /** Sorted copy — dependency ORDER carries no semantics, only the set does. */
  dependsOn: string[];
  retryPolicy?: { maxRetries: number; initialDelayMs?: number; backoffFactor?: number };
  timeoutMs?: number;
}

/**
 * Pick the step's serializable identity fields in canonical form. The
 * non-serializable closures (`runner`, `retryPolicy.retryableErrorFilter`) are
 * deliberately NOT part of the binding: function source text is not stable
 * across minifiers/bundlers, so binding it would produce spurious mismatches
 * (the fail-safe direction, but noisy). Editing only a step's function body is
 * therefore not detected at this layer — whole-script identity binding is the
 * dwf facade runner's job (`scriptHash`).
 */
function stepHashDescriptor(step: StepDefinition): StepHashDescriptor {
  return {
    id: step.id,
    name: step.name,
    phaseId: step.phaseId,
    type: step.type,
    ...(step.role !== undefined ? { role: step.role } : {}),
    dependsOn: [...(step.dependsOn ?? [])].sort(),
    ...(step.retryPolicy !== undefined
      ? {
          retryPolicy: {
            maxRetries: step.retryPolicy.maxRetries,
            ...(step.retryPolicy.initialDelayMs !== undefined
              ? { initialDelayMs: step.retryPolicy.initialDelayMs }
              : {}),
            ...(step.retryPolicy.backoffFactor !== undefined
              ? { backoffFactor: step.retryPolicy.backoffFactor }
              : {}),
          },
        }
      : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  };
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so two
 * structurally equal values always produce the same text regardless of key
 * insertion order; arrays keep their order (it is semantically meaningful).
 * `undefined` serializes as `null` (JSON semantics); non-JSON values (BigInt,
 * functions, symbols) degrade to their `String()` form; cyclic references
 * degrade to the `"[Circular]"` marker instead of throwing. Total — never
 * throws, so hashing hostile step inputs is always safe.
 *
 * @param value - Any runtime value (expected to be JSON-safe in practice).
 */
export function stableStringify(value: unknown): string {
  return stringifyStable(value, new Set());
}

function stringifyStable(value: unknown, seen: Set<object>): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return JSON.stringify(String(value));
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => stringifyStable(item, seen)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const pairs = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stringifyStable(record[key], seen)}`);
    out = `{${pairs.join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * sha256 over the canonical (step definition, input) pair — the hash a core
 * checkpoint is bound by. The two parts are serialized independently
 * ({@link stableStringify}) and joined with a NUL separator so no pair of
 * (definition, input) values can collide across the boundary. Pure: the same
 * pair always yields the same hex digest.
 *
 * The hash binds the PERSISTED (redacted) representation, not the live one
 * (Issue #176): the store masks checkpoint input/output on the way to disk
 * (Issue #112), and a replay re-derives a step's input from those persisted,
 * masked upstream outputs. Hashing the live form made every downstream step
 * of a credential-touching run re-execute on resume (hash of live ≠ hash of
 * derived-from-masked) — "0 new LLM calls" replays billed again. The
 * redaction is idempotent, so hashing `redactValue(input)` yields the same
 * digest at run time (masked once) and at replay time (masked output passed
 * through the idempotent mask again), and the hash then binds exactly the
 * bytes the checkpoint actually holds.
 *
 * @param step - The step definition as currently wired into the workflow.
 * @param input - The runtime input the step is about to receive (or received).
 */
export function computeStepCheckpointHash(step: StepDefinition, input: unknown): string {
  return createHash('sha256')
    .update(stableStringify(stepHashDescriptor(step)))
    .update('\u0000')
    .update(stableStringify(redactValue(input)))
    .digest('hex');
}
