import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFacadeScript } from '../../src/dwf/runner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCENARIO_SOURCE = path.join(
  REPO_ROOT,
  'demos',
  'incident-triage-remediation',
  'scenarios',
  'p1_db_pool_exhaustion.json',
);
const SCRIPT_SOURCE = path.join(REPO_ROOT, 'demos', 'incident-triage-remediation', 'facade.workflow.ts');

interface DemoWorkspace {
  dir: string;
  scriptPath: string;
  cleanup: () => void;
}

/** Workspace layout the demo script expects: scenarios/ at the workspace root. */
function makeDemoWorkspace(): DemoWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-demo-incident-'));
  fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
  fs.copyFileSync(SCENARIO_SOURCE, path.join(dir, 'scenarios', 'p1_db_pool_exhaustion.json'));
  return {
    dir,
    scriptPath: SCRIPT_SOURCE,
    cleanup: () => {
      // Windows: a just-killed sandbox child can hold the dir lock briefly.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
    },
  };
}

const ARGS = JSON.stringify({ scenario: 'p1_db_pool_exhaustion' });

test('incident demo facade script: 5 phases, typed asks, gates and artifact export', async () => {
  const ws = makeDemoWorkspace();
  try {
    const first = await runFacadeScript({ scriptPath: ws.scriptPath, cwd: ws.dir, args: { scenario: 'p1_db_pool_exhaustion' } });
    assert.equal(first.status, 'completed', `demo run failed: ${first.error ?? JSON.stringify(first.diagnostics)}`);

    const value = first.value as {
      tripped: boolean;
      incidentId: string;
      severity: string;
      rootCause: string;
      safetyRisk: string;
      gates: string;
      record: string;
    };
    assert.equal(value.tripped, true);
    assert.ok(value.incidentId.startsWith('INC-'), `unexpected incident id: ${value.incidentId}`);
    assert.equal(value.severity, 'P1');
    assert.ok(value.rootCause.length > 20, 'expected a real root-cause sentence from the typed ask');
    assert.equal(value.safetyRisk, 'LOW');
    assert.equal(value.gates, 'passed');

    // Four typed/untyped asks: triage, remediation plan, safety review, post-mortem record.
    assert.equal(first.stats.asks, 4);
    assert.equal(first.stats.replayHits, 0);
    assert.deepEqual(first.stats.phases, [
      'Detection & Telemetry Probing',
      'Triage & Root Cause Analysis',
      'Remediation Synthesis & Safety Pair Review',
      'Execution & Verification Gate',
      'Post-Mortem Synthesis & Dashboard Export',
    ]);

    // Resume the same run: every node replays from the journal at zero asks.
    const second = await runFacadeScript({
      scriptPath: ws.scriptPath,
      cwd: ws.dir,
      args: { scenario: 'p1_db_pool_exhaustion' },
      resumeRunId: first.runId,
    });
    assert.equal(second.status, 'completed', `resume failed: ${second.error}`);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'resume must not execute any ask');
    assert.ok(second.stats.replayHits >= 4, `expected >=4 replay hits, got ${second.stats.replayHits}`);
  } finally {
    ws.cleanup();
  }
});

test('healthy scenario short-circuits before any ask', async () => {
  const ws = makeDemoWorkspace();
  try {
    // A nominal-telemetry scenario must return early (tripped: false, zero asks).
    const nominal = JSON.parse(fs.readFileSync(SCENARIO_SOURCE, 'utf8')) as { telemetry: { healthCheckStatus: string; http5xxRatePercent: number; activeDbConnections: number; maxDbConnections: number } };
    nominal.telemetry.healthCheckStatus = 'HEALTHY';
    nominal.telemetry.http5xxRatePercent = 0.1;
    nominal.telemetry.activeDbConnections = 23;
    fs.writeFileSync(path.join(ws.dir, 'scenarios', 'nominal.json'), JSON.stringify(nominal, null, 2));

    const r = await runFacadeScript({ scriptPath: ws.scriptPath, cwd: ws.dir, args: { scenario: 'nominal' } });
    assert.equal(r.status, 'completed', `nominal run failed: ${r.error ?? JSON.stringify(r.diagnostics)}`);
    assert.equal((r.value as { tripped: boolean }).tripped, false);
    assert.equal(r.stats.asks, 0, 'a healthy service must not spend any agent calls');
  } finally {
    ws.cleanup();
  }
});
