import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { analyzeFacadeScript } from '../../src/dwf/compile.js';
import { createSQLiteStore } from '../../src/state/store.js';
import type { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../src/types.js';

/**
 * Issue #116: rerun the SAME script from a chosen site. Sites before the
 * boundary replay from the warm cache; the boundary site and later ones run
 * live even though they succeeded in the prior run. The mock provider answers
 * "inspect ... health report" prompts offline with a HEALTHY survey.
 */
const THREE_ASKS = `
phase("One");
const a = await agent("inspector-a").ask<Survey>("inspect health report of service A");
phase("Two");
const b = await agent("inspector-b").ask<Survey>("inspect health report of service B");
phase("Three");
const c = await agent("inspector-c").ask<Survey>("inspect health report of service C");
return { a: a.healthStatus, b: b.healthStatus, c: c.healthStatus };

interface Survey {
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-rerun-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* child may briefly hold the dir on Windows */ } } };
}

function askSiteIds(source: string): string[] {
  const analysis = analyzeFacadeScript(source);
  assert.ok(analysis.ok, `test script must compile: ${JSON.stringify(analysis.diagnostics)}`);
  return analysis.sites.filter((s) => s.kind === 'ask').map((s) => s.siteId);
}

test('rerun from a chosen site: earlier asks replay warm, that site and later ones run live', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, THREE_ASKS);
    const asks = askSiteIds(THREE_ASKS);
    assert.equal(asks.length, 3);

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `first run failed: ${first.error}`);
    assert.equal(first.stats.asks, 3, 'the first run executes every ask live');

    const rerun = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, rerunFromSite: asks[1] });
    assert.equal(rerun.status, 'completed', `rerun failed: ${rerun.error}`);
    assert.notEqual(rerun.runId, first.runId, 'a rerun forks a new run id');
    assert.equal(rerun.amendedFrom, first.runId, 'the rerun carries the lineage');
    assert.equal(rerun.stats.amendHits, 1, 'only the ask before the boundary replays from the warm cache');
    assert.equal(rerun.stats.asks, 2, 'the boundary ask and the one after it run live although they succeeded before');
    assert.deepEqual(rerun.value, { a: 'HEALTHY', b: 'HEALTHY', c: 'HEALTHY' });

    // Rerun from the first site: nothing is imported, everything runs live.
    const full = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, rerunFromSite: asks[0] });
    assert.equal(full.status, 'completed', `full rerun failed: ${full.error}`);
    assert.equal(full.stats.amendHits, 0);
    assert.equal(full.stats.asks, 3);
  } finally {
    ws.cleanup();
  }
});

test('rerun refuses an edited script and points to --amend', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, THREE_ASKS);
    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `first run failed: ${first.error}`);

    const edited = THREE_ASKS.replace('service C', 'service D');
    fs.writeFileSync(scriptPath, edited);
    const rerun = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, rerunFromSite: askSiteIds(edited)[1] });
    assert.equal(rerun.status, 'failed');
    assert.match(rerun.error ?? '', /--amend/, 'the refusal names the sanctioned fork for edited scripts');
  } finally {
    ws.cleanup();
  }
});

test('rerun refuses an unknown --from site and lists the known sites; --rerun with --amend is refused', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, THREE_ASKS);
    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `first run failed: ${first.error}`);

    const unknown = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, rerunFromSite: 'ask#999' });
    assert.equal(unknown.status, 'failed');
    assert.match(unknown.error ?? '', /known sites: .*ask#/);

    const both = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, amendRunId: first.runId, rerunFromSite: askSiteIds(THREE_ASKS)[1] });
    assert.equal(both.status, 'failed');
    assert.match(both.error ?? '', /--rerun alone/);
  } finally {
    ws.cleanup();
  }
});

test('executedAsks settle with the run row and continue across a rerun (Issue #63)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, THREE_ASKS);
    const asks = askSiteIds(THREE_ASKS);

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `first run failed: ${first.error}`);
    assert.equal(first.stats.asks, 3, 'the first run executes every ask live');

    // The settlement persists the lineage's live-ask count next to the token spend.
    const store = createSQLiteStore(path.join(ws.dir, '.workflow', 'dwf.sqlite')) as SQLiteStateStore & DwfJournalStore;
    const firstRow = await store.getDwfRun(first.runId);
    assert.ok(firstRow);
    assert.equal(firstRow.executedAsks, 3, "the executed_asks column records the first run's live asks");

    // Rerun from the second site: 1 warm replay + 2 live asks — the rerun's
    // ledger starts from the restored 3, not from zero, so its settlement
    // carries 3 + 2 = 5. Without the restore the row would read 2 (cap reset).
    const rerun = await runFacadeScript({ scriptPath, cwd: ws.dir, rerunRunId: first.runId, rerunFromSite: asks[1] });
    assert.equal(rerun.status, 'completed', `rerun failed: ${rerun.error}`);
    assert.equal(rerun.stats.amendHits, 1);
    assert.equal(rerun.stats.asks, 2);
    const rerunRow = await store.getDwfRun(rerun.runId);
    assert.ok(rerunRow);
    assert.equal(rerunRow.executedAsks, 5, 'the rerun continues the lineage ask count instead of restarting from zero');
    store.close();
  } finally {
    ws.cleanup();
  }
});
