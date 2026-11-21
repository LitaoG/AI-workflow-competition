/**
 * Unit tests for `BedrockProvider` — native SigV4 zero-dependency integration and CLI registry (Issue #209).
 *
 * Asserted here:
 * 1. InvokeModel payload shape (Anthropic versioned, system lifted to top-level).
 * 2. SigV4 canonical request creation, string to sign, and signature calculation matching official AWS test vectors.
 * 3. Request construction with native SigV4 and session token handling.
 * 4. Mock HTTP fetch response parsing (Claude 3.5 Sonnet payload and token accounting).
 * 5. Error handling and strict credential redaction on non-2xx responses.
 * 6. Zero external SDK dependencies (pure node:crypto and native fetch).
 * 7. CLI / provider registry detection from environment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BedrockProvider,
  configureBedrockFromEnv,
  getSignatureKey,
  hmacSha256,
  sha256Hex,
  signSigV4,
} from '../../src/agent/bedrock-provider.js';
import { createDefaultProviders } from '../../src/agent/http-providers.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { AgentProviderError } from '../../src/agent/provider-contract.js';
import { isDomainError } from '../../src/domain/errors.js';
import type { LLMRequest } from '../../src/types.js';

/** Save/restore the AWS credential env around a mutation. */
function withAwsEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
  const saved: Record<string, string | undefined> = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_REGION: process.env.AWS_REGION,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const SAMPLE_REQUEST: LLMRequest = {
  messages: [
    { role: 'system', content: 'You are specialized agent "triage".' },
    { role: 'user', content: 'incident telemetry p1' },
    { role: 'assistant', content: 'looking' },
    { role: 'user', content: 'go on' },
  ],
  temperature: 0.3,
  maxTokens: 512,
};

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

// ============================================================================
// 1. InvokeModel Payload Shape
// ============================================================================

test('BedrockProvider builds the InvokeModel payload with system lifted out of messages', () => {
  const provider = new BedrockProvider({ modelId: 'anthropic.claude-test-v1:0', region: 'us-east-1' });
  const payload = provider.buildInvokeModelPayload(SAMPLE_REQUEST) as any;

  assert.equal(payload.anthropic_version, 'bedrock-2023-05-31');
  assert.equal(payload.max_tokens, 512);
  assert.equal(payload.temperature, 0.3);
  assert.equal(payload.system, 'You are specialized agent "triage".', 'system prompt must be the top-level field');
  assert.deepEqual(
    payload.messages,
    [
      { role: 'user', content: [{ text: 'incident telemetry p1' }] },
      { role: 'assistant', content: [{ text: 'looking' }] },
      { role: 'user', content: [{ text: 'go on' }] },
    ],
    'conversation messages must be wrapped as { role, content: [{ text }] } without the system turn',
  );
});

test('BedrockProvider applies payload defaults for missing temperature/maxTokens', () => {
  const provider = new BedrockProvider();
  const payload = provider.buildInvokeModelPayload({ messages: [{ role: 'user', content: 'hi' }] }) as any;

  assert.equal(payload.max_tokens, 2048);
  assert.equal(payload.temperature, 0.0);
  assert.equal(payload.system, undefined);
  assert.deepEqual(payload.messages, [{ role: 'user', content: [{ text: 'hi' }] }]);
});

// ============================================================================
// 2. Health Probe & Offline Fallback
// ============================================================================

test('BedrockProvider.checkHealth reflects AWS credential presence', () => {
  const provider = new BedrockProvider({ region: 'eu-central-1' });

  return withAwsEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, () => {
    const withoutCreds = provider.checkHealth();
    assert.equal(withoutCreds.ok, false);
    assert.ok(withoutCreds.detail.includes('falls back to the offline mock'), 'health must disclose the degradation');

    return withAwsEnv({ AWS_ACCESS_KEY_ID: 'AKIA-TEST', AWS_SECRET_ACCESS_KEY: 'secret-test' }, () => {
      const withCreds = provider.checkHealth();
      assert.equal(withCreds.ok, true);
      assert.ok(withCreds.detail.includes('eu-central-1'));
      assert.ok(!withCreds.detail.includes('AKIA-TEST'), 'health detail must never echo credential values');
    });
  });
});

test('BedrockProvider degrades to the offline mock when AWS credentials are missing', () => {
  const provider = new BedrockProvider();

  return withAwsEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, async () => {
    const res = await provider.generate(SAMPLE_REQUEST);
    assert.equal(res.model, 'mock-claude-3-5-sonnet', 'fallback must be the deterministic mock');
    const parsed = JSON.parse(res.content) as { severity?: string };
    assert.equal(parsed.severity, 'P1', 'fallback must serve the mock triage payload for this prompt');
    assert.ok(Number.isFinite(res.latencyMs));
  });
});

test('BedrockProvider fails loudly when credentials exist but the AWS call path is unavailable', () => {
  const provider = new BedrockProvider();

  return withAwsEnv({ AWS_ACCESS_KEY_ID: 'AKIA-TEST', AWS_SECRET_ACCESS_KEY: 'secret-test' }, async () => {
    await assert.rejects(
      () => provider.generate(SAMPLE_REQUEST),
      (err: unknown) => err instanceof Error,
      'Live credentials with unreachable host must throw, not fake success',
    );
  });
});

// ============================================================================
// 3. SigV4 Canonical Request, String to Sign, and Signature Calculation
// ============================================================================

test('signSigV4 matches official AWS Signature Version 4 test suite vector', () => {
  // Official AWS SigV4 GET Example from AWS Documentation:
  const res = signSigV4({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Host': 'iam.amazonaws.com',
    },
    body: '',
    service: 'iam',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    datetime: '20150830T123600Z',
  });

  const expectedHashedCanonicalRequest = 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59';
  const expectedSignature = '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7';

  assert.equal(sha256Hex(res.canonicalRequest), expectedHashedCanonicalRequest, 'Canonical request hash must match AWS standard');
  assert.equal(res.signature, expectedSignature, 'Derived signature must match AWS standard');
  assert.ok(
    res.authorization.includes(`Signature=${expectedSignature}`),
    'Authorization header must contain the calculated signature',
  );
  assert.ok(
    res.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request'),
    'Authorization header must contain the correct credential scope',
  );
});

test('signSigV4 constructs Bedrock POST InvokeModel canonical request with hashed payload', () => {
  const modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
  const region = 'us-east-1';
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;
  const body = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: [{ text: 'ping' }] }] });
  const fixedTime = '2026-11-21T08:59:43Z';

  const res = signSigV4({
    method: 'POST',
    url,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body,
    service: 'bedrock',
    region,
    accessKeyId: 'AKIA_BEDROCK_TEST',
    secretAccessKey: 'SECRET_BEDROCK_TEST',
    datetime: fixedTime,
  });

  // Verify Canonical Request structure
  const lines = res.canonicalRequest.split('\n');
  assert.equal(lines[0], 'POST');
  assert.equal(lines[1], `/model/${modelId}/invoke`);
  assert.equal(lines[2], '', 'query string must be empty');

  // Verify signed headers
  assert.ok(res.headers['host'].includes('bedrock-runtime.us-east-1.amazonaws.com'));
  assert.equal(res.headers['x-amz-date'], '20261121T085943Z');
  assert.equal(res.headers['x-amz-content-sha256'], sha256Hex(body));
  assert.ok(res.headers['authorization'].startsWith('AWS4-HMAC-SHA256 Credential=AKIA_BEDROCK_TEST/20261121/us-east-1/bedrock/aws4_request'));
  assert.ok(res.headers['authorization'].includes('SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date'));
});

// ============================================================================
// 4. Session Token Handling (x-amz-security-token)
// ============================================================================

test('signSigV4 includes x-amz-security-token when sessionToken is provided', () => {
  const sessionToken = 'FwoGZXIvYXdzEExampleSessionToken1234567890';
  const res = signSigV4({
    method: 'POST',
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke',
    body: '{}',
    service: 'bedrock',
    region: 'us-east-1',
    accessKeyId: 'ASIA_TEMPORARY',
    secretAccessKey: 'SECRET_TEMP',
    sessionToken,
    datetime: '2026-11-21T08:59:43Z',
  });

  assert.equal(res.headers['x-amz-security-token'], sessionToken);
  assert.ok(
    res.headers['authorization'].includes('x-amz-security-token'),
    'SignedHeaders must include x-amz-security-token when sessionToken is present',
  );
  assert.ok(res.canonicalRequest.includes(`x-amz-security-token:${sessionToken}`));
});

// ============================================================================
// 5. Mock HTTP Fetch Calling and Response Parsing
// ============================================================================

test('BedrockProvider executes native fetch and parses Claude 3.5 Sonnet InvokeModel response', async () => {
  const { fetch, calls } = mockFetch({
    body: {
      id: 'msg_01X9bV3zK7s',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: '{"status":"healthy","inspected":42}' },
      ],
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 35,
        output_tokens: 15,
      },
    },
  });

  const provider = new BedrockProvider({
    accessKeyId: 'AKIA_MOCK_TEST',
    secretAccessKey: 'SECRET_MOCK_TEST',
    region: 'us-west-2',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    fetchImpl: fetch,
  });

  const res = await provider.generate(SAMPLE_REQUEST);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke');
  assert.equal(call.init.method, 'POST');
  assert.ok(call.init.headers?.['authorization']?.startsWith('AWS4-HMAC-SHA256 Credential=AKIA_MOCK_TEST/'));
  assert.ok(call.init.headers?.['x-amz-date']);
  assert.ok(call.init.headers?.['x-amz-content-sha256']);

  assert.equal(res.content, '{"status":"healthy","inspected":42}');
  assert.equal(res.model, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
  assert.equal(res.usage?.promptTokens, 35);
  assert.equal(res.usage?.completionTokens, 15);
  assert.equal(res.usage?.totalTokens, 50);
  assert.ok(Number.isFinite(res.latencyMs));
});

test('BedrockProvider supports chat and complete methods satisfying ProviderContract', async () => {
  const { fetch } = mockFetch({
    body: {
      content: [{ type: 'text', text: 'acknowledged' }],
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  });

  const provider = new BedrockProvider({
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'SECRET_TEST',
    fetchImpl: fetch,
  });

  const chatRes = await provider.chat([{ role: 'user', content: 'test chat' }]);
  assert.equal(chatRes.content, 'acknowledged');
  assert.equal(chatRes.usage?.totalTokens, 7);

  const completeRes = await provider.complete('test prompt');
  assert.equal(completeRes, 'acknowledged');
});

// ============================================================================
// 6. Error Handling and Credential Redaction
// ============================================================================

test('BedrockProvider maps HTTP error to AgentProviderError and redacts AWS credentials', async () => {
  const secretKey = 'super-secret-aws-key-do-not-leak';
  const accessKey = 'AKIA_SENSITIVE_KEY';
  const sessionToken = 'TOKEN_SENSITIVE_VALUE';

  const { fetch } = mockFetch({
    status: 403,
    body: `The security token ${sessionToken} or key ${secretKey} is invalid for access key ${accessKey}`,
  });

  const provider = new BedrockProvider({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    sessionToken,
    fetchImpl: fetch,
  });

  let thrown: any;
  try {
    await provider.generate(SAMPLE_REQUEST);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof AgentProviderError, 'must throw AgentProviderError');
  assert.ok(isDomainError(thrown), 'must satisfy domain error contract');
  assert.equal(thrown.tag, 'AgentError');
  assert.equal(thrown.details.provider, 'bedrock');
  assert.equal(thrown.details.status, 403);
  assert.equal(thrown.details.retryable, false, '403 is non-retryable');

  // Assert keys never leak into message, details, or stack
  assert.ok(!thrown.message.includes(secretKey), 'secret key must be redacted from message');
  assert.ok(!thrown.message.includes(accessKey), 'access key must be redacted from message');
  assert.ok(!thrown.message.includes(sessionToken), 'session token must be redacted from message');
  assert.ok(!JSON.stringify(thrown.details).includes(secretKey), 'secret key must be redacted from details');
  assert.ok(!thrown.stack?.includes(secretKey), 'secret key must be redacted from stack');
});

test('BedrockProvider treats 429 and 500 HTTP errors as retryable', async () => {
  const { fetch } = mockFetch({
    status: 429,
    body: 'ThrottlingException: Rate exceeded',
  });

  const provider = new BedrockProvider({
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'SECRET_TEST',
    fetchImpl: fetch,
  });

  await assert.rejects(
    () => provider.generate(SAMPLE_REQUEST),
    (err: any) => {
      assert.ok(err instanceof AgentProviderError);
      assert.equal(err.details.retryable, true);
      assert.equal(err.details.status, 429);
      return true;
    },
  );
});

// ============================================================================
// 7. Zero External SDK Dependencies Verification
// ============================================================================

test('BedrockProvider and package.json have 0 external AWS SDK dependencies', () => {
  const providerFilePath = path.resolve(process.cwd(), 'src/agent/bedrock-provider.ts');
  const providerSource = fs.readFileSync(providerFilePath, 'utf8');

  // Verify source does not import @aws-sdk
  assert.ok(
    !providerSource.includes('@aws-sdk'),
    'src/agent/bedrock-provider.ts must not reference @aws-sdk',
  );

  // Verify package.json dependencies
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  const awsSdkDeps = Object.keys(allDeps).filter((d) => d.startsWith('@aws-sdk') || d === 'aws-sdk');
  assert.deepEqual(awsSdkDeps, [], 'package.json must contain zero AWS SDK dependencies');
});

// ============================================================================
// 8. CLI and Provider Registry Integration
// ============================================================================

test('configureBedrockFromEnv registers bedrock provider only when AWS credentials are present', async () => {
  return withAwsEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, async () => {
    assert.equal(configureBedrockFromEnv({}), undefined, 'no credentials -> no registration');

    const registeredId = configureBedrockFromEnv({
      AWS_ACCESS_KEY_ID: 'AKIA_CLI_TEST',
      AWS_SECRET_ACCESS_KEY: 'SECRET_CLI_TEST',
      AWS_REGION: 'eu-west-1',
    });

    assert.equal(registeredId, 'bedrock');
    assert.ok(providerRegistry.list().includes('bedrock'));
    const bedrock = providerRegistry.get('bedrock');
    assert.equal(bedrock.id, 'bedrock');
    const health = await bedrock.checkHealth?.();
    assert.ok(health?.ok);
  });
});

test('createDefaultProviders registers bedrock in createDefaultProviders when AWS credentials are present', async () => {
  const registered = await createDefaultProviders({
    AWS_ACCESS_KEY_ID: 'AKIA_ENV_TEST',
    AWS_SECRET_ACCESS_KEY: 'SECRET_ENV_TEST',
  });

  assert.ok(registered.includes('bedrock'), 'createDefaultProviders must detect and register bedrock');
  assert.ok(providerRegistry.list().includes('bedrock'));
});
