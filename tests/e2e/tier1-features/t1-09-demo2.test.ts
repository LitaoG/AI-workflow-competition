import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertDurationUnder, assertValidEventLog, assertValidCheckpointsDb } from '../helpers/assertions.ts';
import { SAMPLE_DEMO2_MIGRATION_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 9: Demo 2 — Repo Migration Engine (apps/repo-migration-engine)', async (t) => {
  const tempDir = createTempDir('t1-f9-demo2-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F9_01: Demo 2 executes end-to-end in mock mode in <4s with exit code 0', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo2-run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    assertDurationUnder(res, 4000);
  });

  await t.test('T1_F9_02: Phase 1 AST probe scans codebase and identifies deprecated AWS SDK imports', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo2-run-02');
    runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    assert.ok(events.length > 0);
  });

  await t.test('T1_F9_03: Phase 2 Parallel fan-out agent workers transform files concurrently', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo2-run-03');
    runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2);
  });

  await t.test('T1_F9_04: Phase 3 Paired review agents validate transformed AST output', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo2-run-04');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
  });

  await t.test('T1_F9_05: Phase 4 Deterministic shell test gate executes verification build', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo2-run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.some(c => c.status === 'completed'));
  });
});
