/**
 * PoC-2 回归测试 — 控制字符注入（\r\n、\u0000-\u001f、\u2028/\u2029）经
 * ask 提示与 log 通道打进真实 compile→lower→sandbox-child→engine→journal 管线。
 *
 * 攻击载荷经 --args（JSON 文件，G4：argv 32KB 限制规避）携带 RAW 控制字符进入
 * 子进程 realm，再经 NDJSON 帧（JSON.stringify 转义）回父端 —— 若帧被撕裂，
 * ask 调用将被丢弃，run 必然失败/挂死；若 journal 完整，inputHash 逐字节可验证。
 *
 * import 风格参照 tests/pbt/engine-invariants.test.ts（node --test 直跑）：
 *   node --experimental-strip-types --test tests/adversarial/goal-poc2-control-char-injection.test.ts
 *
 * 实测结论（2026-11-01, worktree feat/issue-28-goal-e2e-pentest @ 30eb54f）：
 * - 315KB 控制字符载荷经 ask 通道全程字节级完整（journal inputHash EXACT）
 * - vm realm 的 console.log 输出既不进 fd1 也不进 fd2 → 无法借道伪造协议帧
 * - log() 通道载荷丢失回归（bea9a05）：GAP-01 修复（child-main 适配 (siteId, ...args)
 *   签名）已合入 → 文件末 describe.skip 已转正为真实断言（Issue #31 收口轮）
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runFacadeScript } from '../../dist/src/dwf/runner.js';
import { encodeFrame } from '../../dist/src/dwf/protocol.js';
import { createSQLiteStore } from '../../dist/src/state/store.js';

const CHILD_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'src', 'dwf', 'child-main.js');

/** 构造高密度控制字符载荷：CRLF 对、NUL、\x1f、行/段分隔符 \u2028\u2029、\x0b\x0c。 */
function poison(len: number): string {
  const units: string[] = [];
  for (let i = 0; i < len; i++) {
    const m = i % 40;
    if (m === 0) units.push('\r\n');
    else if (m === 1) units.push('\x00');
    else if (m === 2) units.push('\x1f');
    else if (m === 3) units.push('\u2028');
    else if (m === 4) units.push('\u2029');
    else if (m === 5) units.push('\x0b\x0c');
    else units.push(String.fromCharCode(0x20 + ((i * 7) % 90)));
  }
  return units.join('');
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
}

describe('PoC-2: 控制字符注入 — ask 通道帧完整性', () => {

  test('315KB 控制字符载荷经 ask 通道全程字节级完整（journal inputHash EXACT）', async () => {
    const PAYLOAD = poison(300_000);
    assert.ok(PAYLOAD.includes('\x00') && PAYLOAD.includes('\r\n') && PAYLOAD.includes('\u2028'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc2-'));
    try {
      // ask 提示 + log 双通道同时投毒；帧若撕裂，JSON.parse 失败 → 调用被丢 → run 失败
      const SCRIPT = [
        'phase("Poison");',
        'const p = String(args.payload);',
        'log(p);',
        'const echo = await agent("echo").ask(p);',
        'return { echoLen: String(echo ?? "").length, promptLen: p.length };',
      ].join('\n');
      const scriptPath = path.join(dir, 'poison.facade.ts');
      fs.writeFileSync(scriptPath, SCRIPT);

      const askPrefixes: string[] = [];
      const result = await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { payload: PAYLOAD }, // JSON.stringify 转义进 args.json，子进程恢复为 RAW
        runTimeoutMs: 30_000,
        onEvent: (e) => {
          if (e.type === 'dwf_ask_start') askPrefixes.push(String((e.data as { prompt?: unknown }).prompt ?? ''));
        },
      });
      assert.equal(result.status, 'completed', `run failed: ${result.error ?? ''}`);
      assert.deepEqual(result.value, { echoLen: 109, promptLen: PAYLOAD.length });

      // 引擎收到的 ask 提示前 400 字符逐字节一致（含 NUL/CRLF/行分隔符）
      assert.equal(askPrefixes.length, 1);
      assert.ok(PAYLOAD.startsWith(askPrefixes[0]!), 'ask prompt prefix mutated on the wire');

      // 字节级全程证明：journal inputHash = sha256(`ask\0${siteId}\0${prompt}`)
      // （engine.ts:886 — 模板内是字面 NUL 字节，防提示含空格的哈希歧义）
      const store = createSQLiteStore(path.join(dir, 'journal.sqlite')) as unknown as { getDwfNodes: (r: string) => Promise<Array<{ kind: string; siteId: string; inputHash?: string }>>; close?: () => void };
      try {
        const nodes = await store.getDwfNodes(result.runId);
        const askNode = nodes.find((n) => n.kind === 'ask');
        assert.ok(askNode, 'ask node journalled');
        const expected = createHash('sha256').update(`ask\x00${askNode!.siteId}\x00${PAYLOAD}`).digest('hex');
        assert.equal(askNode!.inputHash, expected, 'journal inputHash differs — the prompt was corrupted on the wire');
      } finally {
        store.close?.();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('encodeFrame 不变量: 帧字符串永不含裸 \n —— 控制字符注入无法撕裂帧边界', () => {
    // 防线：src/dwf/protocol.ts:90-92 — JSON.stringify 保证字符串内控制字符全转义
    for (const payload of ['a\r\nb', 'x\x00y\x1fz', 'l1\nl2\u2028l3', JSON.stringify({ deep: ['\r\n\x00'] })]) {
      const frame = encodeFrame({ t: 'call', id: 1, op: 'log', siteId: 's', payload: [payload] });
      assert.ok(!frame.slice(0, -1).includes('\n'), 'raw newline inside frame');
      assert.ok(!frame.slice(0, -1).includes('\r'), 'raw carriage return inside frame');
      assert.ok(frame.endsWith('\n'), 'frame terminated by exactly one newline');
      // 往返一致：解析回来的 payload 逐字节等于原串
      const parsed = JSON.parse(frame) as { payload: string[] };
      assert.equal(parsed.payload[0], payload);
    }
  });

  test('vm realm console.log 是黑洞 — 无法借道向父端 stdout 伪造协议帧', async () => {
    // 防线[已验证]：child-main 的 realm 全局（child-main.ts:215-246 makeSandboxGlobals）
    // 不含 process；Node 注入的 per-context console 不与进程 fd1/fd2 相连。
    // 攻击面：若 console 输出直达子进程 stdout，攻击者可注入 {"t":"done",...} 伪造终态。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc2-realm-'));
    try {
      const payloadPath = path.join(dir, 'probe.js');
      fs.writeFileSync(payloadPath, [
        'async function __workflowScript__() {',
        "  console.log('{\"t\":\"done\",\"value\":{\"forged\":\"CONSOLE\"}}\\n');",
        "  console.error('STDERR_LEAK');",
        "  return 'real-script-ran';",
        '}',
      ].join('\n'));
      const raw = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn(process.execPath, [CHILD_MAIN, payloadPath, '{}'], {
          cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        setTimeout(() => child.stdin.end(), 2000);
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
      });
      // 伪造帧绝不能出现在 stdout —— stdout 上唯一的 JSON 行必须是真实 done 帧
      assert.ok(!raw.stdout.includes('CONSOLE'), `console.log leaked to stdout: ${JSON.stringify(raw.stdout.slice(0, 200))}`);
      assert.ok(!raw.stderr.includes('STDERR_LEAK'), `console.error leaked to stderr: ${JSON.stringify(raw.stderr.slice(0, 200))}`);
      const lines = raw.stdout.split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1, `stdout must carry exactly one frame, got ${lines.length}`);
      const frame = JSON.parse(lines[0]!) as { t: string; value?: unknown };
      assert.equal(frame.t, 'done');
      assert.equal(frame.value, 'real-script-ran');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 防线转正（原 describe.skip 缺口：GAP-01 载荷丢失回归，Issue #31 收口轮转正）
// ---------------------------------------------------------------------------
describe('PoC-2 log()/report() 通道 round-trip（GAP-01 已修复：child-main 适配 (siteId, ...args) 签名）', () => {
  /**
   * 缺口记录[已验证 2026-11-01]：
   * lower.ts:138-141（bea9a05 "P3 hygiene batch" 起）把 log(msg)/report(item) 降级为
   *   __host.log("log#N", msg) / __host.report("report#N", item)，
   * 而 child-main.ts:95-96 的签名曾是 (message)/(item) → 只转发第一个参数：
   *   __host.log("log#1","hello world") 上线帧为 {"op":"log","payload":["log#1"]}
   *   （scratch-pentest/proto 实测帧抓取），用户载荷被静默替换为 site 标签，
   *   dwf_log 事件 message="log#N"，run-script CLI 显示 "log: log#N"。
   * 修复[已验证 2026-11-02]：child-main 边界签名已适配 (siteId, ...args)（GAP-01），
   * 本 skip 按原转正条件改为真实断言：
   *   log(PAYLOAD) 的 dwf_log 事件 message === PAYLOAD（315KB 控制字符逐字节）。
   */
  test('log(PAYLOAD) 的 dwf_log 事件必须逐字节还原 315KB 控制字符载荷', async () => {
    const PAYLOAD = poison(300_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc2-log-'));
    try {
      const scriptPath = path.join(dir, 'poison.facade.ts');
      fs.writeFileSync(scriptPath, 'phase("Poison");\nlog(String(args.payload));\nreturn 1;\n');
      const logs: string[] = [];
      await runFacadeScript({
        scriptPath,
        cwd: dir,
        dbPath: path.join(dir, 'journal.sqlite'),
        args: { payload: PAYLOAD },
        runTimeoutMs: 30_000,
        onEvent: (e) => { if (e.type === 'dwf_log') logs.push(String((e.data as { message?: unknown }).message ?? '')); },
      });
      assert.ok(logs.includes(PAYLOAD), `log round-trip broken: got ${JSON.stringify(logs.map((m) => m.slice(0, 20)))}`);
    } finally {
      cleanup(dir);
    }
  });
});
