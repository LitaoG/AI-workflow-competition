import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

// 修复 #1（黑盒行为规约审计缺口）：amend 导入缓存关门防线。
// 复现器（复核员实测过的同款时序）：
//   Run1（父）：world.run 写 probe.txt 为 PROBE-OLD；files.read 读回 → journal
//   Amend：world.run 改写 probe.txt 为 PROBE-NEW（diverged → live 执行）；
//          同参 files.read 必须返回 PROBE-NEW（关门后 world 节点不再问导入表），
//          而不是命中导入缓存的 PROBE-OLD。
// 同时锁定：纯节点（ask）不受关门影响，仍吃温缓存。

const RUN1 = `
phase('Setup');
await world.run('node', ['-e', "require('fs').writeFileSync('probe.txt','PROBE-OLD')"], { timeoutMs: 30000 });
const probe1 = await files.read('probe.txt');
return { probe1 };
`;

const AMEND = `
phase('Mutate');
await world.run('node', ['-e', "require('fs').writeFileSync('probe.txt','PROBE-NEW')"], { timeoutMs: 30000 });
const probe2 = await files.read('probe.txt');
return { probe2 };
`;

const PURE_ASK_RUN = `
phase('Ask');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-import-gate-'));
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

test('import gate: after a live world.run, same-args world reads bypass the imported cache', async () => {
  const ws = makeWorkspace();
  try {
    const run1Path = path.join(ws.dir, 'run1.facade.ts');
    fs.writeFileSync(run1Path, RUN1);
    const amendPath = path.join(ws.dir, 'amend.facade.ts');
    fs.writeFileSync(amendPath, AMEND);

    const first = await runFacadeScript({ scriptPath: run1Path, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(first.status, 'completed', first.error);
    assert.equal((first.value as { probe1: string }).probe1, 'PROBE-OLD');

    const amended = await runFacadeScript({
      scriptPath: amendPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      amendRunId: first.runId,
    });
    assert.equal(amended.status, 'completed', amended.error);
    // THE FIX: this must be PROBE-NEW (fresh read of the mutated world), not the
    // imported PROBE-OLD. Before the gate, the same-args worldRead replayed the
    // prior run's value while the disk held PROBE-NEW.
    assert.equal(
      (amended.value as { probe2: string }).probe2,
      'PROBE-NEW',
      'world read after a live world.run must reflect the mutated world',
    );
  } finally {
    ws.cleanup();
  }
});

test('import gate: pure asks keep hitting the warm cache after closure', async () => {
  const ws = makeWorkspace();
  try {
    const askPath = path.join(ws.dir, 'ask.facade.ts');
    fs.writeFileSync(askPath, PURE_ASK_RUN);
    const mutatePath = path.join(ws.dir, 'mutate.facade.ts');
    fs.writeFileSync(
      mutatePath,
      "phase('Mutate');\nawait world.run('node', ['-e', 'process.exit(0)'], { timeoutMs: 30000 });\nreturn {};",
    );

    const first = await runFacadeScript({ scriptPath: askPath, cwd: ws.dir, dbPath: ws.dbPath });
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.stats.asks, 1);

    // A later amend runs a live world.run (closes the gate) and then re-runs the
    // pure ask: the ask's imported entry is pure, so it must still replay.
    const amended = await runFacadeScript({
      scriptPath: mutatePath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      amendRunId: first.runId,
    });
    assert.equal(amended.status, 'completed', amended.error);

    const third = await runFacadeScript({
      scriptPath: askPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      amendRunId: amended.runId,
    });
    assert.equal(third.status, 'completed', third.error);
    assert.equal(third.stats.asks, 0, 'pure ask replays from the warm cache');
    assert.equal(third.stats.amendHits, 1, 'the ask node is an amend hit, not a live re-run');
    assert.equal(third.stats.replayHits, 0);
  } finally {
    ws.cleanup();
  }
});
