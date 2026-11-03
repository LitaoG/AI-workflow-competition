import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript, fillHoleAndRun } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-branch-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('branch-level hole parking: a hole in one branch lets the sibling branch finish; fill continues', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'branch.facade.ts');
    // The hole branch parks at once; the sibling branch runs THREE asks to completion.
    fs.writeFileSync(scriptPath, `
phase("Parallel branches");
const siblingWork = (async () => {
  const a = await agent("worker-1").ask<Answer>("inspect health report of the service");
  const b = await agent("worker-2").ask<Answer>("inspect health report of the service");
  const c = await agent("worker-3").ask<Answer>("inspect health report of the service");
  return [a.healthStatus, b.healthStatus, c.healthStatus];
})();
const plan = await hole<Plan>("mid-branch", "fill me");
const sibling = await siblingWork;
return { sibling, plan };

interface Answer { healthStatus: string; }
interface Plan { action: string; }
`);
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.name, 'mid-branch');
    assert.equal(parked.stats.asks, 3, 'the sibling branch ran its three asks to completion BEFORE parking');
    assert.ok(parked.value && typeof parked.value === 'object');

    // Fill: the amend replays the sibling's three asks at ZERO cost and the body runs.
    const fill = await fillHoleAndRun({
      runId: parked.runId,
      holeName: 'mid-branch',
      body: 'return { action: "NO_ACTION_NEEDED" };',
      cwd: ws.dir,
    });
    assert.equal(fill.status, 'accepted', fill.error);
    const run = fill.run!;
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.stats.amendHits, 3, 'all three sibling asks replayed from the warm cache');
    assert.equal(run.stats.asks, 0, 'the hole body itself needed no model call');
  } finally {
    ws.cleanup();
  }
});
