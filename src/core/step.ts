import { z } from 'zod';
import { StepDefinition, StepRunner, ExecutionContext, RetryPolicy, ProberResult } from '../types.js';
import { GateFailureError } from './error.js';
import { agent } from '../agent/rpc.js';
import { probe as runProber } from '../prober/index.js';
import { spawnSupervised, SPAWN_ENV_ALLOWLIST, JOB_HELPER_SENTINEL_PREFIX } from '../process-supervision.js';
// Leaf utility (redact.ts pulls only ../prober, which is read-only) — the
// shared irreversible mask so gate output can never carry credentials into
// outputs, events or the journal, matching the world.run boundary.
import { redactText } from '../dwf/redact.js';

/**
 * Split a legacy shell-string gate command into argv for the supervised,
 * shell-less spawn (Issue #151: gates migrate to the world.run security
 * standard — no cmd.exe/sh between the engine and the child). Whitespace
 * splits; double-quoted sections group (`\"` escapes a quote, backslashes
 * stay verbatim so Windows paths survive); single-quoted sections group
 * literally. Shell control syntax (&& || ; > < ` $()) is refused loudly
 * instead of silently misbehaving — a sequence that used to run in one shell
 * line becomes separate gate steps.
 */
export function parseGateCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  const flush = (): void => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === '"') {
      hasToken = true;
      let closed = false;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        const c = cmd[j]!;
        if (c === '\\' && cmd[j + 1] === '"') {
          current += '"';
          j++;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        current += c;
      }
      if (!closed) throw new Error(`gate command has an unterminated double quote: ${cmd}`);
      i = j;
      continue;
    }
    if (ch === "'") {
      hasToken = true;
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error(`gate command has an unterminated single quote: ${cmd}`);
      current += cmd.slice(i + 1, end);
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if ('&|;<>`'.includes(ch)) {
      throw new Error(`gate command "${cmd}" uses shell control syntax ("${ch}") — gates run without a shell since #151; split the sequence into separate gate steps`);
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      throw new Error(`gate command "${cmd}" uses command substitution $() — gates run without a shell since #151; pass pre-computed values instead`);
    }
    current += ch;
    hasToken = true;
  }
  flush();
  if (tokens.length === 0) throw new Error('gate command is empty');
  return tokens;
}

/**
 * Run one gate argv under the supervised standard (process-group / Job Object
 * tree kill on timeout, allowlist-only env). Resolves with the captured
 * result; never throws for a nonzero exit — callers map outcomes.
 */
export async function runGateCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const supervised = spawnSupervised(argv[0]!, argv.slice(1), {
    cwd,
    timeoutMs,
    envAllowlist: SPAWN_ENV_ALLOWLIST,
  });
  const result = await supervised.result;
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut };
}

/**
 * Issue #233: a spawn that never STARTED has no side effects, so a transient
 * system-level spawn failure is infrastructure noise, not a gate outcome —
 * the same philosophy as the agent face (failover exists for output-quality
 * reasons, never for infrastructure noise). The win32 job-helper (the
 * authoritative spawn face) surfaces CreateProcessW failures as exitCode -1
 * plus a sentinel line whose errno is EUNKNOWN for every non-ENOENT/EACCES
 * error — resource exhaustion under parallel load included; the legacy
 * direct-spawn shape (`spawn EAGAIN …`) says the same. Retrying a
 * never-started command is idempotent; persistent shapes (ENOENT/EACCES,
 * EUSAGE / job-config / is-in-job sentinels) and real outcomes (nonzero exit,
 * timeout, ordinary failure) never match and map exactly as before.
 */
export function isTransientSpawnFailure(result: { exitCode: number; stderr: string; timedOut: boolean }): boolean {
  if (result.exitCode !== -1 || result.timedOut) return false;
  const neverStarted =
    result.stderr.startsWith(JOB_HELPER_SENTINEL_PREFIX) || result.stderr.startsWith('spawn ');
  if (!neverStarted) return false;
  return /\b(EAGAIN|EMFILE|ENOMEM|EBUSY|EUNKNOWN)\b/.test(result.stderr);
}

const GATE_SPAWN_ATTEMPTS = 3;
const GATE_SPAWN_RETRY_DELAY_MS = 200;

/** runGateCommand with a bounded retry that rides out transient spawn failures (#233). */
export async function runGateCommandWithTransientRetry(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  let result = await runGateCommand(argv, cwd, timeoutMs);
  for (let attempt = 1; isTransientSpawnFailure(result) && attempt < GATE_SPAWN_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, GATE_SPAWN_RETRY_DELAY_MS));
    result = await runGateCommand(argv, cwd, timeoutMs);
  }
  return result;
}

export interface AgentStepConfig<TInput, TOutput> {
  id: string;
  name: string;
  phaseId: string;
  agentRole: string;
  schema: z.ZodType<TOutput>;
  promptBuilder: (input: TInput, ctx: ExecutionContext) => string;
  systemPrompt?: string;
  dependsOn?: string[];
  retryPolicy?: RetryPolicy;
  mockResponse?: TOutput;
}

export function agentStep<TInput, TOutput>(config: AgentStepConfig<TInput, TOutput>): StepDefinition<TInput, TOutput> {
  const runner: StepRunner<TInput, TOutput> = async (input, ctx) => {
    const prompt = config.promptBuilder(input, ctx);
    const client = agent(config.agentRole);
    return await client.ask<TOutput>(prompt, config.schema, {
      systemPrompt: config.systemPrompt,
      mockResponse: config.mockResponse,
    });
  };

  return {
    id: config.id,
    name: config.name,
    phaseId: config.phaseId,
    type: 'agent',
    role: 'worker',
    dependsOn: config.dependsOn,
    runner,
    retryPolicy: config.retryPolicy,
  };
}

export interface GateStepConfig<TInput = unknown> {
  id: string;
  name: string;
  phaseId: string;
  command: string | ((input: TInput, ctx: ExecutionContext) => string);
  cwd?: string;
  timeoutMs?: number;
  dependsOn?: string[];
  customAssertion?: (result: { exitCode: number; stdout: string; stderr: string }) => boolean;
}

export function gateStep<TInput = unknown>(
  config: GateStepConfig<TInput>
): StepDefinition<TInput, { success: boolean; stdout: string; stderr: string; exitCode: number }> {
  const runner: StepRunner<TInput, { success: boolean; stdout: string; stderr: string; exitCode: number }> = async (
    input,
    ctx
  ) => {
    const cmd = typeof config.command === 'function' ? config.command(input, ctx) : config.command;
    const timeout = config.timeoutMs ?? 30000;

    // Supervised, shell-less spawn (Issue #151): allowlist-only env, whole-tree
    // timeout kill, irreversible output redaction — the same boundary the dwf
    // world.run already enforces. Outcome mapping preserves the exec-era
    // contract: nonzero exit / spawn failure / timeout reject with
    // GateFailureError, success resolves with the captured result.
    let result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
    try {
      result = await runGateCommandWithTransientRetry(parseGateCommand(cmd), config.cwd ?? process.cwd(), timeout);
    } catch (err: any) {
      // parse/spawn-level rejection (bad syntax, command not found before the
      // child exists) — the exec-era shape: exit 1, the error text as stderr.
      throw new GateFailureError(config.id, cmd, 1, '', redactText(String(err?.message ?? err)));
    }
    if (result.timedOut) {
      throw new GateFailureError(config.id, cmd, 1, redactText(result.stdout), redactText(`gate "${cmd}" timed out after ${timeout}ms (process tree killed)`));
    }
    if (result.exitCode === -1 && result.stderr.startsWith('spawn ')) {
      throw new GateFailureError(config.id, cmd, 1, '', redactText(result.stderr));
    }
    if (result.exitCode !== 0) {
      throw new GateFailureError(config.id, cmd, result.exitCode, redactText(result.stdout), redactText(result.stderr));
    }

    const res = { success: true, stdout: redactText(result.stdout), stderr: redactText(result.stderr), exitCode: 0 };
    if (config.customAssertion && !config.customAssertion(res)) {
      throw new GateFailureError(config.id, cmd, 0, res.stdout, `Custom assertion failed for gate ${config.id}`);
    }
    return res;
  };

  return {
    id: config.id,
    name: config.name,
    phaseId: config.phaseId,
    type: 'gate',
    role: 'gate',
    dependsOn: config.dependsOn,
    runner,
  };
}

export interface ProbeStepConfig {
  id: string;
  name: string;
  phaseId: string;
  dependsOn?: string[];
  cwd?: string;
}

export function probeStep(config: ProbeStepConfig): StepDefinition<void, ProberResult> {
  const runner: StepRunner<void, ProberResult> = async (_input, ctx) => {
    const probeResult = await runProber({ cwd: config.cwd });
    ctx.setProbeSnapshot(probeResult);
    return probeResult;
  };

  return {
    id: config.id,
    name: config.name,
    phaseId: config.phaseId,
    type: 'probe',
    role: 'inspector',
    dependsOn: config.dependsOn,
    runner,
  };
}

export interface FanOutStepConfig<TItem, TResult> {
  id: string;
  name: string;
  phaseId: string;
  itemsProvider: (ctx: ExecutionContext) => TItem[];
  worker: (item: TItem, index: number, ctx: ExecutionContext) => Promise<TResult>;
  concurrency?: number;
  dependsOn?: string[];
}

export function fanOutStep<TItem, TResult>(
  config: FanOutStepConfig<TItem, TResult>
): StepDefinition<void, TResult[]> {
  const runner: StepRunner<void, TResult[]> = async (_input, ctx) => {
    const items = config.itemsProvider(ctx);
    if (items.length === 0) return [];

    const concurrency = config.concurrency ?? 5;
    const results: TResult[] = new Array(items.length);
    let currentIndex = 0;
    // errgroup discipline (workflow.ts): once one worker fails or the step is
    // cancelled, start no NEW items — the batch signal has been aborted and the
    // step is already being recorded as failed, so the old behavior (pool
    // workers kept pulling queued items whose results were then discarded)
    // spent real side effects on garbage.
    let stopped = false;

    const executeWorker = async () => {
      while (currentIndex < items.length) {
        if (stopped || ctx.signal?.aborted) return;
        const idx = currentIndex++;
        try {
          results[idx] = await config.worker(items[idx], idx, ctx);
        } catch (err) {
          stopped = true;
          throw err;
        }
      }
    };

    const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => executeWorker());
    await Promise.all(pool);

    return results;
  };

  return {
    id: config.id,
    name: config.name,
    phaseId: config.phaseId,
    type: 'fanout',
    role: 'worker',
    dependsOn: config.dependsOn,
    runner,
  };
}

export interface ActionStepConfig<TInput, TOutput> {
  id: string;
  name: string;
  phaseId: string;
  role?: string;
  action: (input: TInput, ctx: ExecutionContext) => Promise<TOutput>;
  dependsOn?: string[];
  /** Wall-clock cap for one execution of this step (enforced by Workflow.run — see withStepTimeout). */
  timeoutMs?: number;
}

export function actionStep<TInput, TOutput>(
  config: ActionStepConfig<TInput, TOutput>
): StepDefinition<TInput, TOutput> {
  return {
    id: config.id,
    name: config.name,
    phaseId: config.phaseId,
    type: 'action',
    role: config.role ?? 'worker',
    dependsOn: config.dependsOn,
    timeoutMs: config.timeoutMs,
    runner: config.action,
  };
}
