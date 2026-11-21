import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineWorkflow } from '../../src/core/workflow.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { EventLogWriter, EventLogReader } from '../../src/state/event-log.js';
import { DAGVisualizerCoordinator } from '../../src/dag/visualizer.js';
import { z } from 'zod';

test('Workflow Integration: end-to-end execution with SQLite checkpoints, event log, and DAG export', async (t) => {
  // Run outputs live in the OS temp dir (P-TEST-2, Issue #86): writing into the
  // tracked tests/integration/fixtures/ path leaked run-* residue that gitignore
  // swallowed, invisible to git status and every cleanliness gate.
  const tmpDir = path.join(os.tmpdir(), 'wf-integration-run-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = path.join(tmpDir, 'state.db');
  const store = new SQLiteStateStore(dbPath);
  const eventWriter = new EventLogWriter(tmpDir);

  const wf = defineWorkflow({
    name: 'FullIntegrationWorkflow',
    description: 'Verifies state persistence, event log, and DAG visualizer end-to-end',
    phases: ['Probe Phase', 'Compute Phase', 'Gate Phase'],
    steps: [
      {
        id: 'probe-step',
        name: 'Probe Step',
        phase: 'Probe Phase',
        role: 'inspector',
        async execute(ctx) {
          const probeRes = await ctx.probe();
          assert.ok(probeRes.system);
          return { os: probeRes.system.platform };
        },
      },
      {
        id: 'compute-step',
        name: 'Compute Step',
        phase: 'Compute Phase',
        role: 'worker',
        dependencies: ['probe-step'],
        async execute(ctx) {
          const prev: any = ctx.getOutput('probe-step');
          const schema = z.object({ answer: z.number() });
          const agentRes = await ctx.agent('worker').ask('calculate', schema, {
            mockResponse: { answer: 42 },
          });
          return { calculated: agentRes.answer, os: prev.os };
        },
      },
      {
        id: 'gate-step',
        name: 'Gate Step',
        phase: 'Gate Phase',
        role: 'gate',
        dependencies: ['compute-step'],
        async execute(ctx) {
          const res = await ctx.gate('node -e "process.exit(0)"');
          assert.equal(res.passed, true);
          return { gatePassed: true };
        },
      },
    ],
  });

  const runId = 'integration-run-001';
  wf.on('event', (evt) => {
    eventWriter.record(evt);
  });

  const { status, context } = await wf.run({
    runId,
    stateStore: store,
    mockMode: true,
  });

  assert.equal(status, 'completed');
  assert.deepEqual(context.getOutput('compute-step'), {
    calculated: 42,
    os: process.platform,
  });

  // Verify checkpoints persisted to SQLite
  const checkpoints = await store.getAllCheckpoints(runId);
  assert.equal(Object.keys(checkpoints).length, 3);
  assert.equal(checkpoints['probe-step']?.status, 'completed');
  assert.equal(checkpoints['compute-step']?.status, 'completed');
  assert.equal(checkpoints['gate-step']?.status, 'completed');

  // Verify event log written and readable
  eventWriter.close();
  const eventLogPath = path.join(tmpDir, 'events.jsonl');
  assert.ok(fs.existsSync(eventLogPath));
  const events = await EventLogReader.readAll(eventLogPath);
  assert.ok(events.length >= 3);

  // Verify DAG export
  const visualizer = new DAGVisualizerCoordinator();
  const graph = wf.exportGraph(runId);
  const html = visualizer.renderHTML(graph);
  assert.ok(html.includes('FullIntegrationWorkflow'));
  assert.ok(html.includes('probe-step'));

  store.close();
});

test('EventLogWriter: handles corrupted trailing fragments without newline cleanly', async () => {
  // Same hygiene rule as above (Issue #86): OS temp dir instead of the repo.
  const tmpDir = path.join(os.tmpdir(), 'wf-integration-crash-recovery-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const logFile = path.join(tmpDir, 'events.jsonl');

  // Simulate abrupt process crash mid-write
  fs.writeFileSync(logFile, '{"id":"evt-1","sequence":1}\n{"id":"evt-broken","state":', 'utf-8');

  // Initialize new writer on crashed directory
  const writer = new EventLogWriter(tmpDir);
  writer.record({
    workflowId: 'test-wf',
    runId: 'run-resume',
    stepId: 'step-recover',
    type: 'step_complete',
    data: { recovered: true },
  });
  writer.close();

  // Verify reader recovers valid events without losing the new event
  const events = await EventLogReader.readAll(logFile);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, 'evt-1');
  assert.equal(events[1]?.stepId, 'step-recover');
  assert.equal(events[1]?.sequence, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

