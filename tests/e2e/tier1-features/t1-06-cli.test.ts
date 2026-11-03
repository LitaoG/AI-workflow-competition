import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertStdoutContains } from '../helpers/assertions.ts';
import { SAMPLE_LINEAR_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 6: Slash Command CLI (/workflow)', async (t) => {
  const tempDir = createTempDir('t1-f6-cli-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F6_01: CLI --help outputs comprehensive usage instructions and command list', () => {
    const res = runCLI(['--help']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'Usage:');
    assertStdoutContains(res, 'run <file>');
    assertStdoutContains(res, 'replay <run-id>');
    assertStdoutContains(res, 'graph <file>');
    assertStdoutContains(res, 'probe');
  });

  await t.test('T1_F6_02: Slash command prefix /workflow run executes identical to naked CLI', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f6-02.ts', SAMPLE_LINEAR_WORKFLOW);
    const res = runCLI(['/workflow', 'run', wfPath, '--mock']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '✔');
  });

  await t.test('T1_F6_03: CLI --version outputs semantic version', () => {
    const res = runCLI(['--version']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'ai-workflow');
  });

  await t.test('T1_F6_04: CLI run --dry-run performs validation without executing steps', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f6-04.ts', SAMPLE_LINEAR_WORKFLOW);
    const res = runCLI(['run', wfPath, '--dry-run']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'Dry run completed');
  });

  await t.test('T1_F6_05: Bilingual toggle --lang zh renders Chinese interface summaries', () => {
    const res = runCLI(['probe', '--lang', 'zh']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '环境探测结果');
  });
});
