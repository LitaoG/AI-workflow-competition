/**
 * Issue #263 regression suite: the no-helper FALLBACK branch must pass the
 * pre-quoted cmd tail verbatim, exactly like the job-helper `--raw` branch.
 *
 * Why a separate file: `queryJobGuardStatus` memoizes the first verdict for the
 * whole process (by design — see the job-guard suites), and `node --test` runs
 * every file in its own process. This file poisons the compiler probe with a
 * non-existent `cscPath` so it always exercises the fallback, without touching
 * the host's real .NET install.
 *
 * The two failures this locks (both observed before the fix):
 *   1. `npm --version` exited 1 (the shim no longer resolved) because Node
 *      re-quoted the tail with MSVCRT rules and cmd.exe does not honor `\"`;
 *   2. the `&` still split the command line into two cmd commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryJobGuardStatus, spawnSupervised } from '../../src/process-supervision.js';

// Inject FIRST: the memo keeps the first verdict, so the whole file sees the
// fallback — which is the branch under test.
const injected = queryJobGuardStatus({ cscPath: 'C:\\__issue263_missing_csc__\\csc.exe' });

test(
  'fallback spawn runs the .cmd shim AND keeps `&` literal (Issue #263)',
  { skip: process.platform !== 'win32' ? 'the cmd route is win32-only' : false, timeout: 60_000 },
  async () => {
    assert.equal(injected.mode, 'fallback-taskkill', `verdict: ${JSON.stringify(injected)}`);

    const proc = spawnSupervised('npm', ['--version', '&', 'echo', 'ISSUE263_PWN'], {
      cwd: process.cwd(),
      timeoutMs: 45_000,
    });
    const result = await proc.result;

    assert.equal(result.exitCode, 0, `fallback spawn must succeed; stderr=${JSON.stringify(result.stderr)}`);
    assert.match(String(result.stdout), /\d+\.\d+\.\d+/, 'the shim must actually run and print a version');
    assert.ok(
      !/(^|\n)ISSUE263_PWN\s*(\r?\n|$)/.test(String(result.stdout)),
      `the & segment must never execute; stdout=${JSON.stringify(result.stdout)}`,
    );
  },
);
