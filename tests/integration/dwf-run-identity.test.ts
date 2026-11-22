import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-run-identity-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

// Issue #266: the parent pushes the runInfo notify frame onto the child's
// stdin AFTER spawn, while the script's top level evaluates at boot — a
// top-level `run.id` read used to race that push and see '' (observed live as
// `.workflow/runs//graph.html` ENOENT in run dwfrun-mwrsia2y-a0088a). The fix
// seeds run identity from the spawn argv, so the top-level read is
// deterministic and must equal the run's actual id.
test('run identity: top-level run.id equals the run id — no runInfo boot race', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'identity.facade.ts');
    fs.writeFileSync(scriptPath, `
// The exact shape that raced before the fix: a top-level read with NO
// preceding await, evaluated at script-boot time.
const topLevelId = run.id;
return { topLevelId, afterSettleId: run.id };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    const value = r.value as { topLevelId: string; afterSettleId: string };
    assert.match(value.topLevelId, /^dwfrun-/, `top-level id must be seeded at boot, got: "${value.topLevelId}"`);
    assert.equal(value.topLevelId, r.runId, 'top-level run.id must equal the actual run id');
    assert.equal(value.afterSettleId, r.runId, 'post-settle read stays consistent');
  } finally {
    ws.cleanup();
  }
});
