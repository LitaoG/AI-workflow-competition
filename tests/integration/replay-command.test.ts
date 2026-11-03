/**
 * Integration tests for `/workflow replay <runId>` — the two real replay
 * paths (facade resume + core rebuild) and the no-fabrication contract:
 * a run whose definition cannot be rebuilt fails loudly with a StorageError
 * instead of reporting a fake success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeReplay } from '../../src/cli/commands/replay.js';
import { executeRun } from '../../src/cli/commands/run.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { createSQLiteStore } from '../../src/state/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Captured {
  out: string;
  err: string;
}

/** Run an async fn with console.log/error/warn captured (restored on both paths). */
async function captureIO<T>(fn: () => Promise<T>): Promise<{ result: T; captured: Captured }> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => void err.push(args.map(String).join(' '));
  try {
    const result = await fn();
    return { result, captured: { out: out.join('\n'), err: err.join('\n') } };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}

function makeWorkspace(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a sandbox child may briefly hold the dir on Windows */
      }
    },
  };
}

function readEffects(effectsPath: string): string[] {
  return fs.existsSync(effectsPath)
    ? fs.readFileSync(effectsPath, 'utf-8').split('\n').filter((line) => line.length > 0)
    : [];
}

/**
 * A two-step linear workflow whose executors leave real side effects:
 * step-1 always appends `step-1`; step-2's behavior depends on `mode`.
 */
function writeCoreDefinition(filePath: string, effectsPath: string, mode: 'transient' | 'always-fails' | 'always-succeeds'): void {
  const step2 =
    mode === 'always-succeeds'
      ? `fs.appendFileSync(EFFECTS, 'step-2\\n', 'utf-8'); return { v: 2 };`
      : mode === 'always-fails'
        ? `throw new Error('simulated permanent failure');`
        : `const current = fs.existsSync(EFFECTS) ? fs.readFileSync(EFFECTS, 'utf-8') : '';
  if (!current.split('\\n').includes('repair')) throw new Error('simulated transient failure');
  fs.appendFileSync(EFFECTS, 'step-2\\n', 'utf-8');
  return { v: 2 };`;
  const content = `
import * as fs from 'node:fs';
const EFFECTS = ${JSON.stringify(effectsPath)};
export default {
  name: 'replay-it-workflow',
  phases: ['Phase 1'],
  steps: [
    {
      id: 'step-1', name: 'Step 1', phase: 'Phase 1', role: 'worker',
      execute: async () => { fs.appendFileSync(EFFECTS, 'step-1\\n', 'utf-8'); return { v: 1 }; }
    },
    {
      id: 'step-2', name: 'Step 2', phase: 'Phase 1', role: 'worker', dependencies: ['step-1'],
      execute: async () => { ${step2} }
    },
  ],
};
`;
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// (a) Core run: failed step genuinely re-executes, completed steps short-circuit
// ---------------------------------------------------------------------------

test('replay of a failed core run re-executes the failed step for real and short-circuits the completed one', async () => {
  const ws = makeWorkspace('replay-it-a-');
  try {
    const effectsPath = path.join(ws.dir, 'effects.jsonl');
    const defPath = path.join(ws.dir, 'wf.replay-a.mjs');
    writeCoreDefinition(defPath, effectsPath, 'transient');
    const runId = 'run-replay-it-a';

    // Initial run: step-1 completes, step-2 fails (no repair marker yet).
    const setupCode = await captureIO(() => executeRun(defPath, { resumeFromFailed: runId, cwd: ws.dir }));
    assert.equal(setupCode.result, 1, 'initial run must fail at step-2');
    assert.deepEqual(readEffects(effectsPath), ['step-1'], 'step-2 must not have recorded a side effect on failure');

    // Repair the transient condition, then replay.
    fs.appendFileSync(effectsPath, 'repair\n', 'utf-8');
    const replay = await captureIO(() => executeReplay(runId, { cwd: ws.dir }));
    assert.equal(replay.result, 0, `replay must succeed: ${replay.captured.err}`);

    // Real execution proof: step-2 ran exactly once more (side effect), step-1 did NOT re-run.
    assert.deepEqual(readEffects(effectsPath), ['step-1', 'repair', 'step-2'], 'failed step re-executed, completed step short-circuited');

    // Real output proof: honest summary, no fabricated "100% verified".
    const combined = `${replay.captured.out}\n${replay.captured.err}`;
    assert.ok(!combined.includes('100% verified'), 'replay must never print the old fake verification banner');
    assert.ok(replay.captured.out.includes('Reused cached checkpoint for step step-1'), 'completed step must be reported as short-circuited');
    assert.ok(replay.captured.out.includes('Step completed: step-2'), 'failed step must be reported as genuinely re-executed');
    assert.ok(
      replay.captured.out.includes('Replay summary: 1 step(s) executed, 1 step(s) short-circuited, 0 step(s) still failing'),
      `summary must reflect real counts, got: ${replay.captured.out}`,
    );

    // Durable proof: the failed checkpoint became a real completed one.
    const store = new SQLiteStateStore(path.join(ws.dir, '.workflow', 'runs', runId, 'checkpoints.db'));
    try {
      const checkpoints = await store.getAllCheckpoints(runId);
      assert.equal(checkpoints['step-2']?.status, 'completed');
      assert.ok(checkpoints['step-2']?.inputHash, 're-executed checkpoint must carry the input binding');
    } finally {
      store.close();
    }

    // Replaying a now-fully-completed run executes nothing at all.
    const before = readEffects(effectsPath);
    const replay2 = await captureIO(() => executeReplay(runId, { cwd: ws.dir }));
    assert.equal(replay2.result, 0);
    assert.deepEqual(readEffects(effectsPath), before, 'second replay must not execute any step');
    assert.ok(
      replay2.captured.out.includes('Replay summary: 0 step(s) executed, 2 step(s) short-circuited, 0 step(s) still failing'),
      `second replay summary must show zero real executions, got: ${replay2.captured.out}`,
    );
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) Core run: a permanently failing step keeps replay exit non-zero with real stats
// ---------------------------------------------------------------------------

test('replay of a run whose step still fails exits non-zero and reports the real failure count', async () => {
  const ws = makeWorkspace('replay-it-b-');
  try {
    const effectsPath = path.join(ws.dir, 'effects.jsonl');
    const defPath = path.join(ws.dir, 'wf.replay-b.mjs');
    writeCoreDefinition(defPath, effectsPath, 'always-fails');
    const runId = 'run-replay-it-b';

    const setupCode = await captureIO(() => executeRun(defPath, { resumeFromFailed: runId, cwd: ws.dir }));
    assert.equal(setupCode.result, 1);

    const replay = await captureIO(() => executeReplay(runId, { cwd: ws.dir }));
    assert.notEqual(replay.result, 0, 'a still-failing step must yield a non-zero exit code');

    const combined = `${replay.captured.out}\n${replay.captured.err}`;
    assert.ok(!combined.includes('100% verified'), 'no fake verification banner on failure');
    assert.ok(
      replay.captured.out.includes('Replay summary: 0 step(s) executed, 1 step(s) short-circuited, 1 step(s) still failing'),
      `summary must report the real failure, got: ${replay.captured.out}`,
    );
    assert.ok(replay.captured.err.includes('simulated permanent failure'), 'the step failure must surface');

    // The failure is durable: the checkpoint is still failed.
    const store = new SQLiteStateStore(path.join(ws.dir, '.workflow', 'runs', runId, 'checkpoints.db'));
    try {
      const checkpoints = await store.getAllCheckpoints(runId);
      assert.equal(checkpoints['step-2']?.status, 'failed');
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) Facade run: replay delegates to run-script --resume (journal short-circuit)
// ---------------------------------------------------------------------------

const FACADE_SCRIPT = `
phase("Inspect");
const health = await agent("inspector").ask<Health>("inspect health report of the service");
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('replay of a facade run resumes from the journal: zero new asks, real replay hits, no fake checkpoints', async () => {
  const ws = makeWorkspace('replay-it-c-');
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_SCRIPT, 'utf-8');

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `initial facade run failed: ${first.error}`);

    const replay = await captureIO(() => executeReplay(first.runId, { cwd: ws.dir }));
    assert.equal(replay.result, 0, `facade replay must succeed: ${replay.captured.err}`);

    // Journal proof: the resumed stream shows real replay hits and NO new ask.
    const dwfDbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');
    const journal = createSQLiteStore(dwfDbPath);
    try {
      const events = await journal.getEvents(first.runId);
      const replayHits = events.filter((e) => e.type === 'dwf_replay_hit').length;
      const askStarts = events.filter((e) => e.type === 'dwf_ask_start').length;
      assert.ok(replayHits >= 1, 'the resumed run must record journal replay hits');
      assert.equal(askStarts, 1, 'the resumed run must not execute any new ask (zero-token short-circuit)');
    } finally {
      journal.close();
    }

    // No fabricated core checkpoints on the facade path.
    assert.ok(
      !fs.existsSync(path.join(ws.dir, '.workflow', 'runs', first.runId, 'checkpoints.db')),
      'facade replay must not write core checkpoints',
    );
  } finally {
    ws.cleanup();
  }
});

test('replay of a failed facade run re-executes the script for real and stays non-zero', async () => {
  const ws = makeWorkspace('replay-it-c2-');
  try {
    const scriptPath = path.join(ws.dir, 'throw.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("Boom");\nthrow new Error("kaboom");', 'utf-8');

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'failed');

    const replay = await captureIO(() => executeReplay(first.runId, { cwd: ws.dir }));
    assert.notEqual(replay.result, 0, 'a genuinely re-executed failing script must stay non-zero');
    assert.ok(replay.captured.err.includes('kaboom'), 'the real script error must surface');
  } finally {
    ws.cleanup();
  }
});

test('replay of a facade run whose script was deleted fails with a StorageError instead of faking success', async () => {
  const ws = makeWorkspace('replay-it-c3-');
  try {
    const scriptPath = path.join(ws.dir, 'vanish.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_SCRIPT, 'utf-8');
    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed');

    fs.rmSync(scriptPath);
    const replay = await captureIO(() => executeReplay(first.runId, { cwd: ws.dir }));
    assert.equal(replay.result, 1, 'an unrebuildable facade run must exit non-zero');
    assert.ok(replay.captured.err.includes('[StorageError]'), `error must carry the StorageError tag: ${replay.captured.err}`);
    assert.ok(replay.captured.err.includes('no longer readable'), 'error must name the unreadable script');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) Unrebuildable core run: explicit StorageError, non-zero, never faked
// ---------------------------------------------------------------------------

test('replay of a core run without a persisted definition fails with StorageError; --file rebuilds it', async () => {
  const ws = makeWorkspace('replay-it-d-');
  try {
    const effectsPath = path.join(ws.dir, 'effects.jsonl');
    const defPath = path.join(ws.dir, 'wf.replay-d.mjs');
    writeCoreDefinition(defPath, effectsPath, 'always-succeeds');
    const runId = 'run-replay-it-d';

    const setup = await captureIO(() => executeRun(defPath, { resumeFromFailed: runId, cwd: ws.dir }));
    assert.equal(setup.result, 0);

    // Simulate a cleaned run directory: the persisted definition copy is gone.
    const runDir = path.join(ws.dir, '.workflow', 'runs', runId);
    fs.rmSync(path.join(runDir, 'workflow.source.mjs'));

    const withoutFile = await captureIO(() => executeReplay(runId, { cwd: ws.dir }));
    assert.equal(withoutFile.result, 1, 'an unrebuildable core run must exit non-zero');
    assert.ok(withoutFile.captured.err.includes('[StorageError]'), `error must carry the StorageError tag: ${withoutFile.captured.err}`);
    assert.ok(withoutFile.captured.err.includes('not persisted'), 'error must state the definition is not persisted');

    // Escape hatch: the original file rebuilds the run honestly (all steps
    // short-circuit). The initial run already produced both side effects, so
    // the zero-re-execution proof is "no NEW effects" plus a summary of zero
    // real executions as counted by the engine's own events.
    const before = readEffects(effectsPath);
    const withFile = await captureIO(() => executeReplay(runId, { cwd: ws.dir, file: defPath }));
    assert.equal(withFile.result, 0, `--file rebuild must succeed: ${withFile.captured.err}`);
    assert.deepEqual(readEffects(effectsPath), before, 'the rebuilt run must short-circuit, not re-execute');
    assert.ok(
      withFile.captured.out.includes('Replay summary: 0 step(s) executed, 2 step(s) short-circuited, 0 step(s) still failing'),
      `rebuilt run must execute nothing for real, got: ${withFile.captured.out}`,
    );
  } finally {
    ws.cleanup();
  }
});

test('replay of an unknown run id exits non-zero with a not-found StorageError', async () => {
  const ws = makeWorkspace('replay-it-d2-');
  try {
    const replay = await captureIO(() => executeReplay('run-does-not-exist-99999', { cwd: ws.dir }));
    assert.equal(replay.result, 1);
    assert.ok(replay.captured.err.includes('not found'), `error must say not found: ${replay.captured.err}`);
  } finally {
    ws.cleanup();
  }
});
