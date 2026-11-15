/**
 * Unified Provider Contract — the single interface every model backend speaks.
 *
 * New providers (HTTP adapters like Anthropic/OpenAI) implement
 * {@link ProviderContract} directly; legacy providers (mock, bedrock, CLI
 * subprocess providers) keep their `LLMProvider.generate` shape and are lifted
 * onto the contract with {@link asContract}. The reverse bridge
 * {@link asLlmProvider} lets contract-native providers register in the global
 * `providerRegistry`, whose currency is still `LLMProvider` (the agent RPC loop
 * consumes it).
 *
 * Error policy: every expected failure is an {@link AgentProviderError} — a
 * thrown `Error` that structurally satisfies the domain algebra's `AgentError`
 * tag (`src/domain/errors.ts`), so it round-trips through
 * `toDomainError`/`toSerializableError` unchanged. The mandated details shape is
 * `{ provider, retryable, status? }`. `retryable` is the provider-level hint;
 * the agent RPC loop's attempt classifier (`src/agent/attempt-classifier.ts`)
 * stays the retry authority and keeps its message-driven semantics.
 *
 * Credentials never flow into logs, error messages, `details`, or stacks: any
 * server-provided text that reaches an error must pass through
 * {@link redactServerText} first.
 */

import type { AgentError } from '../domain/errors.js';
import { domainError } from '../domain/errors.js';
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse, ProviderHealth, TokenUsage } from '../types.js';

// ============================================================================
// Contract types
// ============================================================================

/** JSON-Schema description of the object a structured-output channel must emit. */
export type StructuredOutputSpec = {
  /** Schema name surfaced to the provider (e.g. `triage_result`). */
  name: string;
  /** JSON Schema describing the expected JSON object. */
  schema: Record<string, unknown>;
  /** Optional human description forwarded when the provider supports one. */
  description?: string;
};

/** Per-call knobs for {@link ProviderContract.chat} and friends. */
export type ChatOptions = {
  /** Per-call model override; falls back to the provider's configured default. */
  model?: string;
  /** Sampling temperature (repo convention default: 0 for determinism). */
  temperature?: number;
  /** Output token budget. */
  maxTokens?: number;
  /** Stop sequences forwarded when the provider supports them. */
  stopSequences?: string[];
  /** Abort signal — providers must stop the underlying call when it fires. */
  signal?: AbortSignal;
};

/**
 * A single streaming token/delta chunk emitted by a model backend.
 */
export type StreamChunk = {
  /**
   * The kind of stream chunk:
   *  - `content`: standard generated assistant text or JSON fragments.
   *  - `thinking`: reasoning / chain-of-thought tokens (e.g. Claude 3.7 Extended Thinking, DeepSeek-R1, OpenAI o-series).
   */
  type: 'content' | 'thinking';
  /** The text delta. */
  delta: string;
};

/**
 * Normalize a stream chunk into the standard {@link StreamChunk} structure.
 * Bare strings from legacy or simple streaming providers are wrapped as `{ type: 'content', delta: chunk }`,
 * preserving 100% backward compatibility.
 */
export function normalizeStreamChunk(chunk: string | StreamChunk): StreamChunk {
  if (typeof chunk === 'string') {
    return { type: 'content', delta: chunk };
  }
  return chunk;
}

/**
 * One completed model turn. Structurally identical to the legacy `LLMResponse`.
 *
 * `content` is the FULL assistant text exactly as the model produced it: the
 * agent RPC self-heal loop (`src/agent/rpc.ts`) feeds it verbatim into
 * `extractJson`/`repairJsonString` and appends it back into the repair
 * conversation, so providers must not truncate, trim, or wrap it.
 */
export type ChatResult = {
  /** Raw assistant text — consumed verbatim by the RPC self-heal loop. */
  content: string;
  /** Model that actually served the request. */
  model: string;
  /** Token accounting, when the provider reports it. */
  usage?: TokenUsage;
  /** Wall-clock duration of the call in milliseconds. */
  latencyMs: number;
};

/** Details payload mandated for every {@link AgentProviderError}. */
export type ProviderErrorDetails = {
  /** Registry id of the failing provider. */
  provider: string;
  /** Provider-level retry hint (429/5xx and transport faults → true; other 4xx → false). */
  retryable: boolean;
  /** HTTP status when the failure came from a response. */
  status?: number;
  /**
   * Epoch milliseconds at which a 429/usage limit resets, when the provider
   * supplied a machine-readable reset (Retry-After header). The engine waits
   * for it only within the run deadline and a bounded per-ask count.
   */
  resetAtMs?: number;
};

/**
 * The contract's uniform failure type: a real `Error` (so `try/catch` and
 * `err.stack` work) that also satisfies the domain algebra's `AgentError`
 * member structurally — `{ tag: 'AgentError', message, details }` — built with
 * the `domainError()` factory semantics. Details never contain credentials.
 */
export class AgentProviderError extends Error implements AgentError {
  readonly tag: 'AgentError';
  readonly details: ProviderErrorDetails;
  /** Narrowed from `Error.cause?: unknown` to the domain algebra's `string` form. */
  declare readonly cause?: string;

  constructor(
    provider: string,
    message: string,
    options: { retryable: boolean; status?: number; resetAtMs?: number },
  ) {
    super(message);
    this.name = 'AgentProviderError';
    const tagged = domainError('AgentError', message, {
      details: {
        provider,
        retryable: options.retryable,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.resetAtMs !== undefined && Number.isFinite(options.resetAtMs) ? { resetAtMs: options.resetAtMs } : {}),
      },
    });
    this.tag = tagged.tag as 'AgentError';
    this.details = tagged.details as ProviderErrorDetails;
  }
}

/**
 * The unified provider contract. `chat`/`complete` are mandatory; `stream`,
 * `structured`, and `checkHealth` are optional channels a provider advertises
 * only when it natively supports them.
 */
export interface ProviderContract {
  /** Stable registry id (e.g. `anthropic`, `openai`, `mock`). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /**
   * One chat turn: messages in, the full assistant message out. Errors throw
   * {@link AgentProviderError}.
   */
  chat(messages: readonly LLMMessage[], options?: ChatOptions): Promise<ChatResult>;
  /** Single-prompt convenience returning just the completion text. */
  complete(prompt: string, options?: ChatOptions): Promise<string>;
  /**
   * Optional token-level streaming: yields content or thinking deltas as they arrive.
   * Providers without native streaming simply omit this channel.
   */
  stream?(messages: readonly LLMMessage[], options?: ChatOptions): AsyncIterable<string | StreamChunk>;
  /**
   * Optional provider-native structured output: the provider constrains
   * decoding to the given JSON Schema (e.g. OpenAI `response_format`). The
   * returned `content` is still raw text (the JSON string), keeping the RPC
   * self-heal loop identical for every provider.
   */
  structured?(messages: readonly LLMMessage[], spec: StructuredOutputSpec, options?: ChatOptions): Promise<ChatResult>;
  /** Readiness probe at config/env level — no model call, no network. */
  checkHealth?(): ProviderHealth | Promise<ProviderHealth>;
}

// ============================================================================
// Bridges between the contract and the legacy `LLMProvider` shape
// ============================================================================

/**
 * Lift a legacy `LLMProvider` (mock, bedrock, CLI subprocess providers) onto
 * the unified contract. Zero behavior change: `chat` delegates to `generate`
 * with the same fields, and `ChatResult` is structurally `LLMResponse`.
 */
export function asContract(provider: LLMProvider): ProviderContract {
  const chat = async (messages: readonly LLMMessage[], options?: ChatOptions): Promise<ChatResult> => {
    const request: LLMRequest = {
      messages: [...messages],
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      stopSequences: options?.stopSequences,
      model: options?.model,
      signal: options?.signal,
    };
    const response: LLMResponse = await provider.generate(request);
    return response;
  };
  const contract: ProviderContract = {
    id: provider.id,
    name: provider.name,
    chat,
    complete: async (prompt, options) => {
      const result = await chat([{ role: 'user', content: prompt }], options);
      return result.content;
    },
  };
  if (provider.checkHealth) {
    contract.checkHealth = () => provider.checkHealth!();
  }
  return contract;
}

/**
 * Wrap a contract-native provider (e.g. the Anthropic/OpenAI HTTP adapters) in
 * the legacy `LLMProvider` shape so it can register in the global
 * `providerRegistry` and serve `agent().ask()` calls unchanged.
 */
export function asLlmProvider(contract: ProviderContract): LLMProvider {
  const provider: LLMProvider = {
    id: contract.id,
    name: contract.name,
    generate: async (request: LLMRequest): Promise<LLMResponse> => {
      return await contract.chat(request.messages, {
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        stopSequences: request.stopSequences,
        signal: request.signal,
      });
    },
  };
  if (contract.checkHealth) {
    provider.checkHealth = () => contract.checkHealth!();
  }
  return provider;
}

// ============================================================================
// Credential-safe helpers shared by the HTTP adapters
// ============================================================================

/**
 * Remove every occurrence of `secrets` from free text (server error bodies,
 * network failure messages) before the text may enter an error message.
 * Never logs; returns the sanitized text with `[REDACTED]` placeholders.
 */
/**
 * Parse a Retry-After header into an absolute reset time (epoch ms). Accepts
 * delta-seconds (the HTTP convention) and an HTTP-date. Absent/invalid values
 * return undefined so the engine keeps its existing policy-stop path.
 */
export function retryAfterHeaderToResetAtMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? nowMs + seconds * 1000 : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function redactServerText(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * Read an error-response body defensively (never throws) so adapter error
 * mapping cannot fail on an unreadable or streaming body.
 */
export async function safeErrorBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<response body unreadable>';
  }
}

/**
 * Compose the caller's abort signal with an adapter-owned timeout into the
 * single signal handed to `fetch`. When only the caller's signal is present it
 * is passed through untouched, so caller-driven cancels keep their
 * `AbortError` identity (the attempt classifier treats them as cancelled).
 */
export function composeAbortSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (signal && timeoutMs) return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (signal) return signal;
  if (timeoutMs) return AbortSignal.timeout(timeoutMs);
  return undefined;
}

/**
 * Map a transport-level failure (network drop, DNS, adapter-owned timeout) to
 * a retryable {@link AgentProviderError}. Caller-driven aborts must be
 * rethrown before calling this — they are cancellations, not transport faults.
 * The cause text is redacted against the provider credential first.
 */
export function transportProviderError(provider: string, err: unknown, secrets: ReadonlyArray<string | undefined>): AgentProviderError {
  const timedOut = err instanceof Error && (err.name === 'TimeoutError' || /timeout|timed?\s?out/i.test(err.message));
  const reason = timedOut
    ? 'request timed out'
    : redactServerText(err instanceof Error ? err.message : String(err), secrets);
  const kind = timedOut ? 'timeout' : 'network';
  return new AgentProviderError(provider, `${provider} transport failure (${kind}): ${reason}`, { retryable: true });
}
