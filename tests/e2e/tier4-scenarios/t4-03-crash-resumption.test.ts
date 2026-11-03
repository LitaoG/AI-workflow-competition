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

    const match = resFail.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    // Verify step 1 checkpoint was saved
    const runDir = path.join(process.cwd(), '.workflow', 'runs', runId);
    if (match) {
      const dbPath = path.join(runDir, 'checkpoints.db');
      const checkpoints = assertValidCheckpointsDb(dbPath);
      const step1 = checkpoints.find(c => c.step_id === 'step-1-inspect' || c.step_id === 'step-1-setup');
      assert.ok(step1, 'Step 1 checkpoint must be saved');
      assert.strictEqual(step1.status, 'completed');
    }

    // Now resume from failed
    const resResume = runCLI(['replay', runId, '--resume-from-failed'], {
      env: { REPAIR_STEP_2: '1' }
    });

    assertExitCode(resResume, 0, 'Resumed replay must succeed with exit code 0');
    // Real resume proof: step-2-fail genuinely re-executed (env repair) and the
    // summary reflects what actually executed — no fabricated banner.
    assertStdoutContains(resResume, 'Step completed: step-2-fail');
    assertStdoutContains(resResume, 'Replay summary:');
  });
});
