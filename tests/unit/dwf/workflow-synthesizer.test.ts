/**
 * Phase 7b (F.md §5.7, Issue #154): the workflow synthesizer — the LLM's
 * script is only accepted when it passes the SAME compile purity gate as
 * hand-written scripts; failed attempts feed the exact diagnostics back,
 * bounded retries, then a structured failure with the last diagnostics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeFacadeScript } from '../../../src/dwf/workflow-synthesizer.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';

const VALID_SCRIPT = [
  'phase("main");',
  'const answer = await agent("worker").ask("Summarize the repository layout");',
  'return { answer };',
  '',
].join('\n');

const INVALID_SCRIPT = [
  'const env = process.env;',
  'phase("main");',
  'return 1;',
  '',
].join('\n');

const respond = (content: string): LLMResponse => ({
  content,
  model: 'synth-mock',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
});

/** A provider that replays a scripted queue of scripts (as JSON replies) and records every prompt. */
function scriptQueueProvider(queue: string[]): LLMProvider & { prompts: string[] } {
  return {
    id: 'synth-queue-provider',
    name: 'Synth queue provider',
    prompts: [],
    async generate(request: LLMRequest): Promise<LLMResponse> {
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      this.prompts.push(user);
      const script = queue.shift() ?? INVALID_SCRIPT;
      return respond(JSON.stringify({ script, notes: 'queued reply' }));
    },
  };
}

function withProvider(provider: LLMProvider, fn: () => Promise<void>): Promise<void> {
  providerRegistry.register(provider);
  const previous = providerRegistry.get().id;
  providerRegistry.setDefault(provider.id);
  return fn().finally(() => {
    providerRegistry.setDefault(previous);
  });
}

test('a gate-clean first draft is accepted with attempts=1', async () => {
  const provider = scriptQueueProvider([VALID_SCRIPT]);
  await withProvider(provider, async () => {
    const result = await synthesizeFacadeScript({ task: 'Summarize the repo' });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    if (result.ok) {
      assert.match(result.script, /phase\("main"\)/);
      assert.equal(result.notes, 'queued reply');
    }
  });
});

test('failed attempts feed the real compiler diagnostics back until the gate passes', async () => {
  const provider = scriptQueueProvider([INVALID_SCRIPT, INVALID_SCRIPT, VALID_SCRIPT]);
  await withProvider(provider, async () => {
    const result = await synthesizeFacadeScript({ task: 'Summarize the repo' });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3, 'two gate rejections then acceptance');
    assert.ok(provider.prompts.length >= 3);
    // The repair prompts quote the failure: diagnostics + the previous script.
    assert.match(provider.prompts[1]!, /FAILED the compile purity gate/);
    assert.match(provider.prompts[1]!, /code \d+ at line \d+/);
    assert.match(provider.prompts[2]!, /process\.env/, 'the rejected script rides along as context');
  });
});

test('exhausted attempts return a structured failure with the last diagnostics', async () => {
  const provider = scriptQueueProvider([INVALID_SCRIPT, INVALID_SCRIPT, INVALID_SCRIPT]);
  await withProvider(provider, async () => {
    const result = await synthesizeFacadeScript({ task: 'Summarize the repo' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    if (!result.ok) {
      assert.ok(result.lastDiagnostics.length > 0, 'the compiler diagnostics surface for the caller');
    }
  });
});

test('maxAttempts option bounds the loop (1 = draft only, no repairs)', async () => {
  const provider = scriptQueueProvider([INVALID_SCRIPT, VALID_SCRIPT, VALID_SCRIPT]);
  await withProvider(provider, async () => {
    const result = await synthesizeFacadeScript({ task: 'Summarize the repo', maxAttempts: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(provider.prompts.length, 1, 'no repair ask was issued');
  });
});
