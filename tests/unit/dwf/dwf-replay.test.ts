import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { MockProvider } from '../../../src/agent/mock-provider.js';

/** Counting wrapper so tests can assert exactly how many provider calls happened. */
class CountingProvider implements LLMProvider {
  readonly id = 'dwf-counting-mock';
  readonly name = 'Counting mock';
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
    approvedCommands: ['node'],
    onEvent: () => {},
    ...overrides,
  });
}

function actorFrame(siteId: string): { t: 'call'; id: number; op: 'createActor'; siteId: string; payload: unknown[] } {
  return { t: 'call', id: 1, op: 'createActor', siteId, payload: ['inspector'] };
}

function askFrame(id: number, siteId: string, actor: unknown): { t: 'call'; id: number; op: 'ask'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op: 'ask', siteId, payload: [actor, 'inspect the service', null] };
}

test('engine replay: second engine on the same journal short-circuits asks at zero model calls', async () => {
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  const previousDefault = 'mock';
  providerRegistry.setDefault('dwf-counting-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-replay-test';

    // Run 1: two asks execute against the provider
    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame('actor#1'));
    const reply1 = await engine1.handleCall(askFrame(2, 'ask#1', actor1));
    // G3 contract: an UNTYPED ask returns the subagent's final reply TEXT (no JSON coercion).
    assert.ok(typeof reply1 === 'string' && reply1.length > 0, `untyped reply is text, got: ${typeof reply1}`);
    const callsAfterRun1 = counting.calls;
    assert.ok(callsAfterRun1 >= 1, 'provider was called on the fresh run');

    // Run 2 (resume): same journal, same inputs �?zero provider calls
    const engine2 = makeEngine(runId, store);
    const actor2 = await engine2.handleCall(actorFrame('actor#1'));
    const reply2 = await engine2.handleCall(askFrame(3, 'ask#1', actor2));
    assert.equal(counting.calls, callsAfterRun1, 'replay must not call the provider');
    assert.equal(reply2, reply1);

    // Same site, different prompt �?inputHash mismatch fails loudly
    const engine3 = makeEngine(runId, store);
    const actor3 = await engine3.handleCall(actorFrame('actor#1'));
    // Settle pools (audit gap #5): a DIFFERENT prompt at the same site finds no
    // unconsumed matching row and executes LIVE (content matching replaced the
    // arrival-keyed loud mismatch; the runner's scriptHash gate still refuses
    // byte-different scripts before an engine is ever constructed).
    const callsBeforeLive = counting.calls;
    const reply3 = await engine3.handleCall({ t: 'call', id: 4, op: 'ask', siteId: 'ask#1', payload: [actor3, 'a DIFFERENT prompt', null] });
    assert.ok(counting.calls > callsBeforeLive, 'an unmatched input executes live');
    assert.ok(typeof reply3 === 'string' && reply3.length > 0);

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('ask seat gate bounds concurrency across actors; per-actor asks run FIFO', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  providerRegistry.setDefault('dwf-counting-mock');
  let concurrent = 0;
  let peak = 0;
  const perActorPeaks = new Map<string, number>();
  const perActorConcurrent = new Map<string, number>();

  const engine = new FacadeEngine({
    runId: 'dwfrun-seat-gate',
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [],
    maxConcurrency: 2,
    onEvent: (e) => {
      const data = e.data as { siteId?: string; actor?: string };
      if (e.type === 'dwf_ask_start') {
        concurrent++;
        peak = Math.max(peak, concurrent);
        const actor = data.actor ?? '?';
        const c = (perActorConcurrent.get(actor) ?? 0) + 1;
        perActorConcurrent.set(actor, c);
        perActorPeaks.set(actor, Math.max(perActorPeaks.get(actor) ?? 0, c));
      }
      if (e.type === 'dwf_ask_complete') {
        concurrent--;
        const actor = data.actor ?? '?';
        perActorConcurrent.set(actor, (perActorConcurrent.get(actor) ?? 1) - 1);
      }
    },
  });

  // Four actors fan out six asks; per-actor FIFO means each actor runs its own asks
  // sequentially, while the global seat gate (maxConcurrency 2) caps the cross-actor peak.
  const actorFrames = await Promise.all(
    ['actor#a', 'actor#b', 'actor#c', 'actor#d'].map((siteId, i) =>
      engine.handleCall({ t: 'call', id: i + 1, op: 'createActor', siteId, payload: [`agent-${siteId}`] }),
    ),
  );
  await Promise.all(
    actorFrames.flatMap((actor, i) =>
      [1, 2].map((k) =>
        engine.handleCall({ t: 'call', id: 10 + i * 2 + k, op: 'ask', siteId: `ask#${i}-${k}`, payload: [actor, `inspect health report ${i}-${k}`, null] }),
      ),
    ),
  );
  assert.equal(peak, 2, `peak concurrency must equal the seat limit, saw ${peak}`);
  for (const [actor, p] of perActorPeaks) {
    assert.equal(p, 1, `actor ${actor} must run its asks FIFO (peak ${p})`);
  }
  store.close();
});

test('world.run outside the approval set is rejected', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const engine = makeEngine('dwfrun-approval', store, { approvedCommands: ['node'] });
  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 1, op: 'worldRun', siteId: 'worldrun#1', payload: ['curl', ['http://x'], undefined] }),
    // Tagged errors are plain objects — match the message, not String(err).
    { message: /not in the approved command set/ },
  );
  store.close();
});

test('files.read refusing to escape the workspace', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const engine = makeEngine('dwfrun-escape', store);
  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 1, op: 'worldRead', siteId: 'worldread#1', payload: ['files.read', ['..\\..\\secret.txt']] }),
    // Tagged errors are plain objects — match the message, not String(err).
    { message: /escapes the workspace/ },
  );
  store.close();
});

test('persistent actor sessions: the second ask sees the first turn, per-actor history is kept', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const counting = new CountingProvider();
  const seenRequests: LLMRequest[] = [];
  const wrapper: LLMProvider = {
    id: 'dwf-history-mock',
    name: 'History-capturing mock',
    async generate(request: LLMRequest) {
      seenRequests.push(request);
      return counting.generate(request);
    },
  };
  providerRegistry.register(wrapper);
  providerRegistry.setDefault('dwf-history-mock');

  try {
    const engine = makeEngine('dwfrun-history', store);
    const actor = await engine.handleCall(actorFrame('actor#1'));
    await engine.handleCall({ t: 'call', id: 2, op: 'ask', siteId: 'ask#1', payload: [actor, 'inspect the service', null] });
    await engine.handleCall({ t: 'call', id: 3, op: 'ask', siteId: 'ask#2', payload: [actor, 'now summarize what you found', null] });

    assert.equal(seenRequests.length, 2);
    const first = seenRequests[0]!;
    const second = seenRequests[1]!;
    assert.equal(first.messages.filter((m) => m.role === 'user').length, 1, 'first ask has a bare conversation');
    // The second ask carries the first turn as prior messages (user + assistant).
    const prior = second.messages.filter((m, i) => i > 0 && i < second.messages.length - 1);
    assert.equal(prior.length, 2, `second ask should embed 2 prior turns, got ${prior.length}`);
    assert.equal(prior[0]!.role, 'user');
    assert.equal(prior[1]!.role, 'assistant');
    assert.match(prior[0]!.content, /inspect the service/, 'user turn is the first prompt');
    assert.match(prior[1]!.content, /HEALTHY/, 'assistant turn carries the first ask result');
  } finally {
    providerRegistry.setDefault('mock');
  }
  store.close();
});

test('amend: an edited script forks a new run �?unchanged asks replay, changed ones diverge', async () => {
  const counting = new CountingProvider();
  providerRegistry.register(counting);
  providerRegistry.setDefault('dwf-counting-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-amend-base';

    // Base run: two asks.
    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame('actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1));
    await engine1.handleCall({ t: 'call', id: 3, op: 'ask', siteId: 'ask#2', payload: [actor1, 'second question', null] });
    const callsAfterBase = counting.calls;
    assert.ok(callsAfterBase >= 2);

    // Amend: same ask#1 prompt (replays), changed ask#2 prompt (diverges live).
    const priorNodes = await store.getDwfNodes(runId);
    const importedCache = new Map(priorNodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
    const events: Array<{ type: string }> = [];
    const engine2 = makeEngine('dwfrun-amend-child', store, {
      importedCache,
      onEvent: (e) => events.push(e),
    });
    const actor2 = await engine2.handleCall(actorFrame('actor#1'));
    const replayed = await engine2.handleCall(askFrame(4, 'ask#1', actor2));
    const diverged = await engine2.handleCall({ t: 'call', id: 5, op: 'ask', siteId: 'ask#2', payload: [actor2, 'a CHANGED second question', null] });

    assert.equal(counting.calls, callsAfterBase + 1, 'only the diverged ask hits the provider');
    assert.ok(events.some((e) => e.type === 'dwf_amend_hit'));
    assert.ok(events.some((e) => e.type === 'dwf_amend_diverged'));
    assert.ok(replayed && diverged);

    // Lineage is recordable on the run row.
    await store.saveDwfRun({ runId: 'dwfrun-amend-child', scriptHash: 'x', status: 'completed', parentRunId: runId });
    const child = await store.getDwfRun('dwfrun-amend-child');
    assert.equal(child?.parentRunId, runId);
    store.close();
  } finally {
    providerRegistry.setDefault('mock');
  }
});
