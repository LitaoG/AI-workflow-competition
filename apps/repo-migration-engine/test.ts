#!/usr/bin/env node
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflow } from './workflow.ts';
import { SQLiteStateStore } from 'ai-workflow';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Demo 2 Local Integration Runner: Multi-Agent Repo Migration Engine', async () => {
  const tmpDir = path.resolve(__dirname, 'artifacts', 'test-run-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'state.db');
  const store = new SQLiteStateStore(dbPath);

  try {
    const startTime = Date.now();
    const { status, context } = await workflow.run({
      runId: 'local-demo2-test',
      mockMode: true,
      stateStore: store,
    });

    const durationMs = Date.now() - startTime;
    console.log(`[Demo 2 Test] Finished in ${durationMs}ms with status: ${status}`);

    assert.equal(status, 'completed');
    assert.ok(durationMs < 4000, `Execution exceeded 4s: ${durationMs}ms`);

    // Assert step outputs across all phases
    const baselineOutput: unknown = context.getOutput('step-1-baseline-gate') || context.getOutput('step-1-baseline');
    assert.ok(baselineOutput, 'Phase 1 baseline gate output must exist');

    const scanOutput: any = context.getOutput('step-2a-ast-scan');
    assert.ok(scanOutput, 'Phase 2a AST scan output must exist');
    assert.ok(scanOutput.affectedFiles.length >= 3, 'Scan must find at least 3 affected files');

    const architectOutput: any = context.getOutput('step-2b-architect') || context.getOutput('step-2-architect');
    assert.ok(architectOutput, 'Phase 2b architect plan output must exist');
    assert.ok(architectOutput.topologicalOrder.length >= 3);

    const s3WorkerOutput: any = context.getOutput('step-3a-worker-s3');
    assert.ok(s3WorkerOutput, 'Phase 3 S3 worker output must exist');
    assert.ok(s3WorkerOutput.transformedCode.includes('@aws-sdk/client-s3'));

    const s3ReviewOutput: any = context.getOutput('step-3a-reviewer-s3') || context.getOutput('step-3b-review-s3');
    assert.ok(s3ReviewOutput, 'Phase 3 S3 reviewer output must exist');
    assert.equal(s3ReviewOutput.approved, true);

    const gateOutput: any = context.getOutput('step-4-post-merge-gate');
    assert.ok(gateOutput, 'Phase 4 post-merge gate output must exist');
    assert.equal(gateOutput.passed, true);

    const summaryOutput: any = context.getOutput('step-5-summary') || context.getOutput('step-5-summary-pr');
    assert.ok(summaryOutput, 'Phase 5 summary output must exist');
    assert.ok(summaryOutput.pullRequestMarkdown.includes('AWS SDK v3'));

    console.log('[Demo 2 Test] All 5 phases, fan-out workers, paired reviews, and PR generation verified!');
  } finally {
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
