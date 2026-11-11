/**
 * Issue #127 direction 1: world.run authorization provenance.
 *
 * The script's self-declared command list no longer authorizes anything.
 * Three sources resolve per call — ① explicit (caller parameter), ② the
 * project allowlist (.workflow/approved-commands.json), ③ an interactive TTY
 * confirmation — and every call journals its source (dwf_world_run_auth).
 * With no source the call is refused with actionable guidance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { createSQLiteStore } from '../../src/state/store.js';
import type { DwfJournalStore } from '../../src/types.js';
import type { SQLiteStateStore } from '../../src/state/sqlite-store.js';

const WORLD_SCRIPT = `
phase("World");
const gate = await world.run('node', ['-e', 'process.exit(0)'], { timeoutMs: 30000 });
return { exit: gate.exitCode };
`;

function makeProject(): { dir: string; scriptPath: string; dbPath: string; allowlistPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-world-auth-'));
  const scriptPath = path.join(dir, 'world.facade.ts');
  fs.writeFileSync(scriptPath, WORLD_SCRIPT);
  return {
    dir,
    scriptPath,
    dbPath: path.join(dir, '.workflow', 'dwf.sqlite'),
    allowlistPath: path.join(dir, '.workflow', 'approved-commands.json'),
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows lock lag */
      }
    },
  };
}

async function authEvents(dbPath: string, runId: string): Promise<Array<Record<string, unknown>>> {
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  const events = await store.getEvents(runId);
  store.close();
  return (events as Array<{ type: string; data: Record<string, unknown> }>)
    .filter((e) => e.type === 'dwf_world_run_auth')
    .map((e) => e.data);
}

test('#127: no source — refused with actionable guidance (the self-declared list authorizes nothing)', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'failed', `expected a refusal, got ${r.status}`);
    assert.match(r.error ?? '', /not authorized/);
    assert.match(r.error ?? '', /--approve-cmd node/, 'the guidance must name the command');
    assert.match(r.error ?? '', /approved-commands\.json/, 'the guidance must name the allowlist');
  } finally {
    project.cleanup();
  }
});

test('#127: explicit caller authorization runs and journals source=explicit', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir, approvedCommands: ['node'] });
    assert.equal(r.status, 'completed', r.error);
    const events = await authEvents(project.dbPath, r.runId);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'explicit');
    assert.equal(events[0].cmd, 'node');
  } finally {
    project.cleanup();
  }
});

test('#127: the project allowlist authorizes and journals source=allowlist', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    fs.mkdirSync(path.join(project.dir, '.workflow'), { recursive: true });
    fs.writeFileSync(project.allowlistPath, JSON.stringify({ approved: ['node'] }));
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'completed', r.error);
    const events = await authEvents(project.dbPath, r.runId);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'allowlist');
  } finally {
    project.cleanup();
  }
});

test('#127: the TTY confirmation callback authorizes or declines, journaled as tty', { timeout: 60_000 }, async () => {
  // Confirm → runs, source=tty.
  {
    const project = makeProject();
    try {
      const r = await runFacadeScript({
        scriptPath: project.scriptPath,
        cwd: project.dir,
        confirmWorldRun: async () => true,
      });
      assert.equal(r.status, 'completed', r.error);
      const events = await authEvents(project.dbPath, r.runId);
      assert.equal(events[0]?.source, 'tty');
    } finally {
      project.cleanup();
    }
  }
  // Decline → refused with the interactive-decline error, and the refusal is
  // journaled as its own auth event (Issue #194 P3) — the audit replay shows
  // the attempt, not just the failure error.
  {
    const project = makeProject();
    try {
      const r = await runFacadeScript({
        scriptPath: project.scriptPath,
        cwd: project.dir,
        confirmWorldRun: async () => false,
      });
      assert.equal(r.status, 'failed');
      assert.match(r.error ?? '', /declined interactively/);
      const events = await authEvents(project.dbPath, r.runId);
      assert.equal(events.length, 1, 'the tty decline must journal one auth event (Issue #194 P3)');
      assert.equal(events[0].source, 'tty-declined');
      assert.equal(events[0].cmd, 'node');
    } finally {
      project.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Issue #194 P1: allowlist entries carry a parameter shape (name + args per
// the #127 ruling parameter ②) — name-only matching silently amplified every
// entry to binary-level and silently dead-dropped compound names.
// ---------------------------------------------------------------------------

test('#194 P1: a shape entry authorizes the matching prefix and journals source=allowlist', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    fs.mkdirSync(path.join(project.dir, '.workflow'), { recursive: true });
    fs.writeFileSync(project.allowlistPath, JSON.stringify({ approved: [{ name: 'node', args: ['-e'] }] }));
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'completed', r.error);
    const events = await authEvents(project.dbPath, r.runId);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'allowlist');
  } finally {
    project.cleanup();
  }
});

test('#194 P1: a shape entry does NOT authorize off-shape arguments (fail-closed, refusal journaled as unauthorized)', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    fs.mkdirSync(path.join(project.dir, '.workflow'), { recursive: true });
    // Declared shape is --version; the script calls node -e … — no match.
    fs.writeFileSync(project.allowlistPath, JSON.stringify({ approved: [{ name: 'node', args: ['--version'] }] }));
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'failed', 'an off-shape call must not run');
    assert.match(r.error ?? '', /not authorized/);
    const events = await authEvents(project.dbPath, r.runId);
    assert.equal(events.length, 1, 'the refusal must journal one auth event (Issue #194 P3)');
    assert.equal(events[0].source, 'unauthorized');
  } finally {
    project.cleanup();
  }
});

test('#194 P1: an empty args shape authorizes only the zero-arg call — an argument-ful call is refused', { timeout: 60_000 }, async () => {
  const project = makeProject();
  try {
    fs.mkdirSync(path.join(project.dir, '.workflow'), { recursive: true });
    fs.writeFileSync(project.allowlistPath, JSON.stringify({ approved: [{ name: 'node', args: [] }] }));
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'failed', 'args: [] must not degenerate to binary-wide authorization');
    assert.match(r.error ?? '', /not authorized/);
  } finally {
    project.cleanup();
  }
});

test('#194 P1: a compound name entry can never match — loud warning, entry ignored (fail-closed)', { timeout: 60_000 }, async () => {
  const project = makeProject();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };
  try {
    fs.mkdirSync(path.join(project.dir, '.workflow'), { recursive: true });
    // "git status" as a NAME never matches (cmd is the binary name) — the old
    // parser silently dead-dropped it while the author believed it authorized.
    fs.writeFileSync(project.allowlistPath, JSON.stringify({ approved: ['git status'] }));
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir });
    assert.equal(r.status, 'failed', 'a compound-name entry authorizes nothing');
    assert.match(r.error ?? '', /not authorized/);
    assert.ok(
      warnings.some((w) => w.includes('git status') && w.includes('never match')),
      `a loud warning must name the dead entry, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
    project.cleanup();
  }
});
