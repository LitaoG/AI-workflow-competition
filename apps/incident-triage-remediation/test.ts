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

test('Demo 1 Local Integration Runner: Autonomous DevOps Incident Triage', async () => {
  const tmpDir = path.resolve(__dirname, 'artifacts', 'test-run-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'state.db');
  const store = new SQLiteStateStore(dbPath);

  try {
    const startTime = Date.now();
    const { status, context } = await workflow.run({
      runId: 'local-test-01',
      mockMode: true,
      stateStore: store,
    });

    const durationMs = Date.now() - startTime;
    console.log(`[Demo 1 Test] Finished in ${durationMs}ms with status: ${status}`);

    assert.equal(status, 'completed');
    assert.ok(durationMs < 4000, `Execution exceeded 4s: ${durationMs}ms`);

    // Assert step outputs
    const probeOutput: any = context.getOutput('step-1-probe');
    assert.ok(probeOutput, 'Phase 1 probe output must exist');
    assert.equal(probeOutput.serviceName, 'order-checkout-api');

    const triageOutput: any = context.getOutput('step-2-triage');
    assert.ok(triageOutput, 'Phase 2 triage output must exist');
    assert.ok(['P1', 'P2', 'P3'].includes(triageOutput.severity));

    const planOutput: any = context.getOutput('step-3a-planner');
    assert.ok(planOutput, 'Phase 3a plan output must exist');
    assert.ok(planOutput.actions.length > 0);

    const reviewOutput: any = context.getOutput('step-3b-reviewer');
    assert.ok(reviewOutput, 'Phase 3b review output must exist');
    assert.equal(reviewOutput.approved, true);

    const gateOutput: any = context.getOutput('step-4-gate');
    assert.ok(gateOutput, 'Phase 4 gate output must exist');
    assert.equal(gateOutput.executionSuccess, true);

    const postMortemOutput: any = context.getOutput('step-5-post-mortem');
    assert.ok(postMortemOutput, 'Phase 5 post-mortem output must exist');
    assert.ok(postMortemOutput.title.length > 0);

    console.log('[Demo 1 Test] All 5 phases and safety checks verified successfully!');
  } finally {
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
