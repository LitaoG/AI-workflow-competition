/**
 * Issue #85: channel/future 纯 cell 原语 —— realm 运行层（T6-T16 + 修订①两条）。
 *
 * 全部测试 spawn 真实 dist/src/dwf/child-main.js，脚本为 realm 内裸 JS（直接使用
 * lowered 后的 __channel()/__future()/__host 表面）。纯 cell 语义：零站点、零 journal
 * 帧（stdout 无 t==='call'）；无界 FIFO、每项恰一接收者；close 幂等且唤醒全部 parked
 * （裸 receive → ChannelClosed，for-await → 正常 done）；receive/next 先 buffer 后
 * closed；停滞探针单发、判死按 channel 隔离、消息含 channel 标识与 'deadlock'。
 *
 * harness 纪律（P-TEST-3）：自含 mkdtempSync + finally rmSync；无内置超时的 await 一律
 * Promise.race 超时并 finally kill；子进程先行退出即 reject 帧等待者（红阶段快速失败）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Frame = { t?: string; id?: number; op?: string; value?: unknown; message?: string; name?: string } & Record<string, unknown>;

interface CellDriver {
  frames: Frame[];
  writeLine: (frame: unknown) => void;
  waitFrame: (pred: (f: Frame) => boolean, label: string) => Promise<Frame>;
  stderrText: () => string;
}

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-cell-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spawn the real child-main with a raw realm script; drive it; collect NDJSON frames. */
async function runCellScript(script: string, drive?: (d: CellDriver) => Promise<void>, timeoutMs = 10_000): Promise<{ frames: Frame[]; exitCode: number | null; stderr: string }> {
  const ws = makeWorkspace();
  const scriptPath = path.join(ws.dir, 'script.js');
  fs.writeFileSync(scriptPath, script);
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  // compiled test lives at dist/tests/unit/dwf/ → the child entry at dist/src/dwf/
  const childEntry = fileURLToPath(new URL('../../src/dwf/child-main.js', import.meta.url));
  const child = spawn(process.execPath, [childEntry, scriptPath, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });

  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; reject: (e: Error) => void; label: string }> = [];
  let stderrText = '';
  child.stderr!.on('data', (c: Buffer) => (stderrText += c.toString()));
  let lineBuf = '';
  child.stdout!.on('data', (c: Buffer) => {
    lineBuf += c.toString();
    let idx = lineBuf.indexOf('\n');
    while (idx >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      idx = lineBuf.indexOf('\n');
      if (!line) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue; // protocol is ours on both ends
      }
      frames.push(frame);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(frame)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(frame);
          break;
        }
      }
    }
  });
  const exitPromise = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  child.on('close', () => {
    for (const w of waiters.splice(0)) w.reject(new Error(`child exited before the awaited frame (${w.label}); frames so far: ${JSON.stringify(frames)}`));
  });
  const writeLine = (frame: unknown): void => {
    child.stdin!.write(JSON.stringify(frame) + '\n');
  };
  const waitFrame = (pred: (f: Frame) => boolean, label: string): Promise<Frame> =>
    new Promise<Frame>((resolve, reject) => {
      const existing = frames.find(pred);
      if (existing) {
        resolve(existing);
        return;
      }
      waiters.push({ pred, resolve, reject, label });
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runCellScript timed out after ${timeoutMs}ms; frames: ${JSON.stringify(frames)}; stderr: ${stderrText}`)), timeoutMs);
  });
  try {
    const driveAndExit = (async () => {
      if (drive) await drive({ frames, writeLine, waitFrame, stderrText: () => stderrText });
      const exitCode = await exitPromise;
      return exitCode;
    })();
    const exitCode = await Promise.race([driveAndExit, timeout]);
    return { frames, exitCode, stderr: stderrText };
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
    ws.cleanup();
  }
}

const wrap = (body: string): string => `async function __workflowScript__() {\n${body}\n}\n`;

// ---------------------------------------------------------------------------
// T6 — 无站点不落 journal · 运行半：纯 cell 脚本走完整生命周期，stdout 恰一条 done、零 call 帧
// ---------------------------------------------------------------------------

test('T6: a pure __channel/__future script emits exactly one done frame and zero journal call frames', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  ch.send(1);
  const got = await ch.receive();
  ch.send(2);
  ch.close();
  const drained = [];
  for await (const x of ch) drained.push(x);
  const f = __future();
  f.resolve('done');
  return { got: got, drained: drained, fut: await f.promise };
  `));
  assert.equal(exitCode, 0, `stderr: ${stderrOf(frames)}`);
  const doneFrames = frames.filter((f) => f.t === 'done');
  assert.equal(doneFrames.length, 1, JSON.stringify(frames));
  assert.equal(frames.filter((f) => f.t === 'call').length, 0, `zero call frames expected: ${JSON.stringify(frames)}`);
  assert.deepEqual(doneFrames[0].value, { got: 1, drained: [2], fut: 'done' });
});

function stderrOf(frames: Frame[]): string {
  const err = frames.find((f) => f.t === 'scriptError');
  return err ? String(err.message) : 'no scriptError frame';
}

// ---------------------------------------------------------------------------
// T7 — 无界 FIFO、每项恰一接收者
// ---------------------------------------------------------------------------

test('T7: FIFO waiters-first delivery, one receiver per item, unbounded send-then-drain of 1000 items', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  const order = [];
  const p1 = ch.receive().then(function (v) { order.push(['p1', v]); });
  const p2 = ch.receive().then(function (v) { order.push(['p2', v]); });
  ch.send('a');
  ch.send('b');
  await p1;
  await p2;
  const p3 = ch.receive();
  ch.send('c');
  const third = await p3;
  const big = __channel();
  for (var i = 0; i < 1000; i++) big.send(i);
  const all = [];
  for (var j = 0; j < 1000; j++) all.push(await big.receive());
  return { order: order, third: third, all: all };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, {
    order: [['p1', 'a'], ['p2', 'b']],
    third: 'c',
    all: Array.from({ length: 1000 }, (_, i) => i),
  });
});

// ---------------------------------------------------------------------------
// T8 — for-await 排空
// ---------------------------------------------------------------------------

test('T8: for-await drains exactly the buffered items in order and ends normally at close', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  ch.send(1);
  ch.send(2);
  ch.send(3);
  ch.close();
  const out = [];
  for await (const x of ch) out.push(x);
  return { out: out };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { out: [1, 2, 3] });
});

// ---------------------------------------------------------------------------
// T9 — for-await 先 park 后流入
// ---------------------------------------------------------------------------

test('T9: for-await parks first, an async producer feeds 10/11 then closes — loop collects [10,11] and ends', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  const out = [];
  (async function () {
    await null;
    ch.send(10);
    ch.send(11);
    ch.close();
  })();
  for await (const x of ch) out.push(x);
  return { out: out };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { out: [10, 11] });
});

// ---------------------------------------------------------------------------
// T10 — close 幂等 + close 后 send 抛 ChannelClosed（可捕获）
// ---------------------------------------------------------------------------

test('T10: close() is idempotent and send() after close throws a catchable ChannelClosed', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  ch.close();
  ch.close();
  let name = '';
  try {
    ch.send(1);
  } catch (e) {
    name = e.name;
  }
  return { name: name };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { name: 'ChannelClosed' });
});

// ---------------------------------------------------------------------------
// T11 — closed 排序语义：先 buffer 后 closed（两条路径都锁死）
// ---------------------------------------------------------------------------

test('T11: closed ordering — receive drains leftovers first (7), then ChannelClosed; a closed-and-empty receive also rejects ChannelClosed', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  ch.send(7);
  ch.close();
  const first = await ch.receive();
  let second = '';
  try {
    await ch.receive();
  } catch (e) {
    second = e.name;
  }
  const ch2 = __channel();
  ch2.close();
  let third = '';
  try {
    await ch2.receive();
  } catch (e) {
    third = e.name;
  }
  return { first: first, second: second, third: third };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { first: 7, second: 'ChannelClosed', third: 'ChannelClosed' });
});

// ---------------------------------------------------------------------------
// T12 — 停滞检测：空且开启、无任何在飞 send 可能 → ChannelDeadlock（消息含标识与 deadlock）
// ---------------------------------------------------------------------------

test('T12: a receiver parked on an empty open channel with no in-flight send possibility is rejected with ChannelDeadlock', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  try {
    await ch.receive();
    return { outcome: 'received' };
  } catch (e) {
    return { outcome: e.name, message: String(e.message) };
  }
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  const value = done!.value as { outcome: string; message: string };
  assert.equal(value.outcome, 'ChannelDeadlock');
  assert.ok(/channel#\d+/.test(value.message), `message must name the channel: ${value.message}`);
  assert.ok(value.message.includes('deadlock'), `message must mention deadlock: ${value.message}`);
});

// ---------------------------------------------------------------------------
// T13 — 不误报：微任务续体先于 macrotask 探针落袋
// ---------------------------------------------------------------------------

test('T13: no false deadlock — a microtask continuation sends before the macrotask probe fires', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  Promise.resolve('fast').then(function (v) { ch.send(v); });
  const v = await ch.receive();
  return { v: v };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { v: 'fast' });
});

// ---------------------------------------------------------------------------
// T14 — 真实宿主调用 staging：__pending 非空时探针不得判死；ok 落地后再武装、结算晚于 ok
// ---------------------------------------------------------------------------

test('T14: while a real host call is pending the probe must not harvest; after the ok lands the parked receiver dies with ChannelDeadlock, settled after the ok', async () => {
  const { frames, exitCode } = await runCellScript(
    wrap(`
  __host.log('log#1', 'in flight');
  const ch = __channel();
  try {
    await ch.receive();
    return { outcome: 'received' };
  } catch (e) {
    return { outcome: e.name };
  }
  `),
    async (d) => {
      // 1. collect the real child→parent call frame, then HOLD the ok
      const call = await d.waitFrame((f) => f.t === 'call' && f.op === 'log', 'log call frame');
      // 2. hold window: the pending call must shield the parked receiver — no done, no scriptError
      await sleep(80);
      assert.ok(
        !d.frames.some((f) => f.t === 'done' || f.t === 'scriptError'),
        `receiver must stay unsettled while the host call is pending: ${JSON.stringify(d.frames)}`,
      );
      // 3. release the ok → __deliver settles the call and re-arms at the tail
      const okAt = Date.now();
      d.writeLine({ t: 'ok', id: call.id, value: null });
      // 4. the receiver settles — strictly after the ok write — with ChannelDeadlock
      const done = await d.waitFrame((f) => f.t === 'done' || f.t === 'scriptError', 'done frame');
      assert.ok(Date.now() >= okAt, 'settlement must not precede the ok write');
      assert.equal(done.t, 'done', `expected the done frame, got: ${JSON.stringify(done)}`);
      assert.equal((done.value as { outcome: string }).outcome, 'ChannelDeadlock');
    },
    15_000,
  );
  assert.equal(exitCode, 0, stderrOf(frames));
});

// ---------------------------------------------------------------------------
// T15 — 判死按 channel 隔离：ch1 判死的同时 ch2 的已缓冲项照常可收
// ---------------------------------------------------------------------------

test('T15: deadlock harvest is per-channel — ch1 dies with ChannelDeadlock while ch2 still delivers its buffered keep', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch1 = __channel();
  const ch2 = __channel();
  ch2.send('keep');
  const p1 = ch1.receive().catch(function (e) { return e.name; });
  const r1 = await p1;
  const r2 = await ch2.receive();
  return { r1: r1, r2: r2 };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { r1: 'ChannelDeadlock', r2: 'keep' });
});

// ---------------------------------------------------------------------------
// T16 — future 纯度与语义：resolve/reject 保真、零 call 帧
// ---------------------------------------------------------------------------

test('T16: future resolves/rejects faithfully with zero journal call frames', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const f = __future();
  f.resolve('done');
  const v = await f.promise;
  const g = __future();
  g.reject(new Error('boom-reason'));
  let message = '';
  try {
    await g.promise;
  } catch (e) {
    message = e.message;
  }
  return { v: v, message: message };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const doneFrames = frames.filter((f) => f.t === 'done');
  assert.equal(doneFrames.length, 1, JSON.stringify(frames));
  assert.equal(frames.filter((f) => f.t === 'call').length, 0, `zero call frames expected: ${JSON.stringify(frames)}`);
  assert.deepEqual(doneFrames[0].value, { v: 'done', message: 'boom-reason' });
});

// ---------------------------------------------------------------------------
// 修订①(2-i) — close() 唤醒语义：parked 裸 receive 被 close 以 ChannelClosed 唤醒，绝非 ChannelDeadlock
// ---------------------------------------------------------------------------

test('REV-1: close() wakes a parked bare receiver with ChannelClosed — never ChannelDeadlock', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  (async function () {
    await null;
    ch.close();
  })();
  try {
    await ch.receive();
    return { outcome: 'received' };
  } catch (e) {
    return { outcome: e.name };
  }
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { outcome: 'ChannelClosed' });
});

// ---------------------------------------------------------------------------
// 修订①(2-ii) — 逐项生产者（send 间 await null、末尾 close）+ for-await → 恰收 [1,2] 且正常终止
// ---------------------------------------------------------------------------

test('REV-2: a per-item producer (await null between sends, close at the end) with for-await collects exactly [1,2] and ends the loop normally', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  (async function () {
    await null; ch.send(1);
    await null; ch.send(2);
    await null; ch.close();
  })();
  const out = [];
  for await (const x of ch) out.push(x);
  return { out: out };
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  assert.deepEqual(done!.value, { out: [1, 2] });
});

// ---------------------------------------------------------------------------
// T17（独立复核回归）— 被吞掉的 waitAny 超时不得屏蔽判死探针：realm 定时器静默
// 消亡（败者清理不 clear、拒绝被脚本吞掉）后，探针必须经定时器开火路径尾部再武装，
// 否则 parked 接收者永久漏判（修复前本用例零帧挂死至 harness 超时）。
// ---------------------------------------------------------------------------

test('T17: a swallowed sessions.waitAny timeout no longer shields a parked receiver — the probe re-arms from the timer fire path and harvests ChannelDeadlock', async () => {
  const { frames, exitCode } = await runCellScript(wrap(`
  const ch = __channel();
  __sessions.waitAny([new Promise(function () {})], { timeoutMs: 30 }).catch(function () {});
  try {
    await ch.receive();
    return { outcome: 'received' };
  } catch (e) {
    return { outcome: e.name, message: String(e.message) };
  }
  `));
  assert.equal(exitCode, 0, stderrOf(frames));
  const done = frames.find((f) => f.t === 'done');
  assert.ok(done, JSON.stringify(frames));
  const value = done!.value as { outcome: string; message: string };
  assert.equal(value.outcome, 'ChannelDeadlock');
  assert.ok(/channel#\d+/.test(value.message), `message must name the channel: ${value.message}`);
  assert.ok(value.message.includes('deadlock'), `message must mention deadlock: ${value.message}`);
});
