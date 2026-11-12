/**
 * PoC-1 回归测试 — child NDJSON 协议投毒（帧撕裂 / 粘包 / 垃圾行 / 伪造帧 / 静默超时）。
 *
 * 攻防：攻击脚本 tests/adversarial/fixtures/goal-poc1-frame-poison-child.mjs
 * 通过 RunFacadeOptions.childEntryPath（src/dwf/runner.ts:53 测试钩子）顶替沙箱子进程，
 * 向真实父端解析器（src/dwf/runner.ts:373-390）投喂毒化字节流。
 *
 * import 风格参照 tests/pbt/engine-invariants.test.ts（node --test 直跑）：
 *   node --experimental-strip-types --test tests/adversarial/goal-poc1-ndjson-protocol.test.ts
 *
 * 实测结论（2026-11-01, worktree feat/issue-28-goal-e2e-pentest @ 30eb54f）：
 * - 垃圾行 / 控制字节 / 断裂 JSON 被静默丢弃，不崩溃、不撕裂后续帧（当时 catch→continue；
 *   Issue #34 修复后改为 catch→计数累计 + run 结束 emit dwf_frame_malformed，不再静默）
 * - 跨 chunk 撕裂的帧被缓冲重组，逐字节完整
 * - 整跑超时（runTimeoutMs，runner.ts:354-357）对静默子进程是真实上界 → 可捕获错误
 * - 伪造 {t:"done"} 被接受为终态（信任边界，与官方"fault isolation NOT a security boundary"同构）
 * - 洪泛缺口已在 Issue #34 修复（帧泵让位 + 帧预算）→ 文件末 skip 已转正为真实断言
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFacadeScript } from '../../dist/src/dwf/runner.js';

const HOSTILE_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'goal-poc1-frame-poison-child.mjs');

const VICTIM_SCRIPT = 'phase("P1");\nreport({ victim: true });\nreturn { victim: "real" };\n';

function makeWorkspace(): { dir: string; scriptPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc1-'));
  const scriptPath = path.join(dir, 'victim.facade.ts');
  fs.writeFileSync(scriptPath, VICTIM_SCRIPT);
  return { dir, scriptPath };
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
}

interface RunOutcome {
  status: string;
  error?: string;
  value?: unknown;
  logs: string[];
  eventTypes: string[];
  /** count payloads of every dwf_frame_malformed diagnostic (one run-end emit per run when > 0). */
  malformedCounts: number[];
  wallMs: number;
}

async function runHostile(scenario: string, runTimeoutMs: number, onLog?: (message: string) => void): Promise<RunOutcome> {
  const ws = makeWorkspace();
  const logs: string[] = [];
  const eventTypes: string[] = [];
  const malformedCounts: number[] = [];
  const t0 = Date.now();
  try {
    const result = await runFacadeScript({
      scriptPath: ws.scriptPath,
      cwd: ws.dir,
      dbPath: path.join(ws.dir, 'journal.sqlite'),
      args: { scenario },
      runTimeoutMs,
      childEntryPath: HOSTILE_CHILD,
      onEvent: (e) => {
        eventTypes.push(e.type);
        if (e.type === 'dwf_log') {
          logs.push(String((e.data as { message?: unknown }).message ?? ''));
          onLog?.(String((e.data as { message?: unknown }).message ?? ''));
        }
        if (e.type === 'dwf_frame_malformed') {
          malformedCounts.push(Number((e.data as { count?: unknown }).count ?? -1));
        }
      },
    });
    return { status: result.status, error: result.error, value: result.value, logs, eventTypes, malformedCounts, wallMs: Date.now() - t0 };
  } finally {
    cleanup(ws.dir);
  }
}

describe('PoC-1: child NDJSON 协议投毒 — 父端解析器防线', () => {

  test('A: 控制字节垃圾/CRLF/断裂JSON/错误形态行被干净丢弃，合法帧不受撕裂', async () => {
    const r = await runHostile('garbage', 30_000);
    // 整跑必须干净收尾，绝不崩溃/挂死
    assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
    // 真实 done 帧的价值完整到达 —— 帧边界未被垃圾破坏
    assert.deepEqual(r.value, { ok: 'real-done' });
    // 合法 log 帧在垃圾洪泛之后仍被处理（帧序完好）
    assert.ok(r.logs.includes('legit-log-after-garbage'), `logs=${JSON.stringify(r.logs)}`);
    // 断裂/跨行 JSON 行绝不能被当作帧执行 —— 只允许 CRLF 结尾的合法 JSON 帧通过
    const joined = r.logs.join('|');
    assert.ok(!joined.includes('pretty-printed'), 'newline-inside-frame must not execute');
    // 畸形帧不再静默丢弃（Issue #34 动作 3）：run 结束 emit 一次 dwf_frame_malformed，
    // count 逐行对账 —— NUL 垃圾行 + 断裂 JSON + 跨行断裂两半 = 4；且诊断事件
    // 先于终态事件（emit 时机 = run 结束、终态之前）。
    assert.deepEqual(r.malformedCounts, [4], `malformed counts=${JSON.stringify(r.malformedCounts)}`);
    assert.ok(
      r.eventTypes.lastIndexOf('dwf_frame_malformed') < r.eventTypes.lastIndexOf('dwf_completed'),
      `malformed diagnostic must precede the terminal event: ${JSON.stringify(r.eventTypes)}`,
    );
    assert.ok(r.wallMs < 30_000, `wall=${r.wallMs}ms`);
  });

  test('B: 跨 chunk 撕裂帧逐字节重组；毒化撕裂行（raw NUL 楔入）被干净拒绝', async () => {
    const r = await runHostile('torn', 30_000);
    assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
    // B1: 3 段撕裂 + 60ms 间隔的合法帧必须逐字节重组
    assert.ok(r.logs.includes('torn-frame-reassembled-intact'), `logs=${JSON.stringify(r.logs)}`);
    // B2/B3: raw NUL 楔入与 raw 控制字节载荷（非法 JSON）必须整行拒绝，绝不部分执行
    assert.ok(!r.logs.some((m) => m.includes('poisoned-torn') || m.includes('raw')), `logs=${JSON.stringify(r.logs)}`);
    // 畸形帧诊断对账（Issue #34 动作 3）：B2 毒化撕裂行 + B3 raw 控制字节行 = 2
    assert.deepEqual(r.malformedCounts, [2], `malformed counts=${JSON.stringify(r.malformedCounts)}`);
    assert.deepEqual(r.value, { ok: 'torn-done' });
  });

  test('C: 伪造 {t:"done"} 被接受为终态（信任边界），settled 后帧被忽略', async () => {
    // 信任边界[推断→已验证]：子进程是 done 的唯一合法写者，父端无法区分真伪 ——
    // 与官方一致（child-main.ts:5-6 "NOT a security boundary"；官方 handshake 同样信任对端）。
    // 本测试固化的是：伪造 done 之后的帧绝不再被处理（runner.ts:406 settled 门）。
    const r = await runHostile('forged', 30_000);
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.value, { forged: 'FORGED_DONE' });
    assert.ok(!r.logs.some((m) => m.includes('after-forged-done')), 'post-settle frames must be ignored');
  });

  test('D: 静默子进程 — 整跑超时是真实上界，产生可捕获错误而非挂死', async () => {
    const bound = 12_000;
    const r = await runHostile('silent', bound);
    assert.equal(r.status, 'failed');
    // 可捕获错误：超时错误带有精确上界文本
    assert.match(r.error ?? '', new RegExp(`whole-run timeout \\(${bound}ms\\)`));
    // 上界证据：wall 必须落在 [bound, bound+8s] —— 挂死则超过
    assert.ok(r.wallMs >= bound - 500, `premature: wall=${r.wallMs}ms`);
    assert.ok(r.wallMs <= bound + 8_000, `bound broken: wall=${r.wallMs}ms (bound=${bound}ms)`);
  });

  test('E: 5MB stderr 洪泛被 4000 字符尾部截断防线吸收，不崩溃', async () => {
    // 防线：runner.ts:394-400 — stderrTail 累积前 slice(-4000) + redactText
    const r = await runHostile('stderrflood', 30_000);
    assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
    assert.deepEqual(r.value, { ok: 'stderrflood-done' });
    assert.ok(r.wallMs < 30_000, `wall=${r.wallMs}ms`);
  });
});

// ---------------------------------------------------------------------------
// 防线转正（原 describe.skip 缺口，Issue #34 修复后转为真实断言）
// ---------------------------------------------------------------------------
describe('PoC-1 防线: 持续输出洪泛不再打破超时上界 [已修复]', () => {
  /**
   * 缺口记录[已验证 2026-11-01]：
   * 场景 fixture 'flood'（200MB 有界逐让洪泛）/ 'floodbomb'（无界不洪泛炸弹）：
   *   runTimeoutMs=10_000 时实测 runFacadeScript 返回耗时 213.1s / 120.4s
   *   （probe3-flood-timing.mjs，心跳 3s 间隔在洪泛期间全部缺失 —— 事件循环被
   *   持续可读管道的 data 事件饿死，killTimer 无法到点）。
   * 修复（Issue #34）：
   *   - 帧泵让位：runner stdout 解析按 CHILD_FRAME_LINES_PER_TICK 分片，
   *     setImmediate 让位 event loop —— timers/信号持续可调度；
   *   - 帧预算：单行 > 16MB 或积压 > 32MB → killTree + 命名拒绝
   *     ChildFrameLimitExceeded（对照官方 PROTOCOL_V4_LIMITS
   *     maxFrameBytes=1MB / logicalFrameAssemblyMaxBytes=16MB，
   *     zcode-protocol-v4/core.ts）。
   * 转正断言：洪泛场景在 10s 上界内以命名错误失败 —— 帧预算主动拒绝或
   *   整跑超时到点任一即证明事件循环未被饿死（双防线取或，避免依赖洪泛
   *   写入速度与解析速度的竞速来挑选具体防线）。
   */
  test('flood 场景在 runTimeoutMs=10s 下必须在界内失败（洪泛让位 + 帧预算双防线）', async () => {
    const r = await runHostile('flood', 10_000);
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /whole-run timeout \(10000ms\)|ChildFrameLimitExceeded/);
    assert.ok(r.wallMs <= 18_000, `bound broken: wall=${r.wallMs}ms (bound=10000ms)`);
  });
});
