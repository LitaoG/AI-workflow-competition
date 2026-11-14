/**
 * Issue #259 regression suite: the Windows `.cmd`/`.bat` route must pass
 * arguments through cmd.exe as LITERALS. The pre-fix shape built
 * `cmd /d /s /c npm <raw args>`, so an `&` in any data-driven argument
 * (branch name, PR title, user-filled hole, agent output) executed a second
 * command — `spawnSupervised('npm', ['--version', '&', 'echo', 'INJECTED_MARKER'])`
 * printed the marker on stdout. The fix quotes every argument at the cmd
 * parse level (quoteForCmd) and delivers the line verbatim through the job
 * helper's `--raw` mode (CRT re-quoting would re-break cmd quoting).
 *
 * Real-spawn cases are win32-only (the route does not exist on POSIX); the
 * pure shaping cases are cross-platform.
 *
 * Each spawn carries a timeoutMs so a wedged tree fails fast instead of
 * hanging the suite (P-TEST-3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCmdRouteInvocation, quoteForCmd, spawnSupervised } from '../../src/process-supervision.js';

test('quoteForCmd wraps every argument in cmd-level quotes and doubles embedded quotes', () => {
  assert.equal(quoteForCmd('&'), '"&"');
  assert.equal(quoteForCmd('a&b|c'), '"a&b|c"');
  assert.equal(quoteForCmd('--version'), '"--version"');
  assert.equal(quoteForCmd('say "hi" & del *'), '"say ""hi"" & del *"');
  assert.equal(quoteForCmd(''), '""');
  // trailing backslash must be doubled for the MSVCRT of the final target
  assert.equal(quoteForCmd('C:\\foo\\'), '"C:\\foo\\\\"');
});

test('buildCmdRouteInvocation shapes the /d /s /c invocation with an outer quote pair', () => {
  const r = buildCmdRouteInvocation('npm', ['--version', '&', 'echo', 'INJECTED_MARKER'], 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(
    r.spawnArgs,
    ['/d', '/s', '/c', '"npm "--version" "&" "echo" "INJECTED_MARKER""'],
  );
  assert.equal(
    r.rawChildLine,
    'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm "--version" "&" "echo" "INJECTED_MARKER""',
  );
  // empty args: the lone outer pair is stripped by the /s rule, leaving bare npm
  const empty = buildCmdRouteInvocation('npm', [], 'cmd.exe');
  assert.equal(empty.rawChildLine, 'cmd.exe /d /s /c "npm"');
});

test('(u-1) cmd route executes the shim itself: npm --version still round-trips', { skip: process.platform !== 'win32' ? 'cmd route is win32-only' : false, timeout: 90_000 }, async () => {
  const sup = spawnSupervised('npm', ['--version'], { cwd: process.cwd(), timeoutMs: 60_000 });
  const res = await sup.result;
  assert.equal(res.timedOut, false, `spawn timed out; stderr: ${JSON.stringify(res.stderr)}`);
  assert.equal(res.exitCode, 0, `exitCode: ${res.exitCode}, stderr: ${JSON.stringify(res.stderr)}`);
  assert.match(res.stdout, /\d+\.\d+\.\d+/, `stdout must carry npm's semver: ${JSON.stringify(res.stdout)}`);
});

test('(u-2) args containing & are literals — the second command must NOT execute', { skip: process.platform !== 'win32' ? 'cmd route is win32-only' : false, timeout: 90_000 }, async () => {
  const sup = spawnSupervised('npm', ['--version', '&', 'echo', 'INJECTED_MARKER'], { cwd: process.cwd(), timeoutMs: 60_000 });
  const res = await sup.result;
  assert.equal(res.timedOut, false, `spawn timed out; stderr: ${JSON.stringify(res.stderr)}`);
  // The shim itself must have run (npm's semver on stdout) — otherwise the
  // "no marker" assertion would pass trivially on a dead spawn.
  assert.match(res.stdout, /\d+\.\d+\.\d+/, `npm must still run; stdout: ${JSON.stringify(res.stdout)}, stderr: ${JSON.stringify(res.stderr)}`);
  assert.ok(!res.stdout.includes('INJECTED_MARKER'), `second command executed! stdout: ${JSON.stringify(res.stdout)}`);
  assert.ok(!res.stderr.includes('INJECTED_MARKER'), `second command executed (stderr): ${JSON.stringify(res.stderr)}`);
});

test('(u-3) args with spaces, quotes and metacharacters do not break the route', { skip: process.platform !== 'win32' ? 'cmd route is win32-only' : false, timeout: 90_000 }, async () => {
  // npx is a second .cmd shim; its --version output proves the whole
  // cmd → shim → node round-trip survived a payload full of cmd specials
  // (over-escaping regression guard — the payload must not wedge or kill the route).
  const sup = spawnSupervised('npx', ['--version', 'a & b | c > d', 'say "hi"'], { cwd: process.cwd(), timeoutMs: 60_000 });
  const res = await sup.result;
  assert.equal(res.timedOut, false, `spawn timed out; stderr: ${JSON.stringify(res.stderr)}`);
  assert.match(res.stdout, /\d+\.\d+\.\d+/, `npx must still run; stdout: ${JSON.stringify(res.stdout)}, stderr: ${JSON.stringify(res.stderr)}`);
});
