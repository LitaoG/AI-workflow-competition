/**
 * Evidence Ledger — the provenance bookkeeping of the engine (GOAL §1.2).
 *
 * Every workflow fact must be recorded with its kind — observation (measured),
 * derivation (computed), inference (agent-produced) or unknown (explicitly not
 * established) — plus provenance, coverage and limitations, so downstream
 * consumers can audit *why* a conclusion was reached and what it does not prove.
 * The ledger is a pure, immutable data structure: `appendEvidence` returns a new
 * ledger instead of mutating, keeping the domain layer free of side effects.
 */
import type { TokenUsage } from './workflow-types.js';

/** The epistemic class of a recorded fact. */
export type EvidenceKind = 'observation' | 'derivation' | 'inference' | 'unknown';

/** All valid {@link EvidenceKind} values, in stable order. */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'observation',
  'derivation',
  'inference',
  'unknown',
];

/**
 * Type guard: `true` when `value` is one of the four evidence kinds.
 *
 * @param value - Any parsed value.
 */
export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return EVIDENCE_KINDS.includes(value as EvidenceKind);
}

/** One recorded fact in the ledger. All string fields are plain JSON-safe text. */
export interface EvidenceEntry {
  /** Unique within the ledger: caller-supplied, or auto-assigned on append. */
  readonly id: string;
  /** Epistemic class — `'unknown'` must be used explicitly, never faked. */
  readonly kind: EvidenceKind;
  /** Short human-readable summary of the fact. */
  readonly label: string;
  /** Content hash of the entry's inputs (e.g. sha256 hex, computed by the caller). */
  readonly inputHash: string;
  /** Where the fact came from: step id, agent name, tool invocation, ... */
  readonly provenance: string;
  /** What the fact *does* establish. */
  readonly coverage: string;
  /** What the fact does *not* establish — never left implicit. */
  readonly limitations: string;
  /** Wall-clock duration of the producing operation in milliseconds. */
  readonly durationMs: number;
  /** LLM token consumption of the producing operation, when LLM-backed. */
  readonly tokenUsage?: TokenUsage;
  /** ISO-8601 recording timestamp, when the caller has a wall clock. */
  readonly recordedAt?: string;
}

/** Append payload for {@link appendEvidence}: `id`/`recordedAt` are optional. */
export type EvidenceEntryInput = Omit<EvidenceEntry, 'id' | 'recordedAt'> & {
  readonly id?: string;
  readonly recordedAt?: string;
};

/**
 * One evidence entry as persisted in the `dwf_evidence` SQLite table: the ledger
 * payload plus the facade journal replay key that produced it. The entry's `id`
 * is store-assigned (`e-<ordinal>` from the per-run append ordinal), so callers
 * never set it on write and readers always see stable, run-unique ids.
 */
export interface DwfEvidenceRow {
  /** Id of the run the entry belongs to. */
  readonly runId: string;
  /** Facade site that produced the entry (dwf journal `site_id`). */
  readonly siteId: string;
  /** The site's journalled ordinal — mirrors `dwf_nodes.ordinal` (the replay key). */
  readonly nodeOrdinal: number;
  /** The entry payload; pass {@link EvidenceEntryInput} without an `id`. */
  readonly entry: EvidenceEntryInput;
}

/** An immutable collection of evidence entries for one run. */
export interface EvidenceLedger {
  /** Id of the run the ledger belongs to. */
  readonly runId: string;
  /** Recorded entries, in append order. */
  readonly entries: readonly EvidenceEntry[];
}

/** Filter criteria for {@link queryEvidence}; every field is optional and conjunctive. */
export interface EvidenceQuery {
  /** Keep only entries of these kinds. */
  readonly kinds?: readonly EvidenceKind[];
  /** Keep only entries whose `provenance` contains this substring. */
  readonly provenanceIncludes?: string;
  /** Keep only entries whose `label` contains this substring. */
  readonly labelIncludes?: string;
  /** Maximum number of entries returned (applied after filtering). */
  readonly limit?: number;
}

/** Aggregate totals for a ledger (bookkeeping view). */
export interface EvidenceSummary {
  /** Total number of recorded entries. */
  readonly total: number;
  /** Entry count per evidence kind (all four keys always present). */
  readonly byKind: Readonly<Record<EvidenceKind, number>>;
  /** Sum of `durationMs` across all entries. */
  readonly totalDurationMs: number;
  /** Sum of token usage across all LLM-backed entries. */
  readonly totalTokens: { prompt: number; completion: number; total: number };
}

/**
 * Create an empty {@link EvidenceLedger} for a run.
 *
 * @param runId - Id of the run the ledger belongs to.
 */
export function createEvidenceLedger(runId: string): EvidenceLedger {
  return { runId, entries: [] };
}

/**
 * Return a new ledger with `entry` appended (the input ledger is not mutated).
 * When `entry.id` is omitted a deterministic ordinal id `e-<n>` is assigned from
 * the current entry count; caller-supplied ids are kept verbatim.
 *
 * @param ledger - The ledger to append to.
 * @param entry - The fact to record (see {@link EvidenceEntryInput}).
 */
export function appendEvidence(ledger: EvidenceLedger, entry: EvidenceEntryInput): EvidenceLedger {
  const id = entry.id ?? `e-${ledger.entries.length + 1}`;
  const stored: EvidenceEntry = {
    ...entry,
    id,
    ...(entry.recordedAt !== undefined ? { recordedAt: entry.recordedAt } : {}),
  };
  return { ...ledger, entries: [...ledger.entries, stored] };
}

/**
 * Filter a ledger's entries by the conjunctive criteria of {@link EvidenceQuery}.
 * Pure: returns a fresh array; the ledger and its entries are untouched.
 *
 * @param ledger - The ledger to query.
 * @param query - Optional filters (`kinds`, `provenanceIncludes`, `labelIncludes`, `limit`).
 */
export function queryEvidence(ledger: EvidenceLedger, query: EvidenceQuery = {}): EvidenceEntry[] {
  const matches: EvidenceEntry[] = [];
  for (const entry of ledger.entries) {
    if (query.kinds !== undefined && !query.kinds.includes(entry.kind)) continue;
    if (query.provenanceIncludes !== undefined && !entry.provenance.includes(query.provenanceIncludes)) continue;
    if (query.labelIncludes !== undefined && !entry.label.includes(query.labelIncludes)) continue;
    matches.push(entry);
    if (query.limit !== undefined && matches.length >= query.limit) break;
  }
  return matches;
}

/**
 * Compute the bookkeeping totals of a ledger: entry counts per kind, summed
 * durations and summed LLM token usage.
 *
 * @param ledger - The ledger to summarize.
 */
export function summarizeEvidence(ledger: EvidenceLedger): EvidenceSummary {
  const byKind: Record<EvidenceKind, number> = {
    observation: 0,
    derivation: 0,
    inference: 0,
    unknown: 0,
  };
  let totalDurationMs = 0;
  const totalTokens = { prompt: 0, completion: 0, total: 0 };
  for (const entry of ledger.entries) {
    byKind[entry.kind] += 1;
    totalDurationMs += entry.durationMs;
    if (entry.tokenUsage) {
      totalTokens.prompt += entry.tokenUsage.promptTokens;
      totalTokens.completion += entry.tokenUsage.completionTokens;
      totalTokens.total += entry.tokenUsage.totalTokens;
    }
  }
  return { total: ledger.entries.length, byKind, totalDurationMs, totalTokens };
}
