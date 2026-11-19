import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface CLIOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Issue #148: true when the run fell back to the reference MOCK engine. */
  usedMock: boolean;
  /** The resolved CLI target (bin, dist, AI_WORKFLOW_CLI override, or mock). */
  cliPath: string;
  json<T = unknown>(): T;
}

/**
 * Resolves the CLI target executable.
 * Prioritizes production entrypoints (bin/workflow.js or compiled dist/src/cli/index.js),
 * falling back to the test reference mock engine if production build is not yet available.
 */
export function resolveCLIPath(): string {
  if (process.env.AI_WORKFLOW_CLI && fs.existsSync(process.env.AI_WORKFLOW_CLI)) {
    return process.env.AI_WORKFLOW_CLI;
  }

  const baseDir = import.meta.dirname || process.cwd();
  const projectRoot = path.resolve(baseDir, '..', '..', '..');

  // 1. Check production bin executable (bin/workflow.js)
  const binCli = path.join(projectRoot, 'bin', 'workflow.js');
  if (fs.existsSync(binCli)) {
    return binCli;
  }

  // 2. Check compiled distribution CLI entrypoint (dist/src/cli/index.js)
  const distCli = path.join(projectRoot, 'dist', 'src', 'cli', 'index.js');
  if (fs.existsSync(distCli)) {
    return distCli;
  }

  // 3. Fallback to test reference mock engine
  return path.join(baseDir, 'mock-engine.ts');
}

/**
 * Normalizes CLI arguments to harmonize test assertions with Commander options.
 */
function normalizeCLIArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Map init <template> <targetDir> to init <template> --dir <targetDir>
    if (args[0] === 'init' && i === 2 && !arg.startsWith('-')) {
      normalized.push('--dir', arg);
      continue;
    }
    if (args[0] === '/workflow' && args[1] === 'init' && i === 3 && !arg.startsWith('-')) {
      normalized.push('--dir', arg);
      continue;
    }

    normalized.push(arg);
  }
  return normalized;
}

/**
 * Executes the /workflow CLI command synchronously as an opaque box.
 */
export function runCLI(args: string[], options: CLIOptions = {}): CLIResult {
  const cliPath = resolveCLIPath();
  // Issue #148: the mock fallback used to be silent — with bin and dist both
  // missing, all 121 cases would run against the 576-line reference mock and
  // go green while proving nothing about the real CLI. Make the fallback loud
  // and observable on every result.
  const usedMock = cliPath.endsWith('mock-engine.ts');
  if (usedMock) {
    console.error(
      '[E2E WARNING] production CLI not found (bin/workflow.js AND dist/src/cli/index.js missing) — ' +
        'running against the REFERENCE MOCK ENGINE; these results prove nothing about the real CLI (Issue #148).',
    );
  }
  const startTime = Date.now();
  const normalizedArgs = normalizeCLIArgs(args);

  const spawnArgs = [
    '--experimental-strip-types',
    cliPath,
    ...normalizedArgs,
  ];

  const mergedEnv = {
    ...process.env,
    ...(options.env || {}),
  };

  const proc = spawnSync(process.execPath, spawnArgs, {
    cwd: options.cwd || process.cwd(),
    env: mergedEnv,
    timeout: options.timeoutMs || 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMs = Date.now() - startTime;
  const stdout = proc.stdout ? proc.stdout.trim() : '';
  const stderr = proc.stderr ? proc.stderr.trim() : '';
  // Preserve the real OS exit code (Issue #23): flattening every non-zero
  // code down to 1 made `exitCode === 0 || exitCode === 1` assertions
  // mathematically tautological (they could never fail) and erased the
  // distinction between a controlled failure and other codes.
  const exitCode = proc.status ?? (proc.error ? 1 : 0);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
    usedMock,
    cliPath,
    json<T = unknown>(): T {
      try {
        return JSON.parse(stdout) as T;
      } catch (err) {
        throw new Error(`Failed to parse CLI stdout as JSON: ${(err as Error).message}\nStdout was: ${stdout}`);
      }
    },
  };
}
