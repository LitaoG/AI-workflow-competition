/**
 * Phase 6 (F.md §5.6, Issue #151): tier routing through the facade chain —
 * compile records the tier literal (and refuses non-literals at 9014),
 * lowering passes it as the fourth createActor argument, and the engine
 * routes the ask's failover-chain head through the model router (explicit
 * provider > tier > attributes > registry default).
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

const compile = (body: string) => analyzeFacadeScript(`${body}\nreturn null;`);

test('compile records the tier literal; a non-literal or unknown tier is 9014', () => {
  const ok = compile(`const a = agent("x", { tier: "deep" });`);
  assert.equal(ok.ok, true, JSON.stringify(ok.diagnostics));
  const site = ok.sites.find((s) => s.kind === 'actor');
  assert.equal(site?.tier, 'deep');

  const dynamic = compile(`const t = "fast";\nconst a = agent("x", { tier: t });`);
  assert.equal(dynamic.ok, false);
  assert.ok(dynamic.diagnostics.some((d) => d.code === 9014 && /tier/.test(d.message)), JSON.stringify(dynamic.diagnostics));

  const nonsense = compile(`const a = agent("x", { tier: "sideways" });`);
  assert.equal(nonsense.ok, false);
  assert.ok(nonsense.diagnostics.some((d) => d.code === 9014 && /tier/.test(d.message)));

  const providerStillWorks = compile(`const a = agent("x", { provider: "mock" });`);
  assert.equal(providerStillWorks.ok, true, 'the provider-only form stays clean');
});

test('lowering passes the tier as the fourth createActor argument', () => {
  const lowered = lowerFacadeScript(`const a = agent("x", { tier: "fast" });`);
  assert.equal(lowered.analysis.ok, true, JSON.stringify(lowered.analysis.diagnostics));
  assert.match(lowered.js, /createActor\(\s*["']actor#1["']\s*,\s*["']x["']\s*,\s*null\s*,\s*["']fast["']\s*,\s*null\s*\)/s, lowered.js);

  const untiered = lowerFacadeScript(`const a = agent("x");`);
  assert.match(untiered.js, /createActor\([^)]*null\s*,\s*null\s*\)/s, 'an untiered actor lowers with a null tier');
});

const respond = (content: string): LLMResponse => ({
  content,
  model: 'tier-mock',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
});

/** A provider that records it was called — the routing assertion reads the taps. */
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
const actorFrame = (id: number, opts: unknown[] = [null, null]): CallFrame => ({
  t: 'call', id, op: 'createActor', siteId: 'actor#1', payload: ['router', ...opts],
});
const askFrame = (id: number, actor: unknown, prompt: string): CallFrame => ({
  t: 'call', id, op: 'ask', siteId: 'ask#1', payload: [actor, prompt, null, true],
});

function makeEngine(runId: string, store: SQLiteStateStore & DwfJournalStore): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
  });
}

const ENV_FAST = 'AI_WORKFLOW_FAST_PROVIDER';
const ENV_DEEP = 'AI_WORKFLOW_DEEP_PROVIDER';

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of [ENV_FAST, ENV_DEEP]) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return fn().finally(() => {
    for (const key of [ENV_FAST, ENV_DEEP]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('the engine routes asks through the tier: deep env beats default, explicit provider beats env, unknown tier fails at creation', async () => {
  const fast = tap('router-fast');
  const deep = tap('router-deep');
  providerRegistry.register(fast);
  providerRegistry.register(deep);
  const previous = providerRegistry.get().id;
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    await withEnv({ [ENV_FAST]: 'router-fast', [ENV_DEEP]: 'router-deep' }, async () => {
      // tier 'deep' → deep provider
      const engineA = makeEngine('dwfrun-tier-deep', store);
      const actorA = await engineA.handleCall(actorFrame(1, [null, 'deep']));
      await engineA.handleCall(askFrame(2, actorA, 'hello'));
      assert.equal(deep.hits, 1, 'a deep-tier ask reaches the deep provider');
      assert.equal(fast.hits, 0);

      // tier 'fast' → fast provider
      const engineB = makeEngine('dwfrun-tier-fast', store);
      const actorB = await engineB.handleCall(actorFrame(1, [null, 'fast']));
      await engineB.handleCall(askFrame(2, actorB, 'hello'));
      assert.equal(fast.hits, 1, 'a fast-tier ask reaches the fast provider');

      // explicit provider wins over tier and env
      const engineC = makeEngine('dwfrun-tier-explicit', store);
      const actorC = await engineC.handleCall(actorFrame(1, ['router-fast', 'deep']));
      await engineC.handleCall(askFrame(2, actorC, 'hello'));
      assert.equal(fast.hits, 2, 'an explicit actor provider wins outright');

      // no tier, no schema, small prompt → fast by attribute
      const engineD = makeEngine('dwfrun-tier-attr', store);
      const actorD = await engineD.handleCall(actorFrame(1));
      await engineD.handleCall(askFrame(2, actorD, 'short'));
      assert.equal(fast.hits, 3, 'a small plain ask routes to the fast provider');

      // an unknown tier fails loudly at actor creation
      const engineE = makeEngine('dwfrun-tier-bad', store);
      await assert.rejects(
        engineE.handleCall(actorFrame(1, [null, 'sideways'])),
        (e: { message?: string }) => /unknown tier/.test(String(e?.message)),
      );
    });

    // env unset → registry default (no-op routing)
    await withEnv({ [ENV_FAST]: undefined, [ENV_DEEP]: undefined }, async () => {
      const engineF = makeEngine('dwfrun-tier-unset', store);
      const actorF = await engineF.handleCall(actorFrame(1, [null, 'deep']));
      await engineF.handleCall(askFrame(2, actorF, 'hello'));
      assert.equal(deep.hits, 1, 'an unconfigured tier resolves to the registry default, not the registered tier providers');
      assert.equal(fast.hits, 3);
    });
  } finally {
    providerRegistry.setDefault(previous);
    store.close();
  }
});
