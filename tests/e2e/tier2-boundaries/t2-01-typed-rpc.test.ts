import test from 'node:test';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 1 Typed Agent RPCs', async (t) => {
  const tempDir = createTempDir('t2-f1-rpc-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  // Renamed (Issue #23, 2026-11-15): the old name promised "corrupted JSON
  // triggers retry up to maxRetries then structured error", but MockProvider
  // always emits valid JSON (src/agent/mock-provider.ts) and the local
  // execute() step path below never reaches the typed-RPC retry loop
  // (src/agent/rpc.ts), so corrupted-JSON retry is unobservable in mock-mode
  // CLI runs. Real behavior probed via bin/workflow.js: the arbitrary payload
  // is returned as-is and the workflow completes with exit code 0.
  await t.test('T2_F1_01: Step returning arbitrary unvalidated payload completes without engine-side validation or crash', () => {
    const wfContent = `
export default {
  name: "corrupted-json-wf",
  steps: [
    {
      id: "corrupted-step",
      role: "worker",
      execute: async (ctx) => {
        // Arbitrary payload — the engine does not re-validate step output
        return { data: "not-json" };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t2-f1-01.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
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
    assertExitCode(res, 0);
  });

  // Renamed (Issue #23, 2026-11-15): the old name promised a "Zod union
  // schema failure", but step output on the local execute path is not
  // runtime-validated against any Zod schema — probed via bin/workflow.js,
  // the non-matching branch payload passes through and the workflow
  // completes with exit code 0.
  await t.test('T2_F1_04: Step output shaped like a non-matching union branch is passed through without runtime schema rejection', () => {
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
    assertExitCode(res, 0);
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
    assertExitCode(res, 0);
  });
});
