/**
 * (Issue #151): the plan / build / yolo permission modes —
 * plan denies every write (and every unverifiable tool), build denies writes
 * with a structured confirmation-pending marker, yolo allows everything (the
 * pre-Phase-6 posture). The write class is the tool's own `readOnly` flag.
 * The query-engine end-to-end case proves the marker reaches PERMISSION_DENIED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionGate } from '../../../src/core/permissions/permission-manager.js';
import { parsePermissionMode } from '../../../src/core/permissions/modes.js';
import { QueryEngine } from '../../../src/core/query-engine.js';
import type { ChatOptions, ChatResult, ProviderContract } from '../../../src/agent/provider-contract.js';
import type { EngineEvent, ToolCall, ToolDefinition } from '../../../src/core/agent-loop.js';

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file.',
  readOnly: true,
  execute: () => 'content',
};
const writeTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file.',
  execute: () => 'written',
};
const call = (name: string, id = 'c1'): ToolCall => ({ id, name, input: {} });

test('yolo allows everything — including writes and unknown tools (pre-Phase-6 posture)', () => {
  const gate = createPermissionGate('yolo');
  assert.deepEqual(gate.check(call('read_file'), readTool), { ok: true });
  assert.deepEqual(gate.check(call('write_file'), writeTool), { ok: true });
  assert.deepEqual(gate.check(call('no_such_tool'), undefined), { ok: true });
  assert.deepEqual(gate.check(call('write_file'), undefined), { ok: true });
});

test('plan allows readOnly tools and denies every write with a named reason', () => {
  const gate = createPermissionGate('plan');
  const allow = gate.check(call('read_file'), readTool);
  assert.equal(allow.ok, true);

  const denied = gate.check(call('write_file', 'w1'), writeTool);
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? '' : denied.reason, /plan mode/);
  assert.equal(denied.ok ? undefined : denied.pending, undefined, 'plan denials are flat refusals, not confirmations');

  const unknown = gate.check(call('rm_rf', 'r1'), undefined);
  assert.equal(unknown.ok, false, 'an unflagged tool can never be verified read-only');
});

test('build allows readOnly tools and denies writes with the confirmation-pending marker', () => {
  const gate = createPermissionGate('build');
  assert.equal(gate.check(call('read_file'), readTool).ok, true);

  const denied = gate.check(call('write_file', 'w1'), writeTool);
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? '' : denied.reason, /build mode/);
  assert.deepEqual(denied.ok ? undefined : denied.pending, {
    kind: 'confirmation-required',
    tool: 'write_file',
    callId: 'w1',
  });
});

test('parsePermissionMode defaults to yolo and rejects unknown values', () => {
  assert.equal(parsePermissionMode(undefined), 'yolo');
  assert.equal(parsePermissionMode(''), 'yolo');
  assert.equal(parsePermissionMode('build'), 'build');
  assert.throws(() => parsePermissionMode('sideways'), /unknown permission mode/);
});

/** Scripted main model: first call issues a write, then stops. */
class ScriptedProvider implements ProviderContract {
  readonly id = 'scripted';
  readonly name = 'Scripted provider';
  private calls = 0;
  constructor(private readonly script: (call: number) => string) {}
  async chat(): Promise<ChatResult> {
    this.calls += 1;
    return { content: this.script(this.calls), model: 'scripted', latencyMs: 0 };
  }
  async complete(prompt: string, _options?: ChatOptions): Promise<string> {
    const result = await this.chat();
    return result.content;
  }
}

const toolCall = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ tool_calls: [{ id, name, input }] });

test('query-engine permissionMode=build: the write denial carries the pending marker into the event and the feedback', async () => {
  let writes = 0;
  const writeTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write a file.',
    execute: () => {
      writes += 1;
      return 'written';
    },
  };
  const main = new ScriptedProvider((n) => (n === 1 ? toolCall('w1', 'write_file', { path: 'a.txt' }) : 'Stopped.'));
  const engine = new QueryEngine({ provider: main, tools: [writeTool], permissionMode: 'build', compaction: { budgetTokens: 4000 } });
  const events: EngineEvent[] = [];
  const result = await engine.run('Write a.txt', { onEvent: (e) => events.push(e) });

  assert.equal(result.status, 'completed');
  assert.equal(writes, 0, 'an unconfirmed write never runs');
  const denied = events.find((e) => e.type === 'PERMISSION_DENIED');
  assert.ok(denied && denied.type === 'PERMISSION_DENIED');
  assert.deepEqual(denied.pending, { kind: 'confirmation-required', tool: 'write_file', callId: 'w1' });
});

test('query-engine permissionMode=plan: a readOnly tool still runs', async () => {
  let reads = 0;
  const readTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read a file.',
    readOnly: true,
    execute: () => {
      reads += 1;
      return 'content';
    },
  };
  const main = new ScriptedProvider((n) => (n === 1 ? toolCall('r1', 'read_file', { path: 'a.txt' }) : 'Done.'));
  const engine = new QueryEngine({ provider: main, tools: [readTool], permissionMode: 'plan', compaction: { budgetTokens: 4000 } });
  const events: EngineEvent[] = [];
  const result = await engine.run('Read a.txt', { onEvent: (e) => events.push(e) });

  assert.equal(result.status, 'completed');
  assert.equal(reads, 1, 'a readOnly tool runs under plan mode');
  assert.equal(events.filter((e) => e.type === 'PERMISSION_DENIED').length, 0);
});
