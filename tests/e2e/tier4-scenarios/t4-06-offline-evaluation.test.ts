import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertDurationUnder, assertStdoutContains } from '../helpers/assertions.ts';
import { SAMPLE_DEMO1_INCIDENT_WORKFLOW, SAMPLE_DEMO2_MIGRATION_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 4 - Scenario 6: Offline Fast Evaluation (<4s execution without API keys)', async (t) => {
  const tempDir = createTempDir('t4-scenario6-offline-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 6: Both demo application workflows complete in <4s without external API keys', () => {
    const demo1Path = writeTempFile(tempDir, 'demo1-offline.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const demo2Path = writeTempFile(tempDir, 'demo2-offline.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);

    // 1. Run Demo 1
    const res1 = runCLI(['run', demo1Path, '--mock'], {
      env: {
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        AWS_ACCESS_KEY_ID: ''
      }
    });
    assertExitCode(res1, 0, 'Demo 1 should succeed with zero API keys');
    assertDurationUnder(res1, 4000);
    assertStdoutContains(res1, '✔');

    // 2. Run Demo 2
    const res2 = runCLI(['run', demo2Path, '--mock'], {
      env: {
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        AWS_ACCESS_KEY_ID: ''
      }
    });
    assertExitCode(res2, 0, 'Demo 2 should succeed with zero API keys');
    assertDurationUnder(res2, 4000);
    assertStdoutContains(res2, '✔');
  });
});
