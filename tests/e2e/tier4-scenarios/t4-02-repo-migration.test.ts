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
import { SAMPLE_DEMO2_MIGRATION_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 4 - Scenario 2: Multi-Agent AWS SDK v2 to v3 Codebase Migration with AST Probing & MCP Tools', async (t) => {
  const tempDir = createTempDir('t4-scenario2-migration-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 2 executes AST scan, parallel fan-out transform, reviewer pair, and build gate', () => {
    const wfPath = writeTempFile(tempDir, 'migration-workflow.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const outputDir = path.join(tempDir, 'migration-run');

    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
    assertDurationUnder(res, 4000);
    assertStdoutContains(res, '✔');

    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    assert.ok(events.length >= 4);

    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2);

    const dagPath = path.join(outputDir, 'dag.html');
    assertValidDAGHtml(dagPath);
  });
});
