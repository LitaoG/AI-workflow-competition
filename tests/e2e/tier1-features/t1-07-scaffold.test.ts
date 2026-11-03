import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir } from '../helpers/env.ts';
import { assertExitCode, assertFileExists, assertStdoutContains } from '../helpers/assertions.ts';

test('Tier 1 - Feature 7: Extensible Scaffolding Template (init)', async (t) => {
  const tempDir = createTempDir('t1-f7-scaffold-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F7_01: CLI init basic generates complete starter structure', () => {
    const targetDir = path.join(tempDir, 'basic-app');
    const res = runCLI(['init', 'basic', targetDir]);

    assertExitCode(res, 0);
    assertFileExists(path.join(targetDir, 'workflow.ts'));
    assertFileExists(path.join(targetDir, 'package.json'));
    assertFileExists(path.join(targetDir, 'tsconfig.json'));
    assertFileExists(path.join(targetDir, 'README.md'));
    assertFileExists(path.join(targetDir, '.gitignore'));
  });

  await t.test('T1_F7_02: CLI init multi-agent generates multi-agent workflow skeleton', () => {
    const targetDir = path.join(tempDir, 'multi-agent-app');
    const res = runCLI(['init', 'multi-agent', targetDir]);

    assertExitCode(res, 0);
    assertFileExists(path.join(targetDir, 'workflow.ts'));
    assertStdoutContains(res, 'multi-agent');
  });

  await t.test('T1_F7_03: Scaffolding project executes immediately out-of-the-box in mock mode', () => {
    const targetDir = path.join(tempDir, 'runnable-app');
    runCLI(['init', 'basic', targetDir]);

    const res = runCLI(['run', path.join(targetDir, 'workflow.ts'), '--mock']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '✔');
  });

  await t.test('T1_F7_04: Scaffolding package.json contains valid JSON metadata', () => {
    const targetDir = path.join(tempDir, 'meta-app');
    runCLI(['init', 'basic', targetDir]);

    const pkgPath = path.join(targetDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    assert.strictEqual(pkg.name, 'meta-app');
    assert.strictEqual(pkg.version, '1.0.0');
    assert.strictEqual(pkg.type, 'module');
  });

  await t.test('T1_F7_05: Scaffolding generator handles nested directory creation recursively', () => {
    const nestedDir = path.join(tempDir, 'deeply', 'nested', 'project', 'app');
    const res = runCLI(['init', 'basic', nestedDir]);

    assertExitCode(res, 0);
    assertFileExists(path.join(nestedDir, 'workflow.ts'));
  });
});
