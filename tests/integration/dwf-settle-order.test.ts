import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

// 修复 #5（边界条件安全审计与状态恢复加固）：fanout resume 结算次序闸。
// 三个 thunk 共享同一个 ask 调用点（同 siteId、不同 prompt），用递减的
// world.run 延迟强制 live 完成序为 C、B、A（arrival ordinal 1=C、2=B、3=A）。
// resume 时 journal 瞬时返回，到达序变为 A、B、C——旧实现按到达序分配
// ordinal，A 绑到 C 的 journal 行 → inputHash 大声失败。池匹配（按内容
// 消费 1:1）后：每个 ask 取回自己 inputHash 对应的行，全部零调用重放。

const SCRIPT = `
phase('Fanout');
const targets = [
  { key: 'A', sleepMs: 300 },
  { key: 'B', sleepMs: 200 },
  { key: 'C', sleepMs: 100 },
];
const results = await Promise.all(targets.map((t) =>
  (async () => {
    await world.run('node', ['-e', 'setTimeout(()=>{},' + t.sleepMs + ')'], { timeoutMs: 30000 });
    const h = await agent('inspector').ask<Health>('inspect health report variant ' + t.key + ' of the service');
    return { key: t.key, healthStatus: h.healthStatus };
  })(),
));
report({ settled: results.length });
return { results };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-settle-order-'));
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

test('fanout resume: shared call-site asks replay by content, not arrival order', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath: ws.dbPath, approvedCommands: ['node'] });
    assert.equal(first.status, 'completed', first.error);
    const firstValue = first.value as { results: Array<{ key: string; healthStatus: string }> };
    assert.equal(firstValue.results.length, 3);
    assert.equal(first.stats.asks, 3, 'three fan-out asks ran live');

    // Resume: WITHOUT the settle pool this is exactly where the run explodes —
    // the replay arrival order (A, B, C) differs from the live settle order
    // (C, B, A), so arrival-keyed ordinals misbind journal rows.
    const resumed = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath: ws.dbPath,
      resumeRunId: first.runId, approvedCommands: ['node'] });
    assert.equal(resumed.status, 'completed', `fanout resume failed: ${resumed.error}`);
    assert.deepEqual(resumed.value, first.value);
    assert.equal(resumed.stats.asks, 0, 'all three asks replay at zero provider calls');
    assert.equal(resumed.stats.replayHits, 6, '3 asks + 3 world.run gates replay from the journal');
  } finally {
    ws.cleanup();
  }
});
