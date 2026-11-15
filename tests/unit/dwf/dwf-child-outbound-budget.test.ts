/**
 * Child-side outbound frame budget — the realm path (Issue #58).
 *
 * Issue #17 (eb6974a) placed the child's writableLength queue check on
 * `sendToParent` only, which the host calls for its own done/scriptError
 * frames. Every REALM outbound frame (log/report/call/notify — all `__emit`
 * shapes in child-bootstrap.ts) crossed the captured `__send` capability
 * straight to `process.stdout.write`, bypassing the check: a flooding script
 * queued unbounded writes in the child heap and V8 OOMed before any
 * parent-side defense could fire on POSIX (no Job Object commit cap there) —
 * the exact scenario the Issue #17 guard claims to fail by name.
 *
 * The fix sinks the check to the single outbound choke point
 * (`writeOutboundLine` in child-main.ts) that both `sendToParent` and
 * `sandbox.__send` route through. Over the limit the child TERMINATES the
 * script synchronously at the breach: the terminal ChildFrameLimitExceeded
 * scriptError frame is written straight to fd 1 — it lands in the kernel and
 * survives the immediate exit that discards the stream queue with its ~16 MiB
 * of queued flood frames (a leading newline absorbs a possibly torn in-flight
 * stream frame) — and the realm's sync flood loop cannot keep allocating.
 * Review round 2 (CI-proven, gate run 43753392889 test 93): bounding the
 * write queue alone still OOMed a 2,000-frame flood inside the realm's
 * JSON.stringify, because neither write-completion callbacks nor a throw
 * through __call's promise executor (which would only reject the
 * fire-and-forget log promise) can stop a loop that never yields. The later
 * done frame stays suppressed — one terminal frame per run.
 *
 * The flood cases below drive the REAL child (no childEntryPath override —
 * the default resolves to the compiled child-main.js beside the runner) with
 * facade scripts that flood log()/report() in one synchronous loop: on POSIX,
 * pipe writes are asynchronous, so the whole loop queues before ANY write
 * completion can interleave (completions need event-loop turns a sync loop
 * never yields) and `writableLength` crosses the 16 MiB queue budget
 * deterministically mid-loop — the accumulation mechanism comp Issue #17
 * observed as a V8 OOM on Linux CI before the named failure existed. Each
 * frame stays under every per-frame ceiling (parent single-frame budget
 * 16 MiB chars, pump backlog budget 32 MiB chars for parsed lines, engine log
 * per-message cap 16 MiB chars, engine report per-item cap 1,000,000 bytes) so
 * the ONLY gate that can fire is the child-side queue budget — the error text
 * (`child outbound frame queue exceeds …`) distinguishes it from the parent
 * pump's gates (`single-frame budget` / `backlog`).
 *
 * Bounded-flood arithmetic (drives the event-count upper bounds below, so no
 * assertion depends on the parent's killTree racing the child's tail):
 * a log frame line is 524,288 (message) + ≤64 (JSON shell) chars, so at most
 * 32 lines fit under the 16 MiB queue budget (32 × 524,352 = 16,779,264 > MAX
 * trips the check before frame 33; 31 × 524,352 = 16,254,912 < MAX admits
 * frame 32) → the parent can never see more than 32 logs; bound 33 keeps a
 * +1 margin. A report frame line is 921,612 (item JSON) + ~74 (shell) chars →
 * at most 18 fit (18 × 921,760 = 16,591,680 < MAX; 19 × = 17,513,440 > MAX);
 * bound 19. With the breach terminating the child synchronously, how many
 * pre-breach frames had fully reached the parent is pipe-timing (the queued
 * tail is discarded with the stream), so only the upper bound is asserted —
 * 0 pre-breach frames is legitimate (the terminal frame alone decides the
 * verdict). The 2,000-frame tail-flood case (≈1 GiB nominal) exists precisely
 * because the 64/48-frame cases stay within 2× of the budget: it is the shape
 * that exposed the round-1 write-queue-only gate OOMing in the realm.
 *
 * Round 3 additions: the single-frame and log-source gates are
 * transport-independent (they read the line/message length, not the queue), so
 * their cases run on BOTH platforms — on win32 they are the only locally
 * executable evidence for this suite. The log-source gate (child-bootstrap
 * __host.log, checked BEFORE __call's __emit stringifies) throws synchronously
 * into the script so a giant message cannot double in the stringify; the
 * single-frame gate (writeOutboundLine, mirroring frame-pump's
 * MAX_CHILD_FRAME_CHARS) catches any op whose wire frame still exceeds
 * 16 MiB chars. The under-budget positive case (30 × 512 KiB ≈ 15.7 MiB <
 * 16 MiB) pins that legitimate output is never killed: on POSIX the whole
 * burst queues under the budget, on win32 it flows — both must complete.
 *
 * PLATFORM SCOPE [probe-verified on win32, 2026-11-16, local Node v26.13.0;
 * engines >=22, CI runs 22.23.4 — the conclusion rests on stdout pipe write
 * semantics, identical across these runtimes]: on Windows, stdout pipe writes
 * are SYNCHRONOUS (Node docs: "Pipes: synchronous on Windows and Linux,
 * asynchronous on macOS") — with a reading pump writableLength stays 0 through
 * a 32 MiB flood, and with a non-reading pipe write() blocks instead of
 * queueing; `stdio: 'overlapped'` behaves the same, and a TCP socket is
 * rejected as stdio (spawn ENOTSUP). The child QUEUE can therefore never
 * accumulate on win32 and a queue-shaped flood legitimately completes there —
 * the three queue-shaped cases are skipped on win32 and exercised by the
 * ubuntu-latest CI. The single-frame / log-source / under-budget cases below
 * read lengths, not the queue, and run on both platforms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../../src/dwf/runner.js';

const WIN32_SKIP =
  process.platform === 'win32'
    ? 'Windows pipe stdout writes are synchronous (Node docs; probe-verified: writableLength stays 0 under a reading pump, write() blocks under a non-reading pump, stdio overlapped identical, TCP-socket stdio = spawn ENOTSUP) — the child queue never accumulates on win32 and the flood legitimately completes. The budget fires on POSIX (async pipe writes; the comp Issue #17 Linux CI OOM mechanism) and is exercised by the ubuntu-latest CI.'
    : false;

const LOG_FLOOD_SCRIPT = [
  'phase("P1");',
  'for (let i = 0; i < 64; i++) {',
  '  log("F".repeat(512 * 1024));',
  '}',
  'return { flooded: "log" };',
].join('\n');

const REPORT_FLOOD_SCRIPT = [
  'phase("P1");',
  'const item = { blob: "R".repeat(900 * 1024) };',
  'for (let i = 0; i < 48; i++) {',
  '  report(item);',
  '}',
  'return { flooded: "report" };',
].join('\n');

/**
 * ≈1 GiB nominal tail flood (2,000 × 512 KiB, ~32× the queue budget): the
 * breach fires around frame 33 and the hard gate must DROP the remaining
 * ~1,967 frames — pre-hard-gate they queued unchecked and only the parent's
 * killTree race decided between a named failure and the V8 OOM this defense
 * exists to prevent.
 */
const LOG_TAIL_FLOOD_SCRIPT = [
  'phase("P1");',
  'for (let i = 0; i < 2000; i++) {',
  '  log("F".repeat(512 * 1024));',
  '}',
  'return { flooded: "log-tail" };',
].join('\n');

/** One giant log message: caught by the bootstrap __host.log source gate BEFORE __emit stringifies it (round 3). */
const SINGLE_GIANT_LOG_SCRIPT = [
  'phase("P1");',
  'log("F".repeat(17 * 1024 * 1024));',
  'return { flooded: "giant-log" };',
].join('\n');

/** One giant report item: stringify survives the heap, the writeOutboundLine single-frame budget terminates (round 3). */
const SINGLE_GIANT_REPORT_SCRIPT = [
  'phase("P1");',
  'report({ blob: "F".repeat(17 * 1024 * 1024) });',
  'return { flooded: "giant-report" };',
].join('\n');

/** 30 x 512 KiB ≈ 15.7 MiB < 16 MiB: legitimate output the gates must NEVER kill (round 3 positive case). */
const UNDER_BUDGET_SCRIPT = [
  'phase("P1");',
  'for (let i = 0; i < 30; i++) {',
  '  log("F".repeat(512 * 1024));',
  '}',
  'return { flooded: "under-budget" };',
].join('\n');

interface RunOutcome {
  status: string;
  error?: string;
  value?: unknown;
  logCount: number;
  reportCount: number;
  wallMs: number;
}

/** Runs a flood facade script through the real sandbox child (default child entry). */
async function runFlood(scriptText: string, runTimeoutMs = 45_000): Promise<RunOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-outbound-budget-'));
  let logCount = 0;
  let reportCount = 0;
  const t0 = Date.now();
  try {
    const scriptPath = path.join(dir, 'flood.facade.ts');
    fs.writeFileSync(scriptPath, scriptText);
    const result = await runFacadeScript({
      scriptPath,
      cwd: dir,
      dbPath: path.join(dir, 'journal.sqlite'),
      args: {},
      runTimeoutMs,
      onEvent: (e) => {
        // Count only — retaining 512 KiB messages would needlessly balloon the
        // test process; the verdict under test is the terminal status/error.
        if (e.type === 'dwf_log') logCount += 1;
        if (e.type === 'dwf_report') reportCount += 1;
      },
    });
    return {
      status: result.status,
      error: result.error,
      value: result.value,
      logCount,
      reportCount,
      wallMs: Date.now() - t0,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
  }
}

test('a sync log flood past the 16 MiB child queue budget fails the run by name (ChildFrameLimitExceeded, child outbound frame queue)', { timeout: 60_000, skip: WIN32_SKIP }, async () => {
  const r = await runFlood(LOG_FLOOD_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  // The child-side message shape — NOT the parent pump's "single-frame budget"/"backlog" gates.
  assert.match(r.error ?? '', /child outbound frame queue exceeds 16777216 chars/);
  // The value must never complete: the budget scriptError suppresses the done frame.
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  // Bounded by the queue arithmetic (≤32 pre-breach frames), NOT by the
  // parent's killTree racing the child's tail. No lower bound: with the
  // breach terminating the child synchronously, how many pre-breach frames
  // fully reached the parent is pipe-timing — the terminal frame alone
  // decides the verdict.
  assert.ok(r.logCount <= 33, `the flood tail can never reach the parent: ${r.logCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a sync report flood past the 16 MiB child queue budget fails the run by name (ChildFrameLimitExceeded, child outbound frame queue)', { timeout: 60_000, skip: WIN32_SKIP }, async () => {
  const r = await runFlood(REPORT_FLOOD_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /child outbound frame queue exceeds 16777216 chars/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  assert.ok(r.reportCount <= 19, `the flood tail can never reach the parent: ${r.reportCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a ~1 GiB log tail flood (2000 frames) is still a named failure: the child terminates at the breach instead of OOMing (review round 2)', { timeout: 60_000, skip: WIN32_SKIP }, async () => {
  const r = await runFlood(LOG_TAIL_FLOOD_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /child outbound frame queue exceeds 16777216 chars/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  // The tail (~1,967 frames ≈ 1 GiB) can never reach the parent; the child
  // dies at the breach with the named frame on fd 1 instead of racing the
  // realm's own allocations toward a V8 OOM (the round-1 CI failure shape).
  assert.ok(r.logCount <= 33, `only pre-breach frames may reach the parent: ${r.logCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a single giant log message is named-rejected by the source gate before the stringify doubling (round 3; transport-independent — runs on win32 too)', { timeout: 60_000 }, async () => {
  const r = await runFlood(SINGLE_GIANT_LOG_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  // The bootstrap __host.log source gate message — the frame was never
  // stringified, so the queue/single-frame budget messages cannot appear.
  assert.match(r.error ?? '', /log message is \d+ chars, over the 16777216-char single-frame cap/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a single giant report frame is named-rejected by the child-side single-frame budget (round 3; transport-independent — runs on win32 too)', { timeout: 60_000 }, async () => {
  const r = await runFlood(SINGLE_GIANT_REPORT_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  // The writeOutboundLine single-frame budget message — mirrors the parent
  // pump's single-frame gate shape, fires before the parent sees the frame.
  assert.match(r.error ?? '', /child outbound single frame of \d+ chars exceeds the 16777216-char single-frame budget/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('an under-budget log burst (30 x 512 KiB ≈ 15.7 MiB < 16 MiB) completes normally — legitimate output is never killed (round 3 positive case)', { timeout: 60_000 }, async () => {
  const r = await runFlood(UNDER_BUDGET_SCRIPT);
  assert.equal(r.status, 'completed', `under-budget output must complete, got ${r.status}: ${r.error ?? ''}`);
  assert.deepEqual(r.value, { flooded: 'under-budget' });
  // All 30 frames journaled: on POSIX they queue under the budget and drain
  // before exitAfterFlush(0), on win32 they flow — no gate may fire here.
  assert.equal(r.logCount, 30);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must complete fast`);
});
