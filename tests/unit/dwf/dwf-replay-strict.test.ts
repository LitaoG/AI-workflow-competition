import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, DwfNode, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { MockProvider } from '../../../src/agent/mock-provider.js';

/** Counting wrapper so tests can assert exactly how many provider calls happened. */
class CountingProvider implements LLMProvider {
  readonly id = 'dwf-replay-strict-mock';
  readonly name = 'Counting mock (replay strict)';
  calls = 0;
  private readonly inner = new MockProvider();
  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return this.inner.generate(request);
  }
}

function makeEngine(runId: string, store: SQLiteStateStore & DwfJournalStore, overrides: Partial<ConstructorParameters<typeof FacadeEngine>[0]> = {}): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [{ name: 'node', source: 'explicit' as const }],
    onEvent: () => {},
    ...overrides,
  });
}

function actorFrame(id: number, siteId: string): { t: 'call'; id: number; op: 'createActor'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op: 'createActor', siteId, payload: ['inspector'] };
}

function askFrame(id: number, siteId: string, actor: unknown, prompt: string): { t: 'call'; id: number; op: 'ask'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op: 'ask', siteId, payload: [actor, prompt, null] };
}

test('same-script resume: a drifted ask input at its journal position fails loudly (InputHashMismatch) and preserves the row', async () => {
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-strict-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-replay-strict';

    // Run 1: one ask journalled at (ask#1, ordinal 1).
    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'inspect the service'));
    const rowsBefore: DwfNode[] = await store.getDwfNodes(runId);
    assert.equal(rowsBefore.length, 1);
    assert.equal(counting.calls, 1);

    // Run 2 (same runId → same script, the runner's scriptHash gate enforces
    // this upstream): the ask input drifted. The row at the call's arrival
    // position holds a different inputHash → loud failure, not a silent
    // live re-run (P0-2, official InputHashMismatch semantics).
    const engine2 = makeEngine(runId, store);
    const actor2 = await engine2.handleCall(actorFrame(3, 'actor#1'));
    await assert.rejects(
      () => engine2.handleCall(askFrame(4, 'ask#1', actor2, 'a DIFFERENT prompt')),
      (err: unknown) => {
        const e = err as { tag?: string; message?: string; details?: { siteId?: string; ordinal?: number } };
        assert.equal(e.tag, 'JournalMismatchError', 'the tagged error vocabulary carries the mismatch');
        assert.match(e.message ?? '', /InputHashMismatch/, 'the message carries the InputHashMismatch label');
        assert.match(e.message ?? '', /ask#1#1/, 'the failing (siteId, ordinal) position is named');
        assert.equal(e.details?.siteId, 'ask#1');
        assert.equal(e.details?.ordinal, 1);
        return true;
      },
    );
    assert.equal(counting.calls, 1, 'the defense fires before any provider call');

    // The journal is untouched: no overwrite, no extra failed row.
    const rowsAfter: DwfNode[] = await store.getDwfNodes(runId);
    assert.equal(rowsAfter.length, 1);
    assert.equal(rowsAfter[0]!.inputHash, rowsBefore[0]!.inputHash);
    assert.equal(rowsAfter[0]!.status, 'completed');

    // The unchanged input still replays content-hit after the failed attempt.
    const engine3 = makeEngine(runId, store);
    const actor3 = await engine3.handleCall(actorFrame(5, 'actor#1'));
    const reply = await engine3.handleCall(askFrame(6, 'ask#1', actor3, 'inspect the service'));
    assert.equal(counting.calls, 1, 'unchanged replay costs zero provider calls');
    assert.ok(typeof reply === 'string' && reply.length > 0);

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('same-script resume: unchanged asks replay by content and a genuinely new ask allocates a fresh ordinal past the journal', async () => {
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-strict-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-replay-strict-alloc';

    // Run 1: two asks at the SAME site (ordinals 1, 2).
    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'question one'));
    await engine1.handleCall(askFrame(3, 'ask#1', actor1, 'question two'));
    assert.equal(counting.calls, 2);
    const rowsBefore: DwfNode[] = await store.getDwfNodes(runId);
    assert.deepEqual(rowsBefore.map((n) => n.ordinal).sort((a, b) => a - b), [1, 2]);

    // Run 2: both replay (content hits — the settle pool), then a genuinely new
    // ask executes live. It must take ordinal 3, never overwrite rows 1-2.
    const engine2 = makeEngine(runId, store);
    const actor2 = await engine2.handleCall(actorFrame(4, 'actor#1'));
    await engine2.handleCall(askFrame(5, 'ask#1', actor2, 'question one'));
    await engine2.handleCall(askFrame(6, 'ask#1', actor2, 'question two'));
    assert.equal(counting.calls, 2, 'replayed prefix costs zero provider calls');
    await engine2.handleCall(askFrame(7, 'ask#1', actor2, 'question three (new)'));
    assert.equal(counting.calls, 3, 'the new ask runs live');

    const rowsAfter: DwfNode[] = await store.getDwfNodes(runId);
    assert.equal(rowsAfter.length, 3, 'no journal row was overwritten');
    const ordinals = rowsAfter.map((n) => n.ordinal).sort((a, b) => a - b);
    assert.deepEqual(ordinals, [1, 2, 3]);
    const row1 = rowsAfter.find((n) => n.ordinal === 1)!;
    assert.equal(row1.inputHash, rowsBefore.find((n) => n.ordinal === 1)!.inputHash, 'row 1 survived byte-identical');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('amend keeps legacy content matching: a changed ask at a covered position runs live without the strict gate', async () => {
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-strict-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-replay-strict-amend';

    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'original question'));
    assert.equal(counting.calls, 1);

    // Amend: fresh runId, warm cache from the prior run. scriptHash differs by
    // construction here — the positional InputHashMismatch gate must NOT fire;
    // the edited input diverges and executes live instead.
    const priorNodes: DwfNode[] = await store.getDwfNodes(runId);
    const importedCache = new Map(priorNodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
    const engine2 = makeEngine('dwfrun-replay-strict-amend-child', store, { importedCache });
    const actor2 = await engine2.handleCall(actorFrame(3, 'actor#1'));
    const reply = await engine2.handleCall(askFrame(4, 'ask#1', actor2, 'an EDITED question'));
    assert.equal(counting.calls, 2, 'the amended ask executes live, it does not fail loudly');
    assert.ok(reply !== undefined);

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});
