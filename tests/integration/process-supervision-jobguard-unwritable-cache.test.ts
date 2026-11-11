/**
 * Job-guard cache-unusable degradation (Issue #108).
 *
 * The compile chain (source read → cache mkdir → csc spawn → rename) used to
 * let fs exceptions escape `spawnJobGuarded` entirely, and the module memo was
 * only written on SUCCESS — so a cache directory that cannot be created made
 * every spawn of the process throw, forever. The fix turns any such exception
 * into a memoized fallback-taskkill verdict whose reason names the cache dir
 * and the errno code.
 *
 * Deliberately a separate file (like the other job-guard suites): the verdict
 * is memoized for the whole process, and node --test runs every file in its
 * own process, so this injected-poison verdict cannot contaminate the others.
 *
 * Deterministic repro without ACL games: a regular FILE sits where the cache
 * DIRECTORY is expected, so `mkdirSync(recursive)` throws ENOTDIR on every
 * platform (verified locally on win32).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { queryJobGuardStatus, spawnJobGuarded } from '../../src/process-supervision.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-cache108-'));
const blockFile = path.join(tmp, 'cache'); // a file, not a directory
fs.writeFileSync(blockFile, 'not a directory');
const badCacheDir = path.join(blockFile, 'win32-jobhelper');

// Inject FIRST, before any other supervision call in this process — the memo
// keeps the first verdict, so the whole file sees it.
const injected = queryJobGuardStatus({ cacheDir: badCacheDir });

/** Same csc probe the module uses: without a csc the chain degrades earlier. */
function cscAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  const windir = process.env.WINDIR ?? process.env.SystemRoot;
  if (!windir) return false;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

const reachedCompileStage = cscAvailable();

test('(u-1) unusable cache dir degrades to fallback-taskkill — it never throws', () => {
  // Before the fix this query itself threw ENOTDIR out of mkdirSync.
  assert.equal(injected.mode, 'fallback-taskkill', `verdict: ${JSON.stringify(injected)}`);
});

test('(u-2) the fallback reason names the cache dir and the errno code', () => {
  if (!reachedCompileStage) {
    // POSIX / no-csc hosts degrade before the cache is touched; the reason
    // then names that earlier stage instead. The invariant that matters —
    // fallback, not a throw — is covered by (u-1) on every platform.
    return; // skipped de facto on hosts that cannot reach the compile stage
  }
  assert.match(
    injected.reason ?? '',
    new RegExp(badCacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `reason must name the cache dir: ${JSON.stringify(injected.reason)}`,
  );
  assert.match(injected.reason ?? '', /ENOTDIR/, `reason must carry the errno code: ${JSON.stringify(injected.reason)}`);
});

test('(u-3) the verdict is memoized — the second call does not retry the compile', () => {
  const again = queryJobGuardStatus();
  assert.ok(again === injected, 'the same verdict object must be returned (memoized, not recomputed)');
});

test('(u-4) spawnJobGuarded still returns a working child under the unusable cache', { timeout: 30_000 }, async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobguard-cache108-run-'));
  try {
    const child = spawnJobGuarded(process.execPath, ['-e', 'console.log("cache108-ok");'], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 0, `exitCode: ${code}`);
    assert.ok(Buffer.concat(chunks).toString('utf8').includes('cache108-ok'));
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
  }
});
