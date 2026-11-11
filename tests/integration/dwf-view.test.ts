import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';
import { renderRunViewHtml } from '../../src/dwf/view.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { executeAnswer } from '../../src/cli/commands/answer.js';

const SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
const decision = await escalate('Approve auto-remediation? (yes/no)');
const gate = await world.run('node', ['--version'], { timeoutMs: 30000 });
await artifact.markdown('report', 'Decision: ' + decision + ', gate exit ' + gate.exitCode);
report({ health: health.healthStatus, decision });
return { healthStatus: health.healthStatus, decision, gateExit: gate.exitCode };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-view-'));
  return {
    dir,
    dbPath: path.join(dir, '.workflow', 'dwf.sqlite'),
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

test('run view renders phases, nodes, escalation Q&A, artifact and replay badges', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, approvedCommands: ['node'] });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.kind, 'escalation');

    const answerExit = await executeAnswer(parked.runId, parked.parkedAt!.name, ['yes'], { dbPath: ws.dbPath, approvedCommands: ['node'] });
    assert.equal(answerExit, 0, 'answer must complete the run');

    // Resume once so the view also shows replay hits.
    const resumed = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      resumeRunId: parked.runId, approvedCommands: ['node'] });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.stats.asks, 0);

    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    let html: string;
    try {
      html = await renderRunViewHtml(store, parked.runId);
    } finally {
      store.close();
    }

    // The Studio SPA shell with the embedded snapshot
    assert.ok(html.includes(parked.runId), 'run id missing');
    assert.ok(html.includes('AI-Workflow Studio'), 'studio shell missing');
    assert.ok(html.includes('window.__STUDIO__'), 'embedded snapshot missing');
    assert.ok(html.includes('"status":"completed"'), 'status missing from snapshot');
    // Phase from the event timeline
    assert.ok(html.includes('Inspect'), 'phase missing from snapshot');
    // Node results enriched from the journal (ask verdict + escalation answer)
    assert.ok(html.includes('HEALTHY'), 'ask result missing');
    assert.ok(html.includes('Approve auto-remediation? (yes/no)'), 'question text missing');
    assert.ok(html.includes('"yes"'), 'answer value missing');
    // Replay hits land in the snapshot stats (resume replays 4 nodes here)
    assert.match(html, /"replayHits":[1-9]/, 'replay stats missing');
    // Artifact content embedded for the Inspector gallery
    assert.ok(html.includes('Decision: yes'), 'artifact content missing');
  } finally {
    ws.cleanup();
  }
});

test('run view fails cleanly for an unknown run id', async () => {
  const ws = makeWorkspace();
  try {
    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      await assert.rejects(() => renderRunViewHtml(store, 'dwfrun-does-not-exist'), /not found/);
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});
