/**
 * Issue #117: adoptPidIntoJobGuard — an ALREADY-RUNNING child pid (the MCP
 * stdio server the SDK spawns on our behalf) must not outlive the host. The
 * test spawns a dummy host and a dummy child, adopts the child against the
 * host, kills the HOST, and asserts the child is reaped by the kernel/watchdog
 * within the poll window. On Windows this exercises the jobhelper's `adopt`
 * mode (fresh kill-on-close job + host wait); without a compiled helper the
 * guard degrades to 'fallback' and the case is skipped with a note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { adoptPidIntoJobGuard, isPidAlive } from '../../src/process-supervision.js';

function longLivedProcess(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], { stdio: 'ignore' });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('adoptPidIntoJobGuard: killing the host reaps the adopted child', async () => {
  const host = longLivedProcess();
  const child = longLivedProcess();
  await wait(300); // let both pids materialize
  const hostPid = host.pid!;
  const childPid = child.pid!;
  assert.ok(isPidAlive(hostPid), 'host alive before the kill');
  assert.ok(isPidAlive(childPid), 'child alive before the kill');

  const guard = adoptPidIntoJobGuard(childPid, hostPid);
  try {
    if (guard.mode === 'fallback' && process.platform === 'win32') {
      // No csc / compile failure on this host: the kernel job cannot be
      // exercised here — the client's disconnectAll remains the cleanup path.
      test.skip('job-object mode unavailable on this host (fallback guard)');
      return;
    }
    assert.ok(isPidAlive(childPid), 'the adopted child keeps running while the host lives');

    host.kill('SIGKILL');
    let reaped = false;
    for (let i = 0; i < 40 && !reaped; i++) {
      await wait(150);
      reaped = !isPidAlive(childPid);
    }
    assert.ok(reaped, 'the adopted child is reaped after the host dies');
  } finally {
    guard.stop();
    if (isPidAlive(childPid)) child.kill('SIGKILL');
    if (isPidAlive(hostPid)) host.kill('SIGKILL');
  }
});

test('adoptPidIntoJobGuard: a dead child is a clean no-op (no sentinel failure)', async () => {
  const host = longLivedProcess();
  await wait(200);
  const hostPid = host.pid!;
  // A pid that never existed in this test's lifetime — the helper must exit
  // cleanly instead of failing the guard.
  const guard = adoptPidIntoJobGuard(os.platform() === 'win32' ? 999999 : 999999, hostPid);
  guard.stop();
  assert.ok(isPidAlive(hostPid), 'the host survives a no-op adopt');
  host.kill('SIGKILL');
});
