/**
 * Issue #31 (2026-11-15, park deadlock) — counter-symmetry lock.
 *
 * The runner's in-flight ask counter (runner.ts onEvent) has exactly one
 * increment site (dwf_ask_start) and must have a symmetric settle for every
 * live ask: dwf_ask_complete (success) or dwf_node_failed (both failure
 * shapes — the engine's cancelled:true AbortError branch AND a plain journalled
 * failure). Replayed failed nodes (journal/warm-cache re-emits, tagged
 * replayed:true) never had a dwf_ask_start and are excluded from the
 * decrement — they must not corrupt the counter either.
 *
 * Before the fix a plain failed ask decremented nothing: engineIdle() stayed
 * false forever, maybePark returned at its first guard, the 10s fallback never
 * armed, and a run whose script caught the failure and then hit a hole hung to
 * the whole-run killTimer as `failed` (fillHoleAndRun then refused it — only
 * parked runs are fillable).
 *
 * These tests lock the symmetry as an executable invariant over the observed
 * event stream: starts === completes + liveAskFailures (replayedAskFailures
 * tallied separately, never in the live balance).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../../src/dwf/runner.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';

/** Always throws an unrecognized message: classifier → fatal, non-retryable, not a policy stop. */
class DoomedFailProvider implements LLMProvider {
  readonly id = 'doomed-fail-test';
  readonly name = 'Doomed failing test provider';
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    throw new Error('doomed: deterministic test failure (doomed-fail-test)');
  }
}
providerRegistry.register(new DoomedFailProvider());

const DOOMED_THEN_HOLE = `
phase('doomed');
let doomedAskFailed = false;
try {
  const verdict = await agent('doomed-agent', { provider: 'doomed-fail-test' }).ask<Verdict>('produce the verdict');
  log('unexpected success');
} catch (err) {
  doomedAskFailed = true;
}
phase('park');
const answer = await hole<string>('await-human', 'awaiting a human fill');
return { doomedAskFailed, answer };

interface Verdict { verdict: string; }
`;

const MIXED_THEN_HOLE = `
phase('mix');
let firstOk = false;
try {
  const ok = await agent('ok-agent').ask<Answer>('inspect health report of the service');
  firstOk = true;
} catch (err) {
  firstOk = false;
}
let doomedAskFailed = false;
try {
  const bad = await agent('doomed-agent', { provider: 'doomed-fail-test' }).ask<Verdict>('produce the verdict');
} catch (err) {
  doomedAskFailed = true;
}
const answer = await hole<string>('tail', 'awaiting a human fill');
return { firstOk, doomedAskFailed, answer };

interface Answer { healthStatus: string; }
interface Verdict { verdict: string; }
`;

type ObservedEvent = { type: string; data: Record<string, unknown> };

interface Tally {
  starts: number;
  completes: number;
  liveAskFailures: number;
  replayedAskFailures: number;
}

/** Event-stream tally of the runner's in-flight counter inputs (runner.ts onEvent). */
function tally(events: ObservedEvent[]): Tally {
  const isAskFailure = (e: ObservedEvent, replayed: boolean): boolean =>
    e.type === 'dwf_node_failed'
    && (e.data as { kind?: string }).kind === 'ask'
    && ((e.data as { replayed?: boolean }).replayed === true) === replayed;
  return {
    starts: events.filter((e) => e.type === 'dwf_ask_start').length,
    completes: events.filter((e) => e.type === 'dwf_ask_complete').length,
    liveAskFailures: events.filter((e) => isAskFailure(e, false)).length,
    replayedAskFailures: events.filter((e) => isAskFailure(e, true)).length,
  };
}

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-park-inflight-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* child may briefly hold the dir on Windows */ } } };
}

test('a caught failed ask releases its slot: the run parks and the counter stays symmetric', { timeout: 90_000 }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'doomed.facade.ts');
    fs.writeFileSync(scriptPath, DOOMED_THEN_HOLE);
    const events: ObservedEvent[] = [];

    const parked = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: path.join(ws.dir, 'journal.sqlite'),
      runTimeoutMs: 55_000,
      onEvent: (e) => events.push(e),
    });
    assert.equal(parked.status, 'parked', `expected parked, got ${parked.status}: ${parked.error}`);
    assert.equal(parked.parkedAt?.name, 'await-human');
    assert.equal(parked.stats.asks, 1, 'the doomed ask counted once');

    const live = tally(events);
    assert.equal(live.starts, 1);
    assert.equal(live.completes, 0, 'a failed ask never fires dwf_ask_complete');
    assert.equal(live.liveAskFailures, 1, 'the failed ask settled via dwf_node_failed (kind ask, not replayed)');
    assert.equal(live.starts, live.completes + live.liveAskFailures, 'every ask_start has a symmetric settle');
    assert.equal(events.filter((e) => e.type === 'dwf_parked').length, 1, 'the terminal dwf_parked event fired');

    // Same-script resume: the journalled failure replays (replayed:true) into
    // the catch — the replay had NO dwf_ask_start, so it must not disturb the
    // live balance; the run parks again.
    const resumeEvents: ObservedEvent[] = [];
    const parked2 = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: path.join(ws.dir, 'journal.sqlite'),
      resumeRunId: parked.runId,
      runTimeoutMs: 55_000,
      onEvent: (e) => resumeEvents.push(e),
    });
    assert.equal(parked2.status, 'parked', `expected the resume to park again, got ${parked2.status}: ${parked2.error}`);
    const replayTally = tally(resumeEvents);
    assert.equal(replayTally.starts, 0, 'a replayed node never had a dwf_ask_start');
    assert.equal(replayTally.replayedAskFailures, 1, 'the journalled failure re-emitted with replayed:true');
    assert.equal(replayTally.completes + replayTally.liveAskFailures, 0, 'nothing live settled on the resume');
    assert.equal(
      replayTally.starts,
      replayTally.completes + replayTally.liveAskFailures,
      'the live balance holds even when replayed failures re-emit',
    );
  } finally {
    ws.cleanup();
  }
});

test('mixed success + failed asks keep the counter symmetric and still park', { timeout: 90_000 }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'mixed.facade.ts');
    fs.writeFileSync(scriptPath, MIXED_THEN_HOLE);
    const events: ObservedEvent[] = [];

    const parked = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: path.join(ws.dir, 'journal.sqlite'),
      runTimeoutMs: 55_000,
      onEvent: (e) => events.push(e),
    });
    assert.equal(parked.status, 'parked', `expected parked, got ${parked.status}: ${parked.error}`);
    assert.equal(parked.parkedAt?.name, 'tail');
    assert.equal(parked.stats.asks, 2, 'both asks counted');

    const live = tally(events);
    assert.equal(live.starts, 2);
    assert.equal(live.completes, 1, 'the healthy ask completed');
    assert.equal(live.liveAskFailures, 1, 'the doomed ask settled via dwf_node_failed');
    assert.equal(live.starts, live.completes + live.liveAskFailures, 'every ask_start has a symmetric settle');
  } finally {
    ws.cleanup();
  }
});
