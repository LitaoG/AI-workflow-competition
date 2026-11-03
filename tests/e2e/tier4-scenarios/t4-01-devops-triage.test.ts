import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import {
  assertExitCode,
  assertDurationUnder,
  assertValidEventLog,
  assertValidCheckpointsDb,
  assertValidDAGHtml,
  assertStdoutContains
} from '../helpers/assertions.ts';
import { SAMPLE_DEMO1_INCIDENT_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 4 - Scenario 1: Complete DevOps Incident Triage & Automated Recovery with Shell Gate Validation', async (t) => {
  const tempDir = createTempDir('t4-scenario1-triage-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 1 executes all 5 phases: probe, triage, pair review, shell test gate, post-mortem', () => {
    const wfPath = writeTempFile(tempDir, 'incident-workflow.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'incident-run');

    // Execute workflow end-to-end in offline mock mode
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0, 'Scenario 1 should exit with code 0');
    assertDurationUnder(res, 4000);
    assertStdoutContains(res, '✔');

    // 1. Verify monotonic event stream
    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    assert.strictEqual(events[0].type, 'WORKFLOW_START');
    assert.strictEqual(events[events.length - 1].type, 'WORKFLOW_COMPLETE');

    // 2. Verify durable SQLite step checkpoints
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2, 'Must record multiple step checkpoints');
    for (const cp of checkpoints) {
      assert.strictEqual(cp.status, 'completed');
    }

    // 3. Verify standalone DAG HTML artifact
    const dagPath = path.join(outputDir, 'dag.html');
    assertValidDAGHtml(dagPath);
  });
});
