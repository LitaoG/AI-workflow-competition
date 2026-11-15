/**
 * The realm's boot program (Issue #31 预Seed), moved verbatim from child-main so
 * the host side of the sandbox reads in one screen. Pure JS with no backticks or
 * ${} so it sits safely inside a template literal. Runs ONCE inside the context;
 * every binding it creates is context-native. Shape contracts mirrored from the
 * host side:
 *   - `__tagged` reproduces `domainError(tag, message, {details})`'s plain-object
 *     shape (`src/domain/errors.ts`) so the host's `isDomainError`/`toSerializableError`
 *     boundary conversion reads it unchanged;
 *   - frame shapes reproduce the NDJSON wire protocol byte-for-byte (protocol.ts).
 */
/**
 * The realm's boot program (Issue #31 预Seed). Pure JS with no backticks/`${}` so it
 * sits safely inside a template literal. Runs ONCE inside the context; every binding
 * it creates is context-native. Shape contracts mirrored from the host side:
 *   - `__tagged` reproduces `domainError(tag, message, {details})`'s plain-object
 *     shape (`src/domain/errors.ts`) so the host's `isDomainError`/`toSerializableError`
 *     boundary conversion reads it unchanged;
 *   - frame shapes reproduce the NDJSON wire protocol byte-for-byte (protocol.ts).
 */
export const BOOTSTRAP = `"use strict";
(function () {
  // —— The only host capabilities that ever cross: captured, then deleted from the
  // global object so no host function stays reachable by the script (Issue #31). ——
  var __out = globalThis.__send;
  var __timer = globalThis.__timer;
  var __seedArgsJson = globalThis.__argsJson;
  var __seedBudgetTotal = globalThis.__budgetTotal;
  delete globalThis.__send;
  delete globalThis.__timer;
  delete globalThis.__argsJson;
  delete globalThis.__budgetTotal;
  if (
    typeof __out !== 'function' ||
    __timer === null || typeof __timer !== 'object' || typeof __timer.start !== 'function' || typeof __timer.clear !== 'function' ||
    typeof __seedArgsJson !== 'string' ||
    (__seedBudgetTotal !== null && typeof __seedBudgetTotal !== 'number')
  ) {
    throw new Error('child-main bootstrap: sandbox seed missing');
  }

  // （Issue #85 wrap-at-capture）定时器包装：捕获原始能力后重赋值 __timer，存活句柄记入
  // __liveTimers —— 判死探针以「__pending 与 __liveTimers 皆空」识别「再无任何在飞 send
  // 可能」（realm 无其他定时器来源）。开火先自删句柄再跑 fn（Set.delete 幂等，与
  // waitAny/race 的 finally 双清兼容）；clear 先删再透传。四个既有 __timer.start/clear
  // 调用点逐字节不变。
  var __timerRaw = __timer;
  var __liveTimers = new Set();
  var __timer = {
    start: function (fn, ms) {
      var raw = __timerRaw.start(function () {
        __liveTimers.delete(raw);
        fn();
        // （Issue #85 独立复核修复）定时器开火路径尾部镜像 __deliver 尾部再武装：
        // waitAny/race 的超时定时器可能静默消亡（败者清理不 clear、拒绝被脚本吞掉），
        // 原先仅 park 与 __deliver 尾部两点再武装，此时 parked 接收者将永久漏判。
        // __pending 空且仍有 parked 即再武装单发探针；收割条件不变（__pending 与
        // __liveTimers 皆空且仍有 parked），不引入误报 —— 定时器 fn 的微任务续体先于
        // 探针 macrotask 运行；活跃定时器存在期间探针以 0ms 节奏 bounded 轮询，
        // 定时器消亡或 parked 清空即停。
        if (__pending.size === 0 && __cellAnyParked()) {
          __cellArmProbe();
        }
      }, ms);
      __liveTimers.add(raw);
      return raw;
    },
    clear: function (raw) {
      __liveTimers.delete(raw);
      __timerRaw.clear(raw);
    },
  };

  var __nextId = 0;
  var __pending = new Map();
  /** Actors created in this realm — createActor is synchronous (no IPC round-trip). */
  var __localActors = new Set();
  /** Actors used in ask() calls — tracks actor usage across the run. */
  var __usedActors = new Set();
  /** Pending ask promises → their child call id, so sessions.cancel can route an abort. */
  var __cancellable = new Map();
  /** Budget mirror: total is run-config seeded; the parent pushes spent totals. */
  var __budget = { total: __seedBudgetTotal, spent: 0 };
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
    // Issue #279 (CAP-007, aligned with the source's _awaited semantics): the
    // sentinel must catch calls whose result is DROPPED, not merely calls still
    // in flight at done-time. Every call outside the fire-and-forget whitelist
    // registers a descriptor; consuming the returned promise via then/catch/
    // finally (await included) flips awaited. Settlement alone never does —
    // an ok frame arriving while nobody consumes the promise leaves the
    // descriptor unawaited, and the final audit fails the run.
    var tracked = op !== 'enterPhase' && op !== 'log' && op !== 'report' && op !== 'declareArtifact';
    var desc = tracked ? { siteId: siteId, op: op, awaited: false } : null;
    if (tracked) __trackedCalls.push(desc);
    var promise = new __AwaitTrackedPromise(function (resolve, reject) {
      __pending.set(id, { resolve: resolve, reject: reject, siteId: siteId, op: op });
      __emit({ t: 'call', id: id, op: op, siteId: siteId, payload: payload });
    });
    promise.__dwfDesc = desc;
    if (op === 'ask') __cancellable.set(promise, id);
    var cleanup = function () {
      __cancellable.delete(promise);
    };
    // Internal bookkeeping runs through the native prototype method so the
    // script-facing consumption mark stays exclusive to real script consumption.
    Promise.prototype.then.call(promise, cleanup, cleanup);
    return promise;
  }

  /** Consumption descriptors for the unawaited-call sentinel (Issue #279). */
  var __trackedCalls = [];
  /**
   * Tracked promise: marks its descriptor the moment the script consumes it
   * (await lowers to a .then call, so both spellings mark). Derived
   * promises from species construction carry no descriptor — the original
   * call's mark already happened by then, so the guard only avoids noise.
   */
  class __AwaitTrackedPromise extends Promise {
    then(onFulfilled, onRejected) {
      if (this.__dwfDesc) this.__dwfDesc.awaited = true;
      return super.then(onFulfilled, onRejected);
    }
    catch(onRejected) {
      if (this.__dwfDesc) this.__dwfDesc.awaited = true;
      return super.catch(onRejected);
    }
    finally(onFinally) {
      if (this.__dwfDesc) this.__dwfDesc.awaited = true;
      return super.finally(onFinally);
    }
  }

  /** Route one pending ask turn's abort to the parent by its child call id. */
  function __cancelTurn(turn) {
    var callId = __cancellable.get(turn);
    if (callId !== undefined) {
      var entry = __pending.get(callId);
      if (entry) entry.cancelled = true;
      // A cancelled turn is a sanctioned abandonment — sessions.cancel exists
      // precisely to discard the loser of a race, and its result is never
      // consumed by design. Exempt it from the unawaited-consumption sentinel
      // here, or every cancel-then-race script would fail the done-time audit
      // (Issue #279: cancellation is not the dropped-result failure class).
      if (turn && turn.__dwfDesc) turn.__dwfDesc.awaited = true;
      __emit({ t: 'notify', op: 'cancelCall', cancelId: callId });
    }
    // already-settled turns are a no-op: cancellation only applies to pending work
  }

  globalThis.__host = {
    // createActor must return the actor object synchronously — the script chains
    // \`.ask()\` straight off it without an await. The name goes to the parent as a
    // fire-and-forget notify frame.
    createActor: function (siteId, name, provider, tier, model) {
      __localActors.add(siteId);
      __emit({
        t: 'notify',
        op: 'actorCreated',
        siteId: siteId,
        name: String(name ?? siteId),
        provider: provider === null || provider === undefined ? undefined : String(provider),
        tier: tier === null || tier === undefined ? undefined : String(tier),
        model: model === null || model === undefined ? undefined : String(model),
      });
      return { __actor: siteId };
    },
    ask: function (siteId, actor, prompt, schema, swarm) {
      if (
        !actor || typeof actor !== 'object' ||
        !__localActors.has(actor.__actor ?? '')
      ) {
        var message = 'ask() receiver is not an actor created by agent() in this run (site ' + siteId + ')';
        return Promise.reject(__tagged('AgentError', message, { siteId: siteId }));
      }
      __usedActors.add(actor.__actor ?? '');
      // The fifth argument marks a swarm() task (issue #126): the parent skips the
      // per-actor FIFO and the conversation for it. The flag travels with the
      // frame rather than being re-derived from the siteId prefix, so the engine
      // has one declared source of truth.
      return __call('ask', siteId, [actor, prompt, schema, swarm === true]);
    },
    enterPhase: function (name) {
      return __call('enterPhase', undefined, [name]);
    },
    // lower.ts emits __host.log("log#N", message) / __host.report("report#N", item) —
    // the first parameter is the journal siteId, the second is the real payload.
    log: function (siteId, message) {
      return __call('log', siteId, [message]);
    },
    report: function (siteId, item, artifactId) {
      return __call('report', siteId, [item, artifactId === undefined ? null : artifactId]);
    },
    // Issue #38 D8-③ preset family: declaration, not effect — fire-and-forget;
    // the engine validates the id/spec and journals the declaration.
    declareArtifact: function (siteId, op, args) {
      return __call('declareArtifact', siteId, [op, args]);
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
    // Budget is a frozen snapshot seeded by the run config (canonical parity):
    // total is read-only, spent()/remaining() read the parent-pushed mirror.
    // Object.create(null) keeps the prototype chain from leaking into the realm;
    // freeze makes a strict-mode assignment to total throw, as in the canonical VM.
    budget: Object.freeze(Object.assign(Object.create(null), {
      total: __budget.total,
      spent: function () {
        return __budget.spent;
      },
      remaining: function () {
        return __budget.total == null ? Infinity : Math.max(0, __budget.total - __budget.spent);
      },
    })),
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
  /**
   * swarm(agents, tasks): task i goes to agents[i % agents.length]. Every ask is sent
   * at once, in task order, on the swarm's one ask site, so the journal numbers the
   * turns by task index and a resumed run replays them in the same order; the
   * parent's seat gate caps how many run at a time. Resolves with the answers in
   * task order.
   *
   * Failure policy (fanout.parallel parity, token 预算超限 drop-slot):
   * a WorkflowBudgetExceededError drops that task to null (with one summary log
   * line) — the budget is a run-level fact, failing the whole swarm adds nothing;
   * any other error rejects the swarm with the first such error. Settled turns
   * are journal facts either way, so a resumed run replays them untouched.
   */
  globalThis.__swarm = function (siteId, agents, tasks, schema) {
    if (!Array.isArray(agents) || agents.length === 0) {
      return Promise.reject(new TypeError('swarm() expects a non-empty array of agents'));
    }
    if (!Array.isArray(tasks)) {
      return Promise.reject(new TypeError('swarm() expects an array of task strings'));
    }
    for (var k = 0; k < tasks.length; k++) {
      if (typeof tasks[k] !== 'string') {
        return Promise.reject(new TypeError('swarm() task ' + k + ' must be a string'));
      }
    }
    var turns = tasks.map(function (task, i) {
      return __host.ask(siteId, agents[i % agents.length], task, schema, true);
    });
    return Promise.allSettled(turns).then(function (settled) {
      var dropped = 0;
      var firstError = null;
      var answers = settled.map(function (outcome) {
        if (outcome.status === 'fulfilled') return outcome.value;
        var name = outcome.reason && outcome.reason.name;
        if (name === 'WorkflowBudgetExceededError') {
          dropped++;
          return null;
        }
        if (firstError === null) firstError = outcome.reason;
        return null;
      });
      if (dropped > 0) {
        void __call('log', undefined, ['swarm: ' + dropped + (dropped === 1 ? ' slot dropped' : ' slots dropped') + ' — token budget exceeded']);
      }
      if (firstError !== null) {
        for (var j = 0; j < turns.length; j++) __cancelTurn(turns[j]);
        throw firstError;
      }
      return answers;
    });
  };

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
   * promise racing (its timeout borrows the captured __timer capability); race adds
   * speculative execution — the first FULFILLED turn wins and every other pending
   * turn is cancelled (same abort route as cancel); cancel routes an abort to the
   * parent by the ask's child call id.
   */
  globalThis.__sessions = {
    waitAny: function (turns, opts) {
      // Issue #279 consumption sentinel: waitAny owns every turn it races — the
      // contract is pure racing with NO cancellation, so at done-time a loser
      // may legitimately still be awaiting its reply (the winner settled first
      // and the script moved on). Both sentinel nets must exempt those turns:
      // ① consumption net — mark every turn consumed (mirrors the
      //   sanctioned-abandonment exemption in __cancelTurn); the winner's value
      //   reaches the script through the any-result, losers' results are
      //   discarded by design.
      // ② in-flight net — flag the pending entries abandoned so a loser whose
      //   reply has not arrived yet is not flagged as an unawaited call. The
      //   reply, when it arrives later, still resolves into the void without
      //   touching the journal (no cancelCall notify is emitted — waitAny does
      //   not abort anything; both turns are journalled as ran).
      // Which reply wins the race is pipe-scheduling dependent, so without
      // this exemption every waitAny script is a timing flake (first surfaced
      // by this repo's Linux CI; upstream has no CI to see it).
      for (var w = 0; w < turns.length; w++) {
        var wTurn = turns[w];
        if (wTurn && wTurn.__dwfDesc) {
          wTurn.__dwfDesc.awaited = true;
          var wCallId = __cancellable.get(wTurn);
          if (wCallId !== undefined) {
            var wEntry = __pending.get(wCallId);
            if (wEntry) wEntry.cancelled = true;
          }
        }
      }
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
    race: function (turns, opts) {
      if (!Array.isArray(turns)) {
        throw new TypeError('sessions.race() expects an array of turns — pass [agent(...).ask(...), ...]');
      }
      if (turns.length === 0) {
        throw new TypeError('sessions.race() expects at least one turn');
      }
      for (var i = 0; i < turns.length; i++) {
        var turn = turns[i];
        if (turn === null || (typeof turn !== 'object' && typeof turn !== 'function') || typeof turn.then !== 'function') {
          throw new TypeError('sessions.race() expects promises — pass raw agent(...).ask(...) turns so losers can be cancelled');
        }
        // Same ownership marking as waitAny: race owns every turn it
        // speculatively starts (losers cancelled, winner delivered through the
        // result), so the consumption mark must not depend on Promise.any's
        // internal reaction path (Issue #279 sentinel, comp CI Linux finding).
        if (turn.__dwfDesc) turn.__dwfDesc.awaited = true;
      }
      var cancelAll = function () {
        for (var j = 0; j < turns.length; j++) __cancelTurn(turns[j]);
      };
      // Promise.any: the first FULFILLED turn wins (a failed speculative branch
      // must not pre-empt a slow-but-successful one). Both branches cancel losers.
      var winner = Promise.any(turns).then(
        function (value) {
          cancelAll();
          return value;
        },
        function (err) {
          cancelAll();
          throw err;
        }
      );
      if (!opts || !opts.timeoutMs) return winner;
      var timeoutHandle;
      var timeout = new Promise(function (_resolve, reject) {
        timeoutHandle = __timer.start(function () {
          cancelAll();
          reject(new Error('sessions.race timed out after ' + opts.timeoutMs + 'ms — every pending turn was cancelled'));
        }, opts.timeoutMs);
      });
      return Promise.race([winner, timeout]).finally(function () {
        __timer.clear(timeoutHandle);
      });
    },
    cancel: function (turn) {
      __cancelTurn(turn);
    },
  };

  // —— channel/future 纯 cell 原语（Issue #85）：realm 内 promise 机制，零站点、零 journal。
  // send 无界缓冲（waiters 优先）；FIFO 每项恰一接收者；close 幂等且唤醒本 channel 全部
  // parked —— 裸 receive() reject ChannelClosed，for-await 的 next() 得 {done:true}（已关闭
  // 通道的 parked 绝不以 ChannelDeadlock 收割）；receive/next 一律先 buffer 后 closed；
  // parked receive promise 附 no-op catch（close/判死可在无 await 场景下 reject 它）。
  // 停滞检测：park 即武装单发 macrotask 探针（借上方 __timer 包装），__deliver 尾部在
  // __pending 清空且仍有 parked 时再武装；开火先自清，__pending 与 __liveTimers 皆空且
  // 仍有 parked 才逐 channel 收割为 ChannelDeadlock（消息含 channel 标识）。
  var __cellChannels = [];
  var __cellSeq = 0;
  var __cellProbeArmed = false;
  function __cellAnyParked() {
    for (var i = 0; i < __cellChannels.length; i++) {
      if (__cellChannels[i].__cellParked.length > 0) return true;
    }
    return false;
  }
  function __cellHarvest() {
    for (var i = 0; i < __cellChannels.length; i++) {
      var ch = __cellChannels[i];
      if (ch.__cellIsClosed()) continue; // close() 已唤醒其全部 parked —— 严禁判死已关闭通道
      for (var j = 0; j < ch.__cellParked.length; j++) {
        ch.__cellParked[j].reject(__cellDeadlockError(ch.__cellLabel));
      }
      ch.__cellParked.length = 0;
    }
  }
  function __cellArmProbe() {
    if (__cellProbeArmed) return;
    __cellProbeArmed = true;
    __timer.start(function () {
      __cellProbeArmed = false;
      if (__pending.size === 0 && __liveTimers.size === 0 && __cellAnyParked()) {
        __cellHarvest();
      }
    }, 0);
  }
  function __cellDeadlockError(label) {
    var e = new Error(label + ' deadlock: no sender can arrive anymore while a receiver stays parked');
    e.name = 'ChannelDeadlock';
    return e;
  }
  function __cellClosedError(label) {
    var e = new Error(label + ' is closed');
    e.name = 'ChannelClosed';
    return e;
  }
  globalThis.__channel = function () {
    var seq = ++__cellSeq;
    var label = 'channel#' + seq;
    var buffer = [];
    var parked = [];
    var isClosed = false;
    var ch = {
      __cellLabel: label,
      __cellParked: parked,
      __cellIsClosed: function () {
        return isClosed;
      },
    };
    __cellChannels.push(ch);
    ch.send = function (value) {
      if (isClosed) throw __cellClosedError(label);
      if (parked.length > 0) {
        var r = parked.shift();
        if (r.next) r.resolve({ value: value, done: false });
        else r.resolve(value);
        return;
      }
      buffer.push(value);
    };
    ch.close = function () {
      if (isClosed) return;
      isClosed = true;
      while (parked.length > 0) {
        var r = parked.shift();
        if (r.next) r.resolve({ value: undefined, done: true });
        else r.reject(__cellClosedError(label));
      }
    };
    ch.receive = function () {
      if (buffer.length > 0) return Promise.resolve(buffer.shift());
      if (isClosed) return Promise.reject(__cellClosedError(label));
      var p = new Promise(function (resolve, reject) {
        parked.push({ resolve: resolve, reject: reject, next: false });
        __cellArmProbe(); // park 即武装单发探针（纯 park 场景无宿主行可借 __deliver 尾部再武装）
      });
      p.catch(function () {}); // parked 承诺可能由 close/判死在无 await 场景下 reject —— 防 unhandledRejection
      return p;
    };
    ch[Symbol.asyncIterator] = function () {
      return {
        next: function () {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false });
          if (isClosed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function (resolve, reject) {
            parked.push({ resolve: resolve, reject: reject, next: true });
            __cellArmProbe(); // park 即武装单发探针（for-await 停滞检测同 receive）
          });
        },
      };
    };
    return ch;
  };
  globalThis.__future = function () {
    var resolveFn;
    var rejectFn;
    var promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    return {
      promise: promise,
      resolve: function (value) {
        resolveFn(value);
      },
      reject: function (reason) {
        rejectFn(reason);
      },
    };
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
  // Seal the constructor chain (spec parity).
  // Two bypasses were verified before this seal (Issue #55):
  //   Object.getPrototypeOf(Date).now()   — setPrototypeOf(__SafeDate, __NativeDate) leaked it
  //   new Date(0)["constructor"].now()    — __NativeDate.prototype.constructor was untouched
  // Copy the statics explicitly instead of inheriting from the native constructor;
  // point every Date instance's constructor at the shim, freeze the native
  // constructor, and make its own now() throw as a defence-in-depth backstop.
  const __purityNow = function () {
    throw __purityViolation('Date.now', 'Purity violation: Date.now() is banned in facade scripts. Pass timestamps via args so a relaunch replays byte-identical.');
  };
  __SafeDate.now = __purityNow;
  __SafeDate.parse = __NativeDate.parse;
  __SafeDate.UTC = __NativeDate.UTC;
  __SafeDate.prototype = __NativeDate.prototype;
  __NativeDate.prototype.constructor = __SafeDate;
  __NativeDate.now = __purityNow;
  Object.freeze(__NativeDate);
  globalThis.Date = __SafeDate;

  // Intl no-arg date formatting is a wall-clock side channel that survives the
  // Date seal: Intl.DateTimeFormat#format()/formatToParts() default to
  // %Date.now% when no date is supplied. Verified in this realm and in the
  // reference runtime (Issue #55). Seal the no-arg forms while keeping
  // explicit-date formatting deterministic.
  const __dtfProto = Intl.DateTimeFormat.prototype;
  const __formatDescriptor = Object.getOwnPropertyDescriptor(__dtfProto, 'format');
  if (__formatDescriptor && typeof __formatDescriptor.get === 'function') {
    Object.defineProperty(__dtfProto, 'format', {
      configurable: true,
      get: function () {
        const bound = __formatDescriptor.get.call(this);
        return function (date) {
          if (arguments.length === 0 || date === undefined) {
            throw __purityViolation('Intl.DateTimeFormat.format', 'Purity violation: Intl.DateTimeFormat.format() without an explicit date is banned in facade scripts. Pass timestamps via args so a relaunch replays byte-identical.');
          }
          return bound(date);
        };
      },
    });
  }
  const __formatToParts = __dtfProto.formatToParts;
  if (typeof __formatToParts === 'function') {
    __dtfProto.formatToParts = function (date) {
      if (arguments.length === 0 || date === undefined) {
        throw __purityViolation('Intl.DateTimeFormat.formatToParts', 'Purity violation: Intl.DateTimeFormat.formatToParts() without an explicit date is banned in facade scripts. Pass timestamps via args so a relaunch replays byte-identical.');
      }
      return __formatToParts.call(this, date);
    };
  }

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
    // （Issue #85）cell 停滞探针再武装：每条已解析行处理后，__pending 清空且仍有 parked
    // 接收者时再武装单发探针（与上方 childIdle 的发射时机对齐）。
    if (__pending.size === 0 && __cellAnyParked()) {
      __cellArmProbe();
    }
    return frame.t === 'abort' ? 'abort' : '';
  };
  __deliver.getPending = function (all) {
    var list = [];
    __pending.forEach(function (val) {
      if (!val.cancelled && (all || (val.op !== 'enterPhase' && val.op !== 'log' && val.op !== 'report' && val.op !== 'declareArtifact'))) {
        list.push({ siteId: val.siteId, op: val.op });
      }
    });
    return list;
  };
  // Issue #279: the consumption-side sentinel list — every non-fire-and-forget
  // call whose promise was never consumed via then/catch/finally (await
  // included), regardless of whether the host already settled it. This is the
  // "dropped result" half the in-flight-only getPending list cannot see.
  __deliver.getUnawaited = function () {
    var list = [];
    __trackedCalls.forEach(function (desc) {
      if (!desc.awaited) list.push({ siteId: desc.siteId, op: desc.op });
    });
    return list;
  };
  __deliver.getActorUsage = function () {
    var created = [];
    __localActors.forEach(function (a) { created.push(a); });
    var used = [];
    __usedActors.forEach(function (a) { used.push(a); });
    return { created: created, used: used };
  };
  // 引导源的完成值：唯一一个不经 globalThis 交宿主的 realm 函数引用。
  return __deliver;
})();
`;
