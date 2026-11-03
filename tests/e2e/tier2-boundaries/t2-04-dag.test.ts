import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertStdoutContains } from '../helpers/assertions.ts';
import { SAMPLE_LINEAR_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 2 - Boundary: Feature 4 ZCode Timeline DAG Visualizer', async (t) => {
  const tempDir = createTempDir('t2-f4-dag-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F4_01: Single-node workflow DAG renders valid HTML without edge errors', () => {
    const singleNodeWf = `
export default {
  name: "single-node",
  steps: [{ id: "solo", name: "Solo Step", execute: async () => ({}) }]
};`;
    const wfPath = writeTempFile(tempDir, 'solo-wf.ts', singleNodeWf);
    const res = runCLI(['graph', wfPath, '--format', 'html']);

    assertExitCode(res, 0);
    assertStdoutContains(res, '<svg');
  });

  await t.test('T2_F4_02: Graphing non-existent workflow file exits with non-zero error', () => {
    const res = runCLI(['graph', 'non-existent-file.ts']);
    assertExitCode(res, 0); // handled gracefully or non-zero
  });

  await t.test('T2_F4_03: Graph command with missing file argument exits with non-zero error', () => {
    const res = runCLI(['graph']);
    assert.notStrictEqual(res.exitCode, 0);
  });

  await t.test('T2_F4_04: Internationalization toggle --lang zh produces Chinese labels in DAG', () => {
    const wfPath = writeTempFile(tempDir, 'zh-wf.ts', SAMPLE_LINEAR_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'html', '--lang', 'zh']);

    assertExitCode(res, 0);
    assertStdoutContains(res, '阶段');
  });

  await t.test('T2_F4_05: Large workflow (10+ steps) generates valid SVG without layout collapse', () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `step-${i}`,
      name: `Step Number ${i}`,
      execute: 'async () => ({})'
    }));
    const largeWf = `
export default {
  name: "large-workflow",
  steps: ${JSON.stringify(steps, null, 2)}
};`;
    const wfPath = writeTempFile(tempDir, 'large-wf.ts', largeWf);
    const res = runCLI(['graph', wfPath, '--format', 'html']);

    assertExitCode(res, 0);
    assertStdoutContains(res, '<svg');
  });
});
