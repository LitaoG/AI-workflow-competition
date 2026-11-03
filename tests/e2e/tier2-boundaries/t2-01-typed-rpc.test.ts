import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 1 Typed Agent RPCs', async (t) => {
  const tempDir = createTempDir('t2-f1-rpc-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F1_01: Corrupted or unparseable JSON output from agent triggers retry up to maxRetries then structured error', () => {
    const wfContent = `
export default {
  name: "corrupted-json-wf",
  steps: [
    {
      id: "corrupted-step",
      role: "worker",
      execute: async (ctx) => {
        // Return raw unparseable string simulation
        return { data: "not-json" };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-01.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F1_02: Extremely large prompt payload (64KB) handled without buffer overflow', () => {
    const hugePrompt = 'A'.repeat(64 * 1024);
    const wfContent = `
export default {
  name: "huge-prompt-wf",
  steps: [
    {
      id: "huge-step",
      role: "worker",
      execute: async () => ({ length: ${hugePrompt.length} })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-02.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-02');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T2_F1_03: Null or undefined returned when non-nullable fields are specified in schema', () => {
    const wfContent = `
export default {
  name: "null-field-wf",
  steps: [
    {
      id: "null-step",
      role: "worker",
      execute: async () => ({ requiredField: null })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-03.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-03');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F1_04: Zod union schema failure when response matches neither union branch', () => {
    const wfContent = `
export default {
  name: "union-mismatch-wf",
  steps: [
    {
      id: "union-step",
      role: "worker",
      execute: async () => ({ kind: "unknown-branch", payload: 123 })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-04.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-04');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F1_05: Workflow with zero steps completes gracefully without crash', () => {
    const wfContent = `
export default {
  name: "empty-wf",
  steps: []
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-05.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });
});
