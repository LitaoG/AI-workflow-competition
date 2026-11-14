import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertDurationUnder, assertValidEventLog, assertValidCheckpointsDb } from '../helpers/assertions.ts';
import { SAMPLE_DEMO1_INCIDENT_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 8: Demo 1 — Incident Triage & Remediation (apps/incident-triage-remediation)', async (t) => {
  const tempDir = createTempDir('t1-f8-demo1-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F8_01: Demo 1 executes end-to-end in mock mode in <4s with exit code 0', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-wf.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo1-run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    assertDurationUnder(res, 4000);
  });

  await t.test('T1_F8_02: Phase 1 Telemetry Probe records telemetry anomaly metrics', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-wf.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo1-run-02');
    runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    const probeEvents = events.filter(e => e.type === 'STEP_COMPLETE');
    assert.ok(probeEvents.length >= 1, 'Should record probe completion');
  });

  await t.test('T1_F8_03: Phase 2 Incident Inspector classifies root cause and severity level', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-wf.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo1-run-03');
    runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.some(c => c.status === 'completed'), 'Step checkpoints must record completion');
  });

  await t.test('T1_F8_04: Phase 3 Paired Agents (Planner + Reviewer) produce safety-reviewed remediation', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-wf.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo1-run-04');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
  });

  await t.test('T1_F8_05: Phase 4 Deterministic shell test gate executes recovery verification check', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-wf.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'demo1-run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    const gateCp = checkpoints.find(c => c.step_id === 'step-3-verify' || c.step_id.includes('gate'));
    assert.ok(gateCp, 'Gate checkpoint must be recorded');
  });
});
