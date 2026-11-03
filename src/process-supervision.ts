/**
 * Process supervision for facade-script engine spawns (engine-spec deepening item:
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

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface SupervisedSpawnOptions {
  cwd: string;
  /** Wall-clock cap; on expiry the whole tree is killed. Default: no timeout. */
  timeoutMs?: number;
  /**
   * Additional environment variables (by name) to pass through from the
   * parent environment, on top of the platform-critical base.
   */
  envAllowlist?: string[];
  /** Extra env values set explicitly (win over allowlisted passthrough). */
  env?: Record<string, string | undefined>;
}

export interface SupervisedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the tree was killed because timeoutMs expired. */
  timedOut: boolean;
  durationMs: number;
}

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
  allowlist: string[] = [],
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
 * Verdict rule (stale-running recovery): a successful probe, or
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
 * Host-signal supervision for the duration of one run (engine iron rule —
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

/**
 * Spawn a supervised process: own process group on POSIX, whole-tree kill on
 * timeout or via killTree(), and a sanitized environment.
 */
export function spawnSupervised(cmd: string, args: string[], opts: SupervisedSpawnOptions): SupervisedProcess {
  const startedAt = Date.now();
  const isWindows = process.platform === 'win32';
  const env = buildSanitizedEnv(opts.envAllowlist, opts.env);

  const child = spawn(cmd, args, {
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
      resolve({
        exitCode: child.exitCode ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    child.on('error', () => finish()); // spawn failure → exitCode -1
    child.on('close', () => finish());
  });

  return { child, result, killTree: killTreeBound, pid: child.pid };
}
