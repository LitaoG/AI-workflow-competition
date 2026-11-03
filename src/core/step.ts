import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { StepDefinition, StepRunner, ExecutionContext, RetryPolicy, ProberResult } from '../types.js';
import { GateFailureError } from './error.js';
import { agent } from '../agent/rpc.js';
import { probe as runProber } from '../prober/index.js';

const execAsync = promisify(exec);

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

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: config.cwd ?? process.cwd(),
        timeout,
        windowsHide: true,
      });

      const res = { success: true, stdout, stderr, exitCode: 0 };
      if (config.customAssertion && !config.customAssertion(res)) {
        throw new GateFailureError(config.id, cmd, 0, stdout, `Custom assertion failed for gate ${config.id}`);
      }
      return res;
    } catch (err: any) {
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? err.message ?? '';
      throw new GateFailureError(config.id, cmd, exitCode, stdout, stderr);
    }
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

    const executeWorker = async () => {
      while (currentIndex < items.length) {
        const idx = currentIndex++;
        results[idx] = await config.worker(items[idx], idx, ctx);
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
    runner: config.action,
  };
}
