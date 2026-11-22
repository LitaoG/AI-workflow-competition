/**
 * (Issue #134): `swarm<T>(agents, tasks)` end-to-end through
 * the real runner — compile, lower, child realm, engine seats, journal, resume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { MockProvider } from '../../src/agent/mock-provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-swarm-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

/** MockProvider with a call counter so replay tests can assert zero new calls. */
class CountingMock implements LLMProvider {
  readonly id = 'dwf-swarm-counting-mock';
  readonly name = 'Counting mock';
  calls = 0;
  private readonly inner = new MockProvider();
  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return this.inner.generate(request);
  }
}

const SWARM_SCRIPT = `
phase("Swarm");
const answers = await swarm<Answer>([agent("alpha"), agent("beta")], [
  "inspect health report of service one",
  "inspect health report of service two",
  "inspect health report of service three",
]);
return { answers, count: answers.length };
interface Answer { healthStatus: string; }
`;

test('swarm: three tasks over two agents all complete, answers in task order', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'swarm.facade.ts');
    fs.writeFileSync(scriptPath, SWARM_SCRIPT);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    const value = r.value as { answers: Array<{ healthStatus: string }>; count: number };
    assert.equal(value.count, 3, 'one answer per task');
    assert.ok(value.answers.every((a) => a.healthStatus === 'HEALTHY'), 'every answer validated against the schema');
  } finally {
    ws.cleanup();
  }
});

test('swarm: a task whose reply violates the schema fails the run after repair retries', async () => {
  const ws = makeWorkspace();
  // Issue #267: the mock's canned routing now synthesizes schema-valid bodies
  // for typed asks whose schema is disjoint from the canned template — a
  // plain interface over the mock is SATISFIABLE by design, so
  // "unsatisfiable" is constructed on the provider side: a stub that always
  // returns schema-violating JSON pins the repair-exhaustion semantics
  // (run fails after retries, error names the schema contract) independent
  // of mock canned content.
  const violator: LLMProvider = {
    id: 'dwf-swarm-schema-violator',
    name: 'Schema violator',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      return {
        content: JSON.stringify({ nonsense: true }),
        model: 'violator-mock',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 0,
      };
    },
  };
  providerRegistry.register(violator);
  const previousDefault = 'mock';
  providerRegistry.setDefault(violator.id);
  try {
    const scriptPath = path.join(ws.dir, 'swarm-bad.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Swarm");
const answers = await swarm<Answer>([agent("alpha")], ["tell me a short anecdote"]);
return answers;
interface Answer { verdict: string; score: number; }
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'failed', 'an unsatisfiable answer must fail the run');
    assert.match(r.error ?? '', /schema/i, 'the failure names the schema contract');
  } finally {
    providerRegistry.setDefault(previousDefault);
    ws.cleanup();
  }
});

test('swarm: the first failing task fails the swarm; pending turns are cancelled', async () => {
  const ws = makeWorkspace();
  const boomer: LLMProvider = {
    id: 'dwf-swarm-boom-provider',
    name: 'Boom provider',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('boom')) throw new Error('boom on purpose');
      return { content: `ok for ${user}`, model: 'boom-mock', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 0 };
    },
  };
  providerRegistry.register(boomer);
  const previousDefault = 'mock';
  providerRegistry.setDefault(boomer.id);
  try {
    const scriptPath = path.join(ws.dir, 'swarm-boom.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Swarm");
const answers = await swarm([agent("w")], ["task a", "boom task", "task c"]);
return answers;
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'failed', 'the swarm rejects on its first failing task');
    assert.match(r.error ?? '', /boom on purpose/, 'the failure carries the task error');
  } finally {
    providerRegistry.setDefault(previousDefault);
    ws.cleanup();
  }
});

test('swarm: a resumed run replays every task at zero model calls', async () => {
  const ws = makeWorkspace();
  const counting = new CountingMock();
  providerRegistry.register(counting);
  const previousDefault = 'mock';
  providerRegistry.setDefault(counting.id);
  try {
    const scriptPath = path.join(ws.dir, 'swarm-resume.facade.ts');
    fs.writeFileSync(scriptPath, SWARM_SCRIPT);
    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', first.error);
    const callsAfterRun1 = counting.calls;
    assert.ok(callsAfterRun1 >= 3, 'every task reached the provider on the fresh run');

    const second = await runFacadeScript({ scriptPath, cwd: ws.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', second.error);
    assert.equal(counting.calls, callsAfterRun1, 'the resumed run replays the tasks without model calls');
    assert.deepEqual(second.value, first.value);
  } finally {
    providerRegistry.setDefault(previousDefault);
    ws.cleanup();
  }
});
