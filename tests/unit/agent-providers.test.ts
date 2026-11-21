/**
 * Unit tests for the unified Provider Contract and its two native HTTP
 * adapters (Anthropic Messages API, OpenAI-compatible Chat Completions).
 *
 * All network traffic is mocked via injectable `fetchImpl` — the adapters are
 * asserted on request shape (URL, headers, body fields), response parsing,
 * error mapping (non-2xx status / transport failure → AgentProviderError with
 * the domain `AgentError` tag), and credential discipline: no API key may ever
 * appear in an error message, the details payload, or the stack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  AgentProviderError,
  asContract,
  asLlmProvider,
  type ProviderContract,
  type ProviderErrorDetails,
} from '../../src/agent/provider-contract.js';
import { AnthropicProvider, configureAnthropicFromEnv, resolveAnthropicCacheControl } from '../../src/agent/anthropic-provider.js';
import { OpenAiProvider, configureOpenAiFromEnv } from '../../src/agent/openai-provider.js';
import { configureHttpProvidersFromEnv } from '../../src/agent/http-providers.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { MockProvider } from '../../src/agent/mock-provider.js';
import { agent } from '../../src/agent/rpc.js';
import { isDomainError } from '../../src/domain/errors.js';
import type { LLMMessage } from '../../src/types.js';

// ============================================================================
// Helpers
// ============================================================================

interface RecordedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

type MockReply = { status?: number; body?: unknown; rejectWith?: Error; headers?: Record<string, string> };

function mockFetch(reply: MockReply): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: any, init?: any) => {
    calls.push({ url: String(input), init });
    if (reply.rejectWith) throw reply.rejectWith;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const ANTHROPIC_KEY = 'sk-ant-test-DO-NOT-LEAK-0123456789';
const OPENAI_KEY = 'sk-openai-test-DO-NOT-LEAK-9876543210';
const SYSTEM_AND_USER: LLMMessage[] = [
  { role: 'system', content: 'You are specialized agent "tester". Respond with JSON only.' },
  { role: 'user', content: 'give me the answer' },
];

/** Assert the mandatory AgentProviderError contract shape end to end. */
function assertAgentErrorShape(err: AgentProviderError, provider: string): ProviderErrorDetails {
  assert.equal(err.tag, 'AgentError');
  assert.ok(isDomainError(err), 'must satisfy the domain error algebra structurally');
  assert.ok(err instanceof Error);
  assert.equal(err.details.provider, provider);
  assert.ok(typeof err.details.retryable === 'boolean');
  return err.details;
}

/** Await a rejection and hand back the thrown error (node assert.rejects returns void). */
async function rejectsAgentError(promise: Promise<unknown>): Promise<AgentProviderError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AgentProviderError, `expected AgentProviderError, got: ${String(err)}`);
    return err as AgentProviderError;
  }
  throw new Error('expected the provider call to reject');
}

/** Assert the credential never leaks into message, details, or stack. */
function assertNoKeyLeak(err: unknown, key: string): void {
  const e = err as Error;
  assert.ok(!e.message.includes(key), 'error message must not contain the API key');
  assert.ok(!JSON.stringify((e as AgentProviderError).details).includes(key), 'error details must not contain the API key');
  assert.ok(!e.stack?.includes(key), 'error stack must not contain the API key');
}

// ============================================================================
// Anthropic adapter
// ============================================================================

test('AnthropicProvider.chat sends the Messages API request shape', async () => {
  const { fetch, calls } = mockFetch({
    body: { content: [{ type: 'text', text: '{"answer": 42}' }], model: 'claude-test', usage: { input_tokens: 11, output_tokens: 7 } },
  });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, model: 'claude-test', fetchImpl: fetch });

  const result = await provider.chat(SYSTEM_AND_USER, { temperature: 0.2, maxTokens: 128 });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers?.['content-type'], 'application/json');
  assert.equal(call.init.headers?.['x-api-key'], ANTHROPIC_KEY, 'key must ride the x-api-key header');
  assert.equal(call.init.headers?.['anthropic-version'], '2023-06-01');

  const body = JSON.parse(call.init.body!) as any;
  assert.equal(body.model, 'claude-test');
  assert.equal(body.max_tokens, 128);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.system, SYSTEM_AND_USER[0]!.content, 'system prompt must be lifted to the top-level system field');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'give me the answer' }], 'system must not repeat inside messages');
  assert.equal(body.cache_control, undefined, 'a top-level cache_control field is invalid Messages API shape (HTTP 400) and must never be sent');
  assert.equal(typeof body.system, 'string', 'system stays a plain string unless prompt caching is explicitly enabled');

  assert.equal(result.content, '{"answer": 42}');
  assert.equal(result.model, 'claude-test');
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.ok(Number.isFinite(result.latencyMs));
});

test('AnthropicProvider can turn the prompt-cache marker off for proxies that reject it', async () => {
  const { fetch, calls } = mockFetch({ body: { content: [{ type: 'text', text: 'ok' }], model: 'claude-test' } });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch, cacheControl: false });
  await provider.complete('ping');
  const body = JSON.parse(calls[0]!.init.body!) as any;
  assert.equal(body.cache_control, undefined, 'cacheControl:false must omit the field entirely');
});

test('AnthropicProvider cacheControl:true marks the SYSTEM content block, never a top-level field', async () => {
  const { fetch, calls } = mockFetch({ body: { content: [{ type: 'text', text: 'ok' }], model: 'claude-test' } });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch, cacheControl: true });
  await provider.chat(SYSTEM_AND_USER);
  const body = JSON.parse(calls[0]!.init.body!) as any;
  assert.equal(body.cache_control, undefined, 'the top-level field is invalid Messages API shape (HTTP 400)');
  assert.deepEqual(
    body.system,
    [{ type: 'text', text: SYSTEM_AND_USER[0]!.content, cache_control: { type: 'ephemeral' } }],
    'the marker rides the system content block — the only cache_control form the Messages API accepts',
  );
});

test('AnthropicProvider.complete returns the bare text and uses configured defaults', async () => {
  const { fetch, calls } = mockFetch({ body: { content: [{ type: 'text', text: 'plain answer' }], model: 'm1' } });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, model: 'm1', fetchImpl: fetch, temperature: 0.0, maxTokens: 2048 });

  const text = await provider.complete('ping');
  assert.equal(text, 'plain answer');

  const body = JSON.parse(calls[0]!.init.body!) as any;
  assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
  assert.equal(body.model, 'm1');
  assert.equal(body.temperature, 0.0);
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.system, undefined);
});

test('AnthropicProvider maps non-2xx to AgentError with correct retryable flags', async () => {
  const cases: Array<{ status: number; retryable: boolean }> = [
    { status: 429, retryable: true },
    { status: 500, retryable: true },
    { status: 503, retryable: true },
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 404, retryable: false },
  ];
  for (const { status, retryable } of cases) {
    const { fetch } = mockFetch({ status, body: { error: { message: 'server said no' } } });
    const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
    const err = await rejectsAgentError(provider.chat(SYSTEM_AND_USER));
    const details = assertAgentErrorShape(err, 'anthropic');
    assert.equal(details.status, status, `status ${status}`);
    assert.equal(details.retryable, retryable, `status ${status} retryable`);
    assert.ok(err.message.includes(`HTTP ${status}`));
  }
});

test('AnthropicProvider surfaces Retry-After on 429 as a structured resetAtMs', async () => {
  const before = Date.now();
  const { fetch } = mockFetch({
    status: 429,
    body: { error: { message: 'rate limited' } },
    headers: { 'retry-after': '2' },
  });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
  const err = await rejectsAgentError(provider.chat(SYSTEM_AND_USER));
  const details = assertAgentErrorShape(err, 'anthropic');
  assert.equal(details.status, 429);
  assert.equal(typeof details.resetAtMs, 'number');
  assert.ok(details.resetAtMs! >= before + 1900, `resetAtMs too early: ${details.resetAtMs}`);
  assert.ok(details.resetAtMs! <= Date.now() + 2100, `resetAtMs too late: ${details.resetAtMs}`);
});

test('AnthropicProvider maps transport failures to a retryable AgentError without status', async () => {
  const { fetch } = mockFetch({ rejectWith: new TypeError('fetch failed') });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
  const err = await rejectsAgentError(provider.chat(SYSTEM_AND_USER));
  const details = assertAgentErrorShape(err, 'anthropic');
  assert.equal(details.retryable, true);
  assert.equal(details.status, undefined);
  assert.ok(err.message.includes('network'));
});

test('AnthropicProvider reports an adapter-owned timeout as retryable', async () => {
  const { fetch } = mockFetch({ rejectWith: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch, timeoutMs: 25 });
  const err = await rejectsAgentError(provider.chat(SYSTEM_AND_USER));
  const details = assertAgentErrorShape(err, 'anthropic');
  assert.equal(details.retryable, true);
  assert.ok(err.message.includes('timeout'));
});

test('AnthropicProvider keeps caller-driven cancels as AbortError, not a provider error', async () => {
  const { fetch, calls } = mockFetch({ body: {} });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.chat(SYSTEM_AND_USER, { signal: controller.signal }),
    (err: Error) => err.name === 'AbortError',
  );
  assert.equal(calls.length, 0, 'aborted-before-send must not reach fetch');
});

test('AnthropicProvider redacts the API key out of error message, details, and stack', async () => {
  // Server echoes the credential back inside the error body — worst case.
  const { fetch } = mockFetch({
    status: 401,
    body: { error: { message: `invalid x-api-key (received ${ANTHROPIC_KEY})` } },
  });
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
  const err = await rejectsAgentError(provider.chat(SYSTEM_AND_USER));

  assertNoKeyLeak(err, ANTHROPIC_KEY);
  assert.ok(err.message.includes('[REDACTED]'), 'server body excerpt must be sanitized before entering the message');
  const details = assertAgentErrorShape(err, 'anthropic');
  assert.deepEqual(Object.keys(details).sort(), ['provider', 'retryable', 'status'], 'details carry only the mandated keys');
});

test('AnthropicProvider does not advertise structured/stream channels', () => {
  const { fetch } = mockFetch({ body: {} });
  const provider: ProviderContract = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, fetchImpl: fetch });
  assert.equal(provider.structured, undefined, 'Messages API has no native response_format channel');
  assert.equal(provider.stream, undefined);
});

// ============================================================================
// OpenAI-compatible adapter
// ============================================================================

test('OpenAiProvider.chat sends the Chat Completions request shape', async () => {
  const { fetch, calls } = mockFetch({
    body: { choices: [{ message: { content: '{"answer": 42}' } }], model: 'gpt-test', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
  });
  const provider = new OpenAiProvider({
    apiKey: OPENAI_KEY,
    model: 'gpt-test',
    baseUrl: 'https://gateway.example.internal/v1',
    fetchImpl: fetch,
  });

  const result = await provider.chat(SYSTEM_AND_USER, { temperature: 0.1, maxTokens: 64 });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://gateway.example.internal/v1/chat/completions', 'baseUrl must be honored');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers?.['content-type'], 'application/json');
  assert.equal(call.init.headers?.['authorization'], `Bearer ${OPENAI_KEY}`, 'key must ride the Authorization header');

  const body = JSON.parse(call.init.body!) as any;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.messages, SYSTEM_AND_USER, 'system stays inline for OpenAI');
  assert.equal(body.response_format, undefined, 'plain chat must not send structured params');

  assert.equal(result.content, '{"answer": 42}');
  assert.equal(result.model, 'gpt-test');
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
});

test('OpenAiProvider.structured sends response_format json_schema params', async () => {
  const { fetch, calls } = mockFetch({
    body: { choices: [{ message: { content: '{"answer": 42}' } }], model: 'gpt-test' },
  });
  const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, model: 'gpt-test', fetchImpl: fetch });

  const result = await provider.structured(
    SYSTEM_AND_USER,
    { name: 'answer_card', schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } },
  );

  const body = JSON.parse(calls[0]!.init.body!) as any;
  assert.deepEqual(
    body.response_format,
    {
      type: 'json_schema',
      json_schema: {
        name: 'answer_card',
        schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
        strict: false,
      },
    },
    'structured channel must map the spec onto response_format',
  );
  assert.deepEqual(body.messages, SYSTEM_AND_USER, 'messages must be unchanged by the structured channel');
  assert.equal(result.content, '{"answer": 42}');
});

test('OpenAiProvider parses null content and missing usage defensively', async () => {
  const { fetch } = mockFetch({ body: { choices: [{ message: { content: null } }], model: 'gpt-test' } });
  const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, fetchImpl: fetch });
  const result = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(result.content, '');
  assert.equal(result.usage, undefined);
  assert.equal(result.model, 'gpt-test');
});

test('OpenAiProvider maps non-2xx and transport failures to AgentError with correct retryable flags', async () => {
  const retryable: number[] = [429, 500, 502, 503, 504];
  for (const status of retryable) {
    const { fetch } = mockFetch({ status, body: { error: { message: 'back off' } } });
    const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, fetchImpl: fetch });
    const err = await rejectsAgentError(provider.chat([{ role: 'user', content: 'x' }]));
    const details = assertAgentErrorShape(err, 'openai');
    assert.equal(details.retryable, true, `status ${status}`);
    assert.equal(details.status, status);
  }
  for (const status of [400, 401, 403, 409]) {
    const { fetch } = mockFetch({ status, body: { error: { message: 'nope' } } });
    const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, fetchImpl: fetch });
    const err = await rejectsAgentError(provider.chat([{ role: 'user', content: 'x' }]));
    const details = assertAgentErrorShape(err, 'openai');
    assert.equal(details.retryable, false, `status ${status}`);
    assert.equal(details.status, status);
  }

  const network = mockFetch({ rejectWith: new TypeError('fetch failed') });
  const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, fetchImpl: network.fetch });
  const err = await rejectsAgentError(provider.chat([{ role: 'user', content: 'x' }]));
  const details = assertAgentErrorShape(err, 'openai');
  assert.equal(details.retryable, true);
  assert.equal(details.status, undefined);
});

test('OpenAiProvider redacts the API key out of error message, details, and stack', async () => {
  const { fetch } = mockFetch({
    status: 401,
    body: { error: { message: `incorrect API key provided: ${OPENAI_KEY}` } },
  });
  const provider = new OpenAiProvider({ apiKey: OPENAI_KEY, fetchImpl: fetch });
  const err = await rejectsAgentError(provider.chat([{ role: 'user', content: 'x' }]));

  assertNoKeyLeak(err, OPENAI_KEY);
  assert.ok(err.message.includes('[REDACTED]'));
});

// ============================================================================
// Bridges: legacy LLMProvider onto the contract, contract onto the registry
// ============================================================================

test('asContract lifts the legacy MockProvider onto the unified contract', async () => {
  const contract = asContract(new MockProvider());
  assert.equal(contract.id, 'mock');

  const result = await contract.chat([
    { role: 'system', content: 'You are specialized agent "triage".' },
    { role: 'user', content: 'incident telemetry p1' },
  ]);
  assert.equal(typeof result.content, 'string');
  assert.ok(JSON.parse(result.content), 'mock chat content must stay parseable for the self-heal loop');
  assert.ok(Number.isFinite(result.latencyMs));

  const text = await contract.complete('remediation plan please');
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('asLlmProvider wraps a contract adapter into the registry shape and satisfies the RPC self-heal loop', async () => {
  const { fetch } = mockFetch({
    body: { content: [{ type: 'text', text: '{"answer": 42}' }], model: 'claude-test', usage: { input_tokens: 5, output_tokens: 3 } },
  });
  const adapter = new AnthropicProvider({ apiKey: ANTHROPIC_KEY, model: 'claude-test', fetchImpl: fetch });
  const legacy = asLlmProvider(adapter);
  assert.equal(legacy.id, 'anthropic');
  assert.equal(legacy.name, adapter.name);

  providerRegistry.register(legacy);
  const client = agent('contract-adapter-agent');
  const res = await client.ask('give me the answer', z.object({ answer: z.number() }), { providerId: 'anthropic' });
  assert.deepEqual(res, { answer: 42 }, 'ChatResult.content must flow through extractJson/parse unchanged');
});

// ============================================================================
// Env-driven opt-in registration
// ============================================================================

test('configureAnthropicFromEnv is a no-op without ANTHROPIC_API_KEY and never moves the default', () => {
  const before = providerRegistry.get().id;
  assert.equal(configureAnthropicFromEnv({}), undefined);
  assert.equal(providerRegistry.get().id, before, 'default provider must stay mock');
});

test('configureAnthropicFromEnv registers the anthropic provider from env, default stays mock', async () => {
  assert.equal(configureAnthropicFromEnv({ ANTHROPIC_API_KEY: 'sk-test-env' }), 'anthropic');
  assert.ok(providerRegistry.list().includes('anthropic'));
  assert.equal(providerRegistry.get('anthropic').id, 'anthropic');
  assert.equal(providerRegistry.get().id, 'mock', 'registry default must remain the offline mock');

  const health = await providerRegistry.get('anthropic').checkHealth?.();
  assert.ok(health?.ok);
  assert.ok(!health.detail.includes('sk-test-env'), 'health detail must not leak the key');
});

test('configureOpenAiFromEnv is a no-op without OPENAI_API_KEY and registers model/baseUrl overrides when present', () => {
  const before = providerRegistry.get().id;
  assert.equal(configureOpenAiFromEnv({}), undefined);
  assert.equal(providerRegistry.get().id, before, 'default provider must stay mock');

  assert.equal(configureOpenAiFromEnv({ OPENAI_API_KEY: 'sk-test-env' }), 'openai');
  assert.ok(providerRegistry.list().includes('openai'));
  assert.equal(providerRegistry.get().id, 'mock', 'registry default must remain the offline mock');

  const withOverrides = new OpenAiProvider({
    apiKey: 'sk-x',
    model: 'gpt-override',
    baseUrl: 'https://proxy.example/v1',
  });
  const health = withOverrides.checkHealth();
  assert.ok(health.ok);
  assert.ok(health.detail.includes('gpt-override'), 'env model override must reach the provider config');
  assert.ok(health.detail.includes('proxy.example'), 'env baseUrl override must reach the provider config');
});

test('configureHttpProvidersFromEnv dispatches lazily and only on credential presence', async () => {
  const before = providerRegistry.get().id;

  assert.deepEqual(await configureHttpProvidersFromEnv({}), [], 'no credentials → no registrations');

  assert.deepEqual(
    await configureHttpProvidersFromEnv({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-b' }),
    ['anthropic', 'openai'],
    'both providers register in order when both keys are present',
  );
  assert.ok(providerRegistry.list().includes('anthropic'));
  assert.ok(providerRegistry.list().includes('openai'));
  assert.equal(providerRegistry.get().id, before, 'registry default must remain whatever it was (mock)');
});

// ---------------------------------------------------------------------------
// Issue #260: the cache switch was constructor-only, so the production path
// never enabled it. These lock the env decision AND the wiring into the
// registered provider (the exact gap the issue reported).
// ---------------------------------------------------------------------------

test('resolveAnthropicCacheControl defaults by endpoint and honours the explicit switch', () => {
  assert.equal(
    resolveAnthropicCacheControl({ ANTHROPIC_API_KEY: 'sk' }),
    true,
    'official API → cache on (cache reads bill ~0.1x input)',
  );
  assert.equal(
    resolveAnthropicCacheControl({ ANTHROPIC_API_KEY: 'sk', ANTHROPIC_BASE_URL: 'https://proxy.example' }),
    false,
    'custom gateway → cache off (unknown 400 risk)',
  );
  assert.equal(
    resolveAnthropicCacheControl({ ANTHROPIC_BASE_URL: 'https://proxy.example', AI_WORKFLOW_ANTHROPIC_CACHE: '1' }),
    true,
    'explicit on beats the gateway default',
  );
  assert.equal(
    resolveAnthropicCacheControl({ AI_WORKFLOW_ANTHROPIC_CACHE: 'off' }),
    false,
    'explicit off beats the official default',
  );
  assert.equal(
    resolveAnthropicCacheControl({ ANTHROPIC_BASE_URL: 'https://proxy.example', AI_WORKFLOW_ANTHROPIC_CACHE: 'maybe' }),
    false,
    'unrecognised value falls back to the endpoint policy',
  );
});

test('configureAnthropicFromEnv wires the cache decision into the registered provider', async () => {
  const bodies: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], model: 'claude-test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ];
  try {
    configureAnthropicFromEnv({ ANTHROPIC_API_KEY: 'sk-wire' });
    await providerRegistry.get('anthropic').generate({ messages });
    assert.deepEqual(
      bodies[0]!.system,
      [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      'official endpoint must ship the cache marker without any extra configuration',
    );

    configureAnthropicFromEnv({ ANTHROPIC_API_KEY: 'sk-wire', ANTHROPIC_BASE_URL: 'https://proxy.example' });
    await providerRegistry.get('anthropic').generate({ messages });
    assert.equal(bodies[1]!.system, 'sys', 'custom gateway must not receive the field by default');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MockProvider eliminates cross-app crosstalk and returns service-specific migration transforms', async () => {
  const mock = new MockProvider();

  // 1. Code reviewer routes to CodeReviewerAgent and git checkout rollback (Demo 2)
  const codeReview = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "code-reviewer"' },
      { role: 'user', content: 'Code review this migration patch for src/s3-service.ts' },
    ],
  });
  const codeReviewJson = JSON.parse(codeReview.content);
  assert.equal(codeReviewJson.signedOffBy, 'CodeReviewerAgent');
  assert.equal(codeReviewJson.rollbackCommand, 'git checkout -- .');
  assert.equal(codeReviewJson.isApproved, true);

  // 1b. Real workflow.ts Code Reviewer prompt with space in system prompt and non-adjacent review prompt
  const codeReviewRealPrompt = await mock.generate({
    messages: [
      {
        role: 'system',
        content: 'You are the Code Reviewer Agent. Verify transformed code for semantic parity, interface preservation, and potential regressions.',
      },
      {
        role: 'user',
        content: 'Review the following transformed DynamoDB service code and unified diff against SDK v3 migration standards',
      },
    ],
  });
  const codeReviewRealJson = JSON.parse(codeReviewRealPrompt.content);
  assert.equal(codeReviewRealJson.signedOffBy, 'CodeReviewerAgent');
  assert.equal(codeReviewRealJson.rollbackCommand, 'git checkout -- .');

  // 1c. Code review user prompt without any system prompt
  const codeReviewNoSys = await mock.generate({
    messages: [
      {
        role: 'user',
        content: 'Review the following transformed DynamoDB service code and unified diff against SDK v3 migration standards',
      },
    ],
  });
  const codeReviewNoSysJson = JSON.parse(codeReviewNoSys.content);
  assert.equal(codeReviewNoSysJson.signedOffBy, 'CodeReviewerAgent');
  assert.equal(codeReviewNoSysJson.rollbackCommand, 'git checkout -- .');

  // 2. Safety reviewer routes to SafetyReviewerAgent and pool-config rollback (Demo 1)
  const safetyReview = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "safety-reviewer"' },
      { role: 'user', content: 'Safety review this remediation plan' },
    ],
  });
  const safetyReviewJson = JSON.parse(safetyReview.content);
  assert.equal(safetyReviewJson.signedOffBy, 'SafetyReviewerAgent');
  assert.equal(safetyReviewJson.rollbackCommand, 'npm run rollback:pool-config');

  // 3. Service-specific migration transform for DynamoDB
  const ddbTransform = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "migration-worker"' },
      { role: 'user', content: 'aws-sdk v2->v3 migration transform for src/dynamo-service.ts' },
    ],
  });
  const ddbJson = JSON.parse(ddbTransform.content);
  assert.equal(ddbJson.targetPackage, '@aws-sdk/client-dynamodb');
  assert.ok(ddbJson.transformedCode.includes('DynamoDBDocumentClient'));
  assert.ok(ddbJson.breakingChangesResolved.some((b: string) => b.includes('DynamoDB')));

  // 4. Service-specific migration transform for SQS
  const sqsTransform = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "migration-worker"' },
      { role: 'user', content: 'aws-sdk v2->v3 migration transform for src/sqs-service.ts' },
    ],
  });
  const sqsJson = JSON.parse(sqsTransform.content);
  assert.equal(sqsJson.targetPackage, '@aws-sdk/client-sqs');
  assert.ok(sqsJson.transformedCode.includes('SQSClient'));
  assert.ok(sqsJson.breakingChangesResolved.some((b: string) => b.includes('SQS')));

  // 5. Service-specific migration transform for S3
  const s3Transform = await mock.generate({
    messages: [
      { role: 'system', content: 'You are specialized agent "migration-worker"' },
      { role: 'user', content: 'aws-sdk v2->v3 migration transform for src/s3-service.ts' },
    ],
  });
  const s3Json = JSON.parse(s3Transform.content);
  assert.equal(s3Json.targetPackage, '@aws-sdk/client-s3');
  assert.ok(s3Json.transformedCode.includes('S3Client'));
  assert.ok(s3Json.breakingChangesResolved.some((b: string) => b.includes('S3')));
});
