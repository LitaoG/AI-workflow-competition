import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir } from '../helpers/env.ts';
import { assertExitCode, assertStderrContains } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 7 Scaffolding Template', async (t) => {
  const tempDir = createTempDir('t2-f7-scaffold-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F7_01: Init with unknown template name exits with code 1', () => {
    const res = runCLI(['init', 'unknown-template', path.join(tempDir, 'dummy')]);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'Invalid template');
  });

  await t.test('T2_F7_02: Init into non-empty directory without --force exits with code 1', () => {
    const targetDir = path.join(tempDir, 'existing-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'existing-file.txt'), 'content');

    const res = runCLI(['init', 'basic', targetDir]);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'not empty');
  });

  await t.test('T2_F7_03: Init into non-empty directory with --force overwrites cleanly', () => {
    const targetDir = path.join(tempDir, 'force-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'old.txt'), 'old');

    const res = runCLI(['init', 'basic', targetDir, '--force']);
    assertExitCode(res, 0);
  });

  await t.test('T2_F7_04: Init without specifying template exits with code 1', () => {
    const res = runCLI(['init']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'Invalid template');
  });

  await t.test('T2_F7_05: Init in target path with spaces works cleanly', () => {
    const targetDir = path.join(tempDir, 'path with spaces', 'my app');
    const res = runCLI(['init', 'basic', targetDir]);
    assertExitCode(res, 0);
  });
});
