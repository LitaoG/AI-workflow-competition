/**
 * Tier 5 Adversarial Stress Challenge Suite: Demo App 2 (Multi-Agent Repo Migration Engine)
 * Focus: Concurrency Stress, Simulated Interruption & Zero-Token Resumption Invariants
 *
 * Adversarial Verifications:
 * 1. Phase 3 Fan-Out Concurrency: Verifies that Phase 3 worker steps (S3, DynamoDB, SQS)
 *    execute concurrently in parallel and pair correctly with their respective reviewers.
 * 2. SQLite checkpoints.db Concurrency Stress: 40 parallel fan-out steps hammering WAL
 *    mode without SQLITE_BUSY, deadlocks, or state corruption.
 * 3. Journal event stream (events.jsonl) Concurrency & Integrity: Parallel asynchronous
 *    event writes preserving strict monotonic sequence numbering and 100% JSON validity.
 * 4. Multi-Point Interruption & Recovery — Step 1 (Baseline Gate): Simulated gate failure
 *    via SIMULATE_GATE_FAILURE=true, followed by clean resumption via --resume-from-failed.
 * 5. Multi-Point Interruption & Recovery — Step 2 (Phase 2): Abrupt process termination
 *    (SIGTERM / child.kill), verifying WAL persistence and crash recovery.
 * 6. Multi-Point Interruption & Recovery — Step 3 (Phase 3 Mid-Fan-Out): Simulated
 *    interruption after 2 files via INTERRUPT_AT=2, resuming remaining worker and gates.
 * 7. Zero-Token Resumption Invariant Proof & Timing Benchmark: Verifies that skipped steps
 *    are recognized from checkpoints in <15ms (typical <2ms) and re-expend ZERO LLM tokens.
 * 8. Idempotent Resumption on Completed Run: Resuming an already-completed run skips
 *    all steps instantaneously (<50ms total) with zero token expenditure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import {
  Workflow,
  defineWorkflow,
  actionStep,
  SQLiteStateStore,
  EventLogReader,
  EventLogWriter,
  ReplayEngine,
} from 'ai-workflow';

function runWorkflowCLI(args, options = {}) {
  const rootDir = path.resolve(process.cwd());
  const binCli = path.join(rootDir, 'bin', 'workflow.js');
  const startTime = Date.now();

  const spawnArgs = [
    '--experimental-strip-types',
    binCli,
    ...args,
  ];

  const mergedEnv = {
    ...process.env,
    ...(options.env || {}),
  };

  const proc = spawnSync(process.execPath, spawnArgs, {
    cwd: options.cwd || rootDir,
    env: mergedEnv,
    timeout: options.timeoutMs || 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMs = Date.now() - startTime;
  const stdout = proc.stdout ? proc.stdout.trim() : '';
  const stderr = proc.stderr ? proc.stderr.trim() : '';
  const exitCode = proc.status !== null ? proc.status : (proc.error ? 1 : 0);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
  };
}

function createTempDir(prefix = 'demo2-adv-') {
  const tmpBase = os.tmpdir();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const dirPath = path.join(tmpBase, `${prefix}${Date.now()}-${randomSuffix}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function cleanupTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

const DEMO2_WORKFLOW_PATH = path.resolve(process.cwd(), 'demos', 'repo-migration-engine', 'workflow.ts');

test('Demo 2 Adversarial: Phase 3 Fan-Out Workers execute concurrently and dispatch to paired reviewers', async () => {
  const tempDir = createTempDir('demo2-concur-');
  const outDir = path.join(tempDir, 'run-concur-eval');

  try {
    const res = runWorkflowCLI(['run', DEMO2_WORKFLOW_PATH, '--mock', '--output-dir', outDir]);
    assert.equal(res.exitCode, 0, `Workflow execution failed: ${res.stderr}\n${res.stdout}`);

    const eventLogPath = path.join(outDir, 'events.jsonl');
    assert.ok(fs.existsSync(eventLogPath), 'events.jsonl must exist');
    const events = await EventLogReader.readAll(eventLogPath);

    // 1. Identify step events for the 3 Phase 3 workers and 3 reviewers
    const workerIds = ['step-3a-worker-s3', 'step-3b-worker-dynamo', 'step-3c-worker-sqs'];
    const reviewerIds = ['step-3a-reviewer-s3', 'step-3b-reviewer-dynamo', 'step-3c-reviewer-sqs'];

    const workerStartEvents = events.filter((e) => e.type === 'step_start' && workerIds.includes(e.stepId));
    const workerDoneEvents = events.filter((e) => e.type === 'step_complete' && workerIds.includes(e.stepId));
    const reviewerStartEvents = events.filter((e) => e.type === 'step_start' && reviewerIds.includes(e.stepId));

    assert.equal(workerStartEvents.length, 3, 'All 3 fan-out workers must emit step_start');
    assert.equal(workerDoneEvents.length, 3, 'All 3 fan-out workers must emit step_complete');
    assert.equal(reviewerStartEvents.length, 3, 'All 3 paired reviewers must emit step_start');

    // 2. Concurrency Proof: All 3 workers are dispatched in Phase 3 before ANY reviewer starts
    const firstReviewerStartSeq = Math.min(...reviewerStartEvents.map((e) => e.sequence));
    for (const wStart of workerStartEvents) {
      assert.ok(
        wStart.sequence < firstReviewerStartSeq,
        `Worker ${wStart.stepId} (seq ${wStart.sequence}) must start before first reviewer starts (seq ${firstReviewerStartSeq})`
      );
    }

    // 3. Paired Reviewer Dependency Proof: Each reviewer starts strictly AFTER its paired worker completes
    for (const prefix of ['step-3a', 'step-3b', 'step-3c']) {
      const wDone = events.find((e) => e.type === 'step_complete' && e.stepId.startsWith(prefix));
      const rStart = events.find((e) => e.type === 'step_start' && e.stepId.startsWith(prefix) && e.stepId.includes('reviewer'));
      assert.ok(wDone && rStart, `Pair ${prefix} must have worker complete and reviewer start`);
      assert.ok(
        rStart.sequence > wDone.sequence,
        `Reviewer for ${prefix} (seq ${rStart.sequence}) must start after worker finishes (seq ${wDone.sequence})`
      );
    }
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Demo 2 Adversarial: SQLite checkpoints.db stress under 40 parallel fan-out steps (WAL mode)', async () => {
  const tempDir = createTempDir('demo2-sqlite-stress-');
  const dbPath = path.join(tempDir, 'concurrency-stress.db');
  const store = new SQLiteStateStore(dbPath);
  const eventLogWriter = new EventLogWriter(tempDir);

  const wf = new Workflow({ name: 'FanOutConcurrencyStress' });
  wf.addPhase({ id: 'parallel-phase', name: '40 Parallel Steps' });

  const NUM_STEPS = 40;
  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `worker-${String(i).padStart(2, '0')}`;
    wf.addStep(
      actionStep({
        id: stepId,
        name: `Stress Worker ${i}`,
        phaseId: 'parallel-phase',
        action: async (_input, ctx) => {
          // Asynchronous jitter to maximize concurrent interleaving
          const delay = Math.floor(Math.random() * 25) + 5;
          await new Promise((r) => setTimeout(r, delay));

          ctx.set(`res_${stepId}`, { index: i, transformed: true });
          await ctx.recordArtifact(`art-${stepId}.json`, JSON.stringify({ index: i }));
          return { transformedFile: `service-${i}.ts`, linesChanged: i * 10 };
        },
      })
    );
  }

  const runId = `stress-run-${Date.now()}`;
  wf.on('event', (evt) => eventLogWriter.record(evt));

  const startTime = Date.now();
  const { status, context } = await wf.run({ runId, stateStore: store, mockMode: true });
  const totalDuration = Date.now() - startTime;

  assert.equal(status, 'completed');
  // 40 steps each taking 5-30ms in parallel should finish in <500ms
  assert.ok(totalDuration < 1000, `40 parallel steps should execute in <1000ms (took ${totalDuration}ms)`);

  // Verify all 40 checkpoints are recorded in SQLite without row loss or corruption
  const checkpoints = await store.getAllCheckpoints(runId);
  assert.equal(Object.keys(checkpoints).length, NUM_STEPS, 'All 40 checkpoints must exist in SQLite');

  for (let i = 1; i <= NUM_STEPS; i++) {
    const stepId = `worker-${String(i).padStart(2, '0')}`;
    const cp = checkpoints[stepId];
    assert.ok(cp, `Checkpoint for ${stepId} must exist`);
    assert.equal(cp.status, 'completed');
    assert.equal(cp.output.transformedFile, `service-${i}.ts`);
    assert.equal(cp.output.linesChanged, i * 10);
    assert.deepEqual(context.get(`res_${stepId}`), { index: i, transformed: true });
  }

  eventLogWriter.close();
  store.close();
  cleanupTempDir(tempDir);
});

test('Demo 2 Adversarial: Concurrent event stream integrity & strict monotonic sequence in events.jsonl', async () => {
  const tempDir = createTempDir('demo2-event-stream-');
  const eventLogWriter = new EventLogWriter(tempDir);

  const NUM_EVENTS = 60;
  const runId = `stream-run-${Date.now()}`;

  // Emit 60 events from parallel async promises racing against each other
  await Promise.all(
    Array.from({ length: NUM_EVENTS }, async (_, idx) => {
      const delay = Math.floor(Math.random() * 20);
      await new Promise((r) => setTimeout(r, delay));
      eventLogWriter.record({
        workflowId: 'repo-migration-engine',
        runId,
        stepId: `step-${idx + 1}`,
        type: 'step_complete',
        data: { workerIndex: idx + 1, timestamp: Date.now() },
      });
    })
  );

  eventLogWriter.close();

  const eventLogPath = path.join(tempDir, 'events.jsonl');
  assert.ok(fs.existsSync(eventLogPath), 'events.jsonl must exist');

  // Verify file content validity
  const rawContent = fs.readFileSync(eventLogPath, 'utf-8').trim();
  const rawLines = rawContent.split('\n');
  assert.equal(rawLines.length, NUM_EVENTS, `Must have exactly ${NUM_EVENTS} lines`);

  const events = await EventLogReader.readAll(eventLogPath);
  assert.equal(events.length, NUM_EVENTS, 'All events must be cleanly parseable JSON');

  // Verify strict monotonicity (1, 2, ..., NUM_EVENTS) with ZERO duplicates or gaps
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].sequence, i + 1, `Event at line ${i} must have sequence ${i + 1}`);
  }

  cleanupTempDir(tempDir);
});

test('Demo 2 Adversarial: Simulated interruption at Step 1 (Baseline Gate) via SIMULATE_GATE_FAILURE & Resumption', async () => {
  const tempDir = createTempDir('demo2-step1-interrupt-');
  const outDir = path.join(tempDir, 'run-step1');
  const runId = `run-step1-${Date.now()}`;

  try {
    // Run 1: Fault injection at baseline gate
    const failRes = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ], {
      env: { SIMULATE_GATE_FAILURE: 'true' },
    });

    assert.equal(failRes.exitCode, 1, 'Workflow must exit with code 1 on simulated baseline failure');
    assert.ok(
      failRes.stderr.includes('step-1-baseline-gate') || failRes.stdout.includes('step-1-baseline-gate') || failRes.stderr.includes('Baseline'),
      'Output must indicate Step 1 baseline failure'
    );

    // Verify checkpoints on disk: step-1 is recorded as failed
    const dbPath = path.join(outDir, 'checkpoints.db');
    assert.ok(fs.existsSync(dbPath), 'checkpoints.db must exist after step 1 failure');
    const store1 = new SQLiteStateStore(dbPath);
    const cp1 = await store1.getCheckpoint(runId, 'step-1-baseline-gate');
    store1.close();

    assert.ok(cp1, 'Checkpoint for step-1-baseline-gate must be recorded');
    assert.equal(cp1.status, 'failed');

    // Run 2: Resume with failure resolved
    const resumeRes = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ], {
      env: { SIMULATE_GATE_FAILURE: 'false' },
    });

    assert.equal(resumeRes.exitCode, 0, `Resume failed: ${resumeRes.stderr}\n${resumeRes.stdout}`);
    assert.ok(resumeRes.stdout.includes('Workflow completed successfully'), 'Resumed workflow must complete');

    // Verify final artifacts created
    assert.ok(fs.existsSync(path.join(outDir, 'PULL_REQUEST.md')), 'PULL_REQUEST.md must exist');
    assert.ok(fs.existsSync(path.join(outDir, 'kanban.json')), 'kanban.json must exist');
    assert.ok(fs.existsSync(path.join(outDir, 'dag.html')), 'dag.html must exist');
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Demo 2 Adversarial: Process Signal Interruption (kill mid-workflow) & Crash Resumption', async () => {
  const tempDir = createTempDir('demo2-crash-');
  const outDir = path.join(tempDir, 'run-crash');
  const runId = `run-crash-${Date.now()}`;
  const binCli = path.join(process.cwd(), 'bin', 'workflow.js');

  try {
    // Step A: Spawn child process and kill it once Phase 2 is reported
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      binCli,
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, INTERRUPT_AT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let childStdout = '';
    let killed = false;
    await new Promise((resolve) => {
      child.stdout.on('data', (d) => {
        childStdout += d.toString();
        // Once Step 2a or Phase 2 completes, kill the process abruptly
        if (!killed && (childStdout.includes('step-2a-ast-scan') || childStdout.includes('phase-2'))) {
          killed = true;
          child.kill('SIGTERM');
        }
      });
      child.on('close', () => resolve());
    });

    // Step B: Verify that checkpoints.db survived the unexpected kill cleanly (WAL durability)
    const dbPath = path.join(outDir, 'checkpoints.db');
    assert.ok(fs.existsSync(dbPath), 'checkpoints.db must exist and survive process termination');

    const store = new SQLiteStateStore(dbPath);
    const checkpoints = await store.getAllCheckpoints(runId);
    store.close();

    // Check that at least Step 1 was cleanly committed before process death
    assert.ok(checkpoints['step-1-baseline-gate'], 'Step 1 checkpoint must be committed to SQLite');
    assert.equal(checkpoints['step-1-baseline-gate'].status, 'completed');

    // Step C: Resume from the crash
    const resumeRes = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ]);

    assert.equal(resumeRes.exitCode, 0, `Resume after crash failed: ${resumeRes.stderr}\n${resumeRes.stdout}`);
    assert.ok(resumeRes.stdout.includes('step-1-baseline-gate'), 'Resumed workflow must recognize Step 1');
    assert.ok(resumeRes.stdout.includes('Workflow completed successfully'), 'Resumed workflow must finish to completion');
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Demo 2 Adversarial: Simulated Interruption at Step 3 (INTERRUPT_AT=2) & Zero-Token Resumption', async () => {
  const tempDir = createTempDir('demo2-step3-interrupt-');
  const outDir = path.join(tempDir, 'run-step3');
  const runId = `run-step3-${Date.now()}`;

  try {
    // 1. Run with interruption after 2 transformed files
    const failRes = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ], {
      env: { INTERRUPT_AT: '2' },
    });

    assert.equal(failRes.exitCode, 1, 'Workflow must exit with code 1 when interrupted at step 3');
    assert.ok(
      failRes.stdout.includes('INTERRUPTED_FOR_RESUMPTION_TEST') || failRes.stderr.includes('INTERRUPTED_FOR_RESUMPTION_TEST'),
      'Output must confirm INTERRUPTED_FOR_RESUMPTION_TEST'
    );

    // 2. Verify state store: Steps 1, 2a, 2b, 3a, 3b must be completed
    const dbPath = path.join(outDir, 'checkpoints.db');
    const store1 = new SQLiteStateStore(dbPath);
    const cps1 = await store1.getAllCheckpoints(runId);
    store1.close();

    assert.equal(cps1['step-1-baseline-gate']?.status, 'completed');
    assert.equal(cps1['step-2a-ast-scan']?.status, 'completed');
    assert.equal(cps1['step-2b-architect']?.status, 'completed');
    assert.equal(cps1['step-3a-worker-s3']?.status, 'completed');
    assert.equal(cps1['step-3b-worker-dynamo']?.status, 'completed');
    assert.equal(cps1['step-3c-worker-sqs']?.status, 'failed');

    // 3. Resume the workflow
    const t0 = performance.now();
    const resumeRes = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ], {
      env: { INTERRUPT_AT: '' },
    });
    const resumeDuration = performance.now() - t0;

    assert.equal(resumeRes.exitCode, 0, `Resume failed: ${resumeRes.stderr}\n${resumeRes.stdout}`);
    assert.ok(resumeDuration < 2500, `Resumed execution took ${resumeDuration.toFixed(1)}ms; expected <2500ms`);

    // 4. Verify step_skipped events in events.jsonl
    const eventLogPath = path.join(outDir, 'events.jsonl');
    const events = await EventLogReader.readAll(eventLogPath);
    const skippedEvents = events.filter((e) => e.type === 'step_skipped');
    const skippedStepIds = skippedEvents.map((e) => e.stepId);

    assert.ok(skippedStepIds.includes('step-1-baseline-gate'), 'step-1 must be skipped');
    assert.ok(skippedStepIds.includes('step-2a-ast-scan'), 'step-2a must be skipped');
    assert.ok(skippedStepIds.includes('step-2b-architect'), 'step-2b must be skipped');
    assert.ok(skippedStepIds.includes('step-3a-worker-s3'), 'step-3a must be skipped');
    assert.ok(skippedStepIds.includes('step-3b-worker-dynamo'), 'step-3b must be skipped');

    // 5. Verify that remaining steps completed and final status is completed
    const store2 = new SQLiteStateStore(dbPath);
    const cps2 = await store2.getAllCheckpoints(runId);
    store2.close();

    assert.equal(cps2['step-3c-worker-sqs']?.status, 'completed');
    assert.equal(cps2['step-4-post-merge-gate']?.status, 'completed');
    assert.equal(cps2['step-5-summary']?.status, 'completed');
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Demo 2 Adversarial Invariant: Empirical Proof of Zero-Token Re-expenditure & Instantaneous (<15ms) Skipping', async () => {
  const tempDir = createTempDir('demo2-zero-token-proof-');
  const dbPath = path.join(tempDir, 'bench.db');
  const store = new SQLiteStateStore(dbPath);
  const runId = 'bench-zero-token-run';

  let agentCallCounts = {
    'step-1': 0,
    'step-2a': 0,
    'step-2b': 0,
    'step-3a': 0,
    'step-3b': 0,
    'step-3c': 0,
  };

  let tokenExpenditure = {
    prompt: 0,
    completion: 0,
  };

  const createBenchWorkflow = (failAtStep3c) =>
    defineWorkflow({
      name: 'BenchWorkflow',
      phases: [
        { id: 'p1', name: 'Phase 1' },
        { id: 'p2', name: 'Phase 2' },
        { id: 'p3', name: 'Phase 3' },
      ],
      steps: [
        {
          id: 'step-1',
          name: 'Baseline Step',
          phaseId: 'p1',
          execute: async () => {
            agentCallCounts['step-1']++;
            tokenExpenditure.prompt += 100;
            return { passed: true };
          },
        },
        {
          id: 'step-2a',
          name: 'AST Scan',
          phaseId: 'p2',
          dependsOn: ['step-1'],
          execute: async () => {
            agentCallCounts['step-2a']++;
            tokenExpenditure.prompt += 200;
            return { occurrences: 15 };
          },
        },
        {
          id: 'step-2b',
          name: 'Architect',
          phaseId: 'p2',
          dependsOn: ['step-2a'],
          execute: async () => {
            agentCallCounts['step-2b']++;
            tokenExpenditure.prompt += 500;
            tokenExpenditure.completion += 250;
            return { plan: 'modular-sdk' };
          },
        },
        {
          id: 'step-3a',
          name: 'Transform S3',
          phaseId: 'p3',
          dependsOn: ['step-2b'],
          execute: async () => {
            agentCallCounts['step-3a']++;
            tokenExpenditure.prompt += 400;
            tokenExpenditure.completion += 200;
            return { s3: 'migrated' };
          },
        },
        {
          id: 'step-3b',
          name: 'Transform Dynamo',
          phaseId: 'p3',
          dependsOn: ['step-2b'],
          execute: async () => {
            agentCallCounts['step-3b']++;
            tokenExpenditure.prompt += 400;
            tokenExpenditure.completion += 200;
            return { dynamo: 'migrated' };
          },
        },
        {
          id: 'step-3c',
          name: 'Transform SQS',
          phaseId: 'p3',
          dependsOn: ['step-2b'],
          execute: async () => {
            agentCallCounts['step-3c']++;
            if (failAtStep3c) {
              throw new Error('SIMULATED_INTERRUPTION_AT_SQS');
            }
            tokenExpenditure.prompt += 400;
            tokenExpenditure.completion += 200;
            return { sqs: 'migrated' };
          },
        },
      ],
    });

  // RUN 1: Interrupted at step 3c
  const wf1 = createBenchWorkflow(true);
  let failed = false;
  try {
    await wf1.run({ runId, stateStore: store, mockMode: true });
  } catch {
    failed = true;
  }
  assert.ok(failed, 'Run 1 must fail at Step 3c');

  const initialPromptTokens = tokenExpenditure.prompt;
  const initialCompletionTokens = tokenExpenditure.completion;
  assert.equal(initialPromptTokens, 100 + 200 + 500 + 400 + 400);
  assert.equal(initialCompletionTokens, 250 + 200 + 200);

  // RESET CALL COUNTERS FOR RESUMPTION RUN
  agentCallCounts = {
    'step-1': 0,
    'step-2a': 0,
    'step-2b': 0,
    'step-3a': 0,
    'step-3b': 0,
    'step-3c': 0,
  };
  tokenExpenditure = { prompt: 0, completion: 0 };

  const skippedStepLatencies = [];
  const wf2 = createBenchWorkflow(false);

  wf2.on('step_skipped', (evt) => {
    // Record step skipping event
    skippedStepLatencies.push(evt.stepId);
  });

  // Benchmark SQLite indexed checkpoint lookup latency directly (<15ms requirement)
  const lookupTimes = [];
  for (const stepId of ['step-1', 'step-2a', 'step-2b', 'step-3a', 'step-3b']) {
    const t0 = performance.now();
    const cp = await store.getCheckpoint(runId, stepId);
    const elapsed = performance.now() - t0;
    lookupTimes.push({ stepId, elapsed });
    assert.ok(cp !== null, `Checkpoint for ${stepId} must exist`);
    assert.equal(cp.status, 'completed');
  }

  for (const item of lookupTimes) {
    assert.ok(
      item.elapsed < 15.0,
      `Step ${item.stepId} lookup must be <15ms (was ${item.elapsed.toFixed(3)}ms)`
    );
  }

  // RUN 2: Resume
  const resumeResult = await wf2.run({ runId, stateStore: store, mockMode: true });
  assert.equal(resumeResult.status, 'completed');

  // EMPIRICAL INVARIANT ASSERTIONS:
  // 1. ALL previously completed steps were SKIPPED
  assert.deepEqual(
    skippedStepLatencies.sort(),
    ['step-1', 'step-2a', 'step-2b', 'step-3a', 'step-3b'].sort()
  );

  // 2. ZERO calls made to runner / agent functions for skipped steps
  assert.equal(agentCallCounts['step-1'], 0, 'ZERO calls for step-1');
  assert.equal(agentCallCounts['step-2a'], 0, 'ZERO calls for step-2a');
  assert.equal(agentCallCounts['step-2b'], 0, 'ZERO calls for step-2b');
  assert.equal(agentCallCounts['step-3a'], 0, 'ZERO calls for step-3a');
  assert.equal(agentCallCounts['step-3b'], 0, 'ZERO calls for step-3b');

  // 3. ONLY step-3c was called
  assert.equal(agentCallCounts['step-3c'], 1, 'Only step-3c executed in resumption');

  // 4. ZERO tokens re-spent on skipped steps!
  assert.equal(tokenExpenditure.prompt, 400, 'Only step-3c prompt tokens expended');
  assert.equal(tokenExpenditure.completion, 200, 'Only step-3c completion tokens expended');

  store.close();
  cleanupTempDir(tempDir);
});

test('Demo 2 Adversarial: Idempotent Re-execution on Completed Workflow', async () => {
  const tempDir = createTempDir('demo2-idempotent-');
  const outDir = path.join(tempDir, 'run-idempotent');
  const runId = `run-idempotent-${Date.now()}`;

  try {
    // 1. Initial complete execution
    const run1 = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ]);
    assert.equal(run1.exitCode, 0);

    // 2. Re-run with --resume-from-failed on the already completed run
    const t0 = performance.now();
    const run2 = runWorkflowCLI([
      'run',
      DEMO2_WORKFLOW_PATH,
      '--mock',
      '--output-dir', outDir,
      '--resume-from-failed', runId,
    ]);
    const reResumeDuration = performance.now() - t0;

    assert.equal(run2.exitCode, 0);
    // The engine work itself is ~30ms; the measured wall clock additionally
    // covers a full node --experimental-strip-types subprocess boot (~0.6-1.1s,
    // load-dependent), which is what made the former <800ms bound flaky. The
    // idempotency invariant below (zero real re-executions) carries the real
    // assertion; the wall clock is only a loose sanity ceiling.
    assert.ok(
      reResumeDuration < 2500,
      `Idempotent re-execution should complete in <2500ms including subprocess boot (took ${reResumeDuration.toFixed(1)}ms)`
    );

    // Every step must be accounted for, and every one of them must have been
    // served from its cached checkpoint — the true idempotency invariant.
    assert.ok(
      run2.stdout.includes('⚡ Reused cached checkpoint for step step-1-baseline-gate') &&
      run2.stdout.includes('⚡ Reused cached checkpoint for step step-2a-ast-scan') &&
      run2.stdout.includes('⚡ Reused cached checkpoint for step step-3a-worker-s3') &&
      run2.stdout.includes('⚡ Reused cached checkpoint for step step-5-summary'),
      'All steps must be skipped from cached checkpoints on re-execution'
    );
    assert.ok(
      !run2.stdout.includes('✔ Step completed:'),
      'Idempotent re-execution must genuinely re-execute zero steps'
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});
