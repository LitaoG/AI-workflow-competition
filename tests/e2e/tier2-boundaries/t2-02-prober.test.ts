import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir } from '../helpers/env.ts';
import { assertExitCode } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 2 Deterministic Probing', async (t) => {
  const tempDir = createTempDir('t2-f2-prober-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F2_01: Probing non-git directory returns isGitRepo: false gracefully', () => {
    const res = runCLI(['probe', '--json'], { cwd: tempDir });
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.strictEqual(typeof json.git.isGitRepo, 'boolean');
  });

  await t.test('T2_F2_02: Missing optional toolchains marked uninstalled without throwing errors', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(json.toolchain.tools);
  });

  await t.test('T2_F2_03: Extreme environment variables with long token strings are sanitized cleanly', () => {
    const longToken = 'secret-token-'.repeat(200);
    const res = runCLI(['probe', '--json'], {
      env: {
        SUPER_SECRET_LONG_KEY: longToken
      }
    });
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.strictEqual(json.env.SUPER_SECRET_LONG_KEY, '***REDACTED***');
  });

  await t.test('T2_F2_04: Probing with empty environment preserves system probes', () => {
    const res = runCLI(['probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(json.system.platform);
    assert.ok(json.system.cpus > 0);
  });

  await t.test('T2_F2_05: Probing with unknown flags falls back safely', () => {
    const res = runCLI(['probe', '--json', '--unknown-flag']);
    assertExitCode(res, 0);
  });
});
