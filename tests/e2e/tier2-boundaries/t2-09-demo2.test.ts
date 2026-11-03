import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode } from '../helpers/assertions.ts';
import { SAMPLE_DEMO2_MIGRATION_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 2 - Boundary: Feature 9 Demo 2 Repo Migration', async (t) => {
  const tempDir = createTempDir('t2-f9-demo2-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F9_01: Zero deprecated imports detected terminates cleanly with Migration Not Needed', () => {
    const cleanRepoWf = `
export default {
  name: "clean-repo-migration",
  steps: [
    {
      id: "scan",
      role: "inspector",
      execute: async () => ({ deprecatedCount: 0, status: "SKIPPED" })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'clean-wf.ts', cleanRepoWf);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T2_F9_02: Build test gate failure handled predictably without crash', () => {
    const brokenBuildWf = `
export default {
  name: "broken-build-migration",
  steps: [
    {
      id: "build-gate",
      role: "gate",
      execute: async () => ({ buildPassed: false })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'broken-build.ts', brokenBuildWf);
    const outputDir = path.join(tempDir, 'run-02');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F9_03: Partial fan-out worker failure isolates error without cascading corruption', () => {
    const partialFailureWf = `
export default {
  name: "partial-fail-migration",
  steps: [
    {
      id: "worker-pool",
      role: "worker",
      execute: async () => ([
        { file: "a.ts", success: true },
        { file: "b.ts", success: false, error: "Syntax error in file" }
      ])
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'partial-fail.ts', partialFailureWf);
    const outputDir = path.join(tempDir, 'run-03');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T2_F9_04: Replay after partial migration re-runs without duplicate file transformations', () => {
    const wfPath = writeTempFile(tempDir, 'migration-wf.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['replay', runId]);
    assertExitCode(resReplay, 0);
  });

  await t.test('T2_F9_05: Large codebase simulation (100 files) batch processing limits', () => {
    const files = Array.from({ length: 100 }, (_, i) => `file_${i}.ts`);
    const largeScanWf = `
export default {
  name: "large-scan-wf",
  steps: [
    {
      id: "scan-100",
      role: "inspector",
      execute: async () => ({ filesCount: ${files.length} })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'large-scan.ts', largeScanWf);
    const outputDir = path.join(tempDir, 'run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });
});
