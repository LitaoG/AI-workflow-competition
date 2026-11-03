/**
 * Unit tests for the pure domain layer (src/domain): the Result monad, the tagged
 * error algebra and its NDJSON/JSONL round trip, the evidence ledger, the
 * canonical event vocabulary, and the backward-compatible re-export surface of
 * src/types.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  flatMap,
  match,
  unwrapOr,
  type Result,
} from '../../src/domain/result.js';
import {
  domainError,
  DOMAIN_ERROR_TAGS,
  isDomainErrorTag,
  isDomainError,
  toSerializableError,
  fromSerializableError,
  isCompileError,
  isSchemaValidationError,
  isSandboxTimeout,
  isSandboxSpawnError,
  isStorageError,
  isProberError,
  isAgentError,
  isMcpError,
  isJournalMismatchError,
  type DomainError,
} from '../../src/domain/errors.js';
import { WORKFLOW_EVENT, WORKFLOW_EVENT_TYPES, isWorkflowEventType } from '../../src/domain/events.js';
import {
  createEvidenceLedger,
  appendEvidence,
  queryEvidence,
  summarizeEvidence,
  isEvidenceKind,
} from '../../src/domain/evidence.js';
// Runtime re-export surface of the legacy import path:
import { WORKFLOW_EVENT as REEXPORTED_EVENT, type WorkflowEvent, type WorkflowStatus, type AgentRPCClient, type PromptSchema } from '../../src/types.js';
import type { AgentRPCClient as DomainAgentRPCClient, WorkflowStatus as DomainWorkflowStatus } from '../../src/domain/workflow-types.js';

// ============================================================================
// Result monad
// ============================================================================

test('Result: ok/err build the discriminated branches and guards narrow them', () => {
  const good = ok<number, string>(42);
  const bad = err<number, string>('boom');

  assert.ok(isOk(good));
  assert.equal(good.ok, true);
  assert.equal(good.value, 42);
  assert.equal(good.error, undefined);

  assert.ok(isErr(bad));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'boom');
  assert.equal(bad.value, undefined);

  assert.equal(isOk(bad), false);
  assert.equal(isErr(good), false);
});

test('Result: map transforms only the success branch', () => {
  const doubled = map(ok<number, string>(21), (n) => n * 2);
  assert.deepEqual(doubled, { ok: true, value: 42 });

  const untouched = map(err<number, string>('boom'), (n) => n * 2);
  assert.deepEqual(untouched, { ok: false, error: 'boom' });
});

test('Result: mapErr transforms only the failure branch', () => {
  const retagged = mapErr(err<number, string>('boom'), (message) => ({ code: message }));
  assert.deepEqual(retagged, { ok: false, error: { code: 'boom' } });

  const untouched = mapErr(ok<number, string>(7), (message) => ({ code: message }));
  assert.deepEqual(untouched, { ok: true, value: 7 });
});

test('Result: flatMap chains fallible steps and short-circuits on failure', () => {
  let sideEffect = 0;
  const parse = (text: string): Result<number, string> =>
    /^\d+$/.test(text) ? ok(Number(text)) : err(`not a number: ${text}`);
  const halve = (n: number): Result<number, string> =>
    n % 2 === 0 ? ok(n / 2) : err('odd number');

  assert.deepEqual(flatMap(flatMap(ok<string, string>('84'), parse), halve), { ok: true, value: 42 });
  assert.deepEqual(flatMap(flatMap(ok<string, string>('85'), parse), halve), { ok: false, error: 'odd number' });

  const shortCircuited = flatMap(err<string, string>('boom'), (v) => {
    sideEffect += 1;
    return ok(v.length);
  });
  assert.deepEqual(shortCircuited, { ok: false, error: 'boom' });
  assert.equal(sideEffect, 0, 'flatMap must not invoke the continuation on a failed input');
});

test('Result: match folds both branches exhaustively', () => {
  const describe = (r: Result<number, string>): string =>
    match(r, (n) => `value ${n}`, (message) => `error ${message}`);

  assert.equal(describe(ok(5)), 'value 5');
  assert.equal(describe(err('late')), 'error late');
});

test('Result: unwrapOr substitutes the fallback on failure only', () => {
  assert.equal(unwrapOr(ok<number, string>(3), -1), 3);
  assert.equal(unwrapOr(err<number, string>('boom'), -1), -1);
});

test('Result: composes into a typed pipeline over DomainError', () => {
  const parseCount = (raw: string): Result<number, DomainError> =>
    /^\d+$/.test(raw) ? ok(Number(raw)) : err(domainError('AgentError', 'non-numeric count'));

  const pipeline = (raw: string): Result<string, DomainError> =>
    map(
      flatMap(parseCount(raw), (n): Result<number, DomainError> =>
        n > 0 ? ok(n) : err(domainError('AgentError', 'count must be positive'))
      ),
      (n) => `count=${n}`
    );

  assert.deepEqual(pipeline('3'), { ok: true, value: 'count=3' });
  const negative = pipeline('-1');
  const nonNumeric = pipeline('abc');
  assert.ok(isErr(negative) && isAgentError(negative.error));
  assert.ok(isErr(nonNumeric) && isAgentError(nonNumeric.error));
});

// ============================================================================
// Tagged error algebra
// ============================================================================

test('DomainError: domainError builds every tag with details and cause', () => {
  const error = domainError('SandboxTimeout', 'child exceeded 60s', {
    details: { timeoutMs: 60000, pid: 4242 },
    cause: 'SIGKILL after budget',
  });
  assert.equal(error.tag, 'SandboxTimeout');
  assert.equal(error.message, 'child exceeded 60s');
  assert.deepEqual(error.details, { timeoutMs: 60000, pid: 4242 });
  assert.equal(error.cause, 'SIGKILL after budget');

  const minimal = domainError('McpError', 'tool call failed');
  assert.equal(minimal.details, undefined);
  assert.equal(minimal.cause, undefined);
});

test('DomainError: exactly the nine canonical tags are declared', () => {
  assert.deepEqual([...DOMAIN_ERROR_TAGS], [
    'CompileError',
    'SchemaValidationError',
    'SandboxTimeout',
    'SandboxSpawnError',
    'StorageError',
    'ProberError',
    'AgentError',
    'McpError',
    'JournalMismatchError',
  ]);
});

test('DomainError: each tag has a type guard that narrows and rejects others', () => {
  const samples: readonly DomainError[] = [
    domainError('CompileError', 'type error at line 3'),
    domainError('SchemaValidationError', 'agent output invalid'),
    domainError('SandboxTimeout', 'wall clock exceeded'),
    domainError('SandboxSpawnError', 'spawn failed'),
    domainError('StorageError', 'events.jsonl not writable'),
    domainError('ProberError', 'git probe failed'),
    domainError('AgentError', 'provider outage'),
    domainError('McpError', 'tool crashed'),
    domainError('JournalMismatchError', 'inputHash drift'),
  ];

  for (const sample of samples) {
    for (const other of samples) {
      const expected = sample.tag === other.tag;
      assert.equal(
        expected
          ? matchesGuard(sample, other)
          : !matchesGuard(other, sample),
        true,
        `guard matrix failed for ${sample.tag} vs ${other.tag}`
      );
    }
  }
});

/** Run the full guard matrix: find the unique guard that accepts `error`. */
function matchesGuard(sample: DomainError, error: DomainError): boolean {
  const guards: ReadonlyArray<(error: DomainError) => boolean> = [
    isCompileError,
    isSchemaValidationError,
    isSandboxTimeout,
    isSandboxSpawnError,
    isStorageError,
    isProberError,
    isAgentError,
    isMcpError,
    isJournalMismatchError,
  ];
  const hits = guards.filter((guard) => guard(error));
  return hits.length === 1 && hits[0](sample);
}

test('DomainError: isDomainErrorTag and isDomainError validate parsed input', () => {
  for (const tag of DOMAIN_ERROR_TAGS) {
    assert.equal(isDomainErrorTag(tag), true);
    assert.equal(isDomainError(domainError(tag, 'm')), true);
  }
  assert.equal(isDomainErrorTag('CompileError'), true);
  assert.equal(isDomainErrorTag('NotATag'), false);
  assert.equal(isDomainErrorTag(42), false);

  assert.equal(isDomainError({ tag: 'McpError', message: 'm' }), true);
  assert.equal(isDomainError({ tag: 'Bogus', message: 'm' }), false);
  assert.equal(isDomainError({ tag: 'McpError' }), false);
  assert.equal(isDomainError('McpError'), false);
  assert.equal(isDomainError(null), false);
});

test('DomainError: toSerializableError emits a JSON-safe frame', () => {
  const error = domainError('AgentError', 'boom', {
    details: {
      when: new Date('2024-01-02T03:04:05.000Z'),
      count: NaN,
      big: 123n,
      nested: { ok: true, dropped: undefined },
    },
    cause: 'root cause',
  });

  const wire = toSerializableError(error);
  assert.equal(wire.tag, 'AgentError');
  assert.equal(wire.message, 'boom');
  assert.equal(wire.cause, 'root cause');
  assert.deepEqual(wire.details, {
    when: '2024-01-02T03:04:05.000Z', // Date -> ISO string
    count: null, // non-finite number -> JSON null
    big: '123', // BigInt -> string
    nested: { ok: true }, // undefined members dropped
  });

  // The frame must survive a literal NDJSON encode/decode cycle unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), wire);
});

test('DomainError: toSerializableError/fromSerializableError round trip every tag', () => {
  for (const tag of DOMAIN_ERROR_TAGS) {
    const original = domainError(tag, `message for ${tag}`, {
      details: { ordinal: 7, siteId: 'ask#1' },
      cause: 'underlying failure',
    });
    const line = JSON.stringify(toSerializableError(original));
    const restored = fromSerializableError(JSON.parse(line));

    assert.deepEqual(restored, original, `round trip failed for tag ${tag}`);
  }
});

test('DomainError: fromSerializableError never throws and never echoes payloads', () => {
  const MALFORMED_REASONS: readonly string[] = [
    'payload-not-an-object',
    'unknown-or-missing-tag',
    'missing-or-invalid-message',
  ];
  for (const input of [undefined, null, 42, 'oops', [], {}, { tag: 'Bogus', message: 'm' }, { tag: 'CompileError' }]) {
    const restored = fromSerializableError(input);
    assert.ok(isStorageError(restored), `expected StorageError fallback for ${String(input)}`);
    assert.equal(restored.message, 'Malformed serialized error payload');
    assert.ok(
      MALFORMED_REASONS.includes(String(restored.details?.reason)),
      `unexpected malformed-payload reason: ${String(restored.details?.reason)}`
    );
    assert.equal(JSON.stringify(restored).includes(String(JSON.stringify(input))), false, 'payload must not leak');
  }

  // Optional fields are honored only when well-typed.
  const withExtras = fromSerializableError({ tag: 'ProberError', message: 'm', details: { cwd: '/x' }, cause: 42 });
  assert.ok(isProberError(withExtras));
  assert.deepEqual(withExtras.details, { cwd: '/x' });
  assert.equal(withExtras.cause, undefined);
});

// ============================================================================
// Evidence ledger
// ============================================================================

const OBSERVATION_BASE = {
  kind: 'observation',
  label: 'tsc exit code',
  inputHash: 'a'.repeat(64),
  provenance: 'gate:tsc',
  coverage: 'type check passed on the working tree',
  limitations: 'does not cover runtime behavior',
  durationMs: 1200,
} as const;

test('EvidenceLedger: append is immutable and auto-assigns ordinal ids', () => {
  const empty = createEvidenceLedger('run-1');
  const first = appendEvidence(empty, OBSERVATION_BASE);

  assert.equal(empty.entries.length, 0, 'input ledger must stay untouched');
  assert.notEqual(first, empty);
  assert.equal(first.runId, 'run-1');
  assert.deepEqual(first.entries.map((entry) => entry.id), ['e-1']);

  const second = appendEvidence(first, { ...OBSERVATION_BASE, id: 'custom-id', recordedAt: '2024-01-01T00:00:00.000Z' });
  assert.deepEqual(second.entries.map((entry) => entry.id), ['e-1', 'custom-id']);
  assert.equal(second.entries[1]?.recordedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(first.entries.length, 1, 'previous ledger must stay untouched');
});

test('EvidenceLedger: records all four evidence kinds with token usage', () => {
  let ledger = createEvidenceLedger('run-2');
  for (const kind of ['observation', 'derivation', 'inference', 'unknown'] as const) {
    ledger = appendEvidence(ledger, {
      kind,
      label: `${kind} fact`,
      inputHash: `${kind}-hash`,
      provenance: 'agent:prober',
      coverage: 'covers the probed workspace',
      limitations: 'none recorded',
      durationMs: 10,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  }

  assert.equal(ledger.entries.length, 4);
  assert.deepEqual(ledger.entries.map((entry) => entry.kind), [
    'observation',
    'derivation',
    'inference',
    'unknown',
  ]);
  assert.deepEqual(isEvidenceKind('inference'), true);
  assert.deepEqual(isEvidenceKind('guessed'), false);
});

test('EvidenceLedger: query filters by kind, provenance, label and limit', () => {
  let ledger = createEvidenceLedger('run-3');
  ledger = appendEvidence(ledger, OBSERVATION_BASE);
  ledger = appendEvidence(ledger, { ...OBSERVATION_BASE, id: 'obs-2', provenance: 'agent:reviewer', label: 'review verdict' });
  ledger = appendEvidence(ledger, { ...OBSERVATION_BASE, id: 'inf-1', kind: 'inference', provenance: 'agent:reviewer' });

  assert.equal(queryEvidence(ledger).length, 3, 'no query returns everything');
  assert.deepEqual(queryEvidence(ledger, { kinds: ['inference'] }).map((entry) => entry.id), ['inf-1']);
  assert.deepEqual(queryEvidence(ledger, { kinds: ['observation', 'inference'] }).length, 3);
  assert.deepEqual(queryEvidence(ledger, { provenanceIncludes: 'reviewer' }).map((entry) => entry.id), ['obs-2', 'inf-1']);
  assert.deepEqual(queryEvidence(ledger, { labelIncludes: 'verdict' }).map((entry) => entry.id), ['obs-2']);
  assert.deepEqual(queryEvidence(ledger, { provenanceIncludes: 'agent:', limit: 1 }).map((entry) => entry.id), ['obs-2']);
  assert.deepEqual(queryEvidence(ledger, { provenanceIncludes: 'nowhere' }), []);
});

test('EvidenceLedger: summarize computes kind counts, durations and token totals', () => {
  let ledger = createEvidenceLedger('run-4');
  ledger = appendEvidence(ledger, { ...OBSERVATION_BASE, durationMs: 100, tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } });
  ledger = appendEvidence(ledger, { ...OBSERVATION_BASE, id: 'd-1', kind: 'derivation', durationMs: 50 });
  ledger = appendEvidence(ledger, { ...OBSERVATION_BASE, id: 'u-1', kind: 'unknown', durationMs: 10, tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });

  const summary = summarizeEvidence(ledger);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byKind, { observation: 1, derivation: 1, inference: 0, unknown: 1 });
  assert.equal(summary.totalDurationMs, 160);
  assert.deepEqual(summary.totalTokens, { prompt: 11, completion: 22, total: 33 });
});

// ============================================================================
// Canonical event vocabulary
// ============================================================================

test('Events: constant map carries the legacy wire strings and derives the union', () => {
  assert.equal(WORKFLOW_EVENT.WORKFLOW_START, 'workflow_start');
  assert.equal(WORKFLOW_EVENT.GATE_EVAL, 'gate_eval');
  assert.equal(WORKFLOW_EVENT.AGENT_RPC_REQUEST, 'agent_rpc_request');
  assert.equal(WORKFLOW_EVENT.DWF_REPLAY_HIT, 'dwf_replay_hit');
  assert.equal(WORKFLOW_EVENT.DWF_AMEND_DIVERGED, 'dwf_amend_diverged');
  assert.equal(WORKFLOW_EVENT.DWF_COMPLETED, 'dwf_completed');

  // Backward compatibility: every event type of the legacy union (src/types.ts
  // before the domain extraction) must stay valid — the canonical list may only
  // grow additively (e.g. dwf_escalation_open), never lose members.
  const LEGACY_EVENT_TYPES: readonly string[] = [
    'workflow_start',
    'phase_start',
    'step_start',
    'step_complete',
    'step_failed',
    'step_skipped',
    'gate_eval',
    'phase_complete',
    'workflow_complete',
    'workflow_failed',
    'workflow_aborted',
    'agent_rpc_request',
    'agent_rpc_response',
    'mcp_tool_call',
    'mcp_tool_result',
    'artifact_emitted',
    'dwf_phase',
    'dwf_log',
    'dwf_report',
    'dwf_actor_created',
    'dwf_ask_start',
    'dwf_ask_complete',
    'dwf_replay_hit',
    'dwf_amend_hit',
    'dwf_amend_diverged',
    'dwf_hole_open',
    'dwf_world_run',
    'dwf_call_error',
    'dwf_node_failed',
    'dwf_artifact',
    'dwf_completed',
    'dwf_failed',
  ];
  for (const legacy of LEGACY_EVENT_TYPES) {
    assert.equal(isWorkflowEventType(legacy), true, `legacy event type lost: ${legacy}`);
  }

  // The canonical list has no duplicates.
  assert.equal(new Set(WORKFLOW_EVENT_TYPES).size, WORKFLOW_EVENT_TYPES.length);
});

test('Events: isWorkflowEventType accepts exactly the canonical values', () => {
  for (const type of WORKFLOW_EVENT_TYPES) {
    assert.equal(isWorkflowEventType(type), true);
  }
  assert.equal(isWorkflowEventType('workflow_start'), true);
  assert.equal(isWorkflowEventType('WORKFLOW_START'), false);
  assert.equal(isWorkflowEventType('dwf_unknown'), false);
  assert.equal(isWorkflowEventType(42), false);
  assert.equal(isWorkflowEventType(null), false);
});

// ============================================================================
// Backward-compatible re-export surface (src/types.ts)
// ============================================================================

test('Types re-export: types.js serves the domain contracts unchanged', () => {
  // Runtime proof that the legacy import path re-exports the domain vocabulary.
  assert.deepEqual(REEXPORTED_EVENT, WORKFLOW_EVENT);

  // Type-level proof: values typed via types.js and domain/workflow-types.js are
  // mutually assignable, and a WorkflowEvent typed via types.js accepts the
  // canonical event constants.
  const status: WorkflowStatus = 'completed';
  const domainStatus: DomainWorkflowStatus = status;
  assert.equal(domainStatus, 'completed');

  const event: WorkflowEvent = {
    id: 'ev-1',
    workflowId: 'wf',
    runId: 'run-1',
    stepId: 'step-1',
    type: WORKFLOW_EVENT.STEP_COMPLETE,
    timestamp: '2024-01-01T00:00:00.000Z',
    sequence: 1,
    data: { ok: true },
  };
  assert.equal(event.type, 'step_complete');

  // AgentRPCClient remains implementable and assignable across both paths.
  const client: AgentRPCClient = {
    name: 'test-agent',
    async ask<T>(prompt: string, schema: PromptSchema<T>): Promise<T> {
      return schema.parse(prompt);
    },
  };
  const domainClient: DomainAgentRPCClient = client;
  assert.equal(domainClient.name, 'test-agent');
});

test('PromptSchema: zod schemas satisfy the structural contract with correct inference', () => {
  const viaInterface: PromptSchema<{ ok: boolean }> = z.object({ ok: z.boolean() });

  const valid = viaInterface.safeParse({ ok: true });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.deepEqual(valid.data, { ok: true });
  }

  const invalid = viaInterface.safeParse({ ok: 'nope' });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.ok(invalid.error.issues.length > 0);
  }
});
