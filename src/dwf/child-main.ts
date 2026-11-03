/**
 * Sandbox child entry: runs the lowered facade script inside a `node:vm` realm with
 * only the facade host reachable.
 *
 * Isolation target is fault isolation and determinism, NOT a security boundary (same
 * as the official engine): the child is a disposable process, and the realm denies the
 * script access to the host module system and Node APIs by construction — a fresh vm
 * realm has no `process`, no `require`, no `fetch`.
 *
 * PreSeed discipline (Issue #31, aligned with the official engine's child-source.ts):
 * the script touches only context-native values. What crosses the boundary is:
 *   - inbound: `__argsJson` (a STRING — args are `Object.freeze(JSON.parse(...))`-ed
 *     INSIDE the realm by the BOOTSTRAP, so their prototype chain is context-native
 *     and `args.constructor.constructor` lands on the realm Function, which
 *     `codeGeneration:{strings:false}` refuses with EvalError), inbound NDJSON line
 *     strings (primitives, no realm), and two capabilities — `__send` (one function,
 *     writes one line to the real stdout) and `__timer` (waitAny's timeout) — which
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
import { isDomainError, toDomainError, toSerializableError } from '../domain/errors.js';

/** An `Error` that carries its tagged algebra value for the boundary conversion. */
type TaggedError = Error & { __dwfTagged?: unknown };

const scriptJsPath = process.argv[2];
const argsArg = process.argv[3] ?? '{}';
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
  process.stdout.write(JSON.stringify(frame) + '\n');
}

/**
 * The realm's boot program (Issue #31 预Seed). Pure JS with no backticks/`${}` so it
 * sits safely inside a template literal. Runs ONCE inside the context; every binding
 * it creates is context-native. Shape contracts mirrored from the host side:
 *   - `__tagged` reproduces `domainError(tag, message, {details})`'s plain-object
 *     shape (`src/domain/errors.ts`) so the host's `isDomainError`/`toSerializableError`
 *     boundary conversion reads it unchanged;
 *   - frame shapes reproduce the NDJSON wire protocol byte-for-byte (protocol.ts).
 */
const BOOTSTRAP = `"use strict";
(function () {
  // —— The only host capabilities that ever cross: captured, then deleted from the
  // global object so no host function stays reachable by the script (Issue #31). ——
  var __out = globalThis.__send;
  var __timer = globalThis.__timer;
  var __seedArgsJson = globalThis.__argsJson;
  delete globalThis.__send;
  delete globalThis.__timer;
  delete globalThis.__argsJson;
  if (
    typeof __out !== 'function' ||
    __timer === null || typeof __timer !== 'object' || typeof __timer.start !== 'function' || typeof __timer.clear !== 'function' ||
    typeof __seedArgsJson !== 'string'
  ) {
    throw new Error('child-main bootstrap: sandbox seed missing');
  }

  var __nextId = 0;
  var __pending = new Map();
  /** Actors created in this realm — createActor is synchronous (no IPC round-trip). */
  var __localActors = new Set();
  /** Pending ask promises → their child call id, so sessions.cancel can route an abort. */
  var __cancellable = new Map();
  /** Budget mirror: parent pushes spent totals; total is script-set and notified back. */
  var __budget = { total: null, spent: 0 };
  /** Branch-level hole parking: how many hole() calls are parked awaiting fills. */
  var __openHoles = 0;
  /** P3: run identity — frozen object pushed by the parent's runInfo frame. */
  var __runState = { id: '' };

  var __DOMAIN_TAGS = ['CompileError', 'SchemaValidationError', 'SandboxTimeout', 'SandboxSpawnError', 'StorageError', 'ProberError', 'AgentError', 'McpError', 'JournalMismatchError'];
  function __isDomainError(value) {
    return typeof value === 'object' && value !== null &&
      typeof value.message === 'string' && __DOMAIN_TAGS.includes(value.tag);
  }
  /** Tagged Error Algebra marker (host mirror: domainError + withTagged). */
  function __tagged(tag, message, details) {
    var error = new Error(message);
    error.__dwfTagged = details === undefined
      ? { tag: tag, message: message }
      : { tag: tag, message: message, details: details };
    return error;
  }
  /** A purity backstop enforces a compile-time ban at runtime → CompileError (same tag as the engine's banned op). */
  function __purityViolation(construct, message) {
    return __tagged('CompileError', message, { construct: construct });
  }

  function __emit(obj) {
    __out(JSON.stringify(obj));
  }

  function __call(op, siteId, payload) {
    var id = ++__nextId;
    var promise = new Promise(function (resolve, reject) {
      __pending.set(id, { resolve: resolve, reject: reject });
      __emit({ t: 'call', id: id, op: op, siteId: siteId, payload: payload });
    });
    if (op === 'ask') __cancellable.set(promise, id);
    var cleanup = function () {
      __cancellable.delete(promise);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  globalThis.__host = {
    // createActor must return the actor object synchronously — the script chains
    // \`.ask()\` straight off it without an await. The name goes to the parent as a
    // fire-and-forget notify frame.
    createActor: function (siteId, name, provider) {
      __localActors.add(siteId);
      __emit({ t: 'notify', op: 'actorCreated', siteId: siteId, name: String(name ?? siteId), provider: provider === null || provider === undefined ? undefined : String(provider) });
      return { __actor: siteId };
    },
    ask: function (siteId, actor, prompt, schema) {
      if (
        !actor || typeof actor !== 'object' ||
        !__localActors.has(actor.__actor ?? '')
      ) {
        var message = 'ask() receiver is not an actor created by agent() in this run (site ' + siteId + ')';
        return Promise.reject(__tagged('AgentError', message, { siteId: siteId }));
      }
      return __call('ask', siteId, [actor, prompt, schema]);
    },
    enterPhase: function (name) {
      return __call('enterPhase', undefined, [name]);
    },
    // lower.ts emits __host.log("log#N", message) / __host.report("report#N", item) —
    // the first parameter is the journal siteId, the second is the real payload.
    log: function (siteId, message) {
      return __call('log', siteId, [message]);
    },
    report: function (siteId, item) {
      return __call('report', siteId, [item]);
    },
    artifact: function (siteId, kind, args) {
      return __call('artifact', siteId, [kind, args]);
    },
    worldRead: function (siteId, op, args) {
      return __call('worldRead', siteId, [op, args]);
    },
    worldRun: function (siteId, cmd, args, opts) {
      return __call('worldRun', siteId, [cmd, args, opts]);
    },
    hole: function (siteId, name, prompt) {
      __openHoles += 1;
      return __call('hole', siteId, [name, prompt]);
    },
    escalate: function (siteId, question) {
      return __call('escalate', siteId, [question]);
    },
    workflow: function (siteId, name) {
      return __call('workflow', siteId, [name]);
    },
    // Banned constructs are the compile ban's runtime backstop → CompileError, the
    // same tag the engine's banned op replies with.
    banned: function (what) {
      var message = String(what) + ' is banned in facade scripts';
      return Promise.reject(__tagged('CompileError', message, { construct: String(what) }));
    },
    // 运行实参在 context 内解析重建（官方 child-source.ts:202-206 纪律）：脚本的
    // args 原型链是 context-native 的，.constructor 落在 realm Function 上，被
    // codeGeneration:{strings:false} 以 EvalError 拒绝。Object.freeze 是浅冻结：
    // 挡的是"手滑重新赋值 args"，不是安全边界（实参本来就是调用方给的）。
    args: Object.freeze(JSON.parse(__seedArgsJson)),
    // P3 run identity: bare \`run\` is lowered to __host.run (lower.ts) — frozen on
    // first runInfo receipt, matching facade-dts's \`declare const run\` readonly shape.
    get run() {
      return __runState;
    },
    // Budget mirror (独立工程调准): the script sets
    // total (notified to the enforcer), spent() reflects the parent's completed asks.
    budget: {
      get total() {
        return __budget.total;
      },
      set total(v) {
        __budget.total = typeof v === 'number' && v > 0 ? v : null;
        __emit({ t: 'notify', op: 'budgetSync', spent: -1, total: __budget.total });
      },
      spent: function () {
        return __budget.spent;
      },
      remaining: function () {
        return __budget.total == null ? Infinity : Math.max(0, __budget.total - __budget.spent);
      },
    },
  };

  /**
   * Fan-out primitives (Claude-exact semantics, local to the realm — the thunks call
   * __host.ask which is already journalled; slot concurrency is enforced by the
   * parent's seat gate + AIMD):
   * - parallel: allSettled; a failed thunk maps to null; budget-exceeded drops get a
   *   summary line exactly like Claude's "parallel: N slots dropped".
   * - pipeline: each item flows through all stages independently; a null result stops
   *   that item's downstream stages.
   */
  globalThis.__fanout = {
    parallel: async function (thunks) {
      if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions');
      for (const t of thunks) {
        if (typeof t !== 'function') throw new TypeError('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)');
      }
      if (thunks.length === 0) return [];
      const settled = await Promise.allSettled(thunks.map((t) => Promise.resolve().then(t)));
      let dropped = 0;
      const mapped = settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') return outcome.value;
        const name = outcome.reason?.name ?? '';
        const msg = outcome.reason?.message ?? String(outcome.reason);
        if (name === 'WorkflowBudgetExceededError') {
          dropped++;
          return null;
        }
        void __call('log', undefined, ['parallel[' + i + '] failed: ' + msg]);
        return null;
      });
      if (dropped > 0) void __call('log', undefined, ['parallel: ' + dropped + ' ' + (dropped === 1 ? 'slot' : 'slots') + ' dropped — token budget exceeded']);
      return mapped;
    },
    pipeline: async function (items) {
      const stages = Array.prototype.slice.call(arguments, 1);
      if (!Array.isArray(items)) throw new TypeError('pipeline() expects an array as the first argument');
      for (const stage of stages) {
        if (typeof stage !== 'function') throw new TypeError('pipeline() stages must be functions: pipeline(items, item => ..., result => ...)');
      }
      if (items.length === 0) return [];
      const settled = await Promise.allSettled(items.map((item, index) =>
        Promise.resolve().then(async () => {
          let value = item;
          for (const stage of stages) {
            if (value === null) break;
            value = await stage(value, item, index);
          }
          return value;
        }),
      ));
      let dropped = 0;
      const mapped = settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') return outcome.value;
        const name = outcome.reason?.name ?? '';
        const msg = outcome.reason?.message ?? String(outcome.reason);
        if (name === 'WorkflowBudgetExceededError') {
          dropped++;
          return null;
        }
        void __call('log', undefined, ['pipeline[' + i + '] failed: ' + msg]);
        return null;
      });
      if (dropped > 0) void __call('log', undefined, ['pipeline: ' + dropped + ' ' + (dropped === 1 ? 'slot' : 'slots') + ' dropped — token budget exceeded']);
      return mapped;
    },
  };

  /**
   * Sessionful-worker coordination, implemented locally in the realm: waitAny is pure
   * promise racing (its timeout borrows the captured __timer capability); cancel
   * routes an abort to the parent by the ask's child call id.
   */
  globalThis.__sessions = {
    waitAny: function (turns, opts) {
      const anyTurn = Promise.any(turns);
      if (!opts?.timeoutMs) return anyTurn;
      let timeoutHandle;
      const timeout = new Promise((resolve, reject) => {
        timeoutHandle = __timer.start(function () {
          reject(new Error('waitAny timed out after ' + opts.timeoutMs + 'ms — nobody settled in time'));
        }, opts.timeoutMs);
      });
      return Promise.race([
        anyTurn.finally(function () {
          __timer.clear(timeoutHandle);
        }),
        timeout,
      ]);
    },
    cancel: function (turn) {
      const callId = __cancellable.get(turn);
      if (callId !== undefined) {
        __emit({ t: 'notify', op: 'cancelCall', cancelId: callId });
      }
      // already-settled turns are a no-op: cancellation only applies to pending work
    },
  };

  // —— 运行期禁令（belt；编译诊断是 suspenders）：Date.now / argless new Date() / Math.random ——
  // 全部在 context 内构造：Math 影子是 context 对象，Date 影子返回 context Date 实例。
  const __PureMath = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    __PureMath[key] = Math[key];
  }
  __PureMath.random = function () {
    throw __purityViolation('Math.random', 'Purity violation: Math.random() is banned in facade scripts. Pass randomness via args so a relaunch replays byte-identical.');
  };
  globalThis.Math = __PureMath;

  const __NativeDate = Date;
  const __SafeDate = function (...ctorArgs) {
    if (!(this instanceof __SafeDate)) {
      if (ctorArgs.length === 0) {
        throw __purityViolation('Date', 'Purity violation: Date() without arguments is banned in facade scripts. Pass timestamps via args.');
      }
      return new __NativeDate(...ctorArgs);
    }
    if (ctorArgs.length === 0) {
      throw __purityViolation('new Date', 'Purity violation: new Date() without arguments is banned in facade scripts. Pass timestamps via args.');
    }
    return new __NativeDate(...ctorArgs);
  };
  Object.setPrototypeOf(__SafeDate, __NativeDate);
  __SafeDate.now = function () {
    throw __purityViolation('Date.now', 'Purity violation: Date.now() is banned in facade scripts. Pass timestamps via args so a relaunch replays byte-identical.');
  };
  __SafeDate.parse = __NativeDate.parse;
  __SafeDate.UTC = __NativeDate.UTC;
  globalThis.Date = __SafeDate;

  // —— 入站 reply 消费（由外层 realm 以行字符串调用；解析发生在 context 内）——
  // ⚠ 此函数**从不挂上 globalThis**：它是本引导源最后一个表达式语句的值，作为完成值
  // 交宿主持有（宿主逐行调用）。入站投递机器对脚本不可达——脚本不能伪造 ok/err
  // reply / budgetSync / runInfo，abort 判定只在宿主侧真实 stdin 行上发生
  // （独立评审第 1 轮边界面收紧）。返回 'abort' 交外层 exit(2)；childIdle 的发射
  // 条件与原宿主侧实现逐字一致（每条已解析行处理后：pending 清空且仍有 parked hole）。
  var __deliver = function (line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return ''; // ignore malformed lines; the protocol is ours on both ends
    }
    if (frame.t === 'ok' && typeof frame.id === 'number') {
      const waiter = __pending.get(frame.id);
      __pending.delete(frame.id);
      if (waiter) waiter.resolve(frame.value);
    } else if (frame.t === 'err' && typeof frame.id === 'number') {
      const waiter = __pending.get(frame.id);
      __pending.delete(frame.id);
      if (waiter) {
        const e = new Error(frame.message ?? 'host error');
        if (frame.name) e.name = frame.name;
        // Keep the host's tagged error for the boundary conversion: a scriptError
        // re-raise preserves the tag/details across the protocol round trip. Old
        // hosts (no \`error\` field) rebuild a plain named Error exactly as before.
        if (__isDomainError(frame.error)) e.__dwfTagged = frame.error;
        waiter.reject(e);
      }
    } else if (frame.t === 'notify' && frame.op === 'budgetSync') {
      if (typeof frame.spent === 'number' && frame.spent >= 0) __budget.spent = frame.spent;
    } else if (frame.t === 'notify' && frame.op === 'runInfo') {
      __runState.id = String(frame.runId ?? '');
      if (frame.resumedFrom) __runState.resumedFrom = String(frame.resumedFrom);
      Object.freeze(__runState); // first push completes run identity — readonly per facade-dts
    }
    // Branch-level hole parking: after each reply the child reports idle — the parent
    // parks precisely when the realm has nothing left but parked holes (no timers).
    if (__pending.size === 0 && __openHoles > 0) {
      __emit({ t: 'notify', op: 'childIdle' });
    }
    return frame.t === 'abort' ? 'abort' : '';
  };
  // 引导源的完成值：唯一一个不经 globalThis 交宿主的 realm 函数引用。
  return __deliver;
})();
`;

async function main(): Promise<void> {
  // Parent → child replies on stdin (NDJSON)
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const scriptText = fs.readFileSync(scriptJsPath, 'utf8');

  // 预Seed sandbox（Issue #31）：跨界入站只有字符串（__argsJson）与两个即捕即删的
  // 能力（__send / __timer）；null 原型使 sandbox 自身原型链不可能漏进全局查找
  // （contextified sandbox 的原型属性会泄成 realm 全局，node:vm 的既有已知行为）。
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sandbox.__argsJson = argsJson;
  sandbox.__send = (line: string): void => {
    process.stdout.write(line + '\n');
  };
  sandbox.__timer = {
    start: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms),
    clear: (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle),
  };
  const context = vm.createContext(sandbox, {
    name: 'ai-workflow-facade',
    // Claude-parity hardening: no eval/Function-in-VM string compilation, no wasm
    codeGeneration: { strings: false, wasm: false },
  });
  // The BOOTSTRAP rebuilds every shim inside the realm and deletes the seed globals;
  // after this line the script-visible surface is context-native only. The BOOTSTRAP's
  // completion value is the inbound-delivery function itself — it never sits on
  // globalThis (独立评审第 1 轮边界面收紧): the host holds the only reference, so a
  // script can neither forge ok/err replies into its own pending calls nor replay
  // budgetSync/runInfo frames — the realm-internal mirrors stay parent-driven,
  // exactly like the pre-#31 shape where inbound parsing lived in the host readline
  // callback.
  const deliver = vm.runInContext(BOOTSTRAP, context, { filename: 'workflow-bootstrap.js' }) as (line: string) => string;
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
  // Engine-owned zero-orphan guarantee (引擎的零孤儿进程铁律): stdin is
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
    sendToParent({ t: 'done', value: value === undefined ? null : value });
    process.exit(0);
  } catch (err) {
    const e = err as Error;
    // Boundary conversion (Tagged Error Algebra): a host error re-raised through
    // the realm keeps its tag; the realm's own backstops already carry theirs;
    // any other thrown value — including non-Error junk — takes the AgentError
    // fallback. `message`/`stack`/`name` stay byte-compatible for old parents.
    const attached = (err as TaggedError | null | undefined)?.__dwfTagged;
    const tagged = toSerializableError(isDomainError(attached) ? attached : toDomainError(err));
    sendToParent({ t: 'scriptError', message: e?.message ?? String(err), stack: e?.stack, name: e?.name, error: tagged });
    process.exit(1);
  }
}

void main();
