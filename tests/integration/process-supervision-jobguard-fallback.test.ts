/**
 * Job-guard DEGRADATION suite (Issue #98 Phase 2, blueprint step 7).
 *
 * Deliberately a separate file: the injected fake csc path poisons the
 * module-level memo (the first verdict sticks for the process lifetime by
 * design — degradation must never be retried per spawn), so running these
 * cases beside the job-object cases would contaminate them. node --test runs
 * every file in its own process, which isolates the poison here.
 *
 * The suite is dual-platform: on win32 it exercises the injected-fake-csc
 * degradation; on POSIX the status report alone (job-object supervision does
 * not exist there) — every case degrades honestly instead of hanging or
 * crashing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { queryJobGuardStatus, spawnJobGuarded, spawnSupervised } from '../../src/process-supervision.js';

const FAKE_CSC = path.join(os.tmpdir(), 'definitely-not-csc-9f2a4c.exe');

// Inject FIRST, before any other supervision call in this process — the memo
// keeps the first verdict, so the whole file sees the degraded mode.
const injected = queryJobGuardStatus({ cscPath: FAKE_CSC });

function rmTemp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
}

test('(e-1) injected fake csc path → queryJobGuardStatus reports fallback-taskkill with the reason recorded, memoized', () => {
  assert.equal(injected.mode, 'fallback-taskkill', `injected verdict: ${JSON.stringify(injected)}`);
  assert.ok(injected.reason !== undefined && injected.reason.length > 0, 'a degradation reason must be recorded');
  // Memoization: a later query (even without the probe) returns the SAME
  // degraded verdict instead of re-probing per call.
  const again = queryJobGuardStatus();
  assert.deepEqual(again, injected);
});

test('(e-2) spawnSupervised under degradation returns a complete result — no crash, no hang', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-fb-sup-'));
  try {
    const supervised = spawnSupervised(process.execPath, ['-e', 'console.log("fallback-ok");'], { cwd: tmp });
    const result = await supervised.result;
    assert.equal(result.exitCode, 0, `exitCode: ${result.exitCode}, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('fallback-ok'), `stdout: ${JSON.stringify(result.stdout)}`);
    assert.equal(result.stderr, '');
    assert.equal(result.timedOut, false);
  } finally {
    rmTemp(tmp);
  }
});

test('(e-3) spawnJobGuarded under degradation behaves as the plain spawn path (legacy options)', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-fb-sjg-'));
  try {
    const child = spawnJobGuarded(process.execPath, ['-e', 'console.log("guarded-fallback-ok");'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 0);
    assert.ok(Buffer.concat(chunks).toString('utf8').includes('guarded-fallback-ok'));
  } finally {
    rmTemp(tmp);
  }
});

test('(e-4) killTree under degradation is idempotent and safe on an already-dead pid', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-fb-kill-'));
  try {
    const sleeper = spawnSupervised(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: tmp });
    assert.ok(sleeper.pid !== undefined, 'the sleeper must have a pid');
    await sleeper.killTree();
    await sleepUntilDead(sleeper.pid!);
    // Idempotent: a second kill on the dead pid must resolve, not throw.
    await sleeper.killTree();
  } finally {
    rmTemp(tmp);
  }
});

async function sleepUntilDead(pid: number, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`pid ${pid} did not die within ${deadlineMs}ms`);
}
