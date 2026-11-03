import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertValidEventLog, assertValidCheckpointsDb, assertStdoutContains } from '../helpers/assertions.ts';
import { SAMPLE_LINEAR_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 3: Durable State & Replay (state)', async (t) => {
  const tempDir = createTempDir('t1-f3-state-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F3_01: Workflow execution generates append-only monotonic events.jsonl', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f3-01.ts', SAMPLE_LINEAR_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    assert.strictEqual(events[0].type, 'WORKFLOW_START');
    assert.strictEqual(events[events.length - 1].type, 'WORKFLOW_COMPLETE');
  });

  await t.test('T1_F3_02: Step checkpoints are saved into SQLite checkpoints.db', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f3-02.ts', SAMPLE_LINEAR_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-02');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2, 'Should persist checkpoints for both steps');
    for (const cp of checkpoints) {
      assert.strictEqual(cp.status, 'completed');
      assert.ok(typeof cp.duration_ms === 'number');
    }
  });

  await t.test('T1_F3_03: CLI list command displays workflow run history', () => {
    const res = runCLI(['list']);
    assertExitCode(res, 0);
    assert.ok(res.stdout.length > 0, 'list stdout must not be empty');
  });

  await t.test('T1_F3_04: CLI inspect command outputs checkpoints for an existing run', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f3-04.ts', SAMPLE_LINEAR_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    assertExitCode(resRun, 0);

    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resInspect = runCLI(['inspect', runId]);
    assertExitCode(resInspect, 0);
    assertStdoutContains(resInspect, runId);
  });

  await t.test('T1_F3_05: CLI replay command replays past workflow execution using cached checkpoints', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f3-05.ts', SAMPLE_LINEAR_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    assertExitCode(resRun, 0);

    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['replay', runId]);
    assertExitCode(resReplay, 0);
    // Real replay contract: completed steps are reported as checkpoint hits and
    // the summary reflects what actually executed — no fabricated banner.
    assertStdoutContains(resReplay, 'Reused cached checkpoint');
    assertStdoutContains(resReplay, 'Replay summary:');
  });
});
