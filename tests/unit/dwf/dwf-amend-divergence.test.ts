import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistry } from '../../../src/agent/provider.js';
import { CountingProvider, actorFrame, askFrame, makeNodeApprovedEngine, makeStore, warmCache } from './test-helpers.js';

const makeCounting = (): CountingProvider => new CountingProvider('dwf-amend-divergence-mock', 'Counting mock (amend divergence)');

test('amend divergence is per-actor monotonic: one miss turns the whole actor live; dwf_amend_diverged fires once per actor', async () => {
  const counting = makeCounting();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-amend-divergence-mock');

  try {
    const store = makeStore();
    const runId = 'dwfrun-amend-div-monotonic';

    // Base run: one actor, three asks at three sites.
    const engine1 = makeNodeApprovedEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'question one'));
    await engine1.handleCall(askFrame(3, 'ask#2', actor1, 'question two'));
    await engine1.handleCall(askFrame(4, 'ask#3', actor1, 'question three'));
    const callsAfterBase = counting.calls;
    assert.equal(callsAfterBase, 3);

    // Amend: ask#1's prompt is edited (warm-cache miss), ask#2 and ask#3 are
    // UNCHANGED. Monotonic divergence: the miss marks actor#1, so the later
    // asks of the same actor skip the warm cache and execute live — no
    // half-warm, half-live conversation prefix.
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine2 = makeNodeApprovedEngine('dwfrun-amend-div-monotonic-child', store, {
      importedCache: warmCache(await store.getDwfNodes(runId)),
      onEvent: (e) => events.push({ type: e.type, data: e.data }),
    });
    const actor2 = await engine2.handleCall(actorFrame(5, 'actor#1'));
    await engine2.handleCall(askFrame(6, 'ask#1', actor2, 'an EDITED question one'));
    await engine2.handleCall(askFrame(7, 'ask#2', actor2, 'question two'));
    await engine2.handleCall(askFrame(8, 'ask#3', actor2, 'question three'));

    assert.equal(counting.calls, callsAfterBase + 3, 'the diverged ask AND both unchanged asks of the diverged actor run live');
    assert.equal(events.filter((e) => e.type === 'dwf_amend_hit').length, 0, 'a diverged actor never consults the warm cache again');

    const diverged = events.filter((e) => e.type === 'dwf_amend_diverged');
    assert.equal(diverged.length, 1, 'exactly one dwf_amend_diverged per actor, not one per node');
    assert.equal(diverged[0]!.data.actor, 'actor#1', 'the event names the diverged actor');
    assert.equal(diverged[0]!.data.siteId, 'ask#1', 'the event fires at the FIRST diverging node');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('divergence is scoped per actor: an untouched actor keeps its warm-cache hits', async () => {
  const counting = makeCounting();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-amend-divergence-mock');

  try {
    const store = makeStore();
    const runId = 'dwfrun-amend-div-scoped';

    // Base run: actor A (two asks) and actor B (two asks).
    const engine1 = makeNodeApprovedEngine(runId, store);
    const actorA1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    const actorB1 = await engine1.handleCall(actorFrame(2, 'actor#2'));
    await engine1.handleCall(askFrame(3, 'ask#1', actorA1, 'A question one'));
    await engine1.handleCall(askFrame(4, 'ask#2', actorA1, 'A question two'));
    await engine1.handleCall(askFrame(5, 'ask#3', actorB1, 'B question one'));
    await engine1.handleCall(askFrame(6, 'ask#4', actorB1, 'B question two'));
    const callsAfterBase = counting.calls;
    assert.equal(callsAfterBase, 4);

    // Amend: only actor A's first ask is edited. A diverges (both A asks run
    // live); B never missed, so B's asks replay from the warm cache.
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine2 = makeNodeApprovedEngine('dwfrun-amend-div-scoped-child', store, {
      importedCache: warmCache(await store.getDwfNodes(runId)),
      onEvent: (e) => events.push({ type: e.type, data: e.data }),
    });
    const actorA2 = await engine2.handleCall(actorFrame(7, 'actor#1'));
    const actorB2 = await engine2.handleCall(actorFrame(8, 'actor#2'));
    await engine2.handleCall(askFrame(9, 'ask#1', actorA2, 'an EDITED A question one'));
    await engine2.handleCall(askFrame(10, 'ask#2', actorA2, 'A question two'));
    await engine2.handleCall(askFrame(11, 'ask#3', actorB2, 'B question one'));
    await engine2.handleCall(askFrame(12, 'ask#4', actorB2, 'B question two'));

    assert.equal(counting.calls, callsAfterBase + 2, 'only actor A\'s two asks run live; actor B replays');
    const hits = events.filter((e) => e.type === 'dwf_amend_hit');
    assert.equal(hits.length, 2, 'actor B keeps both warm-cache hits');
    assert.deepEqual(hits.map((e) => e.data.siteId), ['ask#3', 'ask#4']);

    const diverged = events.filter((e) => e.type === 'dwf_amend_diverged');
    assert.equal(diverged.length, 1);
    assert.equal(diverged[0]!.data.actor, 'actor#1');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('an amend with no ask divergence replays everything and emits no dwf_amend_diverged', async () => {
  const counting = makeCounting();
  providerRegistry.register(counting);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-amend-divergence-mock');

  try {
    const store = makeStore();
    const runId = 'dwfrun-amend-div-clean';

    const engine1 = makeNodeApprovedEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'question one'));
    await engine1.handleCall(askFrame(3, 'ask#2', actor1, 'question two'));
    const callsAfterBase = counting.calls;

    // Amend with zero prompt edits: everything hits, nothing diverges.
    const events: Array<{ type: string }> = [];
    const engine2 = makeNodeApprovedEngine('dwfrun-amend-div-clean-child', store, {
      importedCache: warmCache(await store.getDwfNodes(runId)),
      onEvent: (e) => events.push({ type: e.type }),
    });
    const actor2 = await engine2.handleCall(actorFrame(4, 'actor#1'));
    await engine2.handleCall(askFrame(5, 'ask#1', actor2, 'question one'));
    await engine2.handleCall(askFrame(6, 'ask#2', actor2, 'question two'));

    assert.equal(counting.calls, callsAfterBase, 'a clean amend costs zero provider calls');
    assert.equal(events.filter((e) => e.type === 'dwf_amend_hit').length, 2);
    assert.equal(events.filter((e) => e.type === 'dwf_amend_diverged').length, 0, 'no miss → no divergence event');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});
