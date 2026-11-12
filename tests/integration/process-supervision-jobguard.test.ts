/**
 * Win32 Job Object supervision — behavioral gate suite (Issue #98).
 *
 * All assertions are observable terminal states / counts (tasklist rows, pids,
 * exit codes) — no ever-true assertions. Cases (b)/(b2)/(c)/(d) require the
 * 'job-object' mode and skip with a NAMED reason when the machine degraded to
 * 'fallback-taskkill' (a legitimate state, e.g. no csc.exe); case (a) is
 * mechanism-agnostic (taskkill /T works in both modes) and always runs on
 * win32. On non-win32 everything skips (this suite exercises Win32 kernel
 * semantics; CI has no Windows lane).
 *
 * Case map (blueprint step 6):
 *   (a)  high-concurrency orphan stress — 8 supervised loopers with ping
 *        grandchildren, killTree all, zero PING.EXE residue (mechanism-agnostic
 *        regression guard for the unified kill path);
 *   (b)  parent-crash chain — taskkill /F the DRIVER (no /T): the helper's
 *        WaitForMultipleObjects parent branch fires TerminateJobObject;
 *   (b2) helper-kill isolation — taskkill /F the HELPER pid (no /T, driver
 *        alive): the ONLY case that forces the "helper dies unexpectedly →
 *        job handle closes → KILL_ON_JOB_CLOSE kernel kill" path. This is the
 *        single behavioral gate for the inherit-bit iron rule (job handle must
 *        not leak into the supervised tree — SetHandleInformation +
 *        PROC_THREAD_ATTRIBUTE_HANDLE_LIST in scripts/win32-jobhelper.cs): if
 *        the handle leaks, the tree keeps it open, the kernel kill never
 *        fires, ping survives and this test goes red.
 *   (c)  memory guard — JOB_OBJECT_LIMIT_PROCESS_MEMORY commit failure ends
 *        an over-limit child (self-terminated via RangeError, exit != 0) while
 *        a normal allocation survives the same cap;
 *   (d)  the memory cap and the wall-clock tree kill coexist.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPidAlive, killTree, queryJobGuardStatus, spawnSupervised } from '../../src/process-supervision.js';

const IS_WIN32 = process.platform === 'win32';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** CSV data rows for PING.EXE — the observable grandchild marker. */
function pingRowCount(): number {
  const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/FO', 'CSV'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  return (listed.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith('"PING.EXE')).length;
}

async function waitForPingRowsAtLeast(minRows: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pingRowCount() >= minRows) return;
    await sleep(200);
  }
  throw new Error(`PING.EXE rows never reached ${minRows} within ${deadlineMs}ms (grandchild did not start)`);
}

async function waitForPingRowsZero(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pingRowCount() === 0) return;
    await sleep(200);
  }
  throw new Error(`PING.EXE rows never reached 0 within ${deadlineMs}ms — orphan residue`);
}

async function assertPidDead(pid: number, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(150);
  }
  assert.equal(isPidAlive(pid), false, `pid ${pid} must be dead within ${deadlineMs}ms`);
}

function requireWin32(t: TestContext): boolean {
  if (!IS_WIN32) {
    t.skip('win32-only suite (Job Object semantics do not exist on POSIX)');
    return false;
  }
  return true;
}

function requireJobObjectMode(t: TestContext): void {
  const status = queryJobGuardStatus();
  if (status.mode !== 'job-object') {
    t.skip(`job-object mode unavailable on this machine — degraded to fallback-taskkill: ${status.reason ?? 'unknown'}`);
  }
}

/**
 * Hard-kill ONE pid — /F WITHOUT /T on purpose: taskkill's own user-mode tree
 * walk would mask the Job Object mechanism under test (making (b)/(b2)
 * ever-green — the exact trap this suite exists to guard against).
 */
function killPidHard(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
}

/** The supervised grandchild-spawning looper every case uses. */
const LOOP_CHILD_CODE = "const { spawn } = require('node:child_process'); spawn('ping', ['-n', '999999', '127.0.0.1'], { stdio: 'ignore' }); setInterval(() => {}, 1000);";

/**
 * Driver for (b)/(b2): a detached temp-dir script (NEVER inside the repo)
 * that builds the same supervised tree via the built process-supervision
 * module and writes a marker {driverPid, supervisedPid} once the tree exists.
 */
function writeDriver(dir: string): { driverPath: string; markerPath: string } {
  const markerPath = path.join(dir, 'marker.json');
  const supervisionUrl = JSON.stringify(new URL('../../src/process-supervision.js', import.meta.url).href);
  const source = [
    "import * as fs from 'node:fs';",
    `const mod = await import(${supervisionUrl});`,
    'const markerPath = process.argv[2];',
    `const child = mod.spawnSupervised(process.execPath, ['-e', ${JSON.stringify(LOOP_CHILD_CODE)}], { cwd: process.cwd() });`,
    'setTimeout(() => {',
    '  fs.writeFileSync(markerPath, JSON.stringify({ driverPid: process.pid, supervisedPid: child.pid }));',
    '}, 500);',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
  const driverPath = path.join(dir, 'jobguard-driver.mjs');
  fs.writeFileSync(driverPath, source, 'utf8');
  return { driverPath, markerPath };
}

function startDriver(driverPath: string, markerPath: string, cwd: string): ChildProcess {
  const driver = spawn(process.execPath, [driverPath, markerPath], {
    cwd,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  driver.unref();
  return driver;
}

async function readMarker(markerPath: string): Promise<{ driverPid: number; supervisedPid: number }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`driver marker never appeared: ${markerPath}`);
}

/** Best-effort teardown: the driver must never survive a test outcome. */
function cleanupDriver(driver: ChildProcess | undefined): void {
  if (driver?.pid !== undefined && isPidAlive(driver.pid)) {
    spawnSync('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true });
  }
}

function rmTemp(dir: string): void {
  // Windows handle-lag (P-ENV-2): a freshly dead process's temp dir may still
  // be briefly locked — best effort, never mask the test outcome.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------

test('(a) high-concurrency tree kill: 8 supervised loopers + ping grandchildren leave zero orphans', { timeout: 90_000 }, async (t) => {
  if (!requireWin32(t)) return;
  assert.equal(pingRowCount(), 0, 'environment noise: PING.EXE already running before the test — clean the host first');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-a-'));
  const supervised: ReturnType<typeof spawnSupervised>[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      supervised.push(spawnSupervised(process.execPath, ['-e', LOOP_CHILD_CODE], { cwd: tmp }));
    }
    // The grandchildren must ACTUALLY exist before the kill, otherwise the
    // zero-residue assertion would be trivially true.
    await waitForPingRowsAtLeast(1, 15_000);
    for (const s of supervised) await s.killTree();
    await waitForPingRowsZero(2_000);
    assert.equal(pingRowCount(), 0, 'no PING.EXE may survive the unified killTree path');
    for (const s of supervised) {
      assert.ok(s.pid !== undefined, 'every supervised spawn must expose a pid (the helper pid in job mode)');
      await assertPidDead(s.pid);
    }
  } finally {
    for (const s of supervised) {
      if (s.pid !== undefined && isPidAlive(s.pid)) await killTree(s.pid);
    }
    rmTemp(tmp);
  }
});

test('(b) parent-crash chain: hard-killing the driver fires the helper parent-death branch — tree dies', { timeout: 60_000 }, async (t) => {
  if (!requireWin32(t)) return;
  requireJobObjectMode(t);
  if (queryJobGuardStatus().mode !== 'job-object') return; // skip already recorded
  assert.equal(pingRowCount(), 0, 'environment noise: PING.EXE already running before the test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-b-'));
  let driver: ChildProcess | undefined;
  try {
    const { driverPath, markerPath } = writeDriver(dir);
    driver = startDriver(driverPath, markerPath, dir);
    const marker = await readMarker(markerPath);
    await waitForPingRowsAtLeast(1, 15_000);
    // /F without /T: ONLY the driver dies — the helper must notice the parent
    // death on its own and TerminateJobObject the tree.
    killPidHard(marker.driverPid);
    await waitForPingRowsZero(2_000);
    assert.equal(pingRowCount(), 0, 'parent crash must terminate the whole supervised tree (helper parent-wait branch)');
  } finally {
    cleanupDriver(driver);
    rmTemp(dir);
  }
});

test('(b2) helper-kill isolation: killing the HELPER pid closes the job handle — KILL_ON_JOB_CLOSE reaps the tree', { timeout: 60_000 }, async (t) => {
  if (!requireWin32(t)) return;
  requireJobObjectMode(t);
  if (queryJobGuardStatus().mode !== 'job-object') return; // skip already recorded
  assert.equal(pingRowCount(), 0, 'environment noise: PING.EXE already running before the test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-b2-'));
  let driver: ChildProcess | undefined;
  try {
    const { driverPath, markerPath } = writeDriver(dir);
    driver = startDriver(driverPath, markerPath, dir);
    const marker = await readMarker(markerPath);
    await waitForPingRowsAtLeast(1, 15_000);
    // /F without /T, driver stays alive: the ONLY forced path "helper dies
    // unexpectedly → job handle closes → kernel kills the tree". If the job
    // handle leaked into the supervised tree (inherit-bit iron rule), the
    // kernel kill never fires and ping survives → this assertion goes red.
    killPidHard(marker.supervisedPid);
    await waitForPingRowsZero(2_000);
    assert.equal(pingRowCount(), 0, 'KILL_ON_JOB_CLOSE must reap the tree when the helper dies (job-handle inherit-leak gate)');
  } finally {
    cleanupDriver(driver);
    rmTemp(dir);
  }
});

test('(c) memory guard: commit cap ends an over-limit allocation; a normal allocation survives the same cap', { timeout: 60_000 }, async (t) => {
  if (!requireWin32(t)) return;
  requireJobObjectMode(t);
  if (queryJobGuardStatus().mode !== 'job-object') return; // skip already recorded
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-c-'));
  try {
    const overLimit = spawnSupervised(process.execPath, ['-e', 'const b = Buffer.alloc(512*1024*1024); console.log("allocated " + b.length);'], {
      cwd: tmp,
      processMemoryLimitMb: 128,
      timeoutMs: 10_000,
    });
    const overResult = await overLimit.result;
    // JOB_OBJECT_LIMIT_PROCESS_MEMORY makes the commit fail — the child dies
    // BY ITSELF (node RangeError), not by a kernel Terminate.
    assert.ok(overResult.exitCode !== 0, `over-limit child must terminate nonzero (got exitCode ${overResult.exitCode})`);
    assert.match(overResult.stderr, /Array buffer allocation failed|RangeError/, `stderr must carry the commit-failure semantics: ${JSON.stringify(overResult.stderr.slice(0, 400))}`);
    assert.ok(overResult.durationMs < 10_000, `over-limit child must die well under the wall clock (took ${overResult.durationMs}ms)`);
    assert.equal(overResult.timedOut, false, 'the commit cap, not the timeout, must end the over-limit child');

    const control = spawnSupervised(process.execPath, ['-e', 'const b = Buffer.alloc(16*1024*1024); console.log("allocated " + b.length);'], {
      cwd: tmp,
      processMemoryLimitMb: 128,
      timeoutMs: 10_000,
    });
    const controlResult = await control.result;
    assert.equal(controlResult.exitCode, 0, 'a 16MB allocation must survive a 128MB commit cap');
    assert.ok(controlResult.stdout.includes('allocated 16777216'), `control stdout: ${JSON.stringify(controlResult.stdout.slice(0, 200))}`);
  } finally {
    rmTemp(tmp);
  }
});

test('(d) memory cap and whole-tree timeout coexist: the memory path settles first, the timeout path still fires', { timeout: 60_000 }, async (t) => {
  if (!requireWin32(t)) return;
  requireJobObjectMode(t);
  if (queryJobGuardStatus().mode !== 'job-object') return; // skip already recorded
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-d-'));
  try {
    const memChild = spawnSupervised(process.execPath, ['-e', 'const b = Buffer.alloc(512*1024*1024); console.log("allocated " + b.length);'], {
      cwd: tmp,
      processMemoryLimitMb: 128,
      timeoutMs: 15_000,
    });
    const memResult = await memChild.result;
    assert.equal(memResult.timedOut, false, 'the memory path must win before the 15s wall clock');
    assert.ok(memResult.exitCode !== 0, `memory-path child must die nonzero (got ${memResult.exitCode})`);

    const loopChild = spawnSupervised(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      cwd: tmp,
      timeoutMs: 1_000,
    });
    const loopResult = await loopChild.result;
    assert.equal(loopResult.timedOut, true, 'a pure deadloop child must be ended by the timeout tree kill');
    assert.ok(loopResult.durationMs >= 1_000, `timeout kill must honor the wall clock (took ${loopResult.durationMs}ms)`);
    assert.ok(loopResult.durationMs < 10_000, `timeout kill must not hang (took ${loopResult.durationMs}ms)`);
    if (loopChild.pid !== undefined) await assertPidDead(loopChild.pid);
  } finally {
    rmTemp(tmp);
  }
});
