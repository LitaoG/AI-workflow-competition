/**
 * Sandbox child entry: runs the lowered facade script inside a `node:vm` realm with
 * only the facade host reachable.
 *
 * Isolation target is fault isolation and determinism, NOT a security boundary (by design): the child is a disposable process, and the realm denies the
 * script access to the host module system and Node APIs by construction — a fresh vm
 * realm has no `process`, no `require`, no `fetch`.
 *
 * The PreSeed rules below are not speculative hardening — they close a breach that
 * was actually exploited. ADV2b (cross-realm Function escape; captured in the
 * adversarial regression run dwfrun-01748f21, Issue
 * #31): the pre-#31 shape parsed args in the HOST
 * realm and injected the whole object graph into the sandbox, so
 * `args.constructor.constructor("return process")()` walked the object's host-realm
 * prototype chain to the host Function and handed the script the real host
 * `process` — from there `process.binding('spawn_sync')` executed arbitrary system
 * commands, with the run exiting 0 and looking perfectly healthy. This context's
 * `codeGeneration:{strings:false}` could NOT stop it: V8 checks code-generation
 * permission against the realm that CREATED the function being invoked, so a host
 * Function compiles its strings under the host realm's unrestricted policy
 * (probe-verified on this runtime — the escape still succeeds with the lock on);
 * the lock only refuses compilation initiated on this realm's own intrinsics
 * (realm `Function("...")` → EvalError). The root-cause control is therefore the
 * string-only crossing documented below — never let a host-realm object graph
 * become script-reachable — with the static constructor-chain ban (compile.ts
 * 9002, GAP-02) rejecting known text shapes on top of it.
 *
 * PreSeed discipline (Issue #31, aligned with the canonical engine's child-source.ts):
 * the script touches only context-native values. What crosses the boundary is:
 *   - inbound: `__argsJson` (a STRING — args are `Object.freeze(JSON.parse(...))`-ed
 *     INSIDE the realm by the BOOTSTRAP, so their prototype chain is context-native
 *     and `args.constructor.constructor` lands on the realm Function, which
 *     `codeGeneration:{strings:false}` refuses with EvalError), inbound NDJSON line
 *     strings (primitives, no realm), the budget seed `__budgetTotal` (a
 *     number-or-null PRIMITIVE — the run's output-token ceiling, parent-controlled),
 *     and two capabilities — `__send` (one function, writes one line to the real
 *     stdout) and `__timer` (waitAny's timeout) — which
 *     the BOOTSTRAP captures into closures and immediately deletes from the global
 *     object, leaving no host function reachable by the script;
 *   - outbound: `__send(string)` frames only.
 * The inbound-delivery function `__deliver` is likewise host-only: it never sits on
 * globalThis at all — the BOOTSTRAP yields it as its completion value (the last
 * expression statement, returned to the host as `vm.runInContext`'s value), so the
 * script can neither forge ok/err replies nor replay budgetSync/runInfo frames
 * (independent review round 1 boundary tightening — the realm-internal mirrors stay
 * parent-driven, as in the pre-#31 shape).
 * Everything else — `__host`, `__fanout`, `__sessions`, the Math/Date purity shadows,
 * the pending-call bookkeeping, the Tagged Error Algebra markers — is rebuilt by the
 * BOOTSTRAP inside the realm, so `.constructor` chains on any script-visible value
 * resolve to the realm's own intrinsics.
 *
 * Purity enforcement is layered: the compiler bans Date.now/Math.random/no-arg
 * `new Date` at analysis time, and this realm shadows them with throwing versions as
 * the runtime backstop, so a relaunch replays byte-identical.
 *
 * Called by the parent as: node child-main.js <scriptJsPath> <argsJson>
 * Protocol: NDJSON on stdio (see protocol.ts).
 *
 * Error algebra: whatever the script throws is converted to the domain Tagged Error
 * Algebra before it crosses the boundary as a `scriptError` frame (`error` field):
 *   - host errors rebuilt from an `err` frame keep their tag (round trip),
 *   - the realm's own contract backstops (banned constructs, purity violations)
 *     map to `CompileError` — the same tag the engine's `banned` op uses,
 *   - anything else takes the `AgentError` fallback (see toDomainError).
 */
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import readline from 'node:readline';
import { domainError, isDomainError, toDomainError, toSerializableError } from '../domain/errors.js';
import { BOOTSTRAP } from './child-bootstrap.js';

/** An `Error` that carries its tagged algebra value for the boundary conversion. */
type TaggedError = Error & { __dwfTagged?: unknown };

const scriptJsPath = process.argv[2];
const argsArg = process.argv[3] ?? '{}';
// Run-level output-token budget (canonical parity: the script cannot set it).
// argv[4] is absent for older parents and for runs with no budget.
const budgetTotalArg = process.argv[4] ?? '';
const budgetTotal = Number(budgetTotalArg);
const seededBudgetTotal = Number.isFinite(budgetTotal) && budgetTotal > 0 ? budgetTotal : null;
// Issue #266: run identity rides argv[5] — the parent knows the runId before
// spawn, so seeding it at boot removes the top-level `run.id` race with the
// asynchronously-pushed runInfo notify frame. Absent (empty) for older
// parents and direct spawns → identity arrives via the notify, as before.
const seededRunId = typeof process.argv[5] === 'string' ? process.argv[5] : '';
// G4: the parent writes args to a file (argv dies at Windows' 32,767-char limit).
// A bare '{' means an inline JSON payload (older parent) — read it directly.
const argsJson = argsArg.trimStart().startsWith('{') || argsArg.trimStart().startsWith('[')
  ? argsArg
  : fs.readFileSync(argsArg, 'utf8');

if (!scriptJsPath) {
  process.stderr.write('child-main: missing script path argument\n');
  process.exit(3);
}

function sendToParent(frame: unknown): void {
  writeOutboundLine(JSON.stringify(frame));
}

const MAX_OUTBOUND_QUEUE_CHARS = 16 * 1024 * 1024;
/**
 * Single-frame budget, mirroring the parent pump's MAX_CHILD_FRAME_CHARS
 * (frame-pump.ts, same strictly-greater trip): a frame over 16 MiB chars would
 * be named-rejected by the parent anyway — terminating here keeps the failure
 * named and stops the realm from stringifying/writing anything bigger.
 */
const MAX_SINGLE_FRAME_CHARS = 16 * 1024 * 1024;
let outboundBudgetReported = false;

/**
 * The single outbound choke point for EVERY child→parent frame — both the
 * host-produced done/scriptError frames (`sendToParent`) and every realm
 * frame: the bootstrap's `__emit` calls the captured `__send` capability, so
 * `sandbox.__send` below routes here too (Issue #58). The check MUST sit where
 * the bytes actually enter the pipe: realm frames bypassed `sendToParent`
 * entirely, so a flooding report/log script queued unbounded writes in THIS
 * heap and V8 OOMed before any parent-side defense could fire on POSIX (no
 * Job Object commit cap there — the exact scenario Issue #17's guard claimed
 * to prevent). Fail the run by name instead of dying by OOM.
 */
function writeOutboundLine(line: string): void {
  // Hard-gate backstop (Issue #58 review round 1): once the budget is reported
  // the run is terminated synchronously below, so no further line should ever
  // arrive — any that does is dropped, never written unchecked.
  if (outboundBudgetReported) return;
  // Outbound budgets — the child-side twins of the parent's frame budgets
  // (frame-pump.ts): the queue budget catches a flooding script that outpaces
  // the pipe (the queued writes live in THIS heap and V8 OOMs before any
  // parent-side defense fires on POSIX — comp Issue #17, first Linux CI
  // adversarial run); the single-frame budget catches one giant frame whose
  // stringify survived the heap (round 3: the parent-side caps all sit after
  // arrival, so without this the realm amplifies and OOMs before any gate).
  const queueOver = process.stdout.writableLength > MAX_OUTBOUND_QUEUE_CHARS;
  const frameOver = line.length > MAX_SINGLE_FRAME_CHARS;
  if (queueOver || frameOver) {
    outboundBudgetReported = true;
    const message = queueOver
      ? `ChildFrameLimitExceeded: child outbound frame queue exceeds ${MAX_OUTBOUND_QUEUE_CHARS} chars`
      : `ChildFrameLimitExceeded: child outbound single frame of ${line.length} chars exceeds the ${MAX_SINGLE_FRAME_CHARS}-char single-frame budget`;
    // Review round 2 (CI-proven, PR #59 gate run 43753392889 test 93): the
    // round-1 gate bounded the WRITE QUEUE but not the realm's own
    // allocations — the sync flood loop keeps materializing ~1 MB per log()
    // (source string + __emit's JSON.stringify) without yielding, and
    // exitAfterFlush's callback cannot fire mid-loop, so the heap still OOMed
    // (JsonStringifier) before the terminal frame could drain. Throwing back
    // into the realm cannot stop the loop either: __emit runs inside __call's
    // promise executor, so the throw only rejects the fire-and-forget log
    // promise. Terminate HERE, synchronously. The terminal frame must reach
    // the parent, so it is written straight to fd 1: it lands in the kernel
    // immediately and survives the exit that discards the stream queue with
    // its ~16 MiB of queued flood frames (those are the bytes this defense
    // exists to stop). The leading newline terminates a possibly torn
    // in-flight stream frame; on a clean boundary it is an empty line the
    // pump skips. exitAfterFlush is deliberately NOT used — its drain waits
    // on event-loop turns the loop never yields.
    const terminalFrame = '\n' + JSON.stringify({
      t: 'scriptError',
      message,
      name: 'AgentError',
    }) + '\n';
    let delivered = false;
    try {
      delivered = fs.writeSync(1, terminalFrame) === Buffer.byteLength(terminalFrame);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      // Review round 3: fd 1 delivery can fail or land PARTIAL — libuv opens
      // stdout non-blocking, so the write hits EAGAIN (the kernel pipe just
      // filled: the very reason the queue reached its budget) or EPIPE (the
      // parent is gone); a short write tears the frame. Swallowing that
      // degrades the run to an unnamed "exited before finishing". Mirror the
      // terminal frame to stderr: runner.ts:758 carries the child's stderr
      // tail (last 800 chars, redacted) into the close error, so the failure
      // stays named under any fd-1 delivery outcome.
      try {
        fs.writeSync(2, terminalFrame);
      } catch {
        // Nothing left to deliver to — the exit code below still reports it.
      }
    }
    process.exit(1);
  }
  process.stdout.write(line + '\n');
}

/**
 * process.exit() discards pending pipe writes: POSIX pipe buffers hold ~64KB,
 * so a queued fire-and-forget frame larger than the buffer (a big log/report
 * artifact) is silently torn or lost — the parent's pump never assembles it and
 * the result vanishes from the journal while the run still reports success
 * (comp Issue #17: the 315KB log round-trip came back empty on Linux CI;
 * Windows pipe buffering masked it). Drain stdout, then exit.
 */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code));
}


async function main(): Promise<void> {
  // Parent → child replies on stdin (NDJSON)
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const scriptText = fs.readFileSync(scriptJsPath, 'utf8');

  // 预Seed sandbox（Issue #31，ADV2b 的根因修复）：跨界入站只有原语（__argsJson
  // 字符串、__budgetTotal number|null）与两个即捕即删的能力（__send / __timer，
  // 由 BOOTSTRAP 捕获进闭包后从 realm 全局物理 delete）；严禁在宿主域构造对象图
  // 注入 —— 宿主对象的 .constructor.constructor 就是宿主 Function，正是 ADV2b
  // 逃逸的根因。null 原型使 sandbox 自身原型链不可能漏进全局查找（实测普通 {}
  // 作 sandbox 时 globalThis.constructor 会沿宿主 Object.prototype 解析到宿主
  // Function 并成功编译字符串 = 逃逸；contextified sandbox 的原型属性会泄成
  // realm 全局，见 ADV2b 跨域逃逸回归记录）。
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sandbox.__argsJson = argsJson;
  sandbox.__budgetTotal = seededBudgetTotal;
  // Issue #266: run identity seed — a STRING PRIMITIVE (PreSeed discipline:
  // only strings cross); the BOOTSTRAP captures + deletes it like the other
  // seeds and initializes __runState.id from it before the script evaluates.
  sandbox.__runId = seededRunId;
  // Issue #58: this capability is the realm's ONLY outbound channel — the
  // bootstrap captures it as `__out` and every `__emit` frame crosses here —
  // so it must route through the same budget choke point as the host's own
  // frames. The realm itself has no `process` (the bootstrap sees only what
  // this sandbox seeds), so the writableLength check cannot live there.
  sandbox.__send = writeOutboundLine;
  sandbox.__timer = {
    start: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms),
    clear: (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle),
  };
  const context = vm.createContext(sandbox, {
    name: 'ai-workflow-facade',
    // Claude-parity hardening: no eval/Function-in-VM string compilation, no wasm.
    // Defence-in-depth ONLY: V8 enforces this against the realm that CREATED the
    // function being invoked, so it stops compilation on this realm's own intrinsics
    // cold (realm Function("...") → EvalError) but is powerless against a leaked
    // host-realm Function, which compiles under the host realm's unrestricted policy
    // — the exact channel ADV2b used (probe-verified). What actually closes that
    // hole is the PreSeed seeding above: nothing host-realm ever becomes
    // script-reachable.
    codeGeneration: { strings: false, wasm: false },
  });
  // The BOOTSTRAP rebuilds every shim inside the realm and deletes the seed globals;
  // after this line the script-visible surface is context-native only. The BOOTSTRAP's
  // completion value is the inbound-delivery function itself — it never sits on
  // globalThis (独立评审第 1 轮边界面收紧). Mechanically: the IIFE's `return
  // __deliver` is the last expression statement of the bootstrap program, so the
  // function travels out on vm.runInContext's return — a host-side-only channel the
  // script cannot touch (the facade runs afterwards, in the same realm but outside
  // the IIFE's closure, and the return value never re-enters the realm). The host
  // holds the only reference, so a script can neither forge ok/err replies into its
  // own pending calls, nor replay budgetSync/runInfo frames to rewrite the realm's
  // mirrors, nor fake an abort (deliver is only ever invoked on real parent stdin
  // lines, and only a true 'abort' line triggers exit(2) below) — the realm-internal
  // mirrors stay parent-driven, exactly like the pre-#31 shape where inbound parsing
  // lived in the host readline callback.
  interface DeliverFunction {
    (line: string): string;
    getPending?: () => Array<{ siteId?: string; op: string }>;
    getUnawaited?: () => Array<{ siteId?: string; op: string }>;
    getActorUsage?: () => { created: string[]; used: string[] };
  }
  const deliver = vm.runInContext(BOOTSTRAP, context, { filename: 'workflow-bootstrap.js' }) as DeliverFunction;
  if (typeof deliver !== 'function') {
    process.stderr.write('child-main: bootstrap did not yield the inbound delivery function\n');
    process.exit(3);
  }

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (deliver(trimmed) === 'abort') {
      process.exit(2);
    }
  });
  // Engine-owned zero-orphan guarantee (GOAL.md 铁律 3 / 差距矩阵 D7): stdin is
  // the parent→child NDJSON channel — EOF means the parent is gone (crashed or
  // force-killed without a tree kill). No reply can ever arrive again and no
  // host call can cross back, so lingering would only orphan this process on
  // hosts without a job-object coupling. Exit immediately on close.
  rl.on('close', () => {
    process.exit(0);
  });

  const script = new vm.Script(scriptText, { filename: 'workflow.facade.js' });

  try {
    script.runInContext(context); // defines __workflowScript__ in the realm
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = (vm.runInContext('__workflowScript__()', context) as any) as Promise<unknown>;
    const value = await runner;
    // Done-time sentinel audit (Issue #279, CAP-007). Two complementary nets:
    //   1. consumption net — `getUnawaited()` lists every non-fire-and-forget
    //      call whose promise was never consumed via then/catch/finally (await
    //      included), whether or not the host already settled it. This is the
    //      half the old in-flight-only check lost: an ok frame arriving while
    //      the script dropped the promise used to erase the call from
    //      `__pending` and the run reported `completed` over a discarded result.
    //   2. in-flight net — `getPending()` still catches calls awaiting a reply
    //      at done-time (e.g. consumed only via a callback that has not fired).
    const unawaitedCalls = typeof deliver.getUnawaited === 'function' ? deliver.getUnawaited() : [];
    const pendingCalls = typeof deliver.getPending === 'function' ? deliver.getPending() : [];
    const offenders = unawaitedCalls.length > 0 ? unawaitedCalls : pendingCalls;
    if (offenders.length > 0) {
      const first = offenders[0]!;
      const siteDesc = first.siteId ?? 'unknown';
      const fixSuggestion = 'add `await` (or .then/.catch/.finally) at the call site so the result is consumed';
      const msg = `workflow execution failed: unawaited facade call (site ${siteDesc}, op ${first.op}) was never awaited — ${fixSuggestion}`;
      const err = new Error(msg);
      err.name = 'WorkflowUnawaitedPromiseError';
      (err as TaggedError).__dwfTagged = domainError('WorkflowUnawaitedPromiseError', msg, {
        details: { siteId: first.siteId, op: first.op, fixSuggestion },
      });
      throw err;
    }
    // Issue #58: if the outbound budget breached mid-run, the run terminated
    // synchronously at the breach point and control never reaches here — this
    // guard is the backstop that keeps a done frame from ever following a
    // budget scriptError out of the pipe (one terminal frame per run; the
    // parent settles on the first, so double-emitting is at best noise and at
    // worst a completed verdict racing a failed one).
    if (!outboundBudgetReported) {
      sendToParent({ t: 'done', value: value === undefined ? null : value });
      exitAfterFlush(0);
    }
  } catch (err) {
    const e = err as Error;
    // Boundary conversion (Tagged Error Algebra): a host error re-raised through
    // the realm keeps its tag; the realm's own backstops already carry theirs;
    // any other thrown value — including non-Error junk — takes the AgentError
    // fallback. `message`/`stack`/`name` stay byte-compatible for old parents.
    const attached = (err as TaggedError | null | undefined)?.__dwfTagged;
    const tagged = toSerializableError(isDomainError(attached) ? attached : toDomainError(err));
    sendToParent({ t: 'scriptError', message: e?.message ?? String(err), stack: e?.stack, name: e?.name, error: tagged });
    exitAfterFlush(1);
  }
}

void main();
