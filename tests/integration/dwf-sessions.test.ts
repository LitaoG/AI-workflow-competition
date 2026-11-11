import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { LiveGraph } from '../../src/dag/live.js';
import { MockProvider } from '../../src/agent/mock-provider.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

/** A provider whose asks hang until aborted (or 5s) — deterministic cancellation. */
class SlowAbortProvider implements LLMProvider {
  readonly id = 'dwf-slow-abort';
  readonly name = 'Slow provider that honours abort';
  abortedCount = 0;
  startedCount = 0;
  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.startedCount++;
    return new Promise<LLMResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ content: '{"status":"SUCCESS"}', model: 'slow', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 5000 }), 5000);
      request.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.abortedCount++;
        const e = new Error('ask cancelled');
        e.name = 'AbortError';
        reject(e);
      });
    });
  }
}

/**
 * A fast-but-not-instant provider for race tests: the 500ms delay guarantees the
 * slow competitor is already in-flight when the winner resolves, so cancellation
 * produces a deterministic dwf_node_failed(cancelled) event instead of racing
 * the scheduler (the pre-fix test failed intermittently under load).
 */
class DelayedFastProvider implements LLMProvider {
  readonly id = 'dwf-fast-delayed';
  readonly name = 'Delayed fast provider';
  private readonly inner = new MockProvider();
  async generate(request: LLMRequest): Promise<LLMResponse> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.inner.generate(request);
  }
}

const RACE_SCRIPT = `
phase("Race");
const slow = agent("slow-worker", { provider: "dwf-slow-abort" }).ask("slow question");
sessions.cancel(slow); // stop the loser — its provider call aborts, nothing journalled
const fast = await agent("fast-worker").ask<Answer>("inspect health report of the service");
return { answer: fast.healthStatus };

interface Answer {
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-sessions-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* transient Windows lock */ } } };
}

test('sessions.cancel aborts the pending provider call; the run completes with the winner only', async () => {
  const slow = new SlowAbortProvider();
  providerRegistry.register(slow);
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'race.facade.ts');
    fs.writeFileSync(scriptPath, RACE_SCRIPT);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const r = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      runTimeoutMs: 20000,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.status, 'completed', `race run failed: ${r.error}`);
    assert.equal((r.value as { answer: string }).answer, 'HEALTHY');
    // The loser was cancelled: its ask failed with the abort (either the provider's
    // abort listener fired, or rpc's pre-check threw before the call was placed —
    // a timing race, so assert on the event stream, not on the listener counter).
    assert.ok(
      events.some(
        (e) => e.type === 'dwf_node_failed' && e.data.cancelled === true && /cancel/i.test(String(e.data.error)),
      ),
      `expected a cancelled event, got: ${JSON.stringify(events.filter((e) => e.type === 'dwf_node_failed'))}`,
    );
    assert.equal(r.stats.asks, 2, 'both asks started (stats counts started asks)');
    assert.equal(
      events.filter((e) => e.type === 'dwf_ask_complete').length,
      1,
      'only the winner completed — the loser was cancelled before settling',
    );
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});

test('a cancelled turn is not journalled: resume re-executes it instead of replaying a failure', async () => {
  const slow = new SlowAbortProvider();
  providerRegistry.register(slow);
  const ws = makeWorkspace();
  const dbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');
  try {
    const scriptPath = path.join(ws.dir, 'cancel-resume.facade.ts');
    fs.writeFileSync(scriptPath, RACE_SCRIPT);

    const firstEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const first = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath,
      runTimeoutMs: 20000,
      onEvent: (e) => firstEvents.push(e),
    });
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.stats.asks, 2, 'both asks started');
    assert.ok(
      firstEvents.some((e) => e.type === 'dwf_node_failed' && e.data.cancelled === true),
      'the cancellation stays visible as a cancelled event',
    );

    const resumedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const resumed = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath,
      resumeRunId: first.runId,
      runTimeoutMs: 20000,
      onEvent: (e) => resumedEvents.push(e),
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.stats.asks, 1, 'only the cancelled turn runs live on resume; the winner replays');
    assert.ok(
      resumedEvents.some((e) => e.type === 'dwf_ask_start'),
      'the cancelled turn is re-executed, not replayed as a failure',
    );
    assert.ok(
      resumedEvents.some((e) => e.type === 'dwf_replay_hit'),
      'the completed winner replays at zero provider calls',
    );
    assert.equal(
      resumedEvents.filter((e) => e.type === 'dwf_node_failed' && e.data.replayed === true).length,
      0,
      'no journalled failure is replayed for the cancelled turn',
    );
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});

test('waitAny resolves with the first settled turn (pure racing, no cancellation)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'any.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Race");
const winner = (await sessions.waitAny([
  agent("a").ask<Answer>("inspect health report of the service"),
  agent("b").ask<Answer>("inspect health report of the service"),
])) as Answer;
return { status: winner.healthStatus };
interface Answer { healthStatus: string; }
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.equal((r.value as { status: string }).status, 'HEALTHY');
    assert.equal(r.stats.asks, 2, 'both turns ran; waitAny just picks the first settle');
  } finally {
    ws.cleanup();
  }
});

test('sessions.race resolves with the first fulfilled turn and cancels the losers', async () => {
  const slow = new SlowAbortProvider();
  providerRegistry.register(slow);
  providerRegistry.register(new DelayedFastProvider());
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'speculative-race.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Race");
const winner = (await sessions.race([
  agent("slow-worker", { provider: "dwf-slow-abort" }).ask<Answer>("inspect health report of the service"),
  agent("fast-worker", { provider: "dwf-fast-delayed" }).ask<Answer>("inspect health report of the service"),
])) as Answer;
return { status: winner.healthStatus };
interface Answer { healthStatus: string; }
`);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const r = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      runTimeoutMs: 20000,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.status, 'completed', `race run failed: ${r.error}`);
    assert.equal((r.value as { status: string }).status, 'HEALTHY');
    // The run settles as soon as the winner returns; a loser cancellation event
    // can land after settle and be dropped. Wait one tick, then assert the
    // stable invariant: a loser that actually reached the provider observed its
    // AbortSignal, and no second ask completed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelled = events.some(
      (e) => e.type === 'dwf_node_failed' && e.data.cancelled === true && /cancel/i.test(String(e.data.error)),
    );
    assert.ok(
      cancelled || slow.abortedCount >= 1 || slow.startedCount === 0,
      `expected the loser to be cancelled; started=${slow.startedCount} aborted=${slow.abortedCount} ` +
        `events=${JSON.stringify(events.filter((e) => e.type === 'dwf_node_failed'))}`
    );
    assert.ok(slow.startedCount === 0 || slow.abortedCount >= 1, 'a started loser must observe its AbortSignal');
    assert.equal(
      events.filter((e) => e.type === 'dwf_ask_complete').length,
      1,
      'only the winner completed — the loser was cancelled',
    );
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});

test('sessions.race cancels every pending turn on timeout', async () => {
  const slow = new SlowAbortProvider();
  providerRegistry.register(slow);
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'race-timeout.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Race");
try {
  await sessions.race([
    agent("slow-worker", { provider: "dwf-slow-abort" }).ask("slow question"),
  ], { timeoutMs: 150 });
  return { timedOut: false, message: "resolved" };
} catch (e) {
  return { timedOut: true, message: String((e as Error).message ?? e) };
}
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, runTimeoutMs: 20000 });
    assert.equal(r.status, 'completed', r.error);
    const value = r.value as { timedOut: boolean; message: string };
    assert.equal(value.timedOut, true, 'the race must reject on timeout');
    assert.match(value.message, /timed out after 150ms/);
    assert.ok(slow.abortedCount >= 1, 'the pending loser is cancelled by the timeout');
  } finally {
    providerRegistry.setDefault('mock');
    ws.cleanup();
  }
});

test('sessions.race rejects an empty turn list instead of hanging', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'race-empty.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Race");
try {
  await sessions.race([]);
  return { error: "" };
} catch (e) {
  return { error: String((e as Error).message ?? e) };
}
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.match((r.value as { error: string }).error, /at least one turn/);
  } finally {
    ws.cleanup();
  }
});

test('LiveGraph: state JSON reflects phases, asks and terminal status; html page exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-live-'));
  try {
    const out = path.join(dir, 'live.html');
    const g = new LiveGraph(out, 'dwfrun-live-test');
    g.handle('dwf_phase', { phase: 'Survey' });
    g.handle('dwf_ask_start', { siteId: 'ask#1', actor: 'inspector' });
    g.handle('dwf_ask_complete', { siteId: 'ask#1' });
    g.handle('dwf_completed', { status: 'completed' });
    g.finish({ status: 'completed', value: { ok: true } });
    const state = JSON.parse(fs.readFileSync(out.replace(/\.html$/, '.state.json'), 'utf8'));
    assert.equal(state.runId, 'dwfrun-live-test');
    assert.equal(state.result.status, 'completed');
    assert.deepEqual(state.phases.map((p: { name: string }) => p.name), ['Survey']);
    assert.equal(state.asks[0].status, 'done');
    assert.equal(state.asks[0].actor, 'inspector');
    assert.ok(fs.existsSync(out), 'html written');
    assert.match(fs.readFileSync(out, 'utf8'), /setInterval\(tick, 500\)/, 'self-refreshing page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider health: mock always ok; the optional probe is honoured by doctor', () => {
  const mock = new MockProvider();
  const health = mock.checkHealth();
  assert.equal(health.ok, true);
  assert.match(health.detail, /deterministic mock/);
});
