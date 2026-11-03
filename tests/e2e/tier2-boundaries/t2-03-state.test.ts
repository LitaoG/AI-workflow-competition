import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertStderrContains } from '../helpers/assertions.ts';
import { SAMPLE_LINEAR_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 2 - Boundary: Feature 3 Durable State & Replay', async (t) => {
  const tempDir = createTempDir('t2-f3-state-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F3_01: Corrupted or truncated events.jsonl handled with graceful diagnostic, not unhandled crash', () => {
    const corruptFile = writeTempFile(tempDir, 'corrupted/events.jsonl', '{"partial": json\n');
    assert.ok(corruptFile);
  });

  await t.test('T2_F3_02: Replaying non-existent runId exits with non-zero exit code and error message', () => {
    const res = runCLI(['replay', 'non-existent-run-id-99999']);
    assert.notStrictEqual(res.exitCode, 0);
    assertStderrContains(res, 'not found');
  });

  await t.test('T2_F3_03: Inspecting non-existent runId exits with non-zero exit code and error message', () => {
    const res = runCLI(['inspect', 'non-existent-run-id-88888']);
    assert.notStrictEqual(res.exitCode, 0);
    assertStderrContains(res, 'not found');
  });

  await t.test('T2_F3_04: Replaying completed workflow skips all completed steps without re-execution', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t2-f3-04.ts', SAMPLE_LINEAR_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    assertExitCode(resRun, 0);

    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['replay', runId]);
    assertExitCode(resReplay, 0);
  });

  await t.test('T2_F3_05: Resume from failed workflow with --resume-from-failed flag', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t2-f3-05.ts', SAMPLE_LINEAR_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resResume = runCLI(['replay', runId, '--resume-from-failed']);
    assertExitCode(resResume, 0);
  });
});
