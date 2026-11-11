/**
 * PoC-3 回归测试 — 超限报文（1MB 级 / >32MB 级）经真实父端解析器与引擎。
 *
 * 攻击：恶意/失控子进程经 NDJSON 通道投喂超大单帧（1 MiB / 33 MiB log 调用帧），
 * 或在脚本层用 report() 投喂超限条目 —— 验证"超限应产生可捕获错误而非挂死"。
 *
 * import 风格参照 tests/pbt/engine-invariants.test.ts（node --test 直跑）：
 *   node --experimental-strip-types --test tests/adversarial/goal-poc3-oversize-frames.test.ts
 *
 * 实测结论（2026-11-01, worktree feat/issue-28-goal-e2e-pentest @ 30eb54f）：
 * - 1MB 帧：488ms 完整到达；33MB（34,603,008 字符）帧：4.6s 完整到达 —— 无帧长上限，
 *   无"干净拒绝"命名错误（缺口已在 Issue #34 修复 → 文件末 skip 已转正）
 * - report() 有真实的 1MB/条 命名拒绝防线（engine.ts ReportCapExceeded）
 * - 静默子进程的整跑超时上界成立（PoC-1 D 已断言），flood 场景破界（PoC-1 已转正）
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFacadeScript } from '../../dist/src/dwf/runner.js';

const HOSTILE_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'goal-poc1-frame-poison-child.mjs');

const VICTIM_SCRIPT = 'phase("P1");\nreturn { victim: "real" };\n';

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
}

describe('PoC-3: 超限报文 — 大帧到达性与可捕获错误', () => {

  test('1MB log 帧: 完整到达、run 干净完成、墙钟受界', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc3-mb1-'));
    try {
      const scriptPath = path.join(dir, 'victim.facade.ts');
      fs.writeFileSync(scriptPath, VICTIM_SCRIPT);
      const logs: string[] = [];
      const t0 = Date.now();
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { scenario: 'mb1' },
        runTimeoutMs: 30_000,
        childEntryPath: HOSTILE_CHILD,
        onEvent: (e) => { if (e.type === 'dwf_log') logs.push(String((e.data as { message?: unknown }).message ?? '')); },
      });
      const wall = Date.now() - t0;
      assert.equal(result.status, 'completed', `run failed: ${result.error ?? ''}`);
      const big = logs.find((m) => m.length === 1024 * 1024);
      assert.ok(big, '1MB log frame must arrive intact');
      assert.ok(/^A{1048576}$/.test(big!), '1MB message content byte-exact');
      assert.ok(wall < 30_000, `wall=${wall}ms — must stay under the run bound`);
    } finally {
      cleanup(dir);
    }
  });

  test('>32MB log 帧: 命名拒绝、不挂死、墙钟受界（Issue #34 帧预算，替代原"完整到达"现状固化）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc3-mb33-'));
    try {
      const scriptPath = path.join(dir, 'victim.facade.ts');
      fs.writeFileSync(scriptPath, VICTIM_SCRIPT);
      const logs: string[] = [];
      const t0 = Date.now();
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { scenario: 'mb33' },
        runTimeoutMs: 45_000,
        childEntryPath: HOSTILE_CHILD,
        onEvent: (e) => { if (e.type === 'dwf_log') logs.push(String((e.data as { message?: unknown }).message ?? '')); },
      });
      const wall = Date.now() - t0;
      // Issue #34 修复后行为[已验证]：33MB 帧不再被吸收 —— 33MB 单行超过 16MB
      // 单帧预算、也先在 32MB 积压预算闸被拦截 → killTree + ChildFrameLimitExceeded
      // （替代原"33MB 完整到达"现状固化断言，超限已有干净命名拒绝）。
      assert.equal(result.status, 'failed', `expected named rejection, got ${result.status}: ${result.error ?? ''}`);
      assert.match(result.error ?? '', /FrameLimitExceeded|frame.*cap/i);
      assert.ok(!logs.some((m) => m.length === 33 * 1024 * 1024), 'the oversize frame must NOT be processed as a log');
      assert.ok(wall < 45_000, `wall=${wall}ms — must stay under the run bound (no hang)`);
    } finally {
      cleanup(dir);
    }
  });

  test('report() 超限条目: 引擎侧命名拒绝防线（ReportCapExceeded）真实存在（直驱 handleCall）', async () => {
    // 防线：src/dwf/engine.ts:452-456 — report 条目 > 1,000,000 字节 → ReportCapExceeded。
    // 注意[已验证]：经完整管线时该防线被 lower/child-main 载荷丢失回归中性化
    // （真实 1MB 载荷在子进程被丢，跨线只有 10 字符 site 标签 → 引擎永远查不超限），
    // 故这里直驱 FacadeEngine.handleCall 断言引擎侧防线本体；端到端路径 → 文件末 skip。
    const { FacadeEngine } = await import('../../dist/src/dwf/engine.js');
    const engine = new FacadeEngine({
      runId: 'poc3-report-cap',
      workspace: process.cwd(),
      store: {
        saveDwfNode: async () => {},
        getDwfNodes: async () => [],
        getDwfRun: async () => null,
        saveDwfRun: async () => {},
        recordEvent: async () => {},
      } as never,
      args: {},
      approvedCommands: [],
      onEvent: () => {},
    });
    const frame = { t: 'call', id: 1, op: 'report', siteId: 'report#1', payload: [{ blob: 'R'.repeat(1_000_001) }] };
    await assert.rejects(
      () => engine.handleCall(frame as never),
      (err: Error) => err.name === 'ReportCapExceeded' && /per-item cap/.test(err.message),
    );
  });

  test('ask 超限 prompt 被 wire 层命名拒绝（33MB prompt → ChildFrameLimitExceeded）', async () => {
    // Issue #34 修复后行为：33MB prompt 经 args→child→wire，单行超 16MB 帧预算
    // → killTree + 命名拒绝（对照原"无上限全程可达"现状固化，已随修复改写）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc3-ask33-'));
    try {
      const scriptPath = path.join(dir, 'big.facade.ts');
      fs.writeFileSync(scriptPath, [
        'phase("Big");',
        'const r = await agent("e").ask(String(args.big));',
        'return { promptLen: String(args.big).length };',
      ].join('\n'));
      const t0 = Date.now();
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { big: 'C'.repeat(33 * 1024 * 1024) },
        runTimeoutMs: 45_000,
      });
      const wall = Date.now() - t0;
      assert.equal(result.status, 'failed', `expected named rejection, got status=${result.status} value=${JSON.stringify(result.value)}`);
      assert.match(result.error ?? '', /FrameLimitExceeded/);
      assert.ok(wall < 45_000, `wall=${wall}ms`);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 防线转正（原 describe.skip 缺口，Issue #34 修复后转为真实断言）
// ---------------------------------------------------------------------------
describe('PoC-3 防线: NDJSON 通道帧预算 + 引擎入口载荷上限 [已修复]', () => {
  /**
   * 缺口 2（GAP-01 载荷丢失）已由 child-main 边界签名修复闭合 —— report 的
   * 真实超限条目可达引擎侧 1MB/条 上限，端到端断言转正。
   */
  /**
   * 缺口记录[已验证 2026-11-01]：
   * runner.ts 行拆分循环对单帧长度、stdoutBuffer 总量均无字节预算：
   *   1MB 帧 → 被接受（488ms）；33MB（34,603,008 字符）帧 → 被接受（4.6s），
   *   33MB ask prompt → 被接受。全程无任何命名错误。
   * 协议预算基线（通用 NDJSON 长帧档位）：
   *   - 单物理帧上限 1MB（1024*1024 字节）；
   *   - 逻辑帧装配上限 16MB（16*1024*1024 字节）。
   * 修复（Issue #34）：runner 帧泵加单行 16MB / 积压 32MB 预算（字符长度代理
   *   字节），超限 killTree + 命名拒绝 ChildFrameLimitExceeded；engine ask/log
   *   入口加同款上限（BOUNDARY_PAYLOAD_CAP_CHARS）作为 op 级第二道闸。
   *   1MB 帧完整到达是帧边界完整性的既有活跃断言，故单行预算取 16MB 消息档
   *   （本协议无分片层，1MB 物理帧档不适用）。
   */
  test('33MB 帧应被命名上限拒绝（ChildFrameLimitExceeded）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc3-skip-'));
    try {
      const scriptPath = path.join(dir, 'victim.facade.ts');
      fs.writeFileSync(scriptPath, VICTIM_SCRIPT);
      const t0 = Date.now();
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { scenario: 'mb33' },
        runTimeoutMs: 45_000,
        childEntryPath: HOSTILE_CHILD,
      });
      const wall = Date.now() - t0;
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /FrameLimitExceeded|frame.*cap/i);
      assert.ok(wall < 45_000 + 8_000, `wall=${wall}ms must stay near the run bound`);
    } finally {
      cleanup(dir);
    }
  });

  test('超限 report 条目端到端应触发 ReportCapExceeded（per-item cap）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc3-report-skip-'));
    try {
      const scriptPath = path.join(dir, 'big.facade.ts');
      fs.writeFileSync(scriptPath, 'phase("Cap");\nawait report({ blob: "R".repeat(1000001) });\nreturn 1;\n');
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        runTimeoutMs: 30_000,
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /ReportCapExceeded|per-item cap/);
    } finally {
      cleanup(dir);
    }
  });

  test('engine 入口边界载荷上限：ask prompt / log message 超限命名拒绝（直驱 handleCall）', async () => {
    // op 级第二道闸（GOAL.md 差距矩阵 D4 "ask/log 入口同款上限"）：wire 层
    // （runner 帧泵）先行拒绝超限行；此测试直驱引擎断言入口闸本体 ——
    // 超限 ask 不进入 seat/FIFO/预算路径，直接以 ChildFrameLimitExceeded 拒绝。
    const { FacadeEngine } = await import('../../dist/src/dwf/engine.js');
    const engine = new FacadeEngine({
      runId: 'poc3-boundary-cap',
      workspace: process.cwd(),
      store: {
        saveDwfNode: async () => {},
        getDwfNodes: async () => [],
        getDwfRun: async () => null,
        saveDwfRun: async () => {},
        recordEvent: async () => {},
      } as never,
      args: {},
      approvedCommands: [],
      onEvent: () => {},
    });
    await engine.handleCall({ t: 'call', id: 1, op: 'createActor', siteId: 'cap1', payload: ['boundary-actor'] } as never);
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 2, op: 'ask', siteId: 'cap1', payload: [{ __actor: 'cap1' }, 'P'.repeat(16 * 1024 * 1024 + 1)] } as never),
      (err: Error) => /boundary payload cap/.test((err as { message?: string }).message ?? '') && (err as { tag?: string }).tag === 'AgentError',
    );
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 3, op: 'log', siteId: 'cap1', payload: ['L'.repeat(16 * 1024 * 1024 + 1)] } as never),
      (err: Error) => /boundary payload cap/.test((err as { message?: string }).message ?? ''),
    );
  });
});
