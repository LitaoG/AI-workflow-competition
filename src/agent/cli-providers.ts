/**
 * CLI agent providers — route typed `agent().ask()` calls through external
 * agent CLIs (OpenAI Codex CLI, Gemini CLI, opencode) instead of a cloud SDK.
 *
 * Each provider spawns its CLI through the process supervisor (own process
 * group on POSIX, whole-tree kill on Windows, sanitized environment), so a
 * worker call inherits the same lifecycle guarantees as world.run gates.
 * The prompt is a single flattened turn: facade asks are one-shot by design.
 *
 * Selection is env-driven so the engine stays mock-by-default:
 *   AI_WORKFLOW_PROVIDER=codex|gemini|opencode
 *   AI_WORKFLOW_CLI_COMMAND=<explicit binary override>
 *   AI_WORKFLOW_CLI_TIMEOUT_MS=<millis, default 120000>
 */

import * as path from 'node:path';
import { LLMProvider, LLMRequest, LLMResponse } from '../types.js';
import { buildSanitizedEnv, spawnSupervised } from '../process-supervision.js';
import { providerRegistry } from './provider.js';

export interface CliProviderOptions {
  /** Explicit binary path; overrides the provider default. */
  command?: string;
  /** Extra args inserted before the prompt (e.g. model selection flags). */
  argsPrefix?: string[];
  /** Working directory for the CLI (default: process.cwd()). */
  cwd?: string;
  /** Wall clock for one ask; the whole process tree is killed on expiry. */
  timeoutMs?: number;
}

interface CliAgentSpec {
  id: string;
  name: string;
  command: string;
  argsPrefix: string[];
}

export abstract class CliAgentProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;

  private readonly command: string;
  private readonly argsPrefix: string[];
  private readonly cwd?: string;
  private readonly timeoutMs: number;

  constructor(spec: CliAgentSpec, options: CliProviderOptions = {}) {
    this.id = spec.id;
    this.name = spec.name;
    this.command = options.command ?? spec.command;
    this.argsPrefix = options.argsPrefix ?? spec.argsPrefix;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Flatten the RPC turn into the single prompt the CLI receives. */
  protected flatten(request: LLMRequest): string {
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = request.messages.filter((m) => m.role !== 'system').map((m) => m.content);
    return [...system, ...rest].join('\n\n');
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const prompt = this.flatten(request);
    const sup = spawnSupervised(this.command, [...this.argsPrefix, prompt], {
      cwd: this.cwd ?? process.cwd(),
      timeoutMs: this.timeoutMs,
      envAllowlist: ['NO_COLOR', 'FORCE_COLOR', 'NODE_ENV'],
    });
    const result = await sup.result;

    if (result.timedOut) {
      throw new Error(
        `${this.name} timed out after ${this.timeoutMs}ms (process tree killed): ${result.stderr.slice(0, 300)}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `${this.name} exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 500)}`,
      );
    }
    const content = result.stdout.trim();
    if (!content) {
      throw new Error(`${this.name} produced no output on stdout (stderr: ${result.stderr.slice(0, 300)})`);
    }
    return {
      content,
      model: `${this.id}:cli`,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** OpenAI Codex CLI: `codex exec "<prompt>"` prints the final message. */
export class CodexCliProvider extends CliAgentProvider {
  constructor(options: CliProviderOptions = {}) {
    super({ id: 'codex-cli', name: 'OpenAI Codex CLI (exec)', command: 'codex', argsPrefix: ['exec'] }, options);
  }
}

/** Gemini CLI: `gemini -p "<prompt>"` prints the model's answer. */
export class GeminiCliProvider extends CliAgentProvider {
  constructor(options: CliProviderOptions = {}) {
    super({ id: 'gemini-cli', name: 'Gemini CLI', command: 'gemini', argsPrefix: ['-p'] }, options);
  }
}

/** opencode: `opencode run "<prompt>"` prints the agent's reply. */
export class OpenCodeProvider extends CliAgentProvider {
  constructor(options: CliProviderOptions = {}) {
    super({ id: 'opencode', name: 'opencode CLI', command: 'opencode', argsPrefix: ['run'] }, options);
  }
}

export const CLI_PROVIDER_IDS = ['codex', 'codex-cli', 'gemini', 'opencode'] as const;
export type CliProviderSelection = (typeof CLI_PROVIDER_IDS)[number];

/**
 * Read AI_WORKFLOW_PROVIDER from the environment and register + default the
 * matching CLI provider. Returns the registry id that was selected, or
 * undefined when the env is unset/unknown (the mock default stays).
 */
export function configureCliProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.AI_WORKFLOW_PROVIDER?.trim().toLowerCase();
  if (!raw) return undefined;

  const options: CliProviderOptions = {
    command: env.AI_WORKFLOW_CLI_COMMAND || undefined,
    // Validate: NaN/0/negative survived the old `?? 120_000` (nullish only)
    // and reached setTimeout, which Node coerces to 1ms — every CLI ask died
    // as 'timed out after NaNms' (2026-11-14 round 2). Junk falls back to the
    // 120s default.
    timeoutMs: (() => {
      const raw = env.AI_WORKFLOW_CLI_TIMEOUT_MS?.trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
  };
  if (process.env.AI_WORKFLOW_WORKSPACE) {
    options.cwd = path.resolve(process.env.AI_WORKFLOW_WORKSPACE);
  }

  let provider: LLMProvider;
  let registryId: string;
  switch (raw) {
    case 'codex':
    case 'codex-cli':
      provider = new CodexCliProvider(options);
      registryId = provider.id;
      break;
    case 'gemini':
      provider = new GeminiCliProvider(options);
      registryId = provider.id;
      break;
    case 'opencode':
      provider = new OpenCodeProvider(options);
      registryId = provider.id;
      break;
    default:
      return undefined;
  }

  providerRegistry.register(provider);
  providerRegistry.setDefault(registryId);
  return registryId;
}
