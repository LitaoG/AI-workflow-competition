/**
 * Process supervision for facade-script engine spawns (GOAL.md deepening item:
 * "全生命周期进程安全").
 *
 * Every process the engine or runner spawns becomes a supervised unit:
 * - POSIX: the child gets its own process group (`detached: true`); a kill
 *   takes down the whole group (`process.kill(-pid, 'SIGKILL')`), so a
 *   command that spawned grandchildren cannot outlive its timeout.
 * - Windows: there are no process groups, so the kill path is
 *   `taskkill /PID <pid> /T /F` — the /T flag walks the process tree.
 * - Environment: children never inherit the parent's full environment. A
 *   minimal platform-critical base is assembled and only explicitly
 *   allow-listed variables are added, so credentials in the caller's shell
 *   (API keys, tokens) cannot leak into a spawned command or the sandbox.
 *
 * This is OS-level supervision, not a security sandbox: it bounds lifecycle
 * and leakage, not what the child chooses to do with the env it gets.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SupervisedSpawnOptions {
  cwd: string;
  /** Wall-clock cap; on expiry the whole tree is killed. Default: no timeout. */
  timeoutMs?: number;
  /**
   * Additional environment variables (by name) to pass through from the
   * parent environment, on top of the platform-critical base.
   */
  envAllowlist?: readonly string[];
  /** Extra env values set explicitly (win over allowlisted passthrough). */
  env?: Record<string, string | undefined>;
  /**
   * Per-process commit cap in MB, enforced by the Win32 Job Object when the
   * job helper is active (win32 only; ignored on the fallback-taskkill path).
   */
  processMemoryLimitMb?: number;
}

export interface SupervisedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the tree was killed because timeoutMs expired. */
  timedOut: boolean;
  durationMs: number;
}

/**
 * The sanitized environment both engines' supervised spawns run with —
 * world.run (engine.spawnCaptured) and the legacy gates (core/step.ts,
 * core/context.ts, Issue #151). Allowlist-only: spawned children never
 * inherit the parent environment.
 */
export const SPAWN_ENV_ALLOWLIST: readonly string[] = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'NODE_ENV',
];

export interface SupervisedProcess {
  child: ChildProcess;
  /** Resolve when the process exits or times out (never rejects). */
  result: Promise<SupervisedResult>;
  /** Kill the whole tree now (idempotent). Resolves after the kill is issued. */
  killTree: () => Promise<void>;
  /** The process pid; undefined after the child already exited. */
  pid: number | undefined;
}

const PLATFORM_BASE_ENV_WIN = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'PROGRAMFILES', 'PROGRAMFILES(X86)'];
const PLATFORM_BASE_ENV_POSIX = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];

/**
 * A minimal environment: platform-critical variables plus the allowlist.
 * On Windows variable names are matched case-insensitively.
 */
export function buildSanitizedEnv(
  allowlist: readonly string[] = [],
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32';
  const base = isWindows ? PLATFORM_BASE_ENV_WIN : PLATFORM_BASE_ENV_POSIX;
  const wanted = new Set<string>(base);
  for (const name of allowlist) {
    wanted.add(isWindows ? name.toUpperCase() : name);
  }

  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const probe = isWindows ? key.toUpperCase() : key;
    if (wanted.has(probe)) {
      out[key] = value;
      if (isWindows && probe !== key) {
        out[probe] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Non-mutating liveness probe: `process.kill(pid, 0)` performs the OS
 * existence/permission check without delivering a signal.
 *
 * Verdict rule (GOAL.md §1.5 stale-running recovery): a successful probe, or
 * `EPERM` (the process exists but this user may not signal it), means ALIVE —
 * fail-safe, since refusing a resume is the safe direction. `ESRCH` (no such
 * process) and every other error mean NOT alive. Windows note: `kill(pid, 0)`
 * checks existence there too and does not surface `EPERM` for existing
 * processes, so the platform degrades gracefully to exists / not-exists — the
 * resume takeover semantics are pinned cross-platform by injecting a stub
 * probe in the runner tests.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kill a process and its whole tree, platform-appropriately. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      killer.on('error', () => resolve()); // best effort — fall back below
      killer.on('close', () => resolve());
    });
    // Belt and braces: also signal the direct child in case taskkill was
    // unavailable (non- standard PATH).
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }
  // POSIX: negative pid targets the process group (the child is a group
  // leader because it was spawned detached).
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Minimal signal-registration surface shared by the real `process` object and
 * test doubles (an `EventEmitter` satisfies it), so unit tests can exercise
 * the platform branches with an injected bus instead of real OS signals.
 */
export interface SignalBus {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Host-signal supervision for the duration of one run (GOAL.md 铁律 3 —
 * 零孤儿进程): SIGINT/SIGTERM everywhere, SIGBREAK additionally on Windows
 * (Ctrl+Break is Windows-only and never deliverable on POSIX). A signal means
 * "stop the run" — the runner's handler kills the whole sandbox tree and lets
 * the run settle as failed before the host process exits.
 *
 * The caller MUST call the returned disposer exactly once when the run
 * settles, on EVERY exit path (try/finally) — leaving handlers registered
 * would both swallow the next Ctrl+C and make back-to-back runs in one
 * process (node --test runs a whole file in one process) interfere with each
 * other.
 *
 * `bus` and `signals` are injectable for tests: the platform branch (with or
 * without SIGBREAK) is covered by passing a fake bus, and the POSIX default
 * set is covered by faking `process.platform` — real POSIX signal delivery
 * cannot be exercised on a Windows host.
 */
export function onHostSignals(
  handler: (signal: NodeJS.Signals) => void,
  bus: SignalBus = process,
  signals: readonly NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM'],
): () => void {
  for (const signal of signals) bus.on(signal, handler);
  return () => {
    for (const signal of signals) bus.off(signal, handler);
  };
}

// ---------------------------------------------------------------------------
// Win32 Job Object supervision (Issue #98): a tiny C# helper
// (scripts/win32-jobhelper.cs, compiled lazily by the Windows built-in
// csc.exe into a gitignored cache) becomes the DIRECT parent of the supervised
// command and owns a Job Object with KILL_ON_JOB_CLOSE (+ an optional
// per-process commit cap). killTree() is unchanged — taskkill on the helper
// pid closes the job handle and the kernel tears the tree down; a dead node
// parent is matched by the helper's own wait and ends the tree too.
// Degradation (non-win32 / missing csc / failed compile / failed launch) is
// memoized once per process, observable via queryJobGuardStatus(), and falls
// back to the legacy spawn + taskkill /T path with zero functional loss (only
// the memory cap and the crash insurance are lost). POSIX paths are untouched.
// ---------------------------------------------------------------------------

export type JobGuardMode = 'job-object' | 'fallback-taskkill';

export interface JobGuardStatus {
  mode: JobGuardMode;
  /** Why the fallback is active (absent in job-object mode). */
  reason?: string;
}

/** Test injection surface: an explicit csc path overrides the default probe. */
export interface JobGuardProbe {
  cscPath?: string;
  /**
   * Test injection point (Issue #108): overrides the compile cache directory,
   * so a cache that cannot be created can be reproduced deterministically
   * (a regular file at the injected path makes mkdirSync fail — ENOTDIR on
   * POSIX, ENOENT on win32/Node 22; see Issue #261).
   */
  cacheDir?: string;
}

/**
 * stderr sentinel the helper writes when it fails to spawn the supervised
 * command (or the in-job check fails). This LINE is the authoritative
 * spawn-failure criterion — the helper forwards real child exit codes 1:1, so
 * its own exit codes 2/3 collide with them and cannot be used.
 */
export const JOB_HELPER_SENTINEL_PREFIX = 'aiwf-jobhelper: spawn ';

interface JobGuardVerdict {
  status: JobGuardStatus;
  /** Compiled helper exe path (job-object mode only). */
  helperPath?: string;
}

/**
 * Module-level memo: the FIRST verdict computed in this process sticks. The
 * degradation chain (csc probe → compile → launch) must never be retried per
 * spawn (failure amplification), and an injected probe poisons the whole
 * process — which is exactly why the fallback-injection tests live in their
 * own file (node --test runs every file in a separate process).
 */
let jobGuardMemo: JobGuardVerdict | undefined;

function findCscPath(): string | undefined {
  const windir = process.env.WINDIR ?? process.env.SystemRoot;
  if (!windir) return undefined;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function jobHelperSourcePath(): string {
  // dist/src/process-supervision.js → <repoRoot>/scripts/win32-jobhelper.cs
  return fileURLToPath(new URL('../../scripts/win32-jobhelper.cs', import.meta.url));
}

function jobHelperCacheDir(): string {
  // gitignored compile cache, anchored at the repo root (cwd-independent).
  return path.resolve(fileURLToPath(new URL('../../.cache/win32-jobhelper/', import.meta.url)));
}

/**
 * Compile the C# helper with the Windows built-in csc.exe. Cache key is the
 * source sha256 (deterministic product name → cross-process compile races are
 * harmless), products are hash-versioned to dodge the "cannot overwrite a
 * running exe" handle lock. `cacheDir` is injectable for tests (Issue #108).
 */
function compileJobHelper(cscPath: string, cacheDir: string = jobHelperCacheDir()): string | undefined {
  const source = jobHelperSourcePath();
  if (!fs.existsSync(source)) return undefined;
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
  const product = path.join(cacheDir, `jobhelper-${hash}.exe`);
  if (fs.existsSync(product)) return product;
  fs.mkdirSync(cacheDir, { recursive: true });
  const temp = `${product}.${process.pid}.tmp`;
  const compiled = spawnSync(cscPath, ['-nologo', '-warn:0', '-target:exe', `-out:${temp}`, source], {
    timeout: 60_000,
    windowsHide: true,
  });
  let compiledOk = compiled.status === 0 && fs.existsSync(temp);
  if (compiledOk) {
    try {
      fs.renameSync(temp, product);
    } catch (err) {
      // Cross-process compile race: a sibling may have won the rename. The
      // product name is deterministic (source sha256) — if the target exists
      // now, the compile is a success for us too; otherwise it failed.
      if (!fs.existsSync(product)) compiledOk = false;
    }
  }
  if (!compiledOk) {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    return undefined;
  }
  return product;
}

function computeJobGuard(probe?: JobGuardProbe): JobGuardVerdict {
  if (process.platform !== 'win32') {
    return { status: { mode: 'fallback-taskkill', reason: 'job-object supervision is win32-only' } };
  }
  const csc = probe?.cscPath ?? findCscPath();
  if (!csc || !fs.existsSync(csc)) {
    return {
      status: {
        mode: 'fallback-taskkill',
        reason: csc !== undefined
          ? `csc.exe not found at ${csc} — job helper cannot be compiled`
          : 'csc.exe not found under %WINDIR%\\Microsoft.NET — job helper cannot be compiled',
      },
    };
  }
  const cacheDir = probe?.cacheDir ?? jobHelperCacheDir();
  // The compile chain touches the filesystem (source read, cache mkdir,
  // rename) before any process is spawned. A cache that cannot be created —
  // a read-only package root, a managed container mount — must degrade to the
  // legacy taskkill path like every other compile failure, NOT escape as an
  // exception out of spawnJobGuarded (Issue #108: the memo was previously only
  // written on success, so such a failure re-threw on every single spawn).
  let helperPath: string | undefined;
  try {
    helperPath = compileJobHelper(csc, cacheDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    return {
      status: {
        mode: 'fallback-taskkill',
        reason: `job helper cache unusable at ${cacheDir} (${code}) — falling back to taskkill`,
      },
    };
  }
  if (!helperPath) {
    return { status: { mode: 'fallback-taskkill', reason: `job helper compilation failed (csc: ${csc})` } };
  }
  return { status: { mode: 'job-object' }, helperPath };
}

function resolveJobGuard(probe?: JobGuardProbe): JobGuardVerdict {
  if (jobGuardMemo) return jobGuardMemo;
  jobGuardMemo = computeJobGuard(probe);
  return jobGuardMemo;
}

/** Observability for the supervision mode (memoized; first verdict sticks). */
export function queryJobGuardStatus(probe?: JobGuardProbe): JobGuardStatus {
  return resolveJobGuard(probe).status;
}

export interface SpawnJobGuardedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdio for the supervised process (default ['ignore','pipe','pipe']). */
  stdio?: ('pipe' | 'ignore' | 'inherit')[];
  /** Per-process commit cap in MB (0/undefined = no cap; win32 job mode only). */
  processMemoryLimitMb?: number;
  /**
   * Issue #259: complete child command line (program + arguments, already
   * quoted for the child's parse level) forwarded to the job helper's `--raw`
   * mode. Required for `cmd /d /s /c` routes: the helper's default argv path
   * re-quotes elements with MSVCRT rules, which cmd.exe does not honor — the
   * verbatim line is the only shape that survives both parsers. The fallback
   * (no-helper) branch spawns `cmd/args` with `windowsVerbatimArguments`
   * instead.
   */
  rawCommandLine?: string;
}

/**
 * Spawn under the Win32 Job Object helper when available; otherwise spawn
 * directly with the exact legacy options (windowsHide, no shell, no win32
 * detachment). The caller receives the HELPER process — child.pid is the
 * helper's pid and the real command is its job member; stdio handles pass
 * through the helper to the real child byte-faithfully.
 *
 * Typing overload: an all-pipe stdio yields non-null streams (both spawn
 * branches honor the caller's stdio verbatim), so the runner's pump code
 * keeps its pre-helper narrowing.
 */
export function spawnJobGuarded(cmd: string, args: string[], opts: SpawnJobGuardedOptions & { stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessWithoutNullStreams;
export function spawnJobGuarded(cmd: string, args: string[], opts?: SpawnJobGuardedOptions): ChildProcess;
export function spawnJobGuarded(cmd: string, args: string[], opts: SpawnJobGuardedOptions = {}): ChildProcess {
  const stdio = opts.stdio ?? ['ignore', 'pipe', 'pipe'];
  const rawMode = opts.rawCommandLine !== undefined;
  const verdict = resolveJobGuard();
  if (verdict.helperPath !== undefined && fs.existsSync(verdict.helperPath)) {
    const helperArgs = rawMode
      ? [
          '--ppid', String(process.pid),
          '--mem-mb', String(Math.max(0, Math.round(opts.processMemoryLimitMb ?? 0))),
          '--raw', opts.rawCommandLine!,
        ]
      : [
          '--ppid', String(process.pid),
          '--mem-mb', String(Math.max(0, Math.round(opts.processMemoryLimitMb ?? 0))),
          '--', cmd, ...args,
        ];
    const helper = spawn(verdict.helperPath, helperArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio,
      windowsHide: true,
      shell: false,
      // Raw mode carries a pre-quoted command line; verbatim passing is the
      // whole point (any CRT re-quoting by Node would corrupt it).
      windowsVerbatimArguments: rawMode,
      // The helper stays attached: taskkill /T on its pid must reach it (the
      // fallback kill path in both modes).
      detached: false,
    });
    // Third degradation tier: the compiled helper failed to LAUNCH (e.g. AV
    // block). This spawn surfaces the error to the caller exactly like a
    // direct-spawn failure today; the memo sends every future spawn down the
    // fallback path instead of repeating the failure.
    helper.once('error', (err) => {
      jobGuardMemo = {
        status: { mode: 'fallback-taskkill', reason: `job helper launch failed: ${err instanceof Error ? err.message : String(err)}` },
      };
    });
    return helper as ChildProcessWithoutNullStreams;
  }
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio,
    windowsHide: true,
    shell: false,
    // Issue #263: in raw mode `args` is the pre-quoted cmd tail (see
    // buildCmdRouteInvocation). Without verbatim passing Node re-quotes that
    // tail with MSVCRT rules — cmd.exe does not understand `\"`, so the quote
    // toggling breaks: the `&` still splits the line AND the shim itself stops
    // resolving (npm --version exited 1 instead of printing a version). The
    // comment on `rawCommandLine` promised this; the code now does it.
    windowsVerbatimArguments: rawMode,
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;
}

/**
 * Windows: package-manager CLIs are `.cmd`/`.bat` shims (npm.cmd, npx.cmd,
 * tsc.cmd, …) and a `shell: false` spawn cannot exec them — `world.run('npm', …)`
 * failed with ENOENT on every Windows machine. When the bare command name
 * resolves through the (sanitized) PATH to a `.cmd`/`.bat` shim, return the
 * cmd.exe binary so the caller routes through `cmd /c`; real executables and
 * explicit paths are returned untouched. POSIX is a pass-through.
 */
export function resolveWindowsSpawnCommand(cmd: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return cmd;
  if (/[\\/]/.test(cmd)) return cmd; // explicit path — the caller's responsibility
  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').map((d) => d.trim()).filter(Boolean);
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, `${cmd}${ext}`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return ext === '.cmd' || ext === '.bat' ? env.COMSPEC ?? 'cmd.exe' : cmd;
        }
      } catch {
        // unreadable PATH entry — keep scanning
      }
    }
  }
  return cmd; // not found — let the spawn fail with its own ENOENT
}

/**
 * Quote one argument for the cmd.exe parse level (Issue #259). cmd.exe decides
 * whether a character is a metacharacter (`& | < > ^ ( )`) by quote toggling
 * only — it does not understand the MSVCRT `\"` escape, so the CRT-style
 * quoting Node/libuv applies cannot protect an argument like `&` once the line
 * reaches `cmd /c`: the `&` must already sit INSIDE double quotes at the cmd
 * parse level. Doubling embedded quotes (`""`) is understood by BOTH parsers —
 * cmd toggles twice (net: stay quoted) and the MSVCRT of the final target
 * decodes it as one literal quote. Backslash runs that directly precede a
 * quote or end-of-string are doubled for the MSVCRT (paths like `C:\foo\`).
 *
 * Known residuals, both accepted and documented: `%VAR%` is expanded by cmd in
 * an early phase even inside quotes (only vars present in the sanitized child
 * env can expand), and an ODD run of backslashes directly before an embedded
 * quote loses the quote textually (data corruption, never an injection — the
 * cmd-level quoting stays balanced).
 */
export function quoteForCmd(arg: string): string {
  return `"${arg
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/\\+$/, (m) => m + m)}"`;
}

/**
 * Shape the `cmd /d /s /c` invocation for a `.cmd`/`.bat` route (Issue #259).
 * `spawnArgs` is the argv-array form for the direct (fallback) spawn, where
 * `windowsVerbatimArguments` must be set so Node passes the pre-quoted tail
 * through byte-faithfully; `rawChildLine` is the complete child command line
 * for the job-helper `--raw` mode, which forwards it to CreateProcessW
 * verbatim (the helper's CRT-style QuoteArg would re-break cmd quoting).
 *
 * The tail is wrapped once more in quotes because cmd.exe's `/s` rule strips
 * the FIRST and LAST quote of the `/c` string when it starts with a quote:
 * `/c ""npm" "--version""` → `"npm" "--version"` executed as typed. Quoting
 * the command name itself also protects a shim whose name carries
 * metacharacters planted in PATH.
 */
export function buildCmdRouteInvocation(
  cmd: string,
  args: readonly string[],
  comspec: string,
): { spawnArgs: string[]; rawChildLine: string } {
  const tail = [cmd, ...args.map(quoteForCmd)].join(' ');
  return {
    spawnArgs: ['/d', '/s', '/c', `"${tail}"`],
    rawChildLine: `${comspec} /d /s /c "${tail}"`,
  };
}

/**
 * Spawn a supervised process: own process group on POSIX, whole-tree kill on
 * timeout or via killTree(), and a sanitized environment. On Windows the spawn
 * goes through the Job Object helper when it is available (spawnJobGuarded);
 * the POSIX branch below is byte-identical to the pre-helper code.
 */
export function spawnSupervised(cmd: string, args: string[], opts: SupervisedSpawnOptions): SupervisedProcess {
  const startedAt = Date.now();
  const isWindows = process.platform === 'win32';
  const env = buildSanitizedEnv(opts.envAllowlist, opts.env);

  const resolved = resolveWindowsSpawnCommand(cmd, env);
  // `.cmd`/`.bat` route: arguments must be quoted at the CMD parse level
  // (Issue #259 — an unquoted `&` in any data-driven argument executed a
  // second command). buildCmdRouteInvocation yields the verbatim shapes for
  // both spawn branches; POSIX and real-executable routes pass args untouched.
  const cmdRoute = isWindows && resolved !== cmd;
  const route = cmdRoute
    ? buildCmdRouteInvocation(cmd, args, resolved)
    : undefined;
  const spawnArgs = route ? route.spawnArgs : args;

  const child = isWindows
    ? spawnJobGuarded(resolved, spawnArgs, {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        processMemoryLimitMb: opts.processMemoryLimitMb,
        rawCommandLine: route?.rawChildLine,
      })
    : spawn(resolved, spawnArgs, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        // POSIX: detached makes the child a process-group leader, enabling the
        // -pid group kill. On Windows this flag only affects console attachment
        // and is harmless; the tree kill goes through taskkill /T instead.
        detached: !isWindows,
        env,
      });

  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let settled = false;

  const childStdout = child.stdout;
  const childStderr = child.stderr;
  childStdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < 1_048_576) stdout += chunk.toString('utf8');
  });
  childStderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_048_576) stderr += chunk.toString('utf8');
  });

  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid!);
    }, opts.timeoutMs);
    timer.unref?.();
  }

  const killTreeBound = async (): Promise<void> => {
    if (child.pid !== undefined) await killTree(child.pid);
  };

  const result = new Promise<SupervisedResult>((resolve) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Job-helper spawn-failure sentinel (Issue #98): the helper
      // reports CreateProcessW / in-job-check failures with a stderr line —
      // the AUTHORITATIVE criterion, because its exit codes 2/3 collide with
      // 1:1-forwarded child exit codes. Mapped to exitCode -1 + the sentinel
      // line as stderr, preserving the resolve-class semantics a win32 spawn
      // failure already has (engine.ts maps the legacy shape the same way).
      const sentinelLine = stderr.split(/\r?\n/).find((line) => line.startsWith(JOB_HELPER_SENTINEL_PREFIX));
      resolve({
        exitCode: sentinelLine !== undefined ? -1 : (child.exitCode ?? -1),
        stdout,
        stderr: sentinelLine !== undefined ? sentinelLine : stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    child.on('error', () => finish()); // spawn failure → exitCode -1
    child.on('close', () => finish());
  });

  return { child, result, killTree: killTreeBound, pid: child.pid };
}

export interface PidGuard {
  mode: 'watchdog' | 'fallback';
  /**
   * Stop the watchdog (best effort). The child's own close is the primary
   * cleanup path — the guard only exists for the host-dies-first case.
   */
  stop(): void;
}

/**
 * Issue #117: keep an ALREADY-RUNNING child pid from outliving the host —
 * for stdio servers the MCP SDK spawns on our behalf (we never see the spawn,
 * so spawnJobGuarded does not apply).
 *
 * Windows: the compiled job helper's `adopt` mode puts the pid into a fresh
 * kill-on-close job and waits on the host pid — host death (any way,
 * including SIGKILL of node) closes the job and the kernel tears the child
 * down. Degradation (no csc / compile failure) returns 'fallback': the
 * client's own disconnectAll remains the cleanup path, same as before.
 *
 * POSIX: the child sits in the host's process group (Ctrl+C reaches it); a
 * detached sh watchdog closes the SIGKILL gap by polling the host and
 * SIGKILLing the child if the host vanishes.
 */
export function adoptPidIntoJobGuard(childPid: number, hostPid: number = process.pid): PidGuard {
  if (process.platform === 'win32') {
    const verdict = resolveJobGuard();
    if (verdict.status.mode === 'job-object' && verdict.helperPath) {
      const helper = spawn(verdict.helperPath, ['adopt', '--pid', String(childPid), '--ppid', String(hostPid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      helper.unref();
      return {
        mode: 'watchdog',
        stop: () => {
          try {
            helper.kill();
          } catch {
            /* the helper already exited (host or child died first) */
          }
        },
      };
    }
    return { mode: 'fallback', stop: () => {} };
  }
  const watchdog = spawn(
    'sh',
    ['-c', `while kill -0 ${hostPid} 2>/dev/null; do sleep 0.5; done; kill -9 ${childPid} 2>/dev/null`],
    { stdio: 'ignore', detached: true },
  );
  watchdog.unref();
  return {
    mode: 'fallback',
    stop: () => {
      try {
        watchdog.kill();
      } catch {
        /* the watchdog already exited */
      }
    },
  };
}
