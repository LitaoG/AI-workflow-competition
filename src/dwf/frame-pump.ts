/**
 * Child frame pump — the parent side of the NDJSON protocol transport.
 *
 * Frames are parsed one event-loop tick at a time (CHILD_FRAME_LINES_PER_TICK
 * rows, then `setImmediate` yields) so a flooding child can no longer starve
 * the timers phase — the whole-run timeout stays schedulable under sustained
 * output (previously a flood held the loop in the poll phase and the killTimer
 * never fired: measured 213.1s vs a 10s bound). Budgets are enforced before
 * parsing: one line over MAX_CHILD_FRAME_CHARS, or a backlog over
 * MAX_CHILD_FRAME_BUFFER_CHARS, fails the run by name instead of being
 * absorbed.
 *
 * Frame budget provenance (GOAL.md 差距矩阵 D4；官方对照 PROTOCOL_V4_LIMITS):
 * NDJSON 单行即一帧 —— 单行预算取官方 16MB 消息组装上限
 * (logicalFrameAssemblyMaxBytes)，残留积压预算取官方 32MB staged 上限。字符
 * 长度作字节预算的代理（setEncoding('utf8') 后 code units ≤ 字节数），防线
 * 方向为宽松（不误杀合法帧）；ASCII 超限拒绝路径由
 * tests/adversarial/goal-adv3-oversize-frames.test.ts 实测锁定。
 */
import type { ChildToParent } from './protocol.js';

const MAX_CHILD_FRAME_CHARS = 16 * 1024 * 1024;
const MAX_CHILD_FRAME_BUFFER_CHARS = 32 * 1024 * 1024;
/** Pump yield granularity: lines parsed per event-loop tick before yielding. */
const CHILD_FRAME_LINES_PER_TICK = 512;

export interface ChildFramePumpOptions {
  onFrame: (frame: ChildToParent) => void;
  /** Named frame-budget failure — the runner funnels this into finish(). */
  onFail: (detail: string) => void;
  /** The run-scope settled flag — the pump drops buffered work once settled. */
  isSettled: () => boolean;
}

export class ChildFramePump {
  private stdoutBuffer = '';
  private pumping = false;
  private malformedFrameCount = 0;

  constructor(
    private readonly stdout: NodeJS.ReadableStream,
    private readonly opts: ChildFramePumpOptions,
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      // Backlog guard before the pump tick: an unterminated flood must hit the
      // named budget instead of growing the buffer without bound.
      if (this.stdoutBuffer.length > MAX_CHILD_FRAME_BUFFER_CHARS) {
        const backlog = this.stdoutBuffer.length;
        this.stdoutBuffer = '';
        this.opts.onFail(`child stdout backlog of ${backlog} chars exceeds the ${MAX_CHILD_FRAME_BUFFER_CHARS}-char buffered-frame budget`);
        return;
      }
      this.pump();
    });
  }

  /** Unparseable frames counted so far — surfaced as dwf_frame_malformed at settle. */
  get malformedFrames(): number {
    return this.malformedFrameCount;
  }

  /**
   * True while the pump still owes the settle decision work: a yield is in
   * flight or complete frames remain buffered (the child's 'close' handler
   * must drain them before declaring the child exited unfinished).
   */
  get hasPending(): boolean {
    return this.pumping || this.stdoutBuffer.includes('\n');
  }

  /** Kick one parse tick (idempotent while a tick is already in flight). */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      if (this.opts.isSettled()) {
        this.stdoutBuffer = '';
        return;
      }
      let lines = 0;
      let idx: number;
      while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
        if (idx > MAX_CHILD_FRAME_CHARS) {
          this.stdoutBuffer = '';
          this.opts.onFail(`child stdout frame of ${idx} chars exceeds the ${MAX_CHILD_FRAME_CHARS}-char single-frame budget`);
          return;
        }
        const line = this.stdoutBuffer.slice(0, idx);
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        let frame: ChildToParent;
        try {
          frame = JSON.parse(line);
        } catch {
          // Malformed frames are counted and surfaced as a run-end diagnostic
          // (dwf_frame_malformed) — tearing/garbage is never silently dropped.
          this.malformedFrameCount++;
          continue;
        }
        this.opts.onFrame(frame);
        if (++lines >= CHILD_FRAME_LINES_PER_TICK) {
          this.pump(); // yield — timers/signals stay schedulable, resume next tick
          return;
        }
      }
      if (this.stdoutBuffer.length > MAX_CHILD_FRAME_BUFFER_CHARS) {
        const backlog = this.stdoutBuffer.length;
        this.stdoutBuffer = '';
        this.opts.onFail(`child stdout backlog of ${backlog} chars exceeds the ${MAX_CHILD_FRAME_BUFFER_CHARS}-char buffered-frame budget`);
      }
    });
  }
}
