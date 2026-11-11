import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFacadeScript } from '../../src/dwf/runner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT_SOURCE = path.join(REPO_ROOT, 'demos', 'repo-migration-engine', 'facade.workflow.ts');
/** Workspace root the script expects: fixtures/ lives under the demo dir. */
const DEMO_WORKSPACE = path.join(REPO_ROOT, 'demos', 'repo-migration-engine');

function makeJournalPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-demo-migration-'));
  return {
    dbPath: path.join(dir, 'journal.db'),
    cleanup: () => {
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

test('migration demo facade script: scan, fan-out transform+review, gates, PR export', async () => {
  const journal = makeJournalPath();
  try {
    const first = await runFacadeScript({
 scriptPath: SCRIPT_SOURCE, cwd: DEMO_WORKSPACE, dbPath: journal.dbPath, approvedCommands: ['node'],
});
    assert.equal(first.status, 'completed', `demo run failed: ${first.error ?? JSON.stringify(first.diagnostics)}`);

    const value = first.value as {
      migrated: number;
      targetPackage: string;
      allApproved: boolean;
      gates: string;
      record: string;
    };
    assert.equal(value.targetPackage, '@aws-sdk/client-s3');
    assert.equal(value.allApproved, true);
    assert.equal(value.gates, 'passed');
    assert.ok(value.migrated >= 3, `expected the 3 fixture services, got ${value.migrated}`);

    // asks: architect plan + 3 workers + 3 reviewers + PR record = 8
    assert.equal(first.stats.asks, 8);
    assert.equal(first.stats.replayHits, 0);
    assert.deepEqual(first.stats.phases, [
      'Baseline Test Gate',
      'Scan & Migration Architecture',
      'Parallel Fan-Out Workers & Paired Code Reviewers',
      'Compiler Diagnostics & Post-Merge Test Gate',
      'Release Synthesis & PR Generation',
    ]);

    // Resume: identical run replays everything at zero asks.
    const second = await runFacadeScript({

      scriptPath: SCRIPT_SOURCE,
      cwd: DEMO_WORKSPACE,
      dbPath: journal.dbPath,
      resumeRunId: first.runId, approvedCommands: ['node'],
});
    assert.equal(second.status, 'completed', `resume failed: ${second.error}`);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'resume must not execute any ask');
    assert.ok(second.stats.replayHits >= 8, `expected >=8 replay hits, got ${second.stats.replayHits}`);
  } finally {
    journal.cleanup();
  }
});

test('a failing baseline gate aborts before any agent call', async () => {
  // The gate command is a fixed literal; simulate failure by pointing the run
  // at a workspace whose fixture test cannot run (no fixture at all).
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-demo-migration-missing-'));
  try {
    const r = await runFacadeScript({
 scriptPath: SCRIPT_SOURCE, cwd: missing, dbPath: path.join(missing, 'j.db'), approvedCommands: ['node'],
});
    assert.equal(r.status, 'failed');
    assert.ok(r.error!.includes('Baseline gate failed'), `unexpected error: ${r.error}`);
    assert.equal(r.stats.asks, 0, 'the deterministic gate must decide before any model spend');
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(missing, { recursive: true, force: true });
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  }
});
