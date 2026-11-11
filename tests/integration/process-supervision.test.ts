import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSanitizedEnv, isPidAlive, killTree, onHostSignals, spawnSupervised } from '../../src/process-supervision.js';
import { buildSandboxChildArgs, runFacadeScript } from '../../src/dwf/runner.js';

test('buildSanitizedEnv passes only the platform base plus the allowlist', () => {
  process.env.DWF_SECRET_TOKEN = 'super-secret';
  process.env.DWF_PUBLIC_SETTING = 'fine';
  try {
    const env = buildSanitizedEnv(['DWF_PUBLIC_SETTING'], { ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(env.DWF_SECRET_TOKEN, undefined, 'secrets must not leak into child environments');
    assert.equal(env.DWF_PUBLIC_SETTING, 'fine');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(env.PATH, 'PATH must survive: children cannot even spawn without it');
    if (process.platform === 'win32') {
      assert.ok(env.SYSTEMROOT, 'Windows children need SystemRoot for most of node:os/net');
    } else {
      assert.ok(env.HOME, 'POSIX children need HOME for tool configs');
    }
  } finally {
    delete process.env.DWF_SECRET_TOKEN;
    delete process.env.DWF_PUBLIC_SETTING;
  }
});

test('spawnSupervised captures stdout/exit code and resolves a normal run', async () => {
  const sup = spawnSupervised(process.execPath, ['-e', 'console.log("supervised-ok")'], { cwd: process.cwd() });
  const res = await sup.result;
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.ok(res.stdout.includes('supervised-ok'));
  assert.ok(res.durationMs >= 0);
});

test('spawnSupervised environment really is sanitized inside the child', async () => {
  process.env.DWF_SECRET_TOKEN = 'super-secret';
  try {
    const sup = spawnSupervised(
      process.execPath,
      ['-e', 'console.log(JSON.stringify(process.env))'],
      { cwd: process.cwd() },
    );
    const res = await sup.result;
    assert.equal(res.exitCode, 0);
    const childEnv = JSON.parse(res.stdout) as Record<string, string>;
    assert.equal(childEnv.DWF_SECRET_TOKEN, undefined, 'the secret reached the child!');
    assert.ok(childEnv.PATH, 'child PATH missing');
  } finally {
    delete process.env.DWF_SECRET_TOKEN;
  }
});

test('timeout kills the whole process tree, including grandchildren', async () => {
  // The parent spawns a long-lived grandchild, prints its pid, then idles.
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    'const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 250)"], { stdio: "ignore" });',
    'g.unref();',
    'console.log("GC:" + g.pid);',
    'setInterval(() => {}, 250);',
  ].join('\n');

  const sup = spawnSupervised(process.execPath, ['-e', parentScript], {
    cwd: process.cwd(),
    timeoutMs: 1500,
  });
  const res = await sup.result;
  assert.equal(res.timedOut, true, 'the supervisor must report the timeout');
  const match = /GC:(\d+)/.exec(res.stdout);
  assert.ok(match, `grandchild pid missing from parent output: ${res.stdout}`);
  const grandchildPid = Number(match![1]!);

  // Poll until the tree kill lands (taskkill /T is synchronous, the POSIX
  // group kill lands immediately, but exit reaping can lag a beat).
  let alive = true;
  for (let i = 0; i < 25 && alive; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(grandchildPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `grandchild ${grandchildPid} outlived its supervised parent (orphan!)`);
});

test('killTree is idempotent and safe on an already-dead pid', async () => {
  const sup = spawnSupervised(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd() });
  await sup.result;
  // The child already exited �?killTree must resolve without throwing.
  if (sup.pid !== undefined) await killTree(sup.pid);
  await sup.killTree();
});

// ---------------------------------------------------------------------------
// pid liveness probe (GOAL.md §1.5 stale-running recovery)
// ---------------------------------------------------------------------------

test('isPidAlive: the live test process and a freshly spawned sleeper probe alive', async () => {
  assert.equal(isPidAlive(process.pid), true, 'our own pid must probe alive');

  const sup = spawnSupervised(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: process.cwd() });
  assert.ok(sup.pid !== undefined);
  try {
    assert.equal(isPidAlive(sup.pid!), true, 'a genuinely live child must probe alive (real OS probe, no injection)');
  } finally {
    await sup.killTree();
  }
});

test('isPidAlive: an exited child probes dead', async () => {
  const sup = spawnSupervised(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd() });
  await sup.result;
  assert.ok(sup.pid !== undefined);
  assert.equal(isPidAlive(sup.pid!), false, 'a process that has exited must probe dead');
});

test('isPidAlive: EPERM means alive-without-permission; ESRCH and unknown errors mean dead', () => {
  const cases: Array<{ code: string; want: boolean }> = [
    { code: 'EPERM', want: true },
    { code: 'ESRCH', want: false },
    { code: 'EIO', want: false },
  ];
  const original = process.kill;
  try {
    for (const { code, want } of cases) {
      // Simulate the errno without a real signal: stub process.kill (same
      // stubbing technique the platform branch tests use for process.platform).
      Object.defineProperty(process, 'kill', {
        value: () => {
          throw Object.assign(new Error(`simulated ${code}`), { code });
        },
        configurable: true,
        writable: true,
      });
      assert.equal(isPidAlive(424242), want, `errno ${code} must probe ${want ? 'alive' : 'dead'}`);
    }
  } finally {
    Object.defineProperty(process, 'kill', { value: original, configurable: true, writable: true });
  }
  // The stub is gone: a real probe works again.
  assert.equal(isPidAlive(process.pid), true, 'the real probe must be restored after the errno stubs');
});

// ---------------------------------------------------------------------------
// Host-signal supervision (GOAL.md 铁律 3 — 零孤儿进程)
// ---------------------------------------------------------------------------

test('onHostSignals registers the platform signal set on the injected bus and the disposer removes exactly those', () => {
  const bus = new EventEmitter();
  const seen: string[] = [];
  const dispose = onHostSignals((signal) => seen.push(signal), bus);

  const expected = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM'];
  for (const sig of expected) {
    assert.equal(bus.listenerCount(sig), 1, `${sig} must be registered while the run is live`);
  }

  // Firing the event on the bus reaches the handler (the runner's handler then
  // tree-kills and settles the run — that glue is exercised by the real-run
  // tests below, since real signal delivery is platform-hostile in tests).
  bus.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(seen, ['SIGTERM']);

  dispose();
  for (const sig of expected) {
    assert.equal(bus.listenerCount(sig), 0, `${sig} handler must be removed after the run`);
  }
});

test('onHostSignals default set follows process.platform — POSIX branch faked via a platform stub', () => {
  // Windows host: the real SIGBREAK branch is live above; the POSIX branch is
  // covered by stubbing process.platform (configurable own property), the same
  // way the logic branch is verified without real POSIX signal delivery.
  const realPlatform = process.platform;
  const bus = new EventEmitter();
  Object.defineProperty(process, 'platform', { value: 'linux' });
  let dispose: () => void = () => {};
  try {
    dispose = onHostSignals(() => {}, bus);
    assert.equal(bus.listenerCount('SIGINT'), 1);
    assert.equal(bus.listenerCount('SIGTERM'), 1);
    assert.equal(bus.listenerCount('SIGBREAK'), 0, 'SIGBREAK is Windows-only and must not be registered on POSIX');
  } finally {
    dispose();
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
  assert.equal(bus.listenerCount('SIGINT'), 0, 'disposer must remove the handlers on the POSIX set too');
});

// ---------------------------------------------------------------------------
// Sandbox memory cap (--max-old-space-size)
// ---------------------------------------------------------------------------

test('sandbox child argv caps the V8 heap: default 512, runner option overrides, env is the middle layer', () => {
  // Default and argument order: the node flag MUST precede the entry path.
  assert.deepEqual(
    buildSandboxChildArgs('child.js', 'script.js', '{"a":1}'),
    ['--max-old-space-size=512', 'child.js', 'script.js', '{"a":1}', ''],
  );

  // Explicit runner option wins over everything.
  assert.equal(buildSandboxChildArgs('child.js', 'script.js', '{}', 1024)[0], '--max-old-space-size=1024');

  // Environment variable is honored when no option is passed…
  const prev = process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB;
  process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB = '256';
  try {
    assert.equal(buildSandboxChildArgs('child.js', 'script.js', '{}')[0], '--max-old-space-size=256');
    // …and never beats the explicit option.
    assert.equal(buildSandboxChildArgs('child.js', 'script.js', '{}', 1024)[0], '--max-old-space-size=1024', 'explicit option must win over the env var');
    // Junk / non-positive env values fall back to the default instead of producing a broken flag.
    process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB = 'not-a-number';
    assert.equal(buildSandboxChildArgs('child.js', 'script.js', '{}')[0], '--max-old-space-size=512');
    process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB = '-1';
    assert.equal(buildSandboxChildArgs('child.js', 'script.js', '{}')[0], '--max-old-space-size=512');
  } finally {
    if (prev === undefined) delete process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB;
    else process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB = prev;
  }
});

// ---------------------------------------------------------------------------
// runFacadeScript wiring: handlers live exactly as long as the run
// ---------------------------------------------------------------------------

function makeSignalWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-signals-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* child may briefly hold the dir on Windows */ } } };
}

test('runFacadeScript registers host signal handlers while the run is live and removes them after it settles', async () => {
  const ws = makeSignalWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'ok.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("S");\nlog("hello");\nreturn { ok: true };');

    const baseline = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      sigbreak: process.listenerCount('SIGBREAK'),
    };
    let duringRun: { sigint: number; sigterm: number; sigbreak: number } | undefined;
    const result = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      onEvent: (e) => {
        if (e.type === 'dwf_phase' && !duringRun) {
          duringRun = {
            sigint: process.listenerCount('SIGINT'),
            sigterm: process.listenerCount('SIGTERM'),
            sigbreak: process.listenerCount('SIGBREAK'),
          };
        }
      },
    });
    assert.equal(result.status, 'completed', `run failed: ${result.error ?? ''}`);
    assert.ok(duringRun, 'the script must emit at least one phase event');
    assert.equal(duringRun.sigint, baseline.sigint + 1, 'SIGINT handler must be registered while the run is live');
    assert.equal(duringRun.sigterm, baseline.sigterm + 1, 'SIGTERM handler must be registered while the run is live');
    if (process.platform === 'win32') {
      assert.equal(duringRun.sigbreak, baseline.sigbreak + 1, 'SIGBREAK handler must be registered on Windows');
    }

    // Every exit path — completed here, failed below — must restore the baseline.
    assert.equal(process.listenerCount('SIGINT'), baseline.sigint, 'SIGINT handler must be removed after the run');
    assert.equal(process.listenerCount('SIGTERM'), baseline.sigterm, 'SIGTERM handler must be removed after the run');
    assert.equal(process.listenerCount('SIGBREAK'), baseline.sigbreak, 'SIGBREAK handler must be removed after the run');
  } finally {
    ws.cleanup();
  }
});

test('a failed run also removes its host signal handlers (every exit path goes through the same choke point)', async () => {
  const ws = makeSignalWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'boom.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("Boom");\nthrow new Error("kaboom");');
    const baseline = process.listenerCount('SIGINT');
    const result = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /kaboom/);
    assert.equal(process.listenerCount('SIGINT'), baseline, 'a failed run must not leak its SIGINT handler');
  } finally {
    ws.cleanup();
  }
});

test('a SIGINT delivered while the run is live settles the run as failed with the tree killed', async () => {
  const ws = makeSignalWorkspace();
  try {
    // The sandbox child stays alive inside a world.run long enough for the
    // signal to arrive mid-run; the interruption must kill the child tree and
    // settle the run as failed — not hang, not park, not complete.
    const scriptPath = path.join(ws.dir, 'slow.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("Slow");\nconst out = await world.run("node", ["-e", "setTimeout(() => {}, 1200)"]);\nreturn { code: out.exitCode };');

    let signalPhase: (() => void) | undefined;
    const runIsLive = new Promise<void>((resolve) => { signalPhase = resolve; });
    const baseline = process.listenerCount('SIGINT');
    const runPromise = runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      onEvent: (e) => { if (e.type === 'dwf_phase') signalPhase?.(); },
    });
    await runIsLive;

    // Synthetic in-process delivery: invokes exactly the listeners registered
    // for the run (real Ctrl+C would additionally hit the whole console process
    // group — not reproducible in a test). Returns true iff a listener existed;
    // the signal name is the listener's first argument, same as real delivery.
    const delivered = process.emit('SIGINT', 'SIGINT');
    assert.equal(delivered, true, 'the live run must have a SIGINT handler registered');

    const result = await runPromise;
    assert.equal(result.status, 'failed', `interrupted run must settle as failed, got ${result.status}`);
    assert.match(result.error!, /interrupted by SIGINT/, `error must name the signal, got: ${result.error ?? ''}`);
    assert.equal(process.listenerCount('SIGINT'), baseline, 'the interrupted run must remove its handlers too');
  } finally {
    ws.cleanup();
  }
});

test('a child frame whose engine call is still in flight when the run settles must not surface the post-settle journal continuation as an unhandledRejection', async () => {
  const ws = makeSignalWorkspace();
  // Temporary process-level capture, removed in finally. The race this test
  // locks fires its rejection AFTER runFacadeScript has resolved, so without
  // the capture node:test would attribute the stray unhandledRejection to
  // whatever test happens to run at that moment (the SIGINT flake's fingerprint).
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    // The frame is injected while the run is live and its engine call is still
    // awaiting when the run settles: the sandbox child is killed by the settle
    // path, but the engine's own world.run child is a child of the HOST process
    // (outside that tree) — it outlives the settled run, and its exit drives the
    // engine's continuation (journal write) against the already-closed store.
    const scriptPath = path.join(ws.dir, 'settle-race.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("Race");\nconst out = await world.run("node", ["-e", "setTimeout(() => {}, 600)"]);\nreturn { code: out.exitCode };');

    let signalPhase: (() => void) | undefined;
    const runIsLive = new Promise<void>((resolve) => { signalPhase = resolve; });
    const runPromise = runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      onEvent: (e) => { if (e.type === 'dwf_phase') signalPhase?.(); },
    });
    await runIsLive;
    process.emit('SIGINT', 'SIGINT');

    const result = await runPromise;
    assert.equal(result.status, 'failed', `interrupted run must settle as failed, got ${result.status}`);
    assert.match(result.error!, /interrupted by SIGINT/, `error must name the signal, got: ${result.error ?? ''}`);

    // Let the world.run child exit (~600ms after spawn) and the engine's
    // continuation land against the closed store, with margin. The runner's
    // settled guard must swallow the continuation into a warning: the captured
    // window must hold no "database is not open" rejection.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const storeClosed = unhandled.filter((m) => m.includes('database is not open'));
    assert.equal(
      storeClosed.length,
      0,
      `post-settle engine continuation must not surface as an unhandledRejection; captured: ${JSON.stringify(unhandled)}`,
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
    ws.cleanup();
  }
});
