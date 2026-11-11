/**
 * Tagged Error Algebra — the canonical, serializable error vocabulary of the engine.
 *
 * Replaces untyped `new Error(...)` throws at module and process boundaries
 * (NDJSON IPC, JSONL journal, MCP): every expected failure is a plain, JSON-safe
 * discriminated union value tagged with one of the `DomainErrorTag` literals, and is
 * transported via {@link toSerializableError}/{@link fromSerializableError}. Pair it
 * with the `Result` monad (`./result.js`) so boundary functions return failures
 * instead of throwing them.
 *
 * This module is dependency-free by design (Clean Inward Architecture): it imports
 * nothing and may only be imported *into*.
 */

/** Shared payload shape of every tagged error; the `tag` literal discriminates. */
export interface DomainErrorBase {
  /** Human-readable, single-line description of the failure. */
  readonly message: string;
  /** Structured, JSON-safe context (paths, exit codes, site ids, ...). Never secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Root cause chain as plain text (e.g. the child `scriptError` message). */
  readonly cause?: string;
}

/** Facade script failed to compile or type-check, or the builder workflow definition is invalid (e.g. dependency cycle / missing dependency) — the program did not compile. */
export type CompileError = DomainErrorBase & { readonly tag: 'CompileError' };
/** Agent output failed runtime schema validation after the retry budget was spent. */
export type SchemaValidationError = DomainErrorBase & { readonly tag: 'SchemaValidationError' };
/** A supervised child process exceeded its CPU/wall-clock budget and was killed. */
export type SandboxTimeout = DomainErrorBase & { readonly tag: 'SandboxTimeout' };
/** A supervised child process could not be spawned at all. */
export type SandboxSpawnError = DomainErrorBase & { readonly tag: 'SandboxSpawnError' };
/** Durable persistence failed (events.jsonl / SQLite checkpoint / journal). */
export type StorageError = DomainErrorBase & { readonly tag: 'StorageError' };
/** Environment probing failed or returned an inconsistent snapshot. */
export type ProberError = DomainErrorBase & { readonly tag: 'ProberError' };
/** An agent RPC failed (provider outage, malformed transport frame, ...); also the sanctioned catch-all tag for runtime non-agent failures (deterministic gate failures, user aborts, step root-cause fallback — mirrors the `toDomainError` default). */
export type AgentError = DomainErrorBase & { readonly tag: 'AgentError' };
/** An MCP client/server exchange failed. */
export type McpError = DomainErrorBase & { readonly tag: 'McpError' };
/** A journalled node's `inputHash` no longer matches its replay inputs. */
export type JournalMismatchError = DomainErrorBase & { readonly tag: 'JournalMismatchError' };

/** The closed set of tagged errors every boundary must speak. */
export type DomainError =
  | CompileError
  | SchemaValidationError
  | SandboxTimeout
  | SandboxSpawnError
  | StorageError
  | ProberError
  | AgentError
  | McpError
  | JournalMismatchError;

/** The discriminant literal of a {@link DomainError}. */
export type DomainErrorTag = DomainError['tag'];

/** All valid `DomainErrorTag` literals, in stable order (used by input validation). */
export const DOMAIN_ERROR_TAGS: readonly DomainErrorTag[] = [
  'CompileError',
  'SchemaValidationError',
  'SandboxTimeout',
  'SandboxSpawnError',
  'StorageError',
  'ProberError',
  'AgentError',
  'McpError',
  'JournalMismatchError',
];

/** Optional extras accepted by the {@link domainError} factory. */
export interface DomainErrorOptions {
  /** Structured, JSON-safe context. Must never contain credentials or tokens. */
  readonly details?: Record<string, unknown>;
  /** Root cause chain as plain text. */
  readonly cause?: string;
}

/**
 * Build a tagged {@link DomainError}. Total and pure — it never throws.
 * Use this factory instead of `new Error(...)` whenever a failure may cross a
 * module or process boundary; pair with `Result` for expected failures.
 *
 * @param tag - Which member of the error algebra this is.
 * @param message - Human-readable, single-line description.
 * @param options - Optional `details` / `cause` payload.
 */
export function domainError(
  tag: DomainErrorTag,
  message: string,
  options?: DomainErrorOptions
): DomainError {
  const error: DomainErrorBase = {
    message,
    ...(options?.details !== undefined ? { details: options.details } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  };
  return { tag, ...error } as DomainError;
}

/**
 * Type guard: `true` when `value` is one of the known {@link DomainErrorTag} literals.
 *
 * @param value - Any parsed value (e.g. from an NDJSON frame).
 */
export function isDomainErrorTag(value: unknown): value is DomainErrorTag {
  return DOMAIN_ERROR_TAGS.includes(value as DomainErrorTag);
}

/**
 * Structural type guard for a {@link DomainError}: an object carrying a known `tag`
 * and a string `message`. `details`/`cause` are optional and not deeply validated.
 *
 * @param value - Any parsed value (e.g. from an NDJSON frame).
 */
export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { tag?: unknown; message?: unknown };
  return typeof candidate.message === 'string' && isDomainErrorTag(candidate.tag);
}

/** Type guard: narrows to the `CompileError` member. */
export function isCompileError(error: DomainError): error is CompileError {
  return error.tag === 'CompileError';
}

/** Type guard: narrows to the `SchemaValidationError` member. */
export function isSchemaValidationError(error: DomainError): error is SchemaValidationError {
  return error.tag === 'SchemaValidationError';
}

/** Type guard: narrows to the `SandboxTimeout` member. */
export function isSandboxTimeout(error: DomainError): error is SandboxTimeout {
  return error.tag === 'SandboxTimeout';
}

/** Type guard: narrows to the `SandboxSpawnError` member. */
export function isSandboxSpawnError(error: DomainError): error is SandboxSpawnError {
  return error.tag === 'SandboxSpawnError';
}

/** Type guard: narrows to the `StorageError` member. */
export function isStorageError(error: DomainError): error is StorageError {
  return error.tag === 'StorageError';
}

/** Type guard: narrows to the `ProberError` member. */
export function isProberError(error: DomainError): error is ProberError {
  return error.tag === 'ProberError';
}

/** Type guard: narrows to the `AgentError` member. */
export function isAgentError(error: DomainError): error is AgentError {
  return error.tag === 'AgentError';
}

/** Type guard: narrows to the `McpError` member. */
export function isMcpError(error: DomainError): error is McpError {
  return error.tag === 'McpError';
}

/** Type guard: narrows to the `JournalMismatchError` member. */
export function isJournalMismatchError(error: DomainError): error is JournalMismatchError {
  return error.tag === 'JournalMismatchError';
}

/**
 * The NDJSON/JSONL wire form of a {@link DomainError}. Structurally identical to
 * `DomainError`, but every field is guaranteed JSON-safe after
 * {@link toSerializableError} sanitizes it — `JSON.stringify` on a frame carrying
 * this value can never throw.
 */
export type SerializableError = DomainError;

/**
 * Convert a {@link DomainError} into its JSON-safe wire form.
 *
 * `details` is deep-sanitized: non-finite numbers become `null` (JSON semantics),
 * `Date`s become ISO strings, `BigInt`/functions/symbols and circular structures
 * degrade to their `String()` form. Nothing is thrown and no payload is dropped.
 *
 * @param error - The tagged error to serialize.
 */
export function toSerializableError(error: DomainError): SerializableError {
  const frame: {
    tag: DomainErrorTag;
    message: string;
    details?: Record<string, unknown>;
    cause?: string;
  } = { tag: error.tag, message: error.message };
  if (error.details !== undefined) {
    frame.details = toJsonSafeRecord(error.details);
  }
  if (error.cause !== undefined) {
    frame.cause = error.cause;
  }
  return frame;
}

/**
 * Rebuild a {@link DomainError} from a parsed wire frame. Total — never throws.
 *
 * A well-formed payload (known `tag`, string `message`) round-trips through
 * {@link toSerializableError} unchanged. A malformed payload is reported as a
 * `StorageError` carrying only the failure *reason*: the raw payload is never
 * echoed into `details`, so a corrupt or hostile frame cannot leak its content
 * into logs.
 *
 * @param input - Any parsed value (e.g. `JSON.parse` of a JSONL line).
 */
export function fromSerializableError(input: unknown): DomainError {
  if (typeof input !== 'object' || input === null) {
    return malformedSerializedError('payload-not-an-object');
  }
  const candidate = input as { tag?: unknown; message?: unknown; details?: unknown; cause?: unknown };
  if (typeof candidate.tag !== 'string' || !isDomainErrorTag(candidate.tag)) {
    return malformedSerializedError('unknown-or-missing-tag');
  }
  if (typeof candidate.message !== 'string') {
    return malformedSerializedError('missing-or-invalid-message');
  }
  const details =
    typeof candidate.details === 'object' && candidate.details !== null
      ? (candidate.details as Record<string, unknown>)
      : undefined;
  return domainError(candidate.tag, candidate.message, {
    details,
    cause: typeof candidate.cause === 'string' ? candidate.cause : undefined,
  });
}

/** Build the fixed `StorageError` reported for malformed serialized-error payloads. */
function malformedSerializedError(reason: string): DomainError {
  return domainError('StorageError', 'Malformed serialized error payload', {
    details: { reason },
  });
}

/**
 * Convert an arbitrary thrown value into a {@link DomainError}. Total — never throws.
 *
 * The boundary fallback rule (GOAL.md 禁止未经类型化的异常穿透边界): a value that
 * already speaks the algebra passes through unchanged; an `Error` keeps its message
 * verbatim with its class name preserved as `details.errorName` (so legacy
 * `WorkflowBudgetExceededError`-style names survive protocol round trips); any other
 * thrown value (string, number, plain object, `undefined`) degrades to its string
 * form. Values with no better home take `fallbackTag` — the default `AgentError` is
 * the sanctioned catch-all for agent-boundary failures.
 *
 * @param value - Anything a `throw`/`reject` may have carried across a boundary.
 * @param fallbackTag - Tag used when the value has no more specific home.
 */
export function toDomainError(value: unknown, fallbackTag: DomainErrorTag = 'AgentError'): DomainError {
  if (isDomainError(value)) return value;
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown }).cause;
    return domainError(fallbackTag, value.message || value.name || 'unknown error', {
      details: { errorName: value.name },
      cause: typeof cause === 'string' ? cause : undefined,
    });
  }
  if (typeof value === 'string') {
    return domainError(fallbackTag, value, { details: { thrownType: 'string' } });
  }
  if (value === undefined || value === null) {
    return domainError(fallbackTag, `thrown ${String(value)}`, {
      details: { thrownType: value === null ? 'null' : 'undefined' },
    });
  }
  try {
    const encoded = JSON.stringify(value);
    return domainError(fallbackTag, encoded === undefined ? String(value) : encoded, {
      details: { thrownType: typeof value },
    });
  } catch {
    return domainError(fallbackTag, String(value), { details: { thrownType: typeof value } });
  }
}

/**
 * Parse a stored `error_text` value (dwf_nodes journal column) into a tagged
 * {@link DomainError}.
 *
 * Shape-sniffing rule (journal backward compatibility): `JSON.parse` first — when the
 * parsed value is a well-formed serialized error (known `tag` + string `message`, i.e.
 * what {@link toSerializableError} writes), it is rebuilt via
 * {@link fromSerializableError}; anything else — legacy plain-text messages, valid JSON
 * that is not a tagged error, or malformed JSON — returns `undefined` and the caller
 * keeps displaying the raw text. Total: never throws, even on hostile input.
 *
 * @param text - The stored `error_text` value (never `undefined` — filter empty first).
 */
export function tryParseStoredError(text: string): DomainError | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // legacy plain text (or corrupt) — not a tagged error
  }
  return isDomainError(parsed) ? fromSerializableError(parsed) : undefined;
}

/** Deep-sanitize a details record so the whole error survives `JSON.stringify`. */
function toJsonSafeRecord(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    safe[key] = toJsonSafeValue(value);
  }
  return safe;
}

/** JSON-safe any single value, degrading non-encodable values to their string form. */
function toJsonSafeValue(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : JSON.parse(encoded);
  } catch {
    // BigInt, circular structures and other non-encodable values degrade to text.
    return String(value);
  }
}
