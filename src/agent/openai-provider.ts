/**
 * OpenAI-compatible Chat Completions adapter — a thin {@link ProviderContract}
 * over `POST {baseUrl}/chat/completions` using Node 22's built-in `fetch` (no
 * SDK, no new runtime dependencies). `baseUrl` is configurable, so any
 * OpenAI-compatible endpoint (self-hosted gateways, proxies) works.
 *
 * Opt-in only: the provider is registered in the global registry exclusively
 * through {@link configureOpenAiFromEnv} when `OPENAI_API_KEY` is set — the
 * registry default stays the offline mock and nothing dials out on import.
 *
 * Credential discipline: the API key is read from the environment or the
 * constructor options and is never written to logs, error messages, error
 * `details`, or stacks. Server-provided text passes {@link redactServerText}
 * before it may enter an error.
 */

import type { ChatOptions, ChatResult, ProviderContract, StructuredOutputSpec } from './provider-contract.js';
import {
  AgentProviderError,
  asLlmProvider,
  composeAbortSignal,
  redactServerText,
  safeErrorBodyText,
  transportProviderError,
} from './provider-contract.js';
import { providerRegistry } from './provider.js';
import type { LLMMessage, ProviderHealth } from '../types.js';

export interface OpenAiProviderOptions {
  /** API key (from `OPENAI_API_KEY` or explicit config). Never logged. */
  apiKey: string;
  /** Default model id (`OPENAI_MODEL`); per-call `ChatOptions.model` wins. */
  model?: string;
  /** API base including version path (default `https://api.openai.com/v1`). */
  baseUrl?: string;
  /** Default sampling temperature (repo convention: 0). */
  temperature?: number;
  /** Default output token budget (default 2048). */
  maxTokens?: number;
  /** Adapter-owned wall-clock timeout per call in milliseconds. */
  timeoutMs?: number;
  /** Injectable `fetch` for offline tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Native OpenAI-compatible Chat Completions adapter. */
export class OpenAiProvider implements ProviderContract {
  readonly id = 'openai';
  readonly name = 'OpenAI-compatible Chat Completions API';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Env/config-level readiness probe — no network call, no key material. */
  checkHealth(): ProviderHealth {
    return {
      ok: this.apiKey.trim().length > 0,
      detail: `OPENAI_API_KEY configured (model ${this.model} via ${this.baseUrl}); env-level probe only`,
    };
  }

  async chat(messages: readonly LLMMessage[], options?: ChatOptions): Promise<ChatResult> {
    return await this.post(messages, options, undefined);
  }

  async complete(prompt: string, options?: ChatOptions): Promise<string> {
    const result = await this.post([{ role: 'user', content: prompt }], options, undefined);
    return result.content;
  }

  /**
   * Provider-native structured output: the spec maps onto OpenAI's
   * `response_format: { type: 'json_schema', ... }`. `strict` stays false —
   * the adapter cannot guarantee the caller's schema meets OpenAI's strict
   * subset, and the agent RPC self-heal loop validates the result anyway.
   */
  async structured(messages: readonly LLMMessage[], spec: StructuredOutputSpec, options?: ChatOptions): Promise<ChatResult> {
    return await this.post(messages, options, {
      type: 'json_schema',
      json_schema: {
        name: spec.name,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        schema: spec.schema,
        strict: false,
      },
    });
  }

  /** POST the chat payload and map the response onto {@link ChatResult}. */
  private async post(
    messages: readonly LLMMessage[],
    options: ChatOptions | undefined,
    responseFormat: Record<string, unknown> | undefined,
  ): Promise<ChatResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }

    const body: Record<string, unknown> = {
      model: options?.model ?? this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? this.temperature ?? 0.0,
      max_tokens: options?.maxTokens ?? this.maxTokens ?? 2048,
    };
    if (responseFormat !== undefined) body.response_format = responseFormat;

    const url = `${this.baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const signal = composeAbortSignal(options?.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (options?.signal?.aborted) throw err; // caller-driven cancel keeps AbortError identity
      throw transportProviderError(this.id, err, [this.apiKey]);
    }

    if (!response.ok) {
      throw await this.httpError(response);
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new AgentProviderError(this.id, 'OpenAI-compatible API returned a non-JSON success response', { retryable: true });
    }

    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const usage =
      json.usage && typeof json.usage === 'object'
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
          }
        : undefined;

    return {
      content,
      model: typeof json.model === 'string' ? json.model : this.model,
      ...(usage !== undefined ? { usage } : {}),
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Map a non-2xx response to an {@link AgentProviderError} (redacted body excerpt). */
  private async httpError(response: Response): Promise<AgentProviderError> {
    const text = await safeErrorBodyText(response);
    const excerpt = redactServerText(text, [this.apiKey]).slice(0, 200);
    const suffix = excerpt ? `: ${excerpt}` : '';
    return new AgentProviderError(this.id, `OpenAI-compatible API error (HTTP ${response.status})${suffix}`, {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    });
  }
}

function abortError(): Error {
  const e = new Error('ask cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Read `OPENAI_API_KEY` (plus optional `OPENAI_MODEL` / `OPENAI_BASE_URL`) and
 * register the `openai` provider in the global registry. Returns the registry
 * id, or `undefined` when the env is unset — the mock default stays and
 * nothing dials out.
 */
export function configureOpenAiFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;

  const provider = new OpenAiProvider({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  });
  providerRegistry.register(asLlmProvider(provider));
  return provider.id;
}
