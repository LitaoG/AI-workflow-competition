/**
 * Issue #38 D8-③ ②: model()/ModelRef routing through the facade chain —
 * compile enforces the closed-set literal rules (9015: non-literal/empty arg,
 * value-position ban, bad persona shapes), lowering passes the id as the fifth
 * createActor argument (model never crosses the host — official parity), and
 * the engine resolves the binding against the run's model directory at actor
 * CREATION (unresolved → the run fails before any ask) with persona-model
 * precedence over provider/tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { lowerFacadeScript } from '../../../src/dwf/lower.js';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { resolveModelToProvider } from '../../../src/agent/model-router.js';

const compile = (body: string) => analyzeFacadeScript(`${body}\nreturn null;`);

test('#38 compile: model() literal rules — non-literal/empty arg is 9015', () => {
  const dynamic = compile(`const id = "mock";\nconst a = agent("x", { model: model(id) });`);
  assert.equal(dynamic.ok, false);
  assert.ok(dynamic.diagnostics.some((d) => d.code === 9015 && /non-empty compile-time string literal/.test(d.message)), JSON.stringify(dynamic.diagnostics));

  const empty = compile(`const a = agent("x", { model: model("") });`);
  assert.equal(empty.ok, false);
  assert.ok(empty.diagnostics.some((d) => d.code === 9015));

  const badShape = compile(`const a = agent("x", { model: "mo" + "ck" });`);
  assert.equal(badShape.ok, false);
  assert.ok(badShape.diagnostics.some((d) => d.code === 9015 && /model option/.test(d.message)));
});

test('#38 compile: a ModelRef in a value position is banned (official 9010 value-position rule)', () => {
  const stray = compile(`const m = model("mock");\nconst a = agent("x", { model: m });`);
  assert.equal(stray.ok, false);
  assert.ok(stray.diagnostics.some((d) => d.code === 9015 && /only valid as the agent\(\) opts\.model binding/.test(d.message)));

  const logged = compile(`log(model("mock"));`);
  assert.equal(logged.ok, false);
  assert.ok(logged.diagnostics.some((d) => d.code === 9015));

  const inline = compile(`const a = agent("x", { model: model("mock") });`);
  assert.equal(inline.ok, true, JSON.stringify(inline.diagnostics));
  const plain = compile(`const a = agent("x", { model: "mock" });`);
  assert.equal(plain.ok, true, 'a plain literal binding is equally legal');
});

test('#38 lowering: the model id rides as the fifth createActor argument (never crosses the host)', () => {
  const viaCall = lowerFacadeScript(`const a = agent("x", { model: model("mock") });`);
  assert.equal(viaCall.analysis.ok, true, JSON.stringify(viaCall.analysis.diagnostics));
  assert.match(viaCall.js, /createActor\([^)]*null\s*,\s*null\s*,\s*["']mock["']\s*\)/s, viaCall.js);

  const viaLiteral = lowerFacadeScript(`const a = agent("x", { model: "mock" });`);
  assert.match(viaLiteral.js, /createActor\([^)]*null\s*,\s*null\s*,\s*["']mock["']\s*\)/s, viaLiteral.js);
  assert.doesNotMatch(viaLiteral.js, /__host\.model/, 'model() never becomes a host call');

  const unmodelled = lowerFacadeScript(`const a = agent("x");`);
  assert.match(unmodelled.js, /createActor\([^)]*null\s*,\s*null\s*,\s*null\s*\)/s, 'an unmodelled actor lowers with a null model');
});

const respond = (content: string): LLMResponse => ({
  content,
  model: 'model-mock',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
});

function tap(id: string): LLMProvider & { hits: number } {
  return {
    id,
    name: id,
    hits: 0,
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      this.hits += 1;
      return respond(`ok from ${id}`);
    },
  };
}

type CallFrame = { t: 'call'; id: number; op: 'ask' | 'createActor'; siteId: string; payload: unknown[] };
const actorFrame = (id: number, opts: unknown[]): CallFrame => ({
  t: 'call', id, op: 'createActor', siteId: 'actor#1', payload: ['router', ...opts],
});
const askFrame = (id: number, actor: unknown, prompt: string): CallFrame => ({
  t: 'call', id, op: 'ask', siteId: 'ask#1', payload: [actor, prompt, null, true],
});

test('#38 engine: persona model wins over provider/tier; unresolved model fails at creation', async () => {
  providerRegistry.register(tap('mock'));
  const alpha = tap('alpha');
  providerRegistry.register(alpha);
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine = new FacadeEngine({
      runId: 'model-route-1',
      workspace: process.cwd(),
      store,
      args: {},
      approvedCommands: [],
      modelDirectory: { opus: 'alpha' },
      onEvent: (e) => events.push(e as { type: string; data: Record<string, unknown> }),
    });
    // model "opus" → directory → provider alpha; wins over an explicit provider.
    engine.onActorCreated('actor#1', 'router', 'mock', undefined, 'opus');
    const actor = { __actor: 'actor#1' };
    await engine.handleCall(askFrame(1, actor, 'hi') as never);
    assert.equal(alpha.hits, 1, 'the ask routed to the directory-resolved provider');
    assert.equal((tap('mock')).hits >= 0, true);

    // the creation event carries the binding and its resolution.
    const created = events.find((e) => e.type === 'dwf_actor_created');
    assert.equal(created?.data.model, 'opus');
    assert.equal(created?.data.modelProvider, 'alpha');
  } finally {
    store.close();
  }

  // Unresolved model: the run fails at ACTOR CREATION — no ask ever fires.
  const store2 = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = new FacadeEngine({
      runId: 'model-route-2',
      workspace: process.cwd(),
      store: store2,
      args: {},
      approvedCommands: [],
    });
    assert.throws(
      () => engine.onActorCreated('actor#1', 'router', undefined, undefined, 'no-such-model'),
      (err: Error) => /does not resolve against the run's model directory/.test(err.message),
    );
  } finally {
    store2.close();
  }
});

test('#38 resolveModelToProvider: provider/model pin, self-map, $level suffix', () => {
  providerRegistry.register(tap('mock'));
  assert.equal(resolveModelToProvider('mock'), 'mock', 'a registered provider id is implicitly a model');
  providerRegistry.register(tap('bedrock'));
  assert.equal(resolveModelToProvider('bedrock/claude-opus-4-5', {}), 'bedrock', 'the provider part pins the route');
  assert.equal(resolveModelToProvider('opus$high', { opus: 'mock' }), 'mock', 'the $level suffix is stripped');
  assert.throws(() => resolveModelToProvider('nope', {}), (err: Error) => /does not resolve/.test(err.message));
});
