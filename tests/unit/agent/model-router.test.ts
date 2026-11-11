/**
 * Phase 6 (F.md §5.6, Issue #151): task-attribute model routing — the tier
 * fast/deep dual track resolves the failover chain's HEAD. Explicit actor
 * provider wins, then explicit tier, then attributes (schema / prompt size),
 * each tier only when configured (options > env); unconfigured tiers fall
 * back to the registry default (no-op routing, pre-router behavior).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoutedProvider } from '../../../src/agent/model-router.js';
import { providerRegistry } from '../../../src/agent/provider.js';

const FAST = 'AI_WORKFLOW_FAST_PROVIDER';
const DEEP = 'AI_WORKFLOW_DEEP_PROVIDER';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of [FAST, DEEP]) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of [FAST, DEEP]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('an explicit actor provider wins outright — tier and env never override it', () => {
  withEnv({ [FAST]: 'fast-p', [DEEP]: 'deep-p' }, () => {
    assert.equal(resolveRoutedProvider({ actorProvider: 'mock', tier: 'deep', hasSchema: true, promptLength: 99_999 }), 'mock');
  });
});

test('explicit tier routes to the configured tier provider; options beat env', () => {
  providerRegistry.register({ id: 'env-fast', name: 'env-fast', generate: async () => ({ content: '', model: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 }) });
  providerRegistry.register({ id: 'env-deep', name: 'env-deep', generate: async () => ({ content: '', model: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 }) });
  providerRegistry.register({ id: 'opt-deep', name: 'opt-deep', generate: async () => ({ content: '', model: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 }) });
  withEnv({ [FAST]: 'env-fast', [DEEP]: 'env-deep' }, () => {
    assert.equal(resolveRoutedProvider({ tier: 'deep', hasSchema: false, promptLength: 0 }), 'env-deep');
    assert.equal(resolveRoutedProvider({ tier: 'fast', hasSchema: true, promptLength: 99_999 }), 'env-fast');
    assert.equal(
      resolveRoutedProvider({ tier: 'deep', hasSchema: false, promptLength: 0, options: { deepProvider: 'opt-deep' } }),
      'opt-deep',
      'the per-run option beats the env',
    );
  });
});

test('without a tier, schema presence or prompt size routes deep, small plain asks route fast', () => {
  providerRegistry.register({ id: 'env-fast', name: 'env-fast', generate: async () => ({ content: '', model: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 }) });
  providerRegistry.register({ id: 'env-deep', name: 'env-deep', generate: async () => ({ content: '', model: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 }) });
  withEnv({ [FAST]: 'env-fast', [DEEP]: 'env-deep' }, () => {
    assert.equal(resolveRoutedProvider({ hasSchema: true, promptLength: 0 }), 'env-deep', 'a schema-validated ask routes deep');
    assert.equal(resolveRoutedProvider({ hasSchema: false, promptLength: 6000 }), 'env-deep', 'a prompt at the threshold routes deep');
    assert.equal(resolveRoutedProvider({ hasSchema: false, promptLength: 5999 }), 'env-fast', 'a small plain ask routes fast');
  });
});

test('an unconfigured tier falls back to the registry default — no-op routing', () => {
  withEnv({ [FAST]: undefined, [DEEP]: undefined }, () => {
    const expected = providerRegistry.get().id;
    assert.equal(resolveRoutedProvider({ tier: 'deep', hasSchema: false, promptLength: 0 }), expected);
    assert.equal(resolveRoutedProvider({ hasSchema: true, promptLength: 99_999 }), expected);
  });
});

test('a configured tier provider that is not registered fails loudly (AgentError tag)', () => {
  withEnv({ [DEEP]: 'not-registered' }, () => {
    assert.throws(
      () => resolveRoutedProvider({ tier: 'deep', hasSchema: false, promptLength: 0 }),
      (e: { tag?: string; message?: string }) => e.tag === 'AgentError' && /not-registered/.test(String(e.message)),
    );
  });
});
