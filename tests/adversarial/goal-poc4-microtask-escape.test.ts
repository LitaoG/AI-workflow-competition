/**
 * 攻防回归 — PoC4: 异步 microtask 逃逸（审计点后执行）.
 *
 * Attack fixture: tests/adversarial/fixtures/goal-poc4-microtask-escape.ts
 * The script's synchronous surface is benign (returns "POC4-benign-main"); a
 * Promise.resolve().then() microtask fires after the main body returned and before
 * the done frame is emitted (child-main.ts awaits the runner promise; its continuation
 * is queued after the script's own microtasks). The microtask uses the PoC2b escape to
 * forge a done frame straight onto child stdout; the parent settles the run with the
 * ATTACKER-chosen value and silently ignores the real done frame (src/dwf/runner.ts
 * handleChildFrame returns early once settled).
 *
 * Measured matrix (node v22.23.2, before Issue #31):
 *  - Defense ① check: ok:true — STATIC GAP (Promise chaining carries no banned identifier).
 *  - Defense ② run-script: BREACHED — run completed in ~0.36s with result
 *    "MT-FORGED-DONE" (not "POC4-benign-main"): attacker code executed after the
 *    audit point and replaced the run's recorded result. The child exited 0; no error,
 *    no hang — the forgery is indistinguishable from a legitimate completion.
 *
 * Issue #31 closure (2026-11-02):
 *  - The escape itself is PoC2b's (host-realm args object → host Function → process);
 *    the preseed fix rebuilds args INSIDE the realm, so the microtask's
 *    args.constructor.constructor lands on the realm Function and throws EvalError
 *    ("Code generation from strings disallowed") — swallowed by the fixture's own
 *    catch, nothing is forged, and the real done frame keeps the benign value.
 *  - Template adaptation note: the former skip's full-pipeline template
 *    (`runCli(['run-script', POC4, ...]); status 0; stdout has POC4-benign-main`)
 *    cannot be exercised literally any more — since GAP-02 the fixture itself is
 *    refused at the compile gate (9002, asserted below), so a full-pipeline pass
 *    would prove the static layer, not the runtime one. The load-bearing runtime
 *    assertion drives dist child-main directly (compiler bypassed) and keeps the
 *    template's three claims: exit 0, benign value present, forged value absent.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POC4 = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc4-microtask-escape.ts');
const CHILD_MAIN = path.join(ROOT, 'dist', 'src', 'dwf', 'child-main.js');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['bin/workflow.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });
}

describe('PoC4 defense ②: a microtask cannot forge the done frame after the audit point (Issue #31 preseed)', () => {
  // 原缺口（实测 2026-11-01，node v22.23.2）：goal-poc4-microtask-escape.ts passes
  // check clean; run-script completes with result "MT-FORGED-DONE" while the script
  // returned "POC4-benign-main". The escape itself is PoC2b's (host-realm args object
  // → host Function → process.stdout.write of a forged {t:'done'} frame); what PoC4
  // adds is that the forged effect lands AFTER the synchronous audit point (the
  // return value) and the parent cannot distinguish it from a legitimate completion
  // (src/dwf/runner.ts ignores frames once settled — the real done frame is dropped).

  test('PoC4 defense ①: the fixture is refused at compile time with 9002 (GAP-02 static gate)', () => {
    const r = runCli(['check', '-j', POC4]);
    assert.equal(r.error, undefined, `check did not settle in time: ${String(r.error)}`);
    assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}`);
    const analysis = JSON.parse(r.stdout ?? '{}') as {
      ok: boolean;
      diagnostics: Array<{ code: number; category: string; message: string }>;
    };
    assert.equal(analysis.ok, false, 'the poc4 fixture must not compile clean any more');
    const bans = analysis.diagnostics.filter((d) =>
      d.code === 9002 && d.category === 'purity-ban' && d.message.includes('"constructor" property access is banned'),
    );
    assert.ok(bans.length >= 1, `expected a 9002 constructor-chain ban, got: ${JSON.stringify(analysis.diagnostics)}`);
  });

  test('PoC4 defense ②: raw realm probe (compiler bypassed) — the microtask escape throws and the run result stays benign', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-poc4-realm-'));
    try {
      // The fixture's attack, verbatim, against the fixed realm: benign synchronous
      // return; a queued microtask tries the (statically invisible) concat-bypass
      // escape to forge a done frame onto child stdout.
      const scriptPath = path.join(dir, 'poc4-probe.js');
      fs.writeFileSync(scriptPath, [
        'async function __workflowScript__() {',
        '  __host.log("POC4-main-start");',
        '  void Promise.resolve().then(() => {',
        '    try {',
        '      var k = "const" + "ructor";',
        '      var F = __host.args[k][k];',
        '      var proc = F("return process")();',
        '      proc.stdout.write(JSON.stringify({ t: "done", value: "MT-FORGED-DONE" }) + "\\n");',
        '    } catch (e) {',
        '      // blocked — the real done frame will carry "POC4-benign-main"',
        '    }',
        '  });',
        '  return "POC4-benign-main";',
        '}',
      ].join('\n'));
      const argsJsonPath = path.join(dir, 'args.json');
      fs.writeFileSync(argsJsonPath, JSON.stringify({ probe: 'poc4' }));

      const raw = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn(process.execPath, [CHILD_MAIN, scriptPath, argsJsonPath], {
          cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        child.stdin.write(JSON.stringify({ t: 'notify', op: 'runInfo', runId: 'poc4-probe' }) + '\n');
        setTimeout(() => child.stdin.end(), 500);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
      });

      // 原转正模板三连（适配 raw 通道）：exit 0；benign 在；伪造值绝不在。
      assert.equal(raw.code, 0, `child must complete cleanly, got ${String(raw.code)}; stderr: ${raw.stderr.slice(0, 300)}`);
      assert.ok(raw.stdout.includes('POC4-benign-main'), `the real done frame must carry the benign value, stdout: ${raw.stdout.slice(0, 400)}`);
      assert.ok(!raw.stdout.includes('MT-FORGED-DONE'), 'no forged done frame may reach stdout');

      const frames = raw.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { t: string; value?: unknown; op?: string });
      const doneFrames = frames.filter((f) => f.t === 'done');
      assert.equal(doneFrames.length, 1, `exactly one done frame, got ${doneFrames.length}`);
      assert.equal(doneFrames[0]!.value, 'POC4-benign-main');
      assert.ok(frames.some((f) => f.t === 'call' && f.op === 'log'), 'the log call frame must be journalled out before done');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
