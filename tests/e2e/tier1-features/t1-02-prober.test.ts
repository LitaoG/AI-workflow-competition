import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertExitCode } from '../helpers/assertions.ts';

test('Tier 1 - Feature 2: Deterministic Environment Probing (prober)', async (t) => {
  await t.test('T1_F2_01: CLI probe --json outputs valid JSON snapshot with required subsystems', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<Record<string, any>>();
    assert.ok(json.snapshotId, 'Probe must contain snapshotId');
    assert.ok(json.timestamp, 'Probe must contain timestamp');
    assert.ok(json.system, 'Probe must contain system metadata');
    assert.ok(json.git, 'Probe must contain git metadata');
    assert.ok(json.toolchain, 'Probe must contain toolchain metadata');
    assert.ok(json.env, 'Probe must contain the sanitized env snapshot');
    assert.ok(!('sanitizedEnv' in json), 'Probe must not carry the redundant sanitizedEnv duplicate (Issue #36)');
  });

  await t.test('T1_F2_02: System probe accurately captures platform, arch, cpu count, and memory', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(['win32', 'linux', 'darwin'].includes(json.system.platform), 'Platform must be valid OS string');
    assert.ok(typeof json.system.arch === 'string', 'Arch must be string');
    assert.ok(typeof json.system.cpus === 'number' && json.system.cpus > 0, 'CPU count must be positive integer');
    assert.ok(typeof json.system.totalMemoryMB === 'number' && json.system.totalMemoryMB > 0, 'Total memory must be positive integer');
  });

  await t.test('T1_F2_03: Toolchain probe detects Node.js version and toolchain availability', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(json.toolchain.nodeVersion.startsWith('v'), 'Node version must start with "v"');
    assert.strictEqual(json.toolchain.tools.node.installed, true, 'Node toolchain must be marked installed');
  });

  await t.test('T1_F2_04: Git probe reports repository state and branch metadata', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(typeof json.git.isGitRepo === 'boolean', 'isGitRepo must be boolean');
    assert.ok(typeof json.git.branch === 'string', 'branch must be string');
    assert.ok(typeof json.git.commitHash === 'string', 'commitHash must be string');
  });

  await t.test('T1_F2_05: Environment sanitizer redacts sensitive API tokens and credentials', () => {
    const res = runCLI(['probe', '--json'], {
      env: {
        MY_SECRET_KEY: 'super-secret-value-12345',
        AUTH_TOKEN: 'token-abc-987'
      }
    });
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.strictEqual(json.env.MY_SECRET_KEY, '***REDACTED***', 'MY_SECRET_KEY must be redacted');
    assert.strictEqual(json.env.AUTH_TOKEN, '***REDACTED***', 'AUTH_TOKEN must be redacted');
  });
});
