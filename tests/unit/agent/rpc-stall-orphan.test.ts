/**
 * Issue #125: the stall clock's losing attempts.
 *
 * Pre-fix, a stalled attempt's in-flight request kept running untouched: it
 * billed, held its concurrency/rate-limit slot, and its usage (if it ever
 * completed) never reached the budget. The attempt now owns an
 * AbortController (stall → abort), and every losing attempt is accounted —
 * real usage when the orphan still completes, a conservative maxTokens
 * estimate when it dies on our abort. A resolved orphan whose provider
 * reports no usage takes the same conservative estimate (Issue #192 P3).
 * Caller/settle aborts stay unaccounted (#107: no billing past the settle
 * point).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../../../src/agent/rpc.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import { z } from 'zod';

const OK_SCHEMA = z.object({ ok: z.boolean() });
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';

interface UsageEntry {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  droppedAttempt?: boolean;
  estimated?: boolean;
}

test('#125: a stalled attempt is aborted and its real usage still reaches the budget', async () => {
  const signals: AbortSignal[] = [];
  const slow: LLMProvider = {
    id: 'stall-orphan-slow',
    name: 'stall orphan slow provider',
    // Ignores the abort signal (like a mock): resolves late with usage.
    async generate(req: LLMRequest): Promise<LLMResponse> {
      signals.push(req.signal!);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { content: '{"ok":true}', model: 'slow', latencyMs: 150, usage: { promptTokens: 10, completionTokens: 100, totalTokens: 110 } };
    },
  };
  providerRegistry.register(slow);
  const usage: UsageEntry[] = [];

  await assert.rejects(
    agent('stall-orphan-a').ask('x', OK_SCHEMA, {
      providerId: 'stall-orphan-slow',
      stallMs: 50,
      maxRetries: 3,
      onUsage: (u: UsageEntry) => usage.push(u),
    }),
    (err: unknown) => err instanceof Error && /stalled/.test(err.message)
  );

  assert.equal(signals.length, 3, 'the stall-retry chain made 3 attempts');
  for (const s of signals) {
    assert.ok(s.aborted, 'every stalled attempt must be aborted (no orphaned in-flight requests)');
  }
  // Each losing attempt later RESOLVED (the provider ignores the abort) — its
  // real usage must be recorded as a dropped attempt. The last orphan settles
  // ~100ms after the ask threw; give it the time before asserting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(usage.length, 3, `every losing attempt must be accounted, got ${usage.length}`);
  for (const u of usage) {
    assert.equal(u.completionTokens, 100);
    assert.equal(u.droppedAttempt, true, 'the entry must be marked as a dropped attempt');
  }
});

test('#125: an attempt that dies on the stall abort records the conservative estimate', async () => {
  const signalAware: LLMProvider = {
    id: 'stall-orphan-aware',
    name: 'stall orphan signal-aware provider',
    // Honours the abort signal: rejects when aborted (usage unknowable).
    async generate(req: LLMRequest): Promise<LLMResponse> {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 150);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return { content: '{"ok":true}', model: 'aware', latencyMs: 150, usage: { promptTokens: 10, completionTokens: 100, totalTokens: 110 } };
    },
  };
  providerRegistry.register(signalAware);
  const usage: UsageEntry[] = [];

  await assert.rejects(
    agent('stall-orphan-b').ask('x', OK_SCHEMA, {
      providerId: 'stall-orphan-aware',
      stallMs: 50,
      maxRetries: 2,
      onUsage: (u: UsageEntry) => usage.push(u),
    }),
    (err: unknown) => err instanceof Error && /stalled/.test(err.message)
  );

  const estimates = usage.filter((u) => u.estimated);
  assert.equal(estimates.length, 2, 'each aborted orphan must record the conservative maxTokens estimate');
  for (const u of estimates) {
    assert.equal(u.completionTokens, 2048, 'the estimate is the attempt maxTokens cap');
    assert.equal(u.droppedAttempt, true);
  }
});

test('#192: a stalled orphan that resolves with NO usage from the provider takes the conservative estimate', async () => {
  const noUsage: LLMProvider = {
    id: 'stall-orphan-no-usage',
    name: 'stall orphan no-usage provider',
    // Ignores the abort signal (like a mock) and resolves WITHOUT usage —
    // the request was really billed, but its meter is unreadable.
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { content: '{"ok":true}', model: 'no-usage', latencyMs: 150 };
    },
  };
  providerRegistry.register(noUsage);
  const usage: UsageEntry[] = [];

  await assert.rejects(
    agent('stall-orphan-e').ask('x', OK_SCHEMA, {
      providerId: 'stall-orphan-no-usage',
      stallMs: 50,
      maxRetries: 2,
      onUsage: (u: UsageEntry) => usage.push(u),
    }),
    (err: unknown) => err instanceof Error && /stalled/.test(err.message)
  );

  await new Promise((resolve) => setTimeout(resolve, 300)); // let the orphans settle
  assert.equal(usage.length, 2, `each resolved-but-unmetered orphan must be estimated, got ${JSON.stringify(usage)}`);
  for (const u of usage) {
    assert.equal(u.completionTokens, 2048, 'the estimate is the attempt maxTokens cap');
    assert.equal(u.estimated, true, 'the entry must be marked as an estimate');
    assert.equal(u.droppedAttempt, true, 'the entry must be marked as a dropped attempt');
  }
});

test('#125: a race-loser abort (reason "race-loser") is estimated; a bare caller abort is not', async () => {
  const signals: AbortSignal[] = [];
  const hanging: LLMProvider = {
    id: 'stall-orphan-hanging',
    name: 'stall orphan hanging provider',
    async generate(req: LLMRequest): Promise<LLMResponse> {
      signals.push(req.signal!);
      return new Promise<LLMResponse>((resolve) => {
        // Never resolves unless aborted-with-reason loop-back; safe for tests.
        req.signal?.addEventListener('abort', () => {
          setTimeout(() => resolve({ content: '{"ok":true}', model: 'hanging', latencyMs: 0, usage: { promptTokens: 0, completionTokens: 77, totalTokens: 77 } }), 20);
        }, { once: true });
      });
    },
  };
  providerRegistry.register(hanging);

  // Race-loser: the engine cancels the loser with reason 'race-loser'. The
  // hanging provider completes after the abort with REAL usage — the real
  // number wins over the estimate (the estimate path is test 2's).
  {
    const usage: UsageEntry[] = [];
    const controller = new AbortController();
    const p = agent('stall-orphan-c').ask('x', OK_SCHEMA, {
      providerId: 'stall-orphan-hanging',
      maxRetries: 1,
      signal: controller.signal,
      onUsage: (u: UsageEntry) => usage.push(u),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort('race-loser');
    await p.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80)); // let the orphan settle
    assert.ok(signals[0]?.aborted, 'the loser request must be aborted');
    // The hanging provider RESOLVES after the abort, so the response actually
    // arrived and is accounted once through the normal path (real usage wins
    // over any estimate; the estimate path is the signal-aware case, test 2).
    assert.equal(usage.length, 1, `the race-loser orphan must be accounted exactly once, got ${JSON.stringify(usage)}`);
    assert.ok(!usage[0].estimated, 'no estimate when the real usage arrived');
    assert.equal(usage[0].completionTokens, 77, 'the real usage wins over any estimate');
  }

  // Bare caller abort (user cancel / settle): no ESTIMATE — but if the orphan
  // still completes, its REAL usage is honestly accounted (unmarked).
  {
    const usage: UsageEntry[] = [];
    const controller = new AbortController();
    const p = agent('stall-orphan-d').ask('x', OK_SCHEMA, {
      providerId: 'stall-orphan-hanging',
      maxRetries: 1,
      signal: controller.signal,
      onUsage: (u: UsageEntry) => usage.push(u),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(); // bare — no reason
    await p.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(usage.every((u) => !u.estimated), `a bare caller abort must not be estimated, got ${JSON.stringify(usage)}`);
    assert.equal(usage.length, 1, 'the orphan real usage is still accounted (it was really billed)');
  }
});
