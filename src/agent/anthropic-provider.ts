/**
 * Anthropic Messages API adapter — a thin {@link ProviderContract} over the
 * native `POST /v1/messages` endpoint using Node 22's built-in `fetch` (no SDK,
 * no new runtime dependencies).
 *
 * Opt-in only: the provider is registered in the global registry exclusively
 * through {@link configureAnthropicFromEnv} when `ANTHROPIC_API_KEY` is set —
 * the registry default stays the offline mock and nothing dials out on import.
 *
 * Credential discipline: the API key is read from the environment or the
 * constructor options and is never written to logs, error messages, error
 * `details`, or stacks. Server-provided text passes {@link redactServerText}
 * before it may enter an error.
 */

import type { ChatOptions, ChatResult, ProviderContract } from './provider-contract.js';
import {
  AgentProviderError,
  asLlmProvider,
  composeAbortSignal,
  redactServerText,
  retryAfterHeaderToResetAtMs,
  safeErrorBodyText,
  transportProviderError,
} from './provider-contract.js';
import { providerRegistry } from './provider.js';
import type { LLMMessage, ProviderHealth } from '../types.js';

/** Stable `anthropic-version` header value (Messages API). */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  /** API key (from `ANTHROPIC_API_KEY` or explicit config). Never logged. */
  apiKey: string;
  /** Default model id (`ANTHROPIC_MODEL`); per-call `ChatOptions.model` wins. */
  model?: string;
  /** API base (default `https://api.anthropic.com`); version path is appended. */
  baseUrl?: string;
  /** Default sampling temperature (repo convention: 0). */
  temperature?: number;
  /** Default output token budget (default 2048). */
  maxTokens?: number;
  /** Adapter-owned wall-clock timeout per call in milliseconds. */
  timeoutMs?: number;
  /** Injectable `fetch` for offline tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Mark the system prompt as prompt-cacheable. When true, the system prompt is
   * sent as a content block carrying `cache_control: { type: 'ephemeral' }` —
   * the ONLY shape the Messages API accepts (a top-level `cache_control` field
   * is rejected with HTTP 400 "Extra inputs are not permitted", which is what
   * the previous top-level-marker implementation triggered against the real
   * API). Left unset, {@link configureAnthropicFromEnv} decides from the
   * endpoint (official API on, custom base URL off) + `AI_WORKFLOW_ANTHROPIC_CACHE`.
   */
  cacheControl?: boolean;
}

/**
 * Native Anthropic Messages API adapter (`POST {baseUrl}/v1/messages`).
 *
 * The Messages API has no native structured-output (`response_format`) channel,
 * so this adapter does not advertise the contract's optional `structured` or
 * `stream` channels — JSON shape enforcement stays with the agent RPC self-heal
 * loop, exactly as for the mock/CLI providers.
 */
export class AnthropicProvider implements ProviderContract {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Messages API';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheControl: boolean;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'claude-sonnet-4-5';
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cacheControl = options.cacheControl ?? false;
  }

  /** Env/config-level readiness probe — no network call, no key material. */
  checkHealth(): ProviderHealth {
    return {
      ok: this.apiKey.trim().length > 0,
      detail: `ANTHROPIC_API_KEY configured (model ${this.model} via ${this.baseUrl}); env-level probe only`,
    };
  }

  async chat(messages: readonly LLMMessage[], options?: ChatOptions): Promise<ChatResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }

    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const apiMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens ?? 2048,
      temperature: options?.temperature ?? this.temperature ?? 0.0,
      messages: apiMessages,
    };
    if (system) {
      // Warm-cache alignment: actor sessions re-send the whole conversation on
      // every ask (engine.ts priorMessages). When enabled, the system prompt
      // rides as a cache-marked content block — the form the Messages API
      // actually accepts — so the stable prefix is reused instead of billed
      // at full price each turn. A top-level body.cache_control field is NOT
      // valid Messages API shape (HTTP 400).
      body.system = this.cacheControl
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    if (options?.stopSequences?.length) body.stop_sequences = options.stopSequences;

    return await this.post('/v1/messages', body, options);
  }

  async complete(prompt: string, options?: ChatOptions): Promise<string> {
    const result = await this.chat([{ role: 'user', content: prompt }], options);
    return result.content;
  }

  /** POST the payload and map the response onto {@link ChatResult}. */
  private async post(path: string, body: Record<string, unknown>, options?: ChatOptions): Promise<ChatResult> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    const signal = composeAbortSignal(options?.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
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
      throw new AgentProviderError(this.id, 'Anthropic API returned a non-JSON success response', { retryable: true });
    }

    const blocks: any[] = Array.isArray(json.content) ? json.content : [];
    const content = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const usage =
      json.usage && typeof json.usage === 'object'
        ? {
            promptTokens: json.usage.input_tokens ?? 0,
            completionTokens: json.usage.output_tokens ?? 0,
            totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
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
    return new AgentProviderError(this.id, `Anthropic API error (HTTP ${response.status})${suffix}`, {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      resetAtMs: response.status === 429 ? retryAfterHeaderToResetAtMs(response.headers.get('retry-after')) : undefined,
    });
  }
}

function abortError(): Error {
  const e = new Error('ask cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Decide whether the registered provider should cache the stable prefix.
 *
 * Issue #260: the shape was fixed in #245 but nothing could turn it on — the
 * option was constructor-only, so `cacheControl` stayed false in production and
 * every actor turn re-billed the full system prefix. Caching is the single
 * biggest cost lever for long facade sessions (cache reads bill ~0.1x input),
 * so it defaults ON — but only against the official endpoint: a custom
 * `ANTHROPIC_BASE_URL` is usually a proxy that may reject the field with 400,
 * which would fail asks outright. `AI_WORKFLOW_ANTHROPIC_CACHE=1|0` overrides
 * both ways for the rare proxy that does support it (or an official-API
 * billing policy that forbids cache writes).
 */
export function resolveAnthropicCacheControl(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.AI_WORKFLOW_ANTHROPIC_CACHE ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  // Unset (or unrecognised): official API caches, custom gateways stay safe.
  return !env.ANTHROPIC_BASE_URL?.trim();
}

/**
 * Read `ANTHROPIC_API_KEY` (plus optional `ANTHROPIC_MODEL` /
 * `ANTHROPIC_BASE_URL` / `AI_WORKFLOW_ANTHROPIC_CACHE`) and register the
 * `anthropic` provider in the global registry. Returns the registry id, or
 * `undefined` when the env is unset — the mock default stays and nothing dials
 * out.
 */
export function configureAnthropicFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;

  const provider = new AnthropicProvider({
    apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || undefined,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    cacheControl: resolveAnthropicCacheControl(env),
  });
  providerRegistry.register(asLlmProvider(provider));
  return provider.id;
}
