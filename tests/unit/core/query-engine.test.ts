/**
 * QueryEngine and compaction pipeline tests (Issue #102).
 *
 * The headline case is the compaction budget check: a 20-turn tool session in
 * which every tool output is far larger than the whole budget, and the three
 * compaction tiers keep every model request inside the context budget. Models
 * are scripted (no network): each one records every request it received, so
 * the budget is asserted on what the provider actually saw. Retry waits go
 * through an injected fake sleep, so no test waits on a real clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentProviderError, type ChatOptions, type ChatResult, type ProviderContract } from '../../../src/agent/provider-contract.js';
import type { LLMMessage, TokenUsage } from '../../../src/domain/workflow-types.js';
import {
  EngineConfigError,
  parseToolCalls,
  type EngineEvent,
  type PermissionDecision,
  type PermissionGate,
  type ToolDefinition,
} from '../../../src/core/agent-loop.js';
import { QueryEngine } from '../../../src/core/query-engine.js';
import {
  CompactionPipeline,
  estimateMessages,
  estimateTokens,
  type ContextMessage,
} from '../../../src/core/compaction/pipeline.js';
import { projectToolOutput } from '../../../src/core/compaction/micro-compactor.js';
import { snipHistory } from '../../../src/core/compaction/history-snipper.js';
import { ConversationSummarizer } from '../../../src/core/compaction/summarizer.js';

type Reply = string | Error;

/** A provider that answers from a script, optionally reports usage, and records every request it received. */
class ScriptedProvider implements ProviderContract {
  readonly id = 'scripted';
  readonly name = 'Scripted provider';
  readonly requests: LLMMessage[][] = [];

  constructor(
    private readonly script: (call: number, messages: readonly LLMMessage[]) => Reply,
    private readonly usage?: (call: number) => TokenUsage,
  ) {}

  async chat(messages: readonly LLMMessage[], _options?: ChatOptions): Promise<ChatResult> {
    this.requests.push(messages.map((m) => ({ role: m.role, content: m.content })));
    const call = this.requests.length;
    const reply = this.script(call, messages);
    if (reply instanceof Error) throw reply;
    const usage = this.usage?.(call);
    return usage !== undefined
      ? { content: reply, model: 'scripted', usage, latencyMs: 0 }
      : { content: reply, model: 'scripted', latencyMs: 0 };
  }

  async complete(prompt: string, options?: ChatOptions): Promise<string> {
    return (await this.chat([{ role: 'user', content: prompt }], options)).content;
  }
}

function toolCall(id: string, name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool_calls: [{ id, name, input }] });
}

function ofType<T extends EngineEvent['type']>(events: readonly EngineEvent[], type: T): Extract<EngineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Records each retry wait instead of sleeping. */
function fakeSleep(waits: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    waits.push(ms);
  };
}

const echoTool: ToolDefinition = { name: 'echo', description: 'Echo the input.', execute: (input) => JSON.stringify(input) };

test('Compaction budget DoD: a 20-turn tool session keeps every model request inside the context budget', async () => {
  const BUDGET = 2000;
  const spillDir = tempDir('qe-spill-');
  try {
    const bigLog = (part: number): string => `log part ${part}\n${'x'.repeat(20_000)}\nend of part ${part}`;
    const readLog: ToolDefinition = {
      name: 'read_log',
      description: 'Read one part of the build log.',
      inputSchema: { type: 'object', properties: { part: { type: 'number' } }, required: ['part'] },
      readOnly: true,
      execute: (input) => bigLog(Number(input['part'])),
    };
    const main = new ScriptedProvider((call) =>
      call <= 20 ? toolCall(`c${call}`, 'read_log', { part: call }) : 'All 20 log parts read: the build is clean.',
    );
    const summary = new ScriptedProvider(() => '- read the log parts so far; nothing abnormal yet');
    const engine = new QueryEngine({
      provider: main,
      summaryProvider: summary,
      tools: [readLog],
      compaction: { budgetTokens: BUDGET, keepRecentTurns: 2, spillDir },
    });
    const events: EngineEvent[] = [];
    const result = await engine.run('Read log parts 1 to 20, then report.', { maxTurns: 30, onEvent: (e) => events.push(e) });

    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(result.turns, 21);
    assert.equal(result.text, 'All 20 log parts read: the build is clean.');
    assert.equal(main.requests.length, 21);
    main.requests.forEach((request, i) => {
      const tokens = estimateMessages(request);
      assert.ok(tokens <= BUDGET, `request ${i + 1} needs ${tokens} estimated tokens, over the ${BUDGET}-token budget`);
    });
    for (const start of ofType(events, 'MODEL_REQUEST_START')) {
      assert.ok(start.estimatedTokens <= start.budgetTokens, `turn ${start.turn}: ${start.estimatedTokens} > ${start.budgetTokens}`);
    }
    const applied = new Set(ofType(events, 'COMPACTION').filter((e) => e.applied).map((e) => e.tier));
    for (const tier of ['micro', 'snip', 'summarize'] as const) {
      assert.ok(applied.has(tier), `the ${tier} tier must fire at least once (fired: ${[...applied].join(', ')})`);
    }
    assert.ok(summary.requests.length >= 1, 'the summary model must be called');
    // Neither scripted model reports usage, so every successful call is counted at its estimate.
    assert.equal(result.usage.modelCalls, 21);
    assert.equal(result.usage.summaryCalls, summary.requests.length);
    assert.equal(result.usage.estimatedCalls, 21 + summary.requests.length);
    assert.equal(result.usage.failedCalls, 0);
    assert.ok(result.usage.summary.totalTokens > 0);
    assert.equal(result.usage.total.totalTokens, result.usage.model.totalTokens + result.usage.summary.totalTokens);
    assert.equal(fs.readdirSync(spillDir).length, 20, 'every oversized output is spilled once');
    assert.equal(fs.readFileSync(path.join(spillDir, 'turn-7-c7.txt'), 'utf8'), bigLog(7), 'the spilled file keeps the full output');
  } finally {
    fs.rmSync(spillDir, { recursive: true, force: true });
  }
});

test('parseToolCalls: final text, JSON calls, fenced calls, repaired JSON and protocol errors', () => {
  assert.deepEqual(parseToolCalls('The build is clean.', 1), { kind: 'final' });
  assert.deepEqual(parseToolCalls('I did not need any tool_calls for this.', 1), { kind: 'final' });
  assert.deepEqual(parseToolCalls('   ', 1), { kind: 'invalid', message: 'the reply is empty' });
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"id":"a","name":"read","input":{"p":1}}]}', 2), {
    kind: 'tools',
    calls: [{ id: 'a', name: 'read', input: { p: 1 } }],
  });
  assert.deepEqual(parseToolCalls('```json\n{"tool_calls":[{"name":"read"},{"name":"write","input":{"x":"y"}}]}\n```', 3), {
    kind: 'tools',
    calls: [
      { id: 'call_3_0', name: 'read', input: {} },
      { id: 'call_3_1', name: 'write', input: { x: 'y' } },
    ],
  });
  assert.deepEqual(parseToolCalls("{'tool_calls': [{'name': 'read',}],}", 4), {
    kind: 'tools',
    calls: [{ id: 'call_4_0', name: 'read', input: {} }],
  });
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"id":"a","name":"x"},{"id":"a","name":"y"}]}', 5), {
    kind: 'tools',
    calls: [
      { id: 'a', name: 'x', input: {} },
      { id: 'a_1', name: 'y', input: {} },
    ],
  });
  assert.equal(parseToolCalls('{"tool_calls": "read"}', 6).kind, 'invalid');
  assert.deepEqual(parseToolCalls('{"tool_calls": []}', 6), { kind: 'invalid', message: '"tool_calls" is empty' });
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"input":{}}]}', 6), { kind: 'invalid', message: 'tool_calls[0] has no "name"' });
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"name":"x","input":[1]}]}', 6), {
    kind: 'invalid',
    message: 'tool_calls[0].input must be an object',
  });
  assert.equal(parseToolCalls('{"tool_calls": [{"name": "read"', 7).kind, 'invalid', 'truncated JSON is a protocol error');
});

test('code in another language that mentions tool_calls is a final answer, not a broken call', () => {
  assert.deepEqual(parseToolCalls('```ts\nconst reply = { tool_calls: [] };\nparseToolCalls(reply);\n```', 1), { kind: 'final' });
  assert.deepEqual(parseToolCalls('```python\nreply = {"tool_calls": []}\n```', 1), { kind: 'final' });
  assert.deepEqual(parseToolCalls('```\n{"tool_calls":[{"name":"read"}]}\n```', 2), {
    kind: 'tools',
    calls: [{ id: 'call_2_0', name: 'read', input: {} }],
  });
  assert.equal(parseToolCalls('```json\n{"tool_calls": [{"name": "read"\n```', 3).kind, 'invalid', 'a broken json fence is still a protocol error');
});

test('a denied tool call is not executed and the denial is fed back to the model', async () => {
  let writes = 0;
  const writeFile: ToolDefinition = {
    name: 'write_file',
    description: 'Write a file.',
    execute: () => {
      writes += 1;
      return 'written';
    },
  };
  const denyWrites: PermissionGate = {
    check: (call): PermissionDecision => (call.name === 'write_file' ? { ok: false, reason: 'writes are not allowed here' } : { ok: true }),
  };
  const main = new ScriptedProvider((call) => (call === 1 ? toolCall('w1', 'write_file', { path: 'a.txt' }) : 'Stopped: writing is not allowed.'));
  const engine = new QueryEngine({ provider: main, tools: [writeFile], permissions: denyWrites, compaction: { budgetTokens: 4000 } });
  const events: EngineEvent[] = [];
  const result = await engine.run('Write a.txt', { onEvent: (e) => events.push(e) });

  assert.equal(result.status, 'completed');
  assert.equal(writes, 0, 'a denied tool never runs');
  assert.equal(ofType(events, 'PERMISSION_DENIED').length, 1);
  assert.equal(ofType(events, 'TOOL_RESULT').length, 0);
  assert.ok(
    main.requests[1].some((m) => m.content.startsWith('[PERMISSION_DENIED] write_file (w1): writes are not allowed here')),
    'the denial reaches the next model request',
  );
});

test('maxTurns ends a session that never answers, with a tagged AgentError', async () => {
  const main = new ScriptedProvider((call) => toolCall(`e${call}`, 'echo', { n: call }));
  const result = await new QueryEngine({ provider: main, tools: [echoTool], compaction: { budgetTokens: 4000 } }).run('Loop forever', {
    maxTurns: 3,
  });
  assert.equal(result.status, 'max_turns');
  assert.equal(result.turns, 3);
  assert.equal(main.requests.length, 3);
  assert.equal(result.error?.tag, 'AgentError');
  assert.equal(result.error?.details?.['status'], 'max_turns');
});

test('a transient model failure is retried after a backoff; three in a row end the session as failed', async () => {
  const waits: number[] = [];
  const flaky = new ScriptedProvider((call) => (call === 1 ? new Error('HTTP 503') : 'recovered'));
  const recovered = await new QueryEngine({ provider: flaky, compaction: { budgetTokens: 4000 } }).run('Answer', { sleep: fakeSleep(waits) });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.text, 'recovered');
  assert.equal(recovered.turns, 2);
  assert.deepEqual(waits, [250], 'the shared classifier backs off 250 ms after the first transient failure');
  assert.equal(recovered.usage.failedCalls, 1);
  assert.equal(recovered.usage.modelCalls, 2);

  const downWaits: number[] = [];
  const down = new ScriptedProvider(() => new Error('HTTP 503'));
  const events: EngineEvent[] = [];
  const failed = await new QueryEngine({ provider: down, compaction: { budgetTokens: 4000 } }).run('Answer', {
    sleep: fakeSleep(downWaits),
    onEvent: (e) => events.push(e),
  });
  assert.equal(failed.status, 'failed');
  assert.equal(down.requests.length, 3);
  const errors = ofType(events, 'MODEL_ERROR');
  assert.deepEqual(
    errors.map((e) => e.consecutive),
    [1, 2, 3],
  );
  assert.deepEqual(
    errors.map((e) => e.retryable),
    [true, true, false],
    'the last error says the loop stops',
  );
  assert.deepEqual(downWaits, [250, 500], 'exponential backoff, and no wait after the last failure');
  assert.match(failed.error?.message ?? '', /failed 3 times in a row: HTTP 503/);
});

test('a rate-limited model call waits for the Retry-After hint, then the run goes on', async () => {
  const waits: number[] = [];
  const main = new ScriptedProvider((call) => (call === 1 ? new Error('HTTP 429 Too Many Requests (retry-after 2s)') : 'done after the rate limit'));
  const events: EngineEvent[] = [];
  const result = await new QueryEngine({ provider: main, compaction: { budgetTokens: 4000 } }).run('Answer', {
    sleep: fakeSleep(waits),
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'done after the rate limit');
  assert.deepEqual(waits, [2000]);
  const [failure] = ofType(events, 'MODEL_ERROR');
  assert.equal(failure.category, 'rate_limit');
  assert.equal(failure.retryable, true);
  assert.equal(failure.waitMs, 2000);
});

test('a provider reset time is waited for when it is near, and ends the run when it is too far', async () => {
  const nearWaits: number[] = [];
  const near = new ScriptedProvider((call) =>
    call === 1
      ? new AgentProviderError('scripted', 'HTTP 429 Too Many Requests', { retryable: true, status: 429, resetAtMs: Date.now() + 1500 })
      : 'done after the reset',
  );
  const nearResult = await new QueryEngine({ provider: near, compaction: { budgetTokens: 4000 } }).run('Answer', { sleep: fakeSleep(nearWaits) });
  assert.equal(nearResult.status, 'completed');
  assert.equal(nearWaits.length, 1);
  assert.ok(nearWaits[0] > 1000 && nearWaits[0] <= 2500, `waits for the reset plus a 1 s margin, got ${nearWaits[0]} ms`);

  const farWaits: number[] = [];
  const far = new ScriptedProvider(
    () => new AgentProviderError('scripted', 'HTTP 429 usage limit reached', { retryable: true, status: 429, resetAtMs: Date.now() + 120_000 }),
  );
  const farResult = await new QueryEngine({ provider: far, compaction: { budgetTokens: 4000 } }).run('Answer', { sleep: fakeSleep(farWaits) });
  assert.equal(farResult.status, 'failed');
  assert.equal(far.requests.length, 1, 'no retry when the reset is past maxRetryWaitMs');
  assert.deepEqual(farWaits, []);
  assert.match(farResult.error?.message ?? '', /later than maxRetryWaitMs \(60000 ms\)/);
});

test('auth failures and unknown errors stop at once instead of being retried', async () => {
  const waits: number[] = [];
  const unauthorized = new ScriptedProvider(() => new Error('HTTP 401 Unauthorized: invalid api key'));
  const events: EngineEvent[] = [];
  const result = await new QueryEngine({ provider: unauthorized, compaction: { budgetTokens: 4000 } }).run('Answer', {
    sleep: fakeSleep(waits),
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'failed');
  assert.equal(unauthorized.requests.length, 1);
  assert.deepEqual(waits, []);
  const [failure] = ofType(events, 'MODEL_ERROR');
  assert.equal(failure.category, 'auth');
  assert.equal(failure.retryable, false);
  assert.equal(result.error?.details?.['category'], 'auth');

  const odd = new ScriptedProvider(() => new Error('the model returned something odd'));
  const oddResult = await new QueryEngine({ provider: odd, compaction: { budgetTokens: 4000 } }).run('Answer', { sleep: fakeSleep(waits) });
  assert.equal(oddResult.status, 'failed');
  assert.equal(odd.requests.length, 1, 'unknown errors follow the shared classifier: give up, never storm');
  assert.deepEqual(waits, []);
});

test('a broken tool protocol is fed back; three breaks in a row fail the session', async () => {
  const main = new ScriptedProvider((call) => (call === 1 ? '{"tool_calls": "nope"}' : 'a plain final answer'));
  const result = await new QueryEngine({ provider: main, compaction: { budgetTokens: 4000 } }).run('Answer');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'a plain final answer');
  assert.ok(main.requests[1].some((m) => m.content.startsWith('[PROTOCOL_ERROR]')));

  const broken = new ScriptedProvider(() => '{"tool_calls": []}');
  const failed = await new QueryEngine({ provider: broken, compaction: { budgetTokens: 4000 } }).run('Answer');
  assert.equal(failed.status, 'failed');
  assert.equal(broken.requests.length, 3);
});

test('an aborted signal stops the session before the next model call', async () => {
  const controller = new AbortController();
  const aborting: ToolDefinition = {
    name: 'echo',
    description: 'Echo, and abort the session.',
    execute: () => {
      controller.abort();
      return 'echoed';
    },
  };
  const main = new ScriptedProvider((call) => toolCall(`e${call}`, 'echo'));
  const result = await new QueryEngine({ provider: main, tools: [aborting], compaction: { budgetTokens: 4000 } }).run('Go', {
    signal: controller.signal,
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.turns, 1);
  assert.equal(main.requests.length, 1);
  assert.equal(result.error?.tag, 'AgentError');
});

test('an unknown tool and a throwing tool come back as failed tool results, not crashes', async () => {
  const boom: ToolDefinition = {
    name: 'boom',
    description: 'Always fails.',
    execute: () => {
      throw new Error('disk full');
    },
  };
  const main = new ScriptedProvider((call) =>
    call === 1 ? JSON.stringify({ tool_calls: [{ id: 'x1', name: 'no_such_tool' }, { id: 'x2', name: 'boom' }] }) : 'done',
  );
  const events: EngineEvent[] = [];
  const result = await new QueryEngine({ provider: main, tools: [boom], compaction: { budgetTokens: 4000 } }).run('Go', {
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'completed');
  const results = ofType(events, 'TOOL_RESULT');
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.match(results[0].content, /unknown tool "no_such_tool"; available tools: boom/);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].content, 'tool error: disk full');
});

test('a model stuck on failing tool calls stops as stalled; one working call resets the count', async () => {
  const reader: ToolDefinition = {
    name: 'read',
    description: 'Read a file.',
    execute: (input) => {
      if (input['exists'] !== true) throw new Error('ENOENT: no such file');
      return 'file content';
    },
  };
  const stuck = new ScriptedProvider((call) => toolCall(`r${call}`, 'read', { path: 'missing.txt' }));
  const result = await new QueryEngine({ provider: stuck, tools: [reader], compaction: { budgetTokens: 4000 } }).run('Read missing.txt');
  assert.equal(result.status, 'stalled');
  assert.equal(result.turns, 3);
  assert.equal(stuck.requests.length, 3, 'stops after 3 failed turns instead of running to maxTurns');
  assert.equal(result.error?.details?.['failedToolTurns'], 3);

  // fail, fail, ok, fail, fail, then the answer: never three failed turns in a row.
  const pattern = [false, false, true, false, false];
  const mixed = new ScriptedProvider((call) => (call <= pattern.length ? toolCall(`m${call}`, 'read', { exists: pattern[call - 1] }) : 'done'));
  const mixedResult = await new QueryEngine({ provider: mixed, tools: [reader], compaction: { budgetTokens: 4000 } }).run('Read the files');
  assert.equal(mixedResult.status, 'completed');
  assert.equal(mixedResult.turns, 6);

  // Denied calls count as failed turns too.
  const denyAll: PermissionGate = { check: (): PermissionDecision => ({ ok: false, reason: 'read-only session' }) };
  const pushy = new ScriptedProvider((call) => toolCall(`w${call}`, 'echo'));
  const denied = await new QueryEngine({ provider: pushy, tools: [echoTool], permissions: denyAll, compaction: { budgetTokens: 4000 } }).run('Write', {
    maxFailedToolTurns: 2,
  });
  assert.equal(denied.status, 'stalled');
  assert.equal(denied.turns, 2);
});

test('a context that cannot fit the budget stops before any model call', async () => {
  const main = new ScriptedProvider(() => 'never');
  const result = await new QueryEngine({ provider: main, systemPrompt: 'x'.repeat(4000), compaction: { budgetTokens: 500 } }).run('Go');
  assert.equal(result.status, 'context_overflow');
  assert.equal(main.requests.length, 0);
  assert.equal(result.usage.modelCalls, 0);
  assert.equal(result.error?.tag, 'AgentError');
  assert.equal(result.error?.details?.['budgetTokens'], 500);
});

test('usage adds up across calls, and a spend cap stops the run before the request that would pass it', async () => {
  const USAGE: TokenUsage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
  const main = new ScriptedProvider((call) => (call === 1 ? toolCall('e1', 'echo') : 'done'), () => USAGE);
  const result = await new QueryEngine({ provider: main, tools: [echoTool], compaction: { budgetTokens: 4000 } }).run('Go');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, {
    model: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
    summary: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    total: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
    modelCalls: 2,
    summaryCalls: 0,
    estimatedCalls: 0,
    failedCalls: 0,
  });

  const capped = new ScriptedProvider((call) => toolCall(`e${call}`, 'echo'), () => USAGE);
  const cappedResult = await new QueryEngine({ provider: capped, tools: [echoTool], compaction: { budgetTokens: 4000 } }).run('Go', {
    maxTotalTokens: 200,
  });
  assert.equal(cappedResult.status, 'spend_limit');
  assert.equal(capped.requests.length, 1, 'the second request would pass the cap');
  assert.equal(cappedResult.usage.total.totalTokens, 120);
  assert.equal(cappedResult.error?.details?.['maxTotalTokens'], 200);
  assert.equal(cappedResult.error?.details?.['spentTokens'], 120);
});

test('a streaming provider yields STREAM_CHUNK events and the joined text is the answer', async () => {
  const streaming: ProviderContract = {
    id: 'stream',
    name: 'Streaming provider',
    chat: async () => {
      throw new Error('chat must not be used when stream exists');
    },
    complete: async () => '',
    async *stream() {
      yield 'Hello, ';
      yield 'world.';
    },
  };
  const events: EngineEvent[] = [];
  const result = await new QueryEngine({ provider: streaming, compaction: { budgetTokens: 1000 } }).run('Greet', {
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello, world.');
  assert.deepEqual(
    ofType(events, 'STREAM_CHUNK').map((e) => e.chunk),
    ['Hello, ', 'world.'],
  );
  assert.equal(result.usage.estimatedCalls, 1, 'a stream reports no usage, so the call is counted at its estimate');
});

test('the snapshot hook runs after every turn with tool calls and once at the end', async () => {
  const snapshots: number[] = [];
  const main = new ScriptedProvider((call) => (call <= 2 ? toolCall(`e${call}`, 'echo') : 'done'));
  const result = await new QueryEngine({
    provider: main,
    tools: [echoTool],
    compaction: { budgetTokens: 4000 },
    persistSnapshot: (session) => {
      snapshots.push(session.turn);
    },
  }).run('Go');
  assert.equal(result.status, 'completed');
  assert.deepEqual(snapshots, [1, 2, 3]);
});

test('misconfiguration throws EngineConfigError tagged AgentError', () => {
  const main = new ScriptedProvider(() => 'x');
  assert.throws(
    () => new QueryEngine({ provider: main, tools: [echoTool, echoTool], compaction: { budgetTokens: 1000 } }),
    (err: unknown) => err instanceof EngineConfigError && err.tag === 'AgentError' && /duplicate tool name "echo"/.test(err.message),
  );
  assert.throws(() => new CompactionPipeline({ budgetTokens: 0 }), EngineConfigError);
  assert.throws(() => new CompactionPipeline({ budgetTokens: Number.NaN }), EngineConfigError);
});

test('micro-compactor: small outputs pass through; large ones keep a bounded excerpt and spill in full', () => {
  const dir = tempDir('qe-micro-');
  try {
    const small = projectToolOutput('short output', {
      thresholdTokens: 100,
      headChars: 50,
      tailChars: 50,
      spillDir: dir,
      fileStem: 'small',
      estimate: estimateTokens,
    });
    assert.equal(small.compacted, false);
    assert.equal(small.content, 'short output');
    assert.equal(fs.readdirSync(dir).length, 0);

    const big = `HEAD-${'y'.repeat(10_000)}-TAIL`;
    const projected = projectToolOutput(big, {
      thresholdTokens: 100,
      headChars: 400,
      tailChars: 400,
      spillDir: dir,
      fileStem: 'turn 1/call:a',
      estimate: estimateTokens,
    });
    assert.equal(projected.compacted, true);
    assert.ok(projected.content.startsWith('HEAD-'));
    assert.ok(projected.content.endsWith('-TAIL'));
    assert.ok(estimateTokens(projected.content) < estimateTokens(big) / 10, 'the excerpt is a small part of the output');
    const spilled = projected.spilledPath ?? assert.fail('a projected output must be spilled when spillDir is set');
    assert.equal(path.basename(spilled), 'turn_1_call_a.txt');
    assert.equal(fs.readFileSync(spilled, 'utf8'), big);
    assert.match(projected.content, /full output: file:\/\//);

    const unspilled = projectToolOutput(big, { thresholdTokens: 100, headChars: 400, tailChars: 400, fileStem: 'x', estimate: estimateTokens });
    assert.match(unspilled.content, /full output was not kept/);
    assert.equal(unspilled.spilledPath, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a spilled tool output is redacted before it reaches the disk', () => {
  const dir = tempDir('qe-redact-');
  try {
    // Built at run time so no credential-shaped literal sits in the source.
    const apiKey = ['s', 'k-', 'Q1w2E3r4T5y6U7i8O9p0A1s2'].join('');
    const awsKeyId = ['AK', 'IA', 'Z'.repeat(16)].join('');
    const output = `deploy log: using ${apiKey} and ${awsKeyId}\n${'z'.repeat(4000)}\nend`;
    const projected = projectToolOutput(output, {
      thresholdTokens: 100,
      headChars: 400,
      tailChars: 400,
      spillDir: dir,
      fileStem: 'deploy',
      estimate: estimateTokens,
    });
    assert.equal(projected.compacted, true);
    const spilled = fs.readFileSync(projected.spilledPath ?? assert.fail('a projected output must be spilled when spillDir is set'), 'utf8');
    assert.ok(!spilled.includes(apiKey), 'the API key must not reach the disk');
    assert.ok(!spilled.includes(awsKeyId), 'the AWS key id must not reach the disk');
    assert.match(spilled, /\*\*\*REDACTED\*\*\*/);
    assert.ok(spilled.endsWith('\nend'), 'the rest of the output is kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snipHistory keeps the system prompt, the goal and the newest turns; older turns become one record each', () => {
  const messages: ContextMessage[] = [
    { role: 'system', kind: 'system', turn: 0, content: 'system prompt' },
    { role: 'user', kind: 'goal', turn: 0, content: 'the goal' },
  ];
  for (let turn = 1; turn <= 4; turn++) {
    messages.push({ role: 'assistant', kind: 'assistant', turn, content: toolCall(`c${turn}`, 'read') });
    messages.push({ role: 'user', kind: 'tool_result', turn, content: `[tool_result id=c${turn} name=read ok=true]\nresult ${turn}` });
  }
  const { messages: out, foldedTurns } = snipHistory(messages, { keepRecentTurns: 2 });
  assert.deepEqual(foldedTurns, [1, 2]);
  assert.deepEqual(
    out.map((m) => m.kind),
    ['system', 'goal', 'snipped', 'snipped', 'assistant', 'tool_result', 'assistant', 'tool_result'],
  );
  assert.match(out[2].content, /^\[turn 1 folded\] assistant: .* \| tool_result: \[tool_result id=c1 name=read ok=true\] result 1$/);
  assert.deepEqual(snipHistory(messages, { keepRecentTurns: 4 }).foldedTurns, []);
});

test('pipeline: a failed summary is reported as not applied, and the hard snip still fits the budget', async () => {
  const down = new ScriptedProvider(() => new Error('down'));
  const pipeline = new CompactionPipeline({ budgetTokens: 400, keepRecentTurns: 3, snipExcerptChars: 40 }, down);
  const messages: ContextMessage[] = [
    { role: 'system', kind: 'system', turn: 0, content: 'sys' },
    { role: 'user', kind: 'goal', turn: 0, content: 'goal' },
  ];
  for (let turn = 1; turn <= 6; turn++) {
    messages.push({ role: 'assistant', kind: 'assistant', turn, content: 'a'.repeat(200) });
    messages.push({ role: 'user', kind: 'tool_result', turn, content: 'r'.repeat(200) });
  }
  const result = await pipeline.ensureBudget(messages);
  assert.equal(result.withinBudget, true);
  assert.ok(result.estimatedTokens <= 400, `${result.estimatedTokens} > 400`);
  assert.deepEqual(
    result.events.map((e) => [e.tier, e.applied]),
    [
      ['snip', true],
      ['summarize', false],
      ['snip', true],
    ],
  );
  assert.match(result.events[1].detail, /summarizer failed \(1 in a row\): down/);
  assert.equal(result.events[1].calls, 1, 'a failed summary call still counts as a call');
  assert.match(result.events[2].detail, /^hard snip/);
  assert.deepEqual(
    result.messages.slice(0, 2).map((m) => m.kind),
    ['system', 'goal'],
  );
});

test('the summarize tier waits for enough new history instead of calling the summary model every turn', async () => {
  const BUDGET = 2000;
  // Three results of about 220 tokens per turn: under the micro threshold (250), so
  // the two newest turns alone sit above the 70% summarize trigger.
  const part = (n: number): string => `part ${n}: ${'y'.repeat(870)}`;
  const reader: ToolDefinition = { name: 'read', description: 'Read one part.', execute: (input) => part(Number(input['n'])) };
  const main = new ScriptedProvider((call) =>
    call <= 12
      ? JSON.stringify({ tool_calls: [0, 1, 2].map((k) => ({ id: `c${call}_${k}`, name: 'read', input: { n: call * 3 + k } })) })
      : 'All 36 parts read.',
  );
  const SUMMARY_USAGE: TokenUsage = { promptTokens: 300, completionTokens: 30, totalTokens: 330 };
  const summary = new ScriptedProvider(() => '- read the parts so far; nothing abnormal', () => SUMMARY_USAGE);
  const engine = new QueryEngine({
    provider: main,
    summaryProvider: summary,
    tools: [reader],
    compaction: { budgetTokens: BUDGET, keepRecentTurns: 2 },
  });
  const events: EngineEvent[] = [];
  const result = await engine.run('Read all the parts.', { maxTurns: 20, onEvent: (e) => events.push(e) });

  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.turns, 13);
  main.requests.forEach((request, i) => {
    const tokens = estimateMessages(request);
    assert.ok(tokens <= BUDGET, `request ${i + 1} needs ${tokens} estimated tokens, over the ${BUDGET}-token budget`);
  });
  // Without the new-history floor the summary model ran on almost every turn,
  // each time re-summarizing the previous snapshot.
  assert.ok(summary.requests.length >= 1 && summary.requests.length <= 6, `expected 1-6 summary calls, got ${summary.requests.length}`);
  const summarize = ofType(events, 'COMPACTION').filter((e) => e.tier === 'summarize');
  assert.ok(
    summarize.some((e) => !e.applied && e.calls === 0 && e.detail.startsWith('skipped')),
    'some turns must skip the summary call',
  );
  assert.equal(result.usage.summaryCalls, summary.requests.length);
  assert.deepEqual(result.usage.summary, {
    promptTokens: 300 * summary.requests.length,
    completionTokens: 30 * summary.requests.length,
    totalTokens: 330 * summary.requests.length,
  });
});

test('the summarizer opens its circuit after three failures in a row and is not called again', async () => {
  const history: ContextMessage[] = [{ role: 'user', kind: 'snipped', turn: 1, content: '[turn 1 folded] ...' }];
  const down = new ScriptedProvider(() => new Error('summary model unavailable'));
  const summarizer = new ConversationSummarizer(down);
  for (let i = 0; i < 3; i++) assert.equal(await summarizer.summarize(history), undefined);
  assert.equal(summarizer.tripped, true);
  assert.equal(await summarizer.summarize(history), undefined);
  assert.equal(down.requests.length, 3, 'no call once the circuit is open');
  assert.equal(summarizer.lastError, 'summary model unavailable');

  const flaky = new ScriptedProvider((call) => (call === 1 ? new Error('blip') : '- snapshot'));
  const recovering = new ConversationSummarizer(flaky);
  assert.equal(await recovering.summarize(history), undefined);
  assert.deepEqual(await recovering.summarize(history), { snapshot: '- snapshot' });
  assert.equal(recovering.failures, 0, 'a success resets the failure count');

  const metered = new ConversationSummarizer(
    new ScriptedProvider(() => '- metered', () => ({ promptTokens: 50, completionTokens: 5, totalTokens: 55 })),
  );
  assert.deepEqual(await metered.summarize(history), {
    snapshot: '- metered',
    usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
  });
});

test('pipeline: provider-reported prompt tokens only ever scale the estimate up', () => {
  const pipeline = new CompactionPipeline({ budgetTokens: 1000 });
  const request = [{ content: 'x'.repeat(400) }]; // raw estimate: 100 + 4 = 104
  pipeline.observeUsage(request, 52);
  assert.equal(pipeline.calibrationFactor, 1);
  pipeline.observeUsage(request, 208);
  assert.equal(pipeline.calibrationFactor, 2);
  assert.equal(pipeline.estimate(request), 208);
  assert.equal(pipeline.estimateText('x'.repeat(400)), 200);
  pipeline.observeUsage(request, 100_000);
  assert.equal(pipeline.calibrationFactor, 4);
});
