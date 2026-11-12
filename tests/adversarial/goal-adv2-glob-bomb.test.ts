/**
 * ADV2 regression: glob bomb — 3000 files in the run workspace vs
 * `files.glob('*.txt')`, over the 2000-file cap.
 *
 * Attack (fixtures, run byte-identical from a temp-dir bomb field built by this test):
 *   tests/adversarial/fixtures/goal-adv2-glob-uncaught.ts — glob past the cap, uncaught
 *   tests/adversarial/fixtures/goal-adv2-glob-caught.ts   — same bomb, rejection caught
 *
 * Defense under test (src/dwf/engine.ts:595-599 with src/dwf/glob.ts:54): the walk
 * collects cap+1 = 2001 matches and the call REJECTS ("files.glob matched more than
 * 2000 files — narrow the pattern"). Form verified live: Promise reject CATCHABLE in
 * the script; uncaught it fails the run structurally. Exactly 2000 files must NOT
 * reject (cap+1 semantics — the boundary ZCode keeps with maxResults: cap+1,
 * bootstrap/src/app/workflow-world-read.ts:112-123).
 *
 * Observability: the caught fixture carries its observation in the run's RETURN VALUE
 * (result.value) — script-level log()/report() content is dropped by the child realm
 * (child-main.ts:95-96 forwards the lowered site id, lower.ts:137-141, as the payload;
 * found during this ADV, reported to the run owner).
 *
 * The bomb lives only in a temp dir (resource restraint); cleaned up after each test.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFacadeScript } from '../../dist/src/dwf/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uncaughtFixture = path.join(here, 'fixtures', 'goal-adv2-glob-uncaught.ts');
const caughtFixture = path.join(here, 'fixtures', 'goal-adv2-glob-caught.ts');

const GLOB_CAP = 2000;
const BOMB_SIZE = 3000;

/**
 * Windows 句柄延迟释放：run settle 时 finish() 的 killTree 是异步的，sandbox
 * 子进程与 SQLite 连接的目录句柄在 rm 时可能仍被占用（批跑多个 suite 时尤其
 * 如此——goal-adv 门禁实测 boundary 测试 rmdir 报 EBUSY）。重试吸收，先例同
 * tests/integration/dwf-orphan.test.ts 的 cleanup。
 */
async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/** Build a scratch run dir with `count` bomb files, fixture copied byte-identical into it. */
async function makeBombField(count: number, fixture: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'goal-adv2-bomb-'));
  for (let i = 0; i < count; i++) {
    await fs.promises.writeFile(path.join(dir, `bomb-${String(i).padStart(4, '0')}.txt`), 'x');
  }
  await fs.promises.copyFile(fixture, path.join(dir, 'attack.ts'));
  return dir;
}

describe('ADV2: files.glob 3000-file resource bomb', () => {
  test('uncaught: 3000 files → structural run failure carrying the cap message', async () => {
    const dir = await makeBombField(BOMB_SIZE, uncaughtFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'adv2.db'),
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /files\.glob matched more than 2000 files/);
      assert.equal(result.stats.asks, 0, 'no asks needed to trip the world-read cap');
    } finally {
      await cleanup(dir);
    }
  });

  test('caught: same bomb → the reject is catchable in-script and the run completes', async () => {
    const dir = await makeBombField(BOMB_SIZE, caughtFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'adv2.db'),
      });
      assert.equal(result.status, 'completed');
      const value = result.value as { caught?: string; matched?: number };
      assert.ok(value && typeof value.caught === 'string', `expected returned {caught}, got ${JSON.stringify(result.value)}`);
      assert.match(value.caught!, /matched more than 2000 files/);
      assert.equal(value.matched, undefined, 'no partial match list leaks past the cap');
    } finally {
      await cleanup(dir);
    }
  });

  test('boundary: exactly 2000 files does NOT reject (cap+1 semantics, no silent truncation ambiguity)', async () => {
    const dir = await makeBombField(GLOB_CAP, caughtFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'adv2.db'),
      });
      assert.equal(result.status, 'completed');
      const value = result.value as { caught?: string; matched?: number };
      assert.ok(value && value.matched === GLOB_CAP, `expected {matched: 2000}, got ${JSON.stringify(result.value)}`);
      assert.equal(value.caught, undefined);
    } finally {
      await cleanup(dir);
    }
  });
});
