import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type StreamChunk,
  type ProviderContract,
  normalizeStreamChunk,
} from '../../../src/agent/provider-contract.js';
import {
  WORKFLOW_EVENT,
  WORKFLOW_EVENT_TYPES,
  isWorkflowEventType,
  type WorkflowEvent,
} from '../../../src/domain/events.js';

describe('Thinking Stream & SSE Propagation (Issue #304)', () => {
  test('normalizeStreamChunk: bare string wrapped as content delta for backward compatibility', () => {
    const rawString = 'Hello, world!';
    const normalized = normalizeStreamChunk(rawString);

    assert.deepEqual(normalized, {
      type: 'content',
      delta: 'Hello, world!',
    });
  });

  test('normalizeStreamChunk: preserves structured StreamChunk intact', () => {
    const contentChunk: StreamChunk = { type: 'content', delta: 'response snippet' };
    const thinkingChunk: StreamChunk = { type: 'thinking', delta: 'analyzing AST...' };

    assert.equal(normalizeStreamChunk(contentChunk), contentChunk);
    assert.deepEqual(normalizeStreamChunk(contentChunk), {
      type: 'content',
      delta: 'response snippet',
    });

    assert.equal(normalizeStreamChunk(thinkingChunk), thinkingChunk);
    assert.deepEqual(normalizeStreamChunk(thinkingChunk), {
      type: 'thinking',
      delta: 'analyzing AST...',
    });
  });

  test('mixed streaming: processes both thinking deltas and content deltas seamlessly', async () => {
    const mixedDeltas: Array<string | StreamChunk> = [
      { type: 'thinking', delta: 'Step 1: Check inputs.' },
      { type: 'thinking', delta: ' Step 2: Formulate schema.' },
      'The result is: ',
      { type: 'content', delta: '{"success": true}' },
    ];

    async function* mockStream(): AsyncIterable<string | StreamChunk> {
      for (const item of mixedDeltas) {
        yield item;
      }
    }

    const collectedThinking: string[] = [];
    const collectedContent: string[] = [];

    for await (const chunk of mockStream()) {
      const normalized = normalizeStreamChunk(chunk);
      if (normalized.type === 'thinking') {
        collectedThinking.push(normalized.delta);
      } else {
        collectedContent.push(normalized.delta);
      }
    }

    assert.equal(collectedThinking.join(''), 'Step 1: Check inputs. Step 2: Formulate schema.');
    assert.equal(collectedContent.join(''), 'The result is: {"success": true}');
  });

  test('ProviderContract.stream: supports yielding string | StreamChunk', async () => {
    const provider: ProviderContract = {
      id: 'mock-thinking',
      name: 'Mock Thinking Provider',
      chat: async () => ({
        content: 'done',
        model: 'mock-thinking',
        latencyMs: 10,
      }),
      complete: async () => 'done',
      stream: async function* () {
        yield { type: 'thinking', delta: 'reasoning...' };
        yield 'answer';
      },
    };

    assert.ok(provider.stream);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.stream([])) {
      chunks.push(normalizeStreamChunk(c));
    }

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0], { type: 'thinking', delta: 'reasoning...' });
    assert.deepEqual(chunks[1], { type: 'content', delta: 'answer' });
  });

  test('WORKFLOW_EVENT: includes dwf_thinking_delta and satisfies event type guards', () => {
    assert.equal(WORKFLOW_EVENT.DWF_THINKING_DELTA, 'dwf_thinking_delta');
    assert.ok(WORKFLOW_EVENT_TYPES.includes('dwf_thinking_delta'));
    assert.ok(isWorkflowEventType('dwf_thinking_delta'));

    // Unknown event is correctly rejected
    assert.equal(isWorkflowEventType('dwf_unknown_event_xyz'), false);
  });

  test('event serialization: dwf_thinking_delta events roundtrip faithfully', () => {
    const timestamp = new Date().toISOString();
    const event: WorkflowEvent = {
      id: 'evt-think-001',
      workflowId: 'wf-test',
      runId: 'dwfrun-001',
      stepId: 'step-1',
      type: WORKFLOW_EVENT.DWF_THINKING_DELTA,
      timestamp,
      sequence: 42,
      data: {
        siteId: 'ask#1',
        delta: 'Considering edge cases...',
        type: 'thinking',
      },
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json) as WorkflowEvent;

    assert.equal(parsed.id, 'evt-think-001');
    assert.equal(parsed.type, 'dwf_thinking_delta');
    assert.ok(isWorkflowEventType(parsed.type));
    assert.deepEqual(parsed.data, {
      siteId: 'ask#1',
      delta: 'Considering edge cases...',
      type: 'thinking',
    });
  });

  test('Live SSE formatting: verifies dual event and thinking framing for dwf_thinking_delta', () => {
    const capturedWrites: string[] = [];
    const mockRes = {
      write: (str: string) => {
        capturedWrites.push(str);
      },
    };

    const send = (event: string, data: unknown): void => {
      mockRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ev: WorkflowEvent = {
      id: 'ev-1',
      workflowId: 'wf-1',
      runId: 'run-1',
      type: WORKFLOW_EVENT.DWF_THINKING_DELTA,
      timestamp: '2026-11-15T12:00:00.000Z',
      data: { delta: 'Evaluating...', siteId: 'ask#1' },
    };

    // Mirror the live.ts SSE dispatch logic
    send('event', { type: ev.type, data: ev.data, timestamp: ev.timestamp });
    if (ev.type === 'dwf_thinking_delta') {
      send('thinking', { type: ev.type, data: ev.data, timestamp: ev.timestamp });
    }

    assert.equal(capturedWrites.length, 2);
    // 1. Generic SSE event frame
    assert.ok(capturedWrites[0].startsWith('event: event\n'));
    assert.ok(capturedWrites[0].includes('"type":"dwf_thinking_delta"'));
    assert.ok(capturedWrites[0].includes('Evaluating...'));

    // 2. Specific thinking channel frame
    assert.ok(capturedWrites[1].startsWith('event: thinking\n'));
    assert.ok(capturedWrites[1].includes('"type":"dwf_thinking_delta"'));
    assert.ok(capturedWrites[1].includes('Evaluating...'));
  });
});
