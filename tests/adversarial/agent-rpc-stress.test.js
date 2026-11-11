import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { agent } from '../../dist/src/agent/rpc.js';
import { providerRegistry } from '../../dist/src/agent/provider.js';
import { isSchemaValidationError } from '../../dist/src/domain/errors.js';
import { SchemaValidationError } from '../../dist/src/agent/schema-validation-error.js';
import { repairJsonString, extractJson } from '../../dist/src/agent/schema.js';

class ScriptedProvider {
  constructor(id, responses) {
    this.id = id;
    this.name = `ScriptedProvider-${id}`;
    this.responses = [...responses];
    this.callHistory = [];
  }

  async generate(request) {
    this.callHistory.push(request);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error(`ScriptedProvider ran out of canned responses`);
    }

    return {
      content: next,
      model: 'scripted-adversarial-model',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: 1,
    };
  }
}

test('Agent RPC Stress: Recovers from unclosed quote syntax corruption on attempt 2', async () => {
  const provider = new ScriptedProvider('unclosed-quote', [
    '{"title": "Unclosed quote text without terminator, "score": 42}', // syntax error
    '{"title": "Repaired valid title", "score": 42}',                  // valid
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('unclosed-quote');

  const schema = z.object({
    title: z.string(),
    score: z.number(),
  });

  const result = await agent('QA-Agent').ask('get title', schema);

  assert.deepEqual(result, { title: 'Repaired valid title', score: 42 });
  assert.equal(provider.callHistory.length, 2);

  // Verify repair prompt was injected on attempt 2
  const attempt2Messages = provider.callHistory[1].messages;
  const lastUserMsg = attempt2Messages[attempt2Messages.length - 1];
  assert.ok(lastUserMsg.content.includes('Your response was not valid JSON'));
});

test('Agent RPC Stress: Recovers from truncated JSON buffer cutoff on attempt 2', async () => {
  const provider = new ScriptedProvider('truncated-buffer', [
    '{"status": "SUCCESS", "records": [{"id": 1}, {"id": 2', // truncated mid-stream
    '{"status": "SUCCESS", "records": [{"id": 1}, {"id": 2}]}', // full JSON
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('truncated-buffer');

  const schema = z.object({
    status: z.string(),
    records: z.array(z.object({ id: z.number() })),
  });

  const result = await agent('DataAgent').ask('fetch records', schema);
  assert.equal(result.records.length, 2);
  assert.equal(provider.callHistory.length, 2);
});

test('Agent RPC Stress: Recovers from severe property type corruption across multiple fields', async () => {
  const provider = new ScriptedProvider('wrong-types', [
    // Attempt 1: string for number, string for boolean, string for array
    JSON.stringify({
      count: 'one-hundred',
      isActive: 'yes',
      tags: 'devops,aws',
    }),
    // Attempt 2: corrected types
    JSON.stringify({
      count: 100,
      isActive: true,
      tags: ['devops', 'aws'],
    }),
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('wrong-types');

  const schema = z.object({
    count: z.number(),
    isActive: z.boolean(),
    tags: z.array(z.string()),
  });

  const result = await agent('TypeFixerAgent').ask('validate types', schema);
  assert.deepEqual(result, {
    count: 100,
    isActive: true,
    tags: ['devops', 'aws'],
  });

  // Verify attempt 2 feedback mentioned failed fields
  const attempt2Messages = provider.callHistory[1].messages;
  const lastUserMsg = attempt2Messages[attempt2Messages.length - 1].content;
  assert.ok(lastUserMsg.includes('failed runtime schema validation'));
  assert.ok(lastUserMsg.includes('count'));
  assert.ok(lastUserMsg.includes('isActive'));
  assert.ok(lastUserMsg.includes('tags'));
});

test('Agent RPC Stress: Recovers from deeply nested arrays and multi-level object corruptions', async () => {
  const provider = new ScriptedProvider('nested-arrays', [
    // Attempt 1: string inside 2D matrix, and string inside nested object array
    JSON.stringify({
      matrix: [[1, 2], [3, 'four']],
      clusters: [{ clusterId: 'c1', nodes: [{ nodeId: 'n1', cores: 'invalid_cores' }] }],
    }),
    // Attempt 2: valid numeric values
    JSON.stringify({
      matrix: [[1, 2], [3, 4]],
      clusters: [{ clusterId: 'c1', nodes: [{ nodeId: 'n1', cores: 8 }] }],
    }),
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('nested-arrays');

  const schema = z.object({
    matrix: z.array(z.array(z.number())),
    clusters: z.array(
      z.object({
        clusterId: z.string(),
        nodes: z.array(
          z.object({
            nodeId: z.string(),
            cores: z.number(),
          })
        ),
      })
    ),
  });

  const result = await agent('ClusterAgent').ask('parse clusters', schema);
  assert.equal(result.matrix[1][1], 4);
  assert.equal(result.clusters[0].nodes[0].cores, 8);

  const attempt2Msg = provider.callHistory[1].messages.slice(-1)[0].content;
  assert.ok(attempt2Msg.includes('matrix.1.1'));
  assert.ok(attempt2Msg.includes('clusters.0.nodes.0.cores'));
});

test('Agent RPC Stress: 3-Stage Degradation (Syntax -> Schema Mismatch -> Full Recovery on Attempt 3)', async () => {
  const provider = new ScriptedProvider('multi-stage-recovery', [
    '```json\n{"val": "unclosed',                   // attempt 1: syntax error
    '{"val": "not-a-number"}',                      // attempt 2: type error (expected number)
    '{"val": 9999}',                                // attempt 3: fully valid
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('multi-stage-recovery');

  const schema = z.object({ val: z.number() });
  const result = await agent('RetryAgent').ask('test stage', schema);

  assert.equal(result.val, 9999);
  assert.equal(provider.callHistory.length, 3);
});

test('Agent RPC Stress: Cleanly raises SchemaValidationError when severe corruption persists across all 3 retries', async () => {
  const provider = new ScriptedProvider('persistent-syntax-corruption', [
    '{"bad": "unclosed string quote 1',
    '{"bad": "unclosed string quote 2',
    '{"bad": "unclosed string quote 3',
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('persistent-syntax-corruption');

  const schema = z.object({ bad: z.string() });

  await assert.rejects(
    async () => {
      await agent('BrokenAgent').ask('failing prompt', schema);
    },
    (err) => {
      assert.ok(isSchemaValidationError(err));
      assert.ok(err instanceof SchemaValidationError, 'Issue #110: a real Error instance');
      assert.ok(typeof err.stack === 'string' && err.stack.length > 0);
      assert.ok(err.rawText.includes('unclosed string quote'), 'rawText holds the last raw output');
      assert.equal(err.details.attemptCount, 3);
      return true;
    }
  );
  assert.equal(provider.callHistory.length, 3);
});

test('Agent RPC Stress: Cleanly raises SchemaValidationError with Zod issues when type mismatch persists across 3 retries', async () => {
  const provider = new ScriptedProvider('persistent-type-mismatch', [
    '{"expectedNumber": "string1"}',
    '{"expectedNumber": "string2"}',
    '{"expectedNumber": "string3"}',
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('persistent-type-mismatch');

  const schema = z.object({ expectedNumber: z.number() });

  await assert.rejects(
    async () => {
      await agent('MismatchAgent').ask('test type mismatch', schema);
    },
    (err) => {
      assert.ok(isSchemaValidationError(err));
      assert.ok(err instanceof SchemaValidationError, 'Issue #110: a real Error instance');
      assert.equal(err.details.attemptCount, 3);
      assert.ok((err.details.issueCount ?? 0) > 0);
      assert.ok(err.zodErrors.length > 0, 'Issue #110: zodErrors survive on the error');
      assert.deepEqual(err.zodErrors[0].path, ['expectedNumber'], 'the failing field path is recoverable');
      return true;
    }
  );
});

test('Agent RPC Stress: Enforces custom maxRetries=1 immediately upon first failure', async () => {
  const provider = new ScriptedProvider('single-attempt', [
    '{"faulty": true', // failure on first attempt
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('single-attempt');

  const schema = z.object({ faulty: z.boolean() });

  await assert.rejects(
    async () => {
      await agent('FastFailAgent').ask('fail fast', schema, { maxRetries: 1 });
    },
    (err) => {
      assert.ok(isSchemaValidationError(err));
      assert.ok(err instanceof SchemaValidationError, 'Issue #110: a real Error instance');
      assert.equal(err.details.attemptCount, 1);
      return true;
    }
  );
  assert.equal(provider.callHistory.length, 1);
});

test('Agent RPC Stress: Custom maxRetries=5 recovers on 5th attempt after 4 consecutive failures', async () => {
  const provider = new ScriptedProvider('five-attempts', [
    '{"count": "one"}',
    '{"count": "two"}',
    '{"count": "three"}',
    '{"count": "four"}',
    '{"count": 5}', // 5th attempt succeeds
  ]);
  providerRegistry.register(provider);
  providerRegistry.setDefault('five-attempts');

  const schema = z.object({ count: z.number() });
  const res = await agent('PatientAgent').ask('patience test', schema, { maxRetries: 5 });

  assert.equal(res.count, 5);
  assert.equal(provider.callHistory.length, 5);
});

test('Agent RPC Stress: Single-shot heuristic repair recovers malformed JSON without network retry', async () => {
  // Single quotes, unquoted keys, trailing comma
  const rawMalformed = `{ user: 'admin', roles: ['inspector', 'reviewer', ], active: true, }`;
  const repaired = repairJsonString(rawMalformed);
  const parsed = JSON.parse(repaired);

  const schema = z.object({
    user: z.string(),
    roles: z.array(z.string()),
    active: z.boolean(),
  });

  const validated = schema.parse(parsed);
  assert.equal(validated.user, 'admin');
  assert.equal(validated.roles.length, 2);
  assert.equal(validated.active, true);
});

test('Agent RPC Stress: Markdown code fence extraction strips conversational conversational wrapping', () => {
  const conversationalText = `
Here is the JSON you requested:
\`\`\`json
{
  "verdict": "APPROVED",
  "confidence": 0.99
}
\`\`\`
I hope this helps! Let me know if you need anything else.
  `;

  const extracted = extractJson(conversationalText);
  const parsed = JSON.parse(extracted);
  assert.equal(parsed.verdict, 'APPROVED');
  assert.equal(parsed.confidence, 0.99);
});
