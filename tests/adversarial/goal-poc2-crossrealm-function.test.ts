/**
 * TEST-GOAL 阶段4.2 攻防回归 — PoC2: 跨 realm Function 逃逸 → process → child_process.
 *
 * Attack fixtures:
 *  - goal-poc2-crossrealm-function.ts — direct host-object route via Date.parse (statically caught);
 *  - goal-poc2b-crossrealm-args.ts — static-clean route via `args` (lowered to __host.args,
 *    a HOST-realm JSON.parse object, src/dwf/child-main.ts:107);
 *  - goal-poc2c-spawn-sync.ts — with host process in hand: process.binding('spawn_sync') code-exec proof.
 *
 * Measured matrix (node v22.23.2):
 *  - Defense ① on poc2: 3× diagnostic 9002 purity-ban ("Date.parse() is banned") — HELD.
 *  - Defense ① on poc2b/2c: ok:true — STATIC GAP (args is a declared facade primitive;
 *    .constructor chains and string-embedded code are invisible to compile.ts rules).
 *  - Defense ② on poc2b: BREACHED — run completed with hostProcess:"object"
 *    (host process captured); mainModule-undefined (child-main.js is ESM) and dynamic
 *    import inside host-compiled code throws "A dynamic import callback was not
 *    specified" — module routes are dead, but:
 *  - Defense ② on poc2c: BREACHED — process.binding('spawn_sync').spawn executed
 *    `cmd /c exit 42` (observed status 42) and wrote a file OUTSIDE the workspace
 *    (scratch marker), while the run reported completed (exit 0).
 *
 * Issue #31 closure (2026-11-02):
 *  - Static layer (GAP-02, already on main before #31): any .constructor/.prototype/
 *    ["constructor"] access is refused 9002 — poc2b/2c check ok:false; run-script dies
 *    at the compile gate ("逃逸链在编译期即死，不再进入沙箱", Security Sandbox Specification).
 *  - Runtime layer (Issue #31 预Seed): args is rebuilt INSIDE the realm from the
 *    __argsJson string (official child-source.ts:202-206 discipline), so its prototype
 *    chain is context-native and .constructor.constructor lands on the realm Function,
 *    which codeGeneration:{strings:false} refuses with EvalError. Asserted by a raw
 *    child-main probe that bypasses the compiler (computed access obj["con"+"structor"]
 *    is invisible to string-literal static rules) — the former skip's prescription
 *    ("Code generation from strings disallowed") is asserted verbatim.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POC2 = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc2-crossrealm-function.ts');
const POC2B = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc2b-crossrealm-args.ts');
const POC2C = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc2c-spawn-sync.ts');
const CHILD_MAIN = path.join(ROOT, 'dist', 'src', 'dwf', 'child-main.js');
const SPAWN_TIMEOUT_MS = 45_000;

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['bin/workflow.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

test('PoC2 defense ①: the Date.parse host-object route is refused statically with purity-ban(9002)', () => {
  const r = runCli(['check', '-j', POC2]);

  assert.equal(r.error, undefined, `check did not settle in time: ${String(r.error)}`);
  assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}`);

  const analysis = JSON.parse(r.stdout ?? '{}') as {
    ok: boolean;
    diagnostics: Array<{ code: number; category: string }>;
  };
  assert.equal(analysis.ok, false);
  const purityBans = analysis.diagnostics.filter((d) => d.code === 9002 && d.category === 'purity-ban');
  assert.ok(purityBans.length >= 3, `expected >=3 code-9002 purity-ban diagnostics, got: ${JSON.stringify(analysis.diagnostics)}`);
});

describe('PoC2 defense ②: args-route host Function escape is sealed (GAP-02 static + Issue #31 runtime preseed)', () => {
  // 原缺口（实测 2026-11-01，node v22.23.2，Issue #31 修复前）：
  //  1. goal-poc2b-crossrealm-args.ts passes `check` clean (ok:true) and its run-script
  //     COMPLETES with result {"hostProcess":"object",...} — the script captured the
  //     child host's real `process` object via args.constructor.constructor("return process")().
  //  2. goal-poc2c-spawn-sync.ts (also check-clean) COMPLETES with
  //     {"spawnSync":"EXIT42:42:..."} — process.binding('spawn_sync') executed a
  //     command with an attacker-chosen exit status and wrote a marker file OUTSIDE
  //     the workspace; the parent reported the run as completed (exit 0).
  //
  // Root cause: the lowering rewrites the facade constant `args` to `__host.args`
  // (src/dwf/lower.ts isArgsReference), and __host.args was JSON.parse(argsJson) — an
  // object created in the child HOST realm (src/dwf/child-main.ts:107). Its prototype
  // chain therefore carried the HOST Function constructor, on which the VM-context-only
  // codeGeneration:{strings:false} has no effect.
  //
  // 原转正模板（"When fixed, convert to: runCli(['run-script', POC2B...]); status 1;
  // stderr includes 'Code generation from strings disallowed'"）按双层落点拆分实现：
  // 静态层断言在 ②a/②b（GAP-02 后 run-script 在编译门即 exit 1，逃逸根本进不了
  // realm——模板设想的 realm EvalError 只能由绕过编译器的 raw probe 断言，见 ②c）。

  test('PoC2 defense ②a: poc2b/2c are refused at compile time with 9002 (GAP-02 static gate)', () => {
    for (const fixture of [POC2B, POC2C]) {
      const r = runCli(['check', '-j', fixture]);
      assert.equal(r.error, undefined, `check did not settle in time: ${String(r.error)}`);
      assert.equal(r.status, 1, `expected exit 1 for ${path.basename(fixture)}, got ${String(r.status)}`);
      const analysis = JSON.parse(r.stdout ?? '{}') as {
        ok: boolean;
        diagnostics: Array<{ code: number; category: string; message: string }>;
      };
      assert.equal(analysis.ok, false, `${path.basename(fixture)} must not compile clean`);
      const bans = analysis.diagnostics.filter((d) =>
        d.code === 9002 && d.category === 'purity-ban' && d.message.includes('"constructor" property access is banned'),
      );
      assert.ok(bans.length >= 1, `expected a 9002 constructor-chain ban for ${path.basename(fixture)}, got: ${JSON.stringify(analysis.diagnostics)}`);
    }
  });

  test('PoC2 defense ②b: run-script refuses poc2b at the compile gate — the escape never reaches the realm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc2-run-'));
    try {
      const r = runCli(['run-script', POC2B, '--db', path.join(dir, 'journal.sqlite')]);
      assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
      assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}`);
      assert.ok(
        (r.stderr ?? '').includes('purity-ban(9002)'),
        `expected the 9002 compile ban on stderr, got: ${(r.stderr ?? '').slice(0, 400)}`,
      );
      assert.ok(!(r.stdout ?? '').includes('hostProcess'), 'no run result may be produced');
      assert.ok(!(r.stderr ?? '').includes('EXIT42'), 'no spawn-sync exec proof may appear');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PoC2 defense ②c: raw realm probe (compiler bypassed) — args.constructor.constructor cannot reach host process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc2-realm-'));
    try {
      // Computed access ("con"+"structor") is invisible to the compile gate's
      // string-literal rules — this probe bypasses the compiler entirely to pin the
      // RUNTIME layer: context-native args → realm Function → EvalError.
      const scriptPath = path.join(dir, 'xrealm2-probe.js');
      fs.writeFileSync(scriptPath, [
        'async function __workflowScript__() {',
        '  var out = {};',
        '  // seed 全局面（独立评审第 1 轮收紧后）：四个种子全局都必须不可达——',
        '  // __send/__timer/__argsJson 由 BOOTSTRAP 在 realm 内即捕即删，',
        '  // __deliver 从不挂 globalThis（BOOTSTRAP 完成值交宿主）。',
        '  out.seed = { send: typeof __send, timer: typeof __timer, argsJson: typeof __argsJson, deliver: typeof __deliver };',
        '  var routes = {',
        '    direct: function () { return __host.args.constructor.constructor("return process")(); },',
        '    concat: function () { var k = "const" + "ructor"; return __host.args[k][k]("return process")(); },',
        '  };',
        '  for (const name of Object.keys(routes)) {',
        '    try {',
        '      var proc = routes[name]();',
        '      out[name] = (proc && typeof proc.cwd === "function") ? "HOST-PROCESS-LEAK:" + String(proc.cwd()) : ("got:" + typeof proc);',
        '    } catch (e) {',
        '      out[name] = "blocked:" + e.name + ":" + e.message;',
        '    }',
        '  }',
        '  return out;',
        '}',
      ].join('\n'));
      const argsJsonPath = path.join(dir, 'args.json');
      fs.writeFileSync(argsJsonPath, JSON.stringify({ probe: 'xrealm2' }));

      const raw = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn(process.execPath, [CHILD_MAIN, scriptPath, argsJsonPath], {
          cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        child.stdin.write(JSON.stringify({ t: 'notify', op: 'runInfo', runId: 'xrealm2-probe' }) + '\n');
        setTimeout(() => child.stdin.end(), 500);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
      });

      assert.equal(raw.code, 0, `child must complete cleanly, got ${String(raw.code)}; stderr: ${raw.stderr.slice(0, 300)}`);
      const lines = raw.stdout.split('\n').filter((l) => l.trim());
      const done = lines.map((l) => JSON.parse(l) as { t: string; value?: unknown }).find((f) => f.t === 'done');
      assert.ok(done, `a done frame must be present, stdout: ${raw.stdout.slice(0, 400)}`);
      const value = done!.value as { direct: string; concat: string; seed: Record<string, string> };
      // 种子全局四件套全部不可达（脚本既不能外呼也不能伪造入站帧）
      assert.deepEqual(value.seed, { send: 'undefined', timer: 'undefined', argsJson: 'undefined', deliver: 'undefined' });
      // 原转正模板的魔法串逐字落地：realm Function 被 codeGeneration:{strings:false} 拒绝
      for (const route of ['direct', 'concat'] as const) {
        assert.match(
          value[route],
          /^blocked:EvalError:Code generation from strings disallowed/,
          `${route} route must be refused by the realm (got ${JSON.stringify(value[route])})`,
        );
      }
      assert.ok(!raw.stdout.includes('HOST-PROCESS-LEAK'), 'no route may capture the host process');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
