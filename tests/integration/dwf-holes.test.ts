import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript, fillHoleAndRun } from '../../src/dwf/runner.js';

const PARKED_SCRIPT = `
phase("Survey");
const survey = await agent("inspector").ask<Survey>("inspect health report of the service");
phase("Decide");
const decision = await hole<Decision>("decide-remediation", \`survey: \${JSON.stringify(survey)}\`);
log(\`decision: \${decision.action}\`);
return { survey, decision };

interface Survey {
  healthStatus: string;
}
interface Decision {
  action: string;
  owner: string;
}
`;

const GOOD_BODY = `
const decision = await agent("decision-agent").ask<Decision>(\`Decide the remediation action for this survey: \${JSON.stringify(survey)}\`);
return decision;
`;

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-holes-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* child may briefly hold the dir on Windows */ } } };
}

test('a run reaching an unfilled hole parks with the hole reported; fill forks an amend that completes', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);

    // Park: the survey ask is journalled, then the run stops at the hole.
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked', `expected parked, got ${parked.status}: ${parked.error}`);
    assert.equal(parked.parkedAt?.name, 'decide-remediation');
    assert.match(parked.parkedAt?.prompt ?? '', /survey/);
    assert.equal(parked.stats.asks, 1, 'the survey ask ran before the hole');

    // Fill: body spliced, forked as an amend — the survey ask replays at zero cost,
    // the body's own ask runs live, and the script completes with the typed decision.
    const fill = await fillHoleAndRun({ runId: parked.runId, holeName: 'decide-remediation', body: GOOD_BODY, cwd: ws.dir });
    assert.equal(fill.status, 'accepted', `fill refused: ${fill.error ?? JSON.stringify(fill.diagnostics)}`);
    const run = fill.run!;
    assert.equal(run.status, 'completed', `forked run failed: ${run.error}`);
    assert.equal(run.amendedFrom, parked.runId, 'forked run carries the lineage');
    assert.equal(run.stats.amendHits, 1, 'the prefix ask replays from the warm cache');
    assert.equal(run.stats.asks, 1, 'only the body ask executes live');
    const value = run.value as { survey: { healthStatus: string }; decision: { action: string; owner: string } };
    assert.equal(value.survey.healthStatus, 'HEALTHY');
    assert.equal(value.decision.action, 'RESTART_POOL_WORKERS');
    assert.equal(value.decision.owner, 'on-call-sre');

    // The effective (spliced) script exists next to the original.
    assert.ok(fill.effectiveScriptPath && fs.existsSync(fill.effectiveScriptPath));
  } finally {
    ws.cleanup();
  }
});

test('a fill body that fails compilation is refused with diagnostics and splices nothing', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked');

    const fill = await fillHoleAndRun({
      runId: parked.runId,
      holeName: 'decide-remediation',
      body: 'return { action: noSuchVariable.action, owner: "x" };',
      cwd: ws.dir,
    });
    assert.equal(fill.status, 'refused');
    assert.match(fill.error ?? '', /failed compilation/);
    assert.ok((fill.diagnostics ?? []).length > 0, 'diagnostics accompany the refusal');
  } finally {
    ws.cleanup();
  }
});

test('filling an unknown hole (or an untyped one) is refused without touching the run', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked');

    const fill = await fillHoleAndRun({ runId: parked.runId, holeName: 'no-such-hole', body: 'return null;', cwd: ws.dir });
    assert.equal(fill.status, 'refused');
    assert.match(fill.error ?? '', /no hole named/);
  } finally {
    ws.cleanup();
  }
});

test('resuming a parked run with the original script parks again (nothing lost)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);
    const parked1 = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked1.status, 'parked');

    const parked2 = await runFacadeScript({ scriptPath, cwd: ws.dir, resumeRunId: parked1.runId });
    assert.equal(parked2.status, 'parked');
    assert.equal(parked2.stats.replayHits, 1, 'the survey ask replays from the journal');
  } finally {
    ws.cleanup();
  }
});
