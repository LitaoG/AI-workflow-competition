import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, DwfNode, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';

/**
 * Issue #63: the replay identity of a journalled ask is (siteId, inputHash) —
 * the prompt — so a schema tightened after the node was recorded must not
 * replay an answer that no longer satisfies the CURRENT contract. The replay
 * hit degrades to one live execution instead. The executed (live) ask count
 * also restores from the dwf_runs row so the call cap continues across a
 * resume instead of restarting from zero.
 */

const SCHEMA_NUMBER = JSON.stringify({ type: 'object', properties: { v: { type: 'number' } }, required: ['v'] });
const SCHEMA_STRING = JSON.stringify({ type: 'object', properties: { v: { type: 'string' } }, required: ['v'] });

/** Provider whose canned answer changes per call so the test can tell a replay from a live execution. */
class ScriptedProvider implements LLMProvider {
  readonly id = 'dwf-replay-schema-mock';
  readonly name = 'Scripted mock (replay schema)';
  calls = 0;
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    const v = this.calls === 1 ? 1 : 'fresh';
    return {
      content: JSON.stringify({ v }),
      model: 'mock-scripted',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 1,
    };
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

function askFrame(id: number, siteId: string, actor: unknown, prompt: string, schemaJson: string | null): { t: 'call'; id: number; op: 'ask'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op: 'ask', siteId, payload: [actor, prompt, schemaJson] };
}

/** Build the amend warm cache from a prior run's journal rows (the runner's --amend import shape). */
function warmCache(nodes: DwfNode[]): Map<string, DwfNode> {
  return new Map(nodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
}

test('replay schema guard: a same-script resume with a tightened schema re-executes the ask live instead of replaying a stale answer', async () => {
  const provider = new ScriptedProvider();
  providerRegistry.register(provider);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-schema-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const runId = 'dwfrun-replay-schema-journal';

    // Run 1: typed ask records { v: 1 } under the number contract.
    const engine1 = makeEngine(runId, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    const first = await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'same question', SCHEMA_NUMBER));
    assert.deepEqual(first, { v: 1 });
    assert.equal(provider.calls, 1);

    // Run 2 (same journal, same prompt): the ask's schema tightened to string.
    // The stale { v: 1 } must NOT replay — the node runs live once and the
    // fresh provider answer ({ v: "fresh" }) satisfies the new contract.
    const run2Events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine2 = makeEngine(runId, store, { onEvent: (e) => run2Events.push({ type: e.type, data: e.data }) });
    const actor2 = await engine2.handleCall(actorFrame(3, 'actor#1'));
    const second = await engine2.handleCall(askFrame(4, 'ask#1', actor2, 'same question', SCHEMA_STRING));
    assert.equal(provider.calls, 2, 'the schema-invalid warm entry degrades to exactly one live call (not zero)');
    assert.deepEqual(second, { v: 'fresh' }, 'the live answer satisfies the new schema');
    assert.equal(run2Events.filter((e) => e.type === 'dwf_replay_hit').length, 0, 'no replay hit is claimed for a rejected entry');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('replay schema guard on the amend path: a warm entry that fails the edited schema diverges the actor and runs live', async () => {
  const provider = new ScriptedProvider();
  providerRegistry.register(provider);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-schema-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const baseRun = 'dwfrun-replay-schema-amend-base';

    const engine1 = makeEngine(baseRun, store);
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    const first = await engine1.handleCall(askFrame(2, 'ask#1', actor1, 'same question', SCHEMA_NUMBER));
    assert.deepEqual(first, { v: 1 });

    // Amend (new runId, warm cache imported from the base run): same prompt,
    // tightened schema. The warm entry is consumed but unusable → the actor
    // diverges (dwf_amend_diverged) and the ask runs live.
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine2 = makeEngine('dwfrun-replay-schema-amend-fork', store, {
      importedCache: warmCache(await store.getDwfNodes(baseRun)),
      onEvent: (e) => events.push({ type: e.type, data: e.data }),
    });
    const actor2 = await engine2.handleCall(actorFrame(3, 'actor#1'));
    const second = await engine2.handleCall(askFrame(4, 'ask#1', actor2, 'same question', SCHEMA_STRING));
    assert.equal(provider.calls, 2, 'the warm entry failing the current schema runs live');
    assert.deepEqual(second, { v: 'fresh' });
    assert.equal(events.filter((e) => e.type === 'dwf_amend_hit').length, 0, 'no amend hit is claimed for a rejected entry');
    assert.equal(events.filter((e) => e.type === 'dwf_amend_diverged').length, 1, 'the unusable lineage answer diverges the actor');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('executedAsks restore: a resumed ledger past the size threshold does not re-emit dwf_size_warning', async () => {
  const provider = new ScriptedProvider();
  providerRegistry.register(provider);
  const previousDefault = providerRegistry.get().id;
  providerRegistry.setDefault('dwf-replay-schema-mock');

  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;

    // A fresh engine crossing the 25-ask threshold emits the one-shot warning:
    // the count increments per completed ask, so the pre-execution gate of the
    // 26th ask is where executedAsks first reads >= 25.
    const freshEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const fresh = makeEngine('dwfrun-replay-schema-warn', store, { onEvent: (e) => freshEvents.push({ type: e.type, data: e.data }) });
    const actor = await fresh.handleCall(actorFrame(1, 'actor#1'));
    for (let i = 0; i < 26; i++) {
      await fresh.handleCall(askFrame(i + 2, 'ask#1', actor, `question ${i}`, null));
    }
    assert.equal(freshEvents.filter((e) => e.type === 'dwf_size_warning').length, 1, 'the fresh run warns exactly once at the threshold');

    // A resumed engine whose lineage already executed 25 asks must NOT warn
    // again on its first live ask (Issue #63: the restored count re-arms the
    // one-shot warning as already fired instead of restarting from zero).
    const resumedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const resumed = makeEngine('dwfrun-replay-schema-warn-resumed', store, {
      restoreExecutedAsks: 25,
      onEvent: (e) => resumedEvents.push({ type: e.type, data: e.data }),
    });
    const actor2 = await resumed.handleCall(actorFrame(29, 'actor#1'));
    await resumed.handleCall(askFrame(30, 'ask#1', actor2, 'question after resume', null));
    assert.equal(resumedEvents.filter((e) => e.type === 'dwf_size_warning').length, 0, 'no duplicate size warning on resume');
    // The settlement event carries the ledger's ABSOLUTE count (restored + live):
    // the resumed ask is the lineage's 26th executed ask, not its 1st.
    const spentEvents = resumedEvents.filter((e) => e.type === 'dwf_budget_spent');
    assert.equal(spentEvents.length, 1);
    assert.equal(spentEvents[0]!.data.executedAsks, 26, 'the resumed ledger continues from the restored count (25 + 1), not from zero');

    store.close();
  } finally {
    providerRegistry.setDefault(previousDefault);
  }
});

test('executedAsks round-trips through the dwf_runs row', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  await store.saveDwfRun({
    runId: 'dwfrun-replay-schema-row',
    scriptHash: 'deadbeef',
    status: 'completed',
    executedAsks: 7,
    updatedAt: new Date().toISOString(),
  });
  const row = await store.getDwfRun('dwfrun-replay-schema-row');
  assert.ok(row);
  assert.equal(row.executedAsks, 7, 'the executed_asks column persists and reads back');
  store.close();
});
