/**
 * Evidence ledger — maps one journalled node's saveNode outcome to its
 * `dwf_evidence` entry (GOAL.md 证据凭证法则), with the redaction discipline
 * applied at the persistence boundary.
 *
 * Kind mapping over the `domain/evidence.ts` vocabulary:
 * - `worldRead` / `worldRun` / `artifact` → `'observation'` — deterministic
 *   facts measured in the workspace or captured from a subprocess;
 * - `ask` → `'inference'` — the recorded answer is an agent-produced inference;
 *   provider-reported token usage rides along when present;
 * - a failed node → `'unknown'` — explicitly not established, never faked.
 *
 * Recording is best-effort by design: the node's primary journal row is already
 * persisted when this runs, and audit bookkeeping must never fail a node whose
 * primary persistence succeeded. Stores without the evidence surface skip it.
 */
import type { EvidenceEntryInput } from '../domain/evidence.js';
import type { TokenUsage } from '../types.js';
import { redactText } from './redact.js';

/** Input excerpt bound into an evidence label — kept short; redacted before persistence. */
const EVIDENCE_EXCERPT_CHARS = 200;

export interface EvidenceNodeOutcome {
  kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact';
  siteId: string;
  ordinal: number;
  inputHash: string;
  input: string;
  status: 'completed' | 'failed';
  durationMs: number;
  tokenUsage?: TokenUsage;
  errorMessage?: string;
}

/**
 * Build the raw, still-unredacted entry. The label carries a short excerpt of
 * the node's input so the ledger is readable on its own.
 */
export function buildEvidenceEntry(args: EvidenceNodeOutcome): EvidenceEntryInput {
  // Ordinal separator is `@` on purpose: compiler site ids already contain
  // `#` (e.g. `worldread#2`), so `worldread#2@1` stays unambiguous.
  const at = `${args.siteId}@${args.ordinal}`;
  const provenance = `dwf:${args.kind}:${at}`;
  const excerpt =
    args.input.length > EVIDENCE_EXCERPT_CHARS ? `${args.input.slice(0, EVIDENCE_EXCERPT_CHARS)}...` : args.input;
  const recordedAt = new Date().toISOString();
  const tokenUsage = args.tokenUsage;

  if (args.status === 'failed') {
    return {
      kind: 'unknown',
      label: `${args.kind} at ${at} failed (input: ${excerpt})`,
      inputHash: args.inputHash,
      provenance,
      coverage: 'nothing — the operation failed before producing a journalled result',
      limitations: `no result was established: ${args.errorMessage ?? 'unknown error'}`,
      durationMs: args.durationMs,
      recordedAt,
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    };
  }
  switch (args.kind) {
    case 'ask':
      return {
        kind: 'inference',
        label: `ask("${excerpt}") completed at ${at}`,
        inputHash: args.inputHash,
        provenance,
        coverage: 'the model answer recorded in dwf_nodes.result_json answers the recorded prompt at this site',
        limitations: 'a model-produced inference, not a verified world fact — bounded by the recorded prompt and the provider',
        durationMs: args.durationMs,
        recordedAt,
        ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      };
    case 'worldRead':
    case 'worldRun':
    case 'artifact':
      return {
        kind: 'observation',
        label: `${args.kind}(${excerpt}) completed at ${at}`,
        inputHash: args.inputHash,
        provenance,
        coverage: `the deterministic ${args.kind} output recorded in dwf_nodes.result_json for this site`,
        limitations: 'reflects the workspace only at execution time — no guarantee it still holds',
        durationMs: args.durationMs,
        recordedAt,
      };
  }
}

/**
 * Record one evidence entry for a journalled node at its saveNode point.
 *
 * The entry's user-derived text (label/limitations carry prompt and error
 * excerpts) passes {@link redactText} BEFORE persistence (不可逆脱敏: what
 * reaches SQLite is already masked, and journal replays inherit the masked
 * form). Field-wise on purpose: {@link redactValue} on the whole entry would
 * DESTROY `inputHash` — its anchored whole-value rule masks any string that
 * is nothing but hex (see redact.ts trade-off note), and a masked hash would
 * break the ledger↔`dwf_nodes` agreement. `inputHash`/`provenance`/
 * `durationMs`/`tokenUsage` are engine-generated structure with no user
 * content and pass through verbatim; `inputHash` is the SAME hash the
 * `dwf_nodes` row is keyed by, so a ledger entry and its node row always agree.
 */
export async function recordNodeEvidence(
  store: { saveDwfEvidence?: (row: { runId: string; siteId: string; nodeOrdinal: number; entry: EvidenceEntryInput }) => Promise<void> },
  runId: string,
  outcome: EvidenceNodeOutcome,
): Promise<void> {
  if (store.saveDwfEvidence === undefined) return;
  const rawEntry = buildEvidenceEntry(outcome);
  const entry: EvidenceEntryInput = {
    ...rawEntry,
    // The prose carries user content (prompt excerpts, error messages) —
    // masked irreversibly before the serialization boundary.
    label: redactText(rawEntry.label),
    coverage: redactText(rawEntry.coverage),
    limitations: redactText(rawEntry.limitations),
  };
  try {
    await store.saveDwfEvidence({
      runId,
      siteId: outcome.siteId,
      nodeOrdinal: outcome.ordinal,
      entry,
    });
  } catch {
    /* best-effort evidence bookkeeping — never fail a journalled node over it */
  }
}
