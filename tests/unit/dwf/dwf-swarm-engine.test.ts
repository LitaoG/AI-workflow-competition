/**
 * Phase 4 (F.md §六, Issue #126): engine-side `swarm()` semantics, driven through
 * the same host-call frames the child realm sends — no child process needed.
 *
 * Locked here:
 * - F6: a tuple-typed ask's synthesized Draft-07 schema passes the dispatch lint
 *   and validates (pre-fix, the lint rejected the array `items` and every tuple
 *   ask died before the provider was reached);
 * - F1: swarm tasks carry no conversation (identical messages for every task,
 *   regular asks still accumulate history) and do not FIFO-serialize behind the
 *   actor's chain (concurrency = the engine's ask-seat pool);
 * - replay: swarm turns replay from the journal at zero model calls, matched by
 *   content even when completion order differs from arrival order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';

const respond = (content: string): LLMResponse => ({
  content,
  model: 'swarm-test-mock',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Always answers with a valid `[string, number]` tuple; counts provider calls. */
class TupleProvider implements LLMProvider {
  readonly id = 'dwf-tuple-provider';
  readonly name = 'Tuple provider';
  calls = 0;
  async generate(): Promise<LLMResponse> {
    this.calls++;
    return respond('["a", 1]');
  }
}

/** Records every request's messages; replies with the prompt's own marker. */
class RecordingProvider implements LLMProvider {
  readonly id = 'dwf-recording-provider';
  readonly name = 'Recording provider';
  readonly calls: LLMMessage[][] = [];
  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request.messages);
    const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return respond(user.includes('slow') ? 'slow-ok' : user.includes('boom') ? 'boom-ok' : 'fast-ok');
  }
}

type EngineOptions = Partial<ConstructorParameters<typeof FacadeEngine>[0]>;

function makeEngine(runId: string, store: SQLiteStateStore & DwfJournalStore, overrides: EngineOptions = {}): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
    ...overrides,
  });
}

type CallFrame = { t: 'call'; id: number; op: 'ask' | 'createActor'; siteId: string; payload: unknown[] };

const actorFrame = (id: number, siteId: string): CallFrame => ({ t: 'call', id, op: 'createActor', siteId, payload: ['swarmer', null] });
const askFrame = (id: number, siteId: string, actor: unknown, prompt: string, swarm = false): CallFrame => ({
  t: 'call',
  id,
  op: 'ask',
  siteId,
  payload: [actor, prompt, null, swarm],
});

function useDefault(id: string): () => void {
  providerRegistry.setDefault(id);
  return () => providerRegistry.setDefault('mock');
}

test('a tuple-typed ask passes the dispatch lint and validates its reply (#126 F6)', async () => {
  // The schema comes from the compiler itself — exactly the JSON the engine
  // receives at dispatch time (schema-synth → lintJsonSchema → zod).
  const analysis = analyzeFacadeScript(`const v = await agent("t").ask<[string, number]>("give me a pair");\nreturn v;`);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  const site = analysis.sites.find((s) => s.kind === 'ask');
  assert.ok(site?.schema, 'the compiler synthesized a schema for the tuple');
  const schemaJson = JSON.stringify(site.schema);

  const tuple = new TupleProvider();
  providerRegistry.register(tuple);
  const restore = useDefault(tuple.id);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-tuple-ask', store);
    const actor = await engine.handleCall(actorFrame(1, 'actor#1'));
    // The pre-fix engine threw SchemaValidationError here ("received an invalid
    // JSON Schema") because the lint rejected the array-form items.
    const typed = await engine.handleCall({
      t: 'call', id: 2, op: 'ask', siteId: 'ask#1',
      payload: [actor, 'give me a pair', schemaJson],
    });
    assert.deepEqual(typed, ['a', 1]);
    assert.equal(tuple.calls, 1, 'one provider call: the schema was accepted, no repair retries ran');
  } finally {
    restore();
    store.close();
  }
});

test('swarm tasks carry no conversation; regular asks still accumulate history (#126 F1)', async () => {
  const recorder = new RecordingProvider();
  providerRegistry.register(recorder);
  const restore = useDefault(recorder.id);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-swarm-conversation', store);
    const actor = await engine.handleCall(actorFrame(1, 'actor#1'));
    for (let i = 1; i <= 4; i++) {
      await engine.handleCall(askFrame(i + 1, 'swarm#1', actor, `batch task ${i}`, true));
    }
    assert.equal(recorder.calls.length, 4);
    // The supervision invariant (#126 F1): task N wires the same message COUNT
    // as task 1 — only the user text itself differs, no conversation turns
    // accumulate in front of it.
    assert.ok(recorder.calls.every((messages) => messages.length === recorder.calls[0]!.length), 'every swarm task sends the same number of messages');
    assert.ok(recorder.calls.every((messages) => messages.every((m) => m.role !== 'assistant')), 'no conversation turns leak in');
    const userTexts = recorder.calls.map((messages) => messages.find((m) => m.role === 'user')?.content);
    assert.deepEqual(userTexts, ['batch task 1', 'batch task 2', 'batch task 3', 'batch task 4'], 'each task sends exactly its own user turn');

    // Regular asks on the SAME actor keep the official conversation contract:
    // the second one sees the first's turns as priorMessages.
    await engine.handleCall(askFrame(8, 'ask#1', actor, 'plain ask one', false));
    await engine.handleCall(askFrame(9, 'ask#1', actor, 'plain ask two', false));
    const regular = recorder.calls.slice(4);
    assert.equal(regular.length, 2);
    assert.equal(regular[0]!.length, 2, 'first regular ask: system + user only');
    assert.equal(regular[1]!.length, 4, 'second regular ask: history accumulated');
    assert.ok(regular[1]!.some((m) => m.role === 'assistant'), 'the prior turn is a conversation turn');
  } finally {
    restore();
    store.close();
  }
});

test('swarm tasks do not FIFO behind the actor chain — a held task does not block the next (#126 F1)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: LLMProvider = {
    id: 'dwf-gated-provider',
    name: 'Gated provider',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('slow')) await gate;
      return respond(user.includes('slow') ? 'slow-ok' : 'fast-ok');
    },
  };
  providerRegistry.register(gated);
  const restore = useDefault(gated.id);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-swarm-fifo', store);
    const actor = await engine.handleCall(actorFrame(1, 'actor#1'));
    const slow = engine.handleCall(askFrame(2, 'swarm#1', actor, 'slow task', true)) as Promise<unknown>;
    const fast = engine.handleCall(askFrame(3, 'swarm#1', actor, 'fast task', true)) as Promise<unknown>;
    // Pre-fix, the fast task waited on the actor chain behind the held slow
    // task; the race times out and names the regression.
    const fastReply = await Promise.race([
      fast,
      sleep(2000).then(() => {
        throw new Error('swarm task 2 FIFO-blocked behind task 1 — the actor chain was not bypassed');
      }),
    ]);
    assert.equal(fastReply, 'fast-ok');
    release();
    assert.equal(await slow, 'slow-ok');
  } finally {
    restore();
    store.close();
  }
});

test('swarm concurrency is bounded by the engine seat pool (maxConcurrency)', async () => {
  let inFlight = 0;
  let peak = 0;
  const prober: LLMProvider = {
    id: 'dwf-seat-probe-provider',
    name: 'Seat probe provider',
    async generate(): Promise<LLMResponse> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(25);
      inFlight--;
      return respond('ok');
    },
  };
  providerRegistry.register(prober);
  const restore = useDefault(prober.id);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-swarm-seats', store, { maxConcurrency: 2 });
    const actor = await engine.handleCall(actorFrame(1, 'actor#1'));
    const tasks = [1, 2, 3, 4, 5, 6].map((i) => engine.handleCall(askFrame(i + 1, 'swarm#1', actor, `task ${i}`, true)) as Promise<unknown>);
    const answers = await Promise.all(tasks);
    assert.deepEqual(answers, Array(6).fill('ok'));
    assert.equal(peak, 2, 'six tasks ran two at a time — the seat pool, not the agent count, caps the swarm');
  } finally {
    restore();
    store.close();
  }
});

test('swarm turns replay from the journal at zero model calls, regardless of completion order', async () => {
  let calls = 0;
  const counting: LLMProvider = {
    id: 'dwf-swarm-counting-provider',
    name: 'Counting provider',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls++;
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      // Later tasks answer sooner, so live completion order differs from the
      // task order the journal was written in.
      const delay = user.endsWith('3') ? 5 : user.endsWith('2') ? 20 : 35;
      await sleep(delay);
      return respond(`answer for ${user}`);
    },
  };
  providerRegistry.register(counting);
  const restore = useDefault(counting.id);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine1 = makeEngine('dwfrun-swarm-replay', store, { maxConcurrency: 3 });
    const actor1 = await engine1.handleCall(actorFrame(1, 'actor#1'));
    const prompts = ['swarm task 1', 'swarm task 2', 'swarm task 3'];
    const first = [];
    for (let i = 0; i < prompts.length; i++) {
      first.push(await engine1.handleCall(askFrame(i + 2, 'swarm#1', actor1, prompts[i]!, true)));
    }
    const callsAfterRun1 = calls;
    assert.equal(callsAfterRun1, 3);

    const engine2 = makeEngine('dwfrun-swarm-replay', store, { maxConcurrency: 3 });
    const actor2 = await engine2.handleCall(actorFrame(1, 'actor#1'));
    const second = [];
    for (let i = 0; i < prompts.length; i++) {
      second.push(await engine2.handleCall(askFrame(i + 2, 'swarm#1', actor2, prompts[i]!, true)));
    }
    assert.deepEqual(second, first, 'the resumed run replays the recorded answers in task order');
    assert.equal(calls, callsAfterRun1, 'replay must not call the provider');
  } finally {
    restore();
    store.close();
  }
});
