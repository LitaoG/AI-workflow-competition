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
 * `sandbox.__send` route through. Over the limit the child writes the existing
 * ChildFrameLimitExceeded scriptError frame past the closed gate (so the named
 * failure reaches the pipe), DROPS every subsequent outbound line — review
 * round 1: the sync flood loop never yields, so an unchecked tail would keep
 * growing the queue past any bound and V8-OOM before the terminal frame can
 * drain; dropping it stops heap growth at the breach — suppresses the later
 * done frame (one terminal frame per run), and exits 1 once the queue drains.
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
 * bound 19. The 2,000-frame tail-flood case (≈1 GiB nominal) exists precisely
 * because the 64/48-frame cases stay within 2× of the budget: before the hard
 * gate, the post-breach tail still queued unchecked and only the parent's
 * killTree race hid it.
 *
 * PLATFORM SCOPE [probe-verified on win32, 2026-11-16, Node v26.13.0]: on
 * Windows, stdout pipe writes are SYNCHRONOUS (Node docs: "Pipes: synchronous
 * on Windows and Linux, asynchronous on macOS") — with a reading pump
 * writableLength stays 0 through a 32 MiB flood, and with a non-reading pipe
 * write() blocks instead of queueing; `stdio: 'overlapped'` behaves the same,
 * and a TCP socket is rejected as stdio (spawn ENOTSUP). The child queue can
 * therefore never accumulate on win32 and the flood legitimately completes
 * there — the tests are skipped on win32 and exercised by the ubuntu-latest
 * CI.
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
  // parent's killTree racing the child's tail.
  assert.ok(r.logCount >= 1 && r.logCount <= 33, `frames flowed before the breach and the flood tail never reached the parent: ${r.logCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a sync report flood past the 16 MiB child queue budget fails the run by name (ChildFrameLimitExceeded, child outbound frame queue)', { timeout: 60_000, skip: WIN32_SKIP }, async () => {
  const r = await runFlood(REPORT_FLOOD_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /child outbound frame queue exceeds 16777216 chars/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  assert.ok(r.reportCount >= 1 && r.reportCount <= 19, `reports flowed before the breach and the flood tail never reached the parent: ${r.reportCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});

test('a ~1 GiB log tail flood (2000 frames) is still a named failure: the post-breach tail is dropped, not queued (review round 1 hard gate)', { timeout: 60_000, skip: WIN32_SKIP }, async () => {
  const r = await runFlood(LOG_TAIL_FLOOD_SCRIPT);
  assert.equal(r.status, 'failed', `expected named failure, got ${r.status}: ${r.error ?? ''}`);
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /child outbound frame queue exceeds 16777216 chars/);
  assert.equal(r.value, undefined, `no done value may be reported: ${JSON.stringify(r.value)}`);
  // The tail (~1,967 frames ≈ 1 GiB) must be DROPPED at the gate: the parent
  // still sees only the ≤32 pre-breach frames — the heap stops growing at the
  // breach instead of racing the drain toward a V8 OOM.
  assert.ok(r.logCount >= 1 && r.logCount <= 33, `only pre-breach frames may reach the parent, tail must be dropped: ${r.logCount}`);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms — must fail fast, not hang or OOM`);
});
