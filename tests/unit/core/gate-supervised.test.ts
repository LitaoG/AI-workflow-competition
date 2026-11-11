/**
 * Phase 6 (F.md §5.6, Issue #151): the legacy gates run under the supervised
 * spawn standard — shell-less argv parsing, allowlist-only env, whole-tree
 * timeout kill, irreversible output redaction — with the exec-era outcome
 * contract preserved (GateFailureError for gateStep, a false GateResult for
 * ctx.gate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateStep, parseGateCommand, isTransientSpawnFailure } from '../../../src/core/step.js';
import { WorkflowExecutionContext } from '../../../src/core/context.js';
import { GateFailureError } from '../../../src/core/error.js';

test('parseGateCommand: quotes group, escapes and Windows paths survive, shell syntax refused', () => {
  assert.deepEqual(parseGateCommand('node -e "process.exit(0)"'), ['node', '-e', 'process.exit(0)']);
  assert.deepEqual(parseGateCommand(`node -e "console.log('a b')"`), ['node', '-e', `console.log('a b')`]);
  assert.deepEqual(parseGateCommand(String.raw`node "C:\dir with spaces\gate.js" --flag`), ['node', String.raw`C:\dir with spaces\gate.js`, '--flag']);
  assert.deepEqual(parseGateCommand(`node -e "say \\"hi\\""`), ['node', '-e', 'say "hi"']);
  assert.deepEqual(parseGateCommand("echo 'a && b'"), ['echo', 'a && b'], 'metachars inside quotes are literal');

  assert.throws(() => parseGateCommand('a && b'), /shell control syntax/);
  assert.throws(() => parseGateCommand('a | b'), /shell control syntax/);
  assert.throws(() => parseGateCommand('a > b'), /shell control syntax/);
  assert.throws(() => parseGateCommand('echo $(id)'), /command substitution/);
  assert.throws(() => parseGateCommand('node -e "unterminated'), /unterminated double quote/);
  assert.throws(() => parseGateCommand('   '), /empty/);
});

test('gateStep: a passing gate resolves with the captured result; a failing one rejects with the real exit code', async () => {
  const pass = gateStep({ id: 'g-pass', name: 'pass', phaseId: 'p', command: 'node -e "process.stdout.write(\'healthz-ok\')"' });
  const out = await pass.runner!(undefined, {} as never);
  assert.equal(out.success, true);
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, 'healthz-ok');

  const fail = gateStep({ id: 'g-fail', name: 'fail', phaseId: 'p', command: 'node -e "console.error(\'boom\'); process.exit(42)"' });
  await assert.rejects(
    () => fail.runner!(undefined, {} as never),
    (err: unknown) => {
      assert.ok(err instanceof GateFailureError);
      const gateErr = err as GateFailureError & { exitCode?: number; stderr?: string };
      assert.equal(gateErr.exitCode, 42, 'the real exit code rides on the failure');
      assert.match(String(gateErr.stderr), /boom/, 'the stderr reaches the error');
      return true;
    },
  );
});

test('gateStep: output is irreversibly redacted before it reaches callers', async () => {
  // A command that prints a credential-shaped value (AWS AKIA + 16 uppercase —
  // a CREDENTIAL_TOKEN_SHAPES member); the mask must arrive.
  const leak = 'AKIAIOSFODNN7EXAMPLE';
  const step = gateStep({ id: 'g-leak', name: 'leak', phaseId: 'p', command: `node -e "console.log('token ${leak}')"` });
  const out = await step.runner!(undefined, {} as never);
  assert.equal(out.success, true);
  assert.doesNotMatch(out.stdout, /AKIAIOSFODNN7EXAMPLE/, 'the raw credential never survives the boundary');
  assert.match(out.stdout, /\*\*\*REDACTED\*\*\*/);
});

test('gateStep: a hung command is tree-killed at the timeout', async () => {
  const step = gateStep({
    id: 'g-hang',
    name: 'hang',
    phaseId: 'p',
    command: 'node -e "setTimeout(() => {}, 60000)"',
    timeoutMs: 500,
  });
  const started = Date.now();
  await assert.rejects(
    () => step.runner!(undefined, {} as never),
    (err: unknown) => {
      assert.ok(err instanceof GateFailureError);
      assert.match(String((err as Error).message), /timed out/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, 'the kill lands well before the 60s child timer');
});

test('ctx.gate: a failing command is a false GateResult with the real exit code', async () => {
  const ctx = new WorkflowExecutionContext({ workflowId: 'wf-gate-ctx', runId: 'run-gate-ctx' });
  const res = await ctx.gate('node -e "process.exit(7)"');
  assert.equal(res.passed, false);
  assert.equal(res.success, false);
  assert.equal(res.exitCode, 7);
  const ok = await ctx.gate('node -e "console.log(\'fine\')"');
  assert.equal(ok.passed, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'fine\n', 'console.log output arrives with its newline');
});

test('isTransientSpawnFailure: transient never-started spawn shapes retry; persistent ones and real outcomes do not (Issue #233)', () => {
  // win32 job-helper sentinel, EUNKNOWN = every non-ENOENT/EACCES CreateProcessW
  // failure (resource exhaustion under parallel load included) — transient.
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'aiwf-jobhelper: spawn node EUNKNOWN', timedOut: false }), true);
  // legacy direct-spawn transient shapes.
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'spawn EAGAIN: resource temporarily unavailable', timedOut: false }), true);
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'spawn EMFILE: too many open files', timedOut: false }), true);
  // persistent legacy shapes fail fast.
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'spawn ENOENT', timedOut: false }), false);
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'spawn EACCES', timedOut: false }), false);
  // persistent sentinel reasons (usage / job-config / is-in-job check) fail fast.
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'aiwf-jobhelper: spawn node EUSAGE', timedOut: false }), false);
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'aiwf-jobhelper: spawn node job-config-failed', timedOut: false }), false);
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'aiwf-jobhelper: spawn node is-in-job-check-failed', timedOut: false }), false);
  // real outcomes never match: nonzero exit, timeout, successful run.
  assert.equal(isTransientSpawnFailure({ exitCode: 42, stderr: 'boom', timedOut: false }), false);
  assert.equal(isTransientSpawnFailure({ exitCode: -1, stderr: 'aiwf-jobhelper: spawn node EUNKNOWN', timedOut: true }), false);
  assert.equal(isTransientSpawnFailure({ exitCode: 0, stderr: '', timedOut: false }), false);
});
