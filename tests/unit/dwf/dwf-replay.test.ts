import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import type { LLMProvider, LLMRequest } from '../../../src/types.js';
import type { DwfNode } from '../../../src/domain/workflow-types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { CountingProvider, actorFrame, askFrame, makeNodeApprovedEngine, makeStore } from './test-helpers.js';
import type { DwfTestStore } from './test-helpers.js';

const makeCounting = (): CountingProvider => new CountingProvider('dwf-counting-mock', 'Counting mock');

/**
 * Wrap the store so the Nth saveDwfNode call throws AFTER a successful
 * execute — the Issue #144 scenario: a journalled node whose row write fails
 * mid-run, leaving the journal without that row while the world already moved.
 */
function failSaveOnCall(store: DwfTestStore, failOnCall: number): DwfTestStore {
  let saveCalls = 0;
  const wrapped = Object.create(store) as DwfTestStore;
  wrapped.saveDwfNode = async (node: DwfNode) => {
    saveCalls++;
    if (saveCalls === failOnCall) throw new Error('injected journal write failure (Issue #144)');
    return store.saveDwfNode(node);
  };
  return wrapped;
}

test('engine replay: second engine on the same journal short-circuits asks at zero model calls', async () => {
  const counting = makeCounting();
  providerRegistry.register(counting);
  const previousDefault = 'mock';
  providerRegistry.setDefault('dwf-counting-mock');

  try {
    const store = makeStore();
    const runId = 'dwfrun-replay-test';

    // Run 1: two asks execute against the provider
    const engine1 = makeNodeApprovedEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    const reply1 = await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'inspect the service'));
    // G3 contract: an UNTYPED ask returns the subagent's final reply TEXT (no JSON coercion).
    assert.ok(typeof reply1 === 'string' && reply1.length > 0, `untyped reply is text, got: ${typeof reply1}`);
    const callsAfterRun1 = counting.calls;
    assert.ok(callsAfterRun1 >= 1, 'provider was called on the fresh run');

    // Run 2 (resume): same journal, same inputs �?zero provider calls
    const engine2 = makeNodeApprovedEngine(runId, store);
    const actor2 = await engine2.handleCall(actorFrame(1, 'actor#1'));
    const reply2 = await engine2.handleCall(askFrame(3, 'ask#1', actor2, 'inspect the service'));
    assert.equal(counting.calls, callsAfterRun1, 'replay must not call the provider');
    assert.equal(reply2, reply1);

    // Same site, different prompt �?inputHash mismatch fails loudly
    const engine3 = makeNodeApprovedEngine(runId, store);
    const actor3 = await engine3.handleCall(actorFrame(1, 'actor#1'));
    // Settle pools still match by content, but on a same-script resume the
    // positional strictness gate (P0-2, locked in dwf-replay-strict.test.ts)
    // fires first: a drifted ask input whose arrival position holds an
    // unconsumed journal row fails loudly instead of running live (the amend
    // path, importedCache present, keeps the legacy content-only matching).
    const callsBeforeMismatch = counting.calls;
    await assert.rejects(
      () => engine3.handleCall({ t: 'call', id: 4, op: 'ask', siteId: 'ask#1', payload: [actor3, 'a DIFFERENT prompt', null] }),
      (err: unknown) => {
        const e = err as { tag?: string; message?: string };
        assert.equal(e.tag, 'JournalMismatchError', 'the tagged error vocabulary carries the mismatch');
        assert.match(e.message ?? '', /InputHashMismatch at ask#1#1/);
        return true;
      },
    );
    assert.equal(counting.calls, callsBeforeMismatch, 'the strict gate fires before any provider call');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('issue #144: a non-ask journal row lost to a write failure must not oscillate on resume', async () => {
  const store = makeStore();
  const runId = 'dwfrun-ordinal-converge';

  // Run 1: worldRead A records row #1; worldRead B's row write fails (injected
  // saveDwfNode failure after a successful read) → the run fails, leaving the
  // journal with ONLY row #1 at the site.
  const engine1 = makeNodeApprovedEngine(runId, failSaveOnCall(store, 2));
  const readA = await engine1.handleCall({ t: 'call', id: 1, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['package.json']] });
  await assert.rejects(
    () => engine1.handleCall({ t: 'call', id: 2, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['tsconfig.json']] }),
    /injected journal write failure/,
  );
  const rowsAfterRun1 = (await store.getDwfNodes(runId)).filter((n) => n.siteId === 'wr#1');
  assert.equal(rowsAfterRun1.length, 1, 'the failed write must leave exactly one surviving row');
  assert.equal(rowsAfterRun1[0]!.ordinal, 1);

  // Resume 1: A replays; B runs live and must allocate ordinal 2 — past the
  // surviving pool row — instead of upsert-overwriting row #1 with B's value.
  const engine2 = makeNodeApprovedEngine(runId, store);
  const hitA = await engine2.handleCall({ t: 'call', id: 3, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['package.json']] });
  assert.equal(hitA, readA, 'the surviving row replays verbatim');
  const liveB = await engine2.handleCall({ t: 'call', id: 4, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['tsconfig.json']] });
  assert.notEqual(liveB, readA, 'B executed live against its own input');
  const rowsAfterResume1 = (await store.getDwfNodes(runId)).filter((n) => n.siteId === 'wr#1');
  assert.deepEqual(
    rowsAfterResume1.map((n) => n.ordinal).sort((a, b) => a - b),
    [1, 2],
    'the live call must claim a FRESH ordinal, never overwrite the surviving row',
  );

  // Resume 2: both rows replay — the journal converged. Pre-fix, rows #1/#2
  // swapped ownership on every resume and the run never settled.
  const events: Array<{ type: string }> = [];
  const engine3 = makeNodeApprovedEngine(runId, store, { onEvent: (e) => events.push({ type: e.type }) });
  const hitA2 = await engine3.handleCall({ t: 'call', id: 5, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['package.json']] });
  const hitB2 = await engine3.handleCall({ t: 'call', id: 6, op: 'worldRead', siteId: 'wr#1', payload: ['files.read', ['tsconfig.json']] });
  assert.equal(hitA2, readA);
  assert.equal(hitB2, liveB, 'row #2 replays B — not a swapped value');
  assert.equal(events.filter((e) => e.type === 'dwf_replay_hit').length, 2, 'both calls short-circuit from the journal');
  assert.equal((await store.getDwfNodes(runId)).filter((n) => n.siteId === 'wr#1').length, 2, 'the journal is stable across resumes');

  store.close();
});

test('ask seat gate bounds concurrency across actors; per-actor asks run FIFO', async () => {
  const store = makeStore();
  const counting = makeCounting();
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
  const store = makeStore();
  const engine = makeNodeApprovedEngine('dwfrun-approval', store, { approvedCommands: [{ name: 'node', source: 'explicit' as const }] });
  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 1, op: 'worldRun', siteId: 'worldrun#1', payload: ['curl', ['http://x'], undefined] }),
    // Tagged errors are plain objects — match the message, not String(err).
    { message: /is not authorized/ },
  );
  store.close();
});

test('files.read refusing to escape the workspace', async () => {
  const store = makeStore();
  const engine = makeNodeApprovedEngine('dwfrun-escape', store);
  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 1, op: 'worldRead', siteId: 'worldread#1', payload: ['files.read', ['..\\..\\secret.txt']] }),
    // Tagged errors are plain objects — match the message, not String(err).
    { message: /escapes the workspace/ },
  );
  store.close();
});

test('persistent actor sessions: the second ask sees the first turn, per-actor history is kept', async () => {
  const store = makeStore();
  const counting = makeCounting();
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
    const engine = makeNodeApprovedEngine('dwfrun-history', store);
    const actor = await engine.handleCall(actorFrame(1, 'actor#1'));
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
  const counting = makeCounting();
  providerRegistry.register(counting);
  providerRegistry.setDefault('dwf-counting-mock');

  try {
    const store = makeStore();
    const runId = 'dwfrun-amend-base';

    // Base run: two asks.
    const engine1 = makeNodeApprovedEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'inspect the service'));
    await engine1.handleCall({ t: 'call', id: 3, op: 'ask', siteId: 'ask#2', payload: [actor1, 'second question', null] });
    const callsAfterBase = counting.calls;
    assert.ok(callsAfterBase >= 2);

    // Amend: same ask#1 prompt (replays), changed ask#2 prompt (diverges live).
    const priorNodes = await store.getDwfNodes(runId);
    const importedCache = new Map(priorNodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
    const events: Array<{ type: string }> = [];
    const engine2 = makeNodeApprovedEngine('dwfrun-amend-child', store, {
      importedCache,
      onEvent: (e) => events.push(e),
    });
    const actor2 = await engine2.handleCall(actorFrame(1, 'actor#1'));
    const replayed = await engine2.handleCall(askFrame(4, 'ask#1', actor2, 'inspect the service'));
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
