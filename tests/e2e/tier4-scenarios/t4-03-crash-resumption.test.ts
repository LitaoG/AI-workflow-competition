import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import {
  assertExitCode,
  assertValidCheckpointsDb,
  assertStdoutContains
} from '../helpers/assertions.ts';
import { SAMPLE_FAILING_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 4 - Scenario 3: Simulated Mid-Workflow Crash & Zero-Token Resumption via --resume-from-failed', async (t) => {
  const tempDir = createTempDir('t4-scenario3-resume-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 3: Initial failure commits failure checkpoint, then resume succeeds without re-running step 1', () => {
    const wfPath = writeTempFile(tempDir, 'failing-wf.ts', SAMPLE_FAILING_WORKFLOW);

    // Initial run fails at step 2
    const resFail = runCLI(['run', wfPath, '--mock']);
    assert.strictEqual(resFail.exitCode, 1, 'Initial run should fail with exit code 1');

    // runId extraction is mandatory: without the real run id neither the resume
    // target nor its per-run checkpoint db is known — failing loudly here beats
    // probing a fabricated 'run-test' directory (the old silent fallback).
    const match = resFail.stdout.match(/run-\d+-[a-z0-9]+/i);
    assert.ok(match, 'runId must be extractable from the initial run stdout');
    const runId = match[0];

    // Verify step 1 checkpoint was saved (unconditional: `run` always writes
    // the per-run checkpoints db next to the event log)
    const runDir = path.join(process.cwd(), '.workflow', 'runs', runId);
    const dbPath = path.join(runDir, 'checkpoints.db');
    const checkpoints = assertValidCheckpointsDb(dbPath);
    const step1 = checkpoints.find(c => c.step_id === 'step-1-inspect' || c.step_id === 'step-1-setup');
    assert.ok(step1, 'Step 1 checkpoint must be saved');
    assert.strictEqual(step1.status, 'completed');

    // Now resume from failed
    const resResume = runCLI(['replay', runId, '--resume-from-failed'], {
      env: { REPAIR_STEP_2: '1' }
    });

    assertExitCode(resResume, 0, 'Resumed replay must succeed with exit code 0');
    // Real resume proof: step-2-fail genuinely re-executed (env repair) and the
    // summary reflects what actually executed — no fabricated banner.
    assertStdoutContains(resResume, 'Step completed: step-2-fail');
    assertStdoutContains(resResume, 'Replay summary:');
    // Zero-token proof: the completed step-1-setup must short-circuit from its
    // cached checkpoint (per-step cache-reuse event), and the summary must
    // count exactly 1 short-circuit (step-1) + 2 real executions (repaired
    // step-2 and never-run step-3) + 0 failures — resumption that re-ran
    // step-1 would change the short-circuit count and go red here.
    assertStdoutContains(resResume, 'Reused cached checkpoint for step step-1-setup');
    assertStdoutContains(
      resResume,
      'Replay summary: 2 step(s) executed, 1 step(s) short-circuited, 0 step(s) still failing'
    );
  });
});
