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
 * PreSeed discipline (Issue #31):
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
import { isDomainError, toDomainError, toSerializableError } from '../domain/errors.js';
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
  sandbox.__send = (line: string): void => {
    process.stdout.write(line + '\n');
  };
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
