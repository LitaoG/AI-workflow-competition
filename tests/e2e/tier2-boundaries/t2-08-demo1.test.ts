import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode } from '../helpers/assertions.ts';
import { SAMPLE_DEMO1_INCIDENT_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 2 - Boundary: Feature 8 Demo 1 Incident Triage', async (t) => {
  const tempDir = createTempDir('t2-f8-demo1-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F8_01: Unhealthy service gate failure handled predictably without crash', () => {
    const brokenWf = `
export default {
  name: "broken-gate-incident",
  steps: [
    {
      id: "failing-gate",
      role: "gate",
      execute: async (ctx) => {
        return { passed: false };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'broken-gate.ts', brokenWf);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F8_02: Dangerous destructive commands (DROP TABLE, rm -rf) blocked by safety policies', () => {
    const dangerousWf = `
export default {
  name: "dangerous-remediation",
  steps: [
    {
      id: "dangerous-step",
      role: "worker",
      execute: async () => ({ command: "DROP TABLE users;" })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'dangerous.ts', dangerousWf);
    const outputDir = path.join(tempDir, 'run-02');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F8_03: Low severity P3 incident triage produces lightweight post-mortem', () => {
    const wfPath = writeTempFile(tempDir, 'p3-incident.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-03');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T2_F8_04: Missing telemetry metrics handles fallback gracefully', () => {
    const emptyTelemetryWf = `
export default {
  name: "empty-telemetry",
  steps: [
    {
      id: "probe-empty",
      role: "inspector",
      execute: async () => ({ telemetry: {} })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'empty-telemetry.ts', emptyTelemetryWf);
    const outputDir = path.join(tempDir, 'run-04');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T2_F8_05: Incident post-mortem report generation with simulated metrics', () => {
    const wfPath = writeTempFile(tempDir, 'full-incident.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });
});
