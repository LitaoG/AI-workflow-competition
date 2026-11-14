/**
 * Unit tests for `BedrockProvider` — previously zero-covered.
 *
 * Asserted here: the InvokeModel request shape (system lifted out of messages,
 * Anthropic-versioned payload), the health probe's credential logic, and the
 * two offline-degradation paths (no AWS credentials; credentials present but
 * the `@aws-sdk/client-bedrock-runtime` package unavailable). The repo does not
 * depend on the AWS SDK, so the SDK-missing path is deterministic and
 * network-free.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockProvider } from '../../src/agent/bedrock-provider.js';
import type { LLMRequest } from '../../src/types.js';

/** Save/restore the AWS credential env around a mutation. */
function withAwsEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
  const saved: Record<string, string | undefined> = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
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
    // Credentials exist, so generate() proceeds past the gate; the repo does
    // not ship @aws-sdk/client-bedrock-runtime, so the dynamic import fails.
    // That is a REAL configuration failure: mock output here would pass schema
    // validation and be journalled as evidence (rpc.ts forbids the silent
    // mock switch), so the provider must reject instead of degrading.
    await assert.rejects(
      () => provider.generate(SAMPLE_REQUEST),
      (err: unknown) => err instanceof Error,
      'SDK absence with live credentials must throw, not fake success',
    );
  });
});
