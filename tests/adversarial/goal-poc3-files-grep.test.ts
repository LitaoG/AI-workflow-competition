// PoC3 regression: workspace file harvesting of on-disk credentials.
//
// VERDICT SPLIT (live-verified 2026-11-01, run dwfrun-mvxr8jgi-4c03b4 for the
// value path and dwfrun-mvxrb8cc-45b103 for the error path):
//
//   - VALUE PATH (files.grep / files.read result values): GAP. The engine's
//     redaction call points cover world.run subprocess output
//     (FacadeEngine.spawnCaptured, src/dwf/engine.ts) and the runner's
//     stderr/error frames (src/dwf/runner.ts), but FacadeEngine.worldRead
//     returns `fs.readFileSync` text RAW (src/dwf/engine.ts, case 'files.read')
//     and grepWorkspace returns matched lines RAW, and journalled() persists
//     resultJson without redactValue (src/dwf/engine.ts). Live evidence:
//     `run-script` CLI printed `result: {"hits":[{"path":".env",...,
//     "text":"GOAL_POC_TOKEN=sk-decoy-123"}],...}` and the journal
//     dwf_nodes.result_json stored the raw decoy (worldread#2/#3). Even the
//     URI-credential mask (maskUriCredentials) is skipped on this path — a
//     `DATABASE_URL=postgres://app:hunter2@...` line came back verbatim.
//     → FIXED (GAP-03): journalled() now masks the value once at the boundary
//     (src/dwf/engine.ts — redactValue before resultJson AND before the value
//     returns to the script), so the CLI's result line, the journal and the
//     replay all inherit the mask. The value-path assertions below run for
//     real since then.
//
//   - ERROR PATH: DEFENSE HOLDS. A script that throws with the harvested
//     content gets its error redacted before it reaches the CLI or the
//     journal (runner.ts redactText on the run error; engine.ts redactText on
//     frame messages) — live run printed
//     `GOAL_POC_TOKEN=***REDACTED***` and `postgres://***:***@localhost:5432/db`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const DECOY = 'sk-decoy-123';
const ENV_CONTENT = `GOAL_POC_TOKEN=${DECOY}\nDATABASE_URL=postgres://app:hunter2@localhost:5432/db\nNOTE=benign decoy workspace\n`;

/** Decoy workspace: a .env with the credential plus one benign file. */
function makeDecoyWorkspace(tag: string): string {
  const dir = path.join(os.tmpdir(), `goal-poc3-ws-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), ENV_CONTENT, 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'benign file\n', 'utf8');
  return dir;
}

function runScript(fixture: string, cwd: string, dbPath: string): { status: number | null; out: string } {
  const res = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin', 'workflow.js'), 'run-script', fixture, '--db', dbPath],
    { cwd, env: { ...process.env, GOAL_POC_TOKEN: DECOY }, encoding: 'utf8', timeout: 50_000 },
  );
  return { status: res.status, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

// Windows 上 spawnSync 子进程刚退出，其工作区/SQLite 文件句柄的释放是异步的——
// 紧随的 rmSync 会随机撞 EBUSY（实测 5 轮 1 轮双 describe 同挂，编排层全量门禁
// 亦被打红）。node rmSync 内建线性退避重试（EBUSY/EPERM/ENOTEMPTY）加大到
// 20×250ms 仍可能不够（Defender/索引服务扫描刚写入的含令牌 .env 可锁数秒），
// 故清理降级为 best-effort：重试后仍失败仅告警，绝不因清理卫生问题判红测试——
// 断言已完成时残留目录交由 OS %TEMP% 策略清理（AI-PITFALLS P-ENV-2 同根因）。
function rmTempSync(p: string, opts: { recursive?: boolean }): void {
  try {
    fs.rmSync(p, { ...opts, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.warn(`[cleanup] best-effort rmSync failed for ${p}: ${(err as Error).message}`);
  }
}

describe('PoC3: error path redaction (defense holds today)', () => {
  test('a thrown script error carrying the harvested .env content is redacted before CLI output and journal', () => {
    const fixture = path.join(repoRoot, 'tests', 'adversarial', 'fixtures', 'goal-cred-snoop-4-error-path.ts');
    const ws = makeDecoyWorkspace('err');
    const dbPath = path.join(os.tmpdir(), `goal-poc3-err-${process.pid}-${Date.now()}.sqlite`);
    try {
      const { status, out } = runScript(fixture, ws, dbPath);
      assert.notEqual(status, 0, `expected the run to fail (the script throws):\n${out}`);
      // Redaction evidence on the failure channel:
      assert.match(out, /GOAL_POC_TOKEN=\*\*\*REDACTED\*\*\*/, 'expected the KV shape masked in the run error');
      assert.match(out, /postgres:\/\/\*\*\*:\*\*\*@/, 'expected the URI credential masked in the run error');
      // Leak surface:
      assert.ok(!out.includes(DECOY), `decoy value leaked into CLI output:\n${out}`);
      assert.ok(!out.includes('hunter2'), `URI credential leaked into CLI output:\n${out}`);
    } finally {
      rmTempSync(dbPath, {});
      rmTempSync(ws, { recursive: true });
    }
  });
});

describe('PoC3: files.grep / files.read must not leak workspace .env credentials', () => {
  // Enabled (GAP-03): journalled() masks the value at the boundary, so the
  // script-visible value, the CLI result line and dwf_nodes.result_json all
  // carry the mask. run-script on goal-cred-snoop-3-files-grep.ts from a
  // workspace holding a .env with GOAL_POC_TOKEN=sk-decoy-123 must return
  // redacted values and store no raw decoy in the journal:
  test('grep hits and file content come back redacted and the decoy value reaches no output', () => {
    const fixture = path.join(repoRoot, 'tests', 'adversarial', 'fixtures', 'goal-cred-snoop-3-files-grep.ts');
    const ws = makeDecoyWorkspace('val');
    const dbPath = path.join(os.tmpdir(), `goal-poc3-val-${process.pid}-${Date.now()}.sqlite`);
    try {
      const { status, out } = runScript(fixture, ws, dbPath);
      assert.equal(status, 0, `run-script failed:\n${out}`);
      // The decoy value must not appear anywhere in CLI output...
      assert.ok(!out.includes(DECOY), `decoy value leaked into CLI output:\n${out}`);
      assert.ok(!out.includes('hunter2'), `URI credential leaked into CLI output:\n${out}`);
      // ...nor in the journal's persisted node results.
      const db = new DatabaseSync(dbPath);
      try {
        const rows = db.prepare('SELECT result_json FROM dwf_nodes WHERE result_json IS NOT NULL').all() as Array<{ result_json: string }>;
        for (const row of rows) {
          assert.ok(!row.result_json.includes(DECOY), `raw decoy persisted in journal: ${row.result_json.slice(0, 200)}`);
          assert.ok(!row.result_json.includes('hunter2'), `raw URI credential persisted in journal: ${row.result_json.slice(0, 200)}`);
        }
      } finally {
        db.close();
      }
    } finally {
      rmTempSync(dbPath, {});
      rmTempSync(ws, { recursive: true });
    }
  });
});
