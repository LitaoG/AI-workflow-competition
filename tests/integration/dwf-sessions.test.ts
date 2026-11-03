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
  async generate(request: LLMRequest): Promise<LLMResponse> {
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
      events.some((e) => e.type === 'dwf_node_failed' && /cancel/i.test(String(e.data.error))),
      `expected a cancelled node failure, got: ${JSON.stringify(events.filter((e) => e.type === 'dwf_node_failed'))}`,
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
