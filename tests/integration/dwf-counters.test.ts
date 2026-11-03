import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { createSQLiteStore } from '../../src/state/store.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';

// 修复 #4（黑盒行为规约推导审计缺口）：resume 恢复 budget 计数与 artifact 版本。
// 之前：resume 后 outputTokensSpent 从 0 重账（硬闸归零）、artifactVersions
// 从 1 重数（ON CONFLICT 覆盖旧产物）。现在：计数从 journal/结算行恢复。

const SPEND_SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

const ARTIFACT_SCRIPT = `
phase('Publish');
await artifact.markdown('alpha', 'V1 content from the first attempt');
return { done: true };
`;

const ARTIFACT_AMEND_SCRIPT = `
phase('Publish');
await artifact.markdown('alpha', 'V2 content from the amended attempt');
return { done: true };
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-counters-'));
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

test('artifact versions continue across an amend — the third version is the third version', async () => {
  const ws = makeWorkspace();
  try {
    const p1 = path.join(ws.dir, 'a1.facade.ts');
    fs.writeFileSync(p1, ARTIFACT_SCRIPT);
    const first = await runFacadeScript({ scriptPath: p1, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(first.status, 'completed', first.error);

    // Amend: same artifact id, new content → live publish (input diverged) —
    // the version must CONTINUE from the journal, not restart at 1.
    const p2 = path.join(ws.dir, 'a2.facade.ts');
    fs.writeFileSync(p2, ARTIFACT_AMEND_SCRIPT);
    const second = await runFacadeScript({
      scriptPath: p2,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      amendRunId: first.runId,
    });
    assert.equal(second.status, 'completed', second.error);

    let versionOfSecond: number | undefined;
    for (const e of (await import('node:events')).EventEmitter ? [] : []) void e;
    // The dwf_artifact event carries the version; recover it from the journal.
    const store = createSQLiteStore(ws.dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const events = await store.getEvents(second.runId);
      const art = events.filter((e) => e.type === 'dwf_artifact');
      assert.equal(art.length, 1);
      versionOfSecond = (art[0]!.data as { version?: number }).version;
    } finally {
      store.close();
    }
    assert.equal(versionOfSecond, 2, `version must be 2 (continue), got ${versionOfSecond}`);
  } finally {
    ws.cleanup();
  }
});
