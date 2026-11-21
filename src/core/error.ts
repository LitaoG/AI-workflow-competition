import { RetryPolicy } from '../types.js';
import { toDomainError, type DomainErrorTag } from '../domain/errors.js';

export class WorkflowError extends Error {
  readonly code: string;
  readonly stepId?: string;
  readonly phaseId?: string;
  readonly timestamp: string;
  readonly isRecoverable: boolean;

  constructor(message: string, code: string, options?: { stepId?: string; phaseId?: string; isRecoverable?: boolean }) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.stepId = options?.stepId;
    this.phaseId = options?.phaseId;
    this.timestamp = new Date().toISOString();
    this.isRecoverable = options?.isRecoverable ?? false;
  }
}

export class StepExecutionError extends WorkflowError {
  /** Domain algebra tag — passthrough of the root cause's tag (fallback `AgentError`). */
  readonly tag: DomainErrorTag;
  /** Domain payload: `{ stepId, phaseId, rootMessage, ...rootDetails }` — never the raw error object. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly originalError: unknown;

  constructor(stepId: string, phaseId: string, originalError: unknown) {
    const msg = originalError instanceof Error ? originalError.message : toDomainError(originalError).message;
    super(`Step "${stepId}" failed: ${msg}`, 'STEP_EXECUTION_FAILED', {
      stepId,
      phaseId,
      isRecoverable: true,
    });
    this.name = 'StepExecutionError';
    this.originalError = originalError;
    const root = toDomainError(originalError);
    this.tag = root.tag;
    this.details = { stepId, phaseId, rootMessage: root.message, ...(root.details ?? {}) };
  }
}

export class GateFailureError extends WorkflowError {
  /** Domain algebra tag — deterministic gate failures have no dedicated member; `AgentError` is the sanctioned fallback (details carry the precision). */
  readonly tag: 'AgentError';
  /** Domain payload: `{ stepId, command, exitCode }` — stdout/stderr stay out (oversize payloads). */
  readonly details: Readonly<Record<string, unknown>>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;

  constructor(stepId: string, command: string, exitCode: number, stdout: string, stderr: string) {
    super(`Deterministic Gate "${stepId}" failed with exit code ${exitCode}. Cmd: "${command}"\nStderr: ${stderr}`, 'GATE_FAILURE', {
      stepId,
      isRecoverable: false,
    });
    this.name = 'GateFailureError';
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.tag = 'AgentError';
    this.details = { stepId, command, exitCode };
  }
}

/**
 * Agent output failed runtime schema validation after the retry budget was
 * spent. The class itself lives in `src/agent/schema-validation-error.ts`
 * (Issue #110) — next to its throw site, the rpc ask loop — and is re-exported
 * here so the `../core/error.js` import surface and the `src/index.ts` public
 * export are unchanged. Instances carry `tag: 'SchemaValidationError'` plus a
 * persistence-safe `details` payload (GOAL.md 5.1) while remaining `Error`
 * subclasses; `rawText`/`zodErrors` are process-only.
 */
export { SchemaValidationError } from '../agent/schema-validation-error.js';

export class ProviderError extends WorkflowError {
  /** Domain algebra tag — provider failures take `AgentError` (details carry `providerId`/`statusCode`). */
  readonly tag: 'AgentError';
  /** Domain payload: `{ providerId, statusCode? }`. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly providerId: string;
  readonly statusCode?: number;

  constructor(providerId: string, message: string, statusCode?: number, isRecoverable = true) {
    super(`LLM Provider [${providerId}] error: ${message}`, 'PROVIDER_ERROR', { isRecoverable });
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.statusCode = statusCode;
    this.tag = 'AgentError';
    this.details = { providerId, ...(statusCode !== undefined ? { statusCode } : {}) };
  }
}

export class CircularDependencyError extends WorkflowError {
  /** Domain algebra tag — an invalid workflow definition is the builder-DAG face of `CompileError`. */
  readonly tag: 'CompileError';
  /** Domain payload: `{ cycle }`. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Circular dependency detected in workflow DAG: ${cycle.join(' -> ')}`, 'CIRCULAR_DEPENDENCY');
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
    this.tag = 'CompileError';
    this.details = { cycle };
  }
}

export class MissingDependencyError extends WorkflowError {
  /** Domain algebra tag — an invalid workflow definition is the builder-DAG face of `CompileError`. */
  readonly tag: 'CompileError';
  /** Domain payload: `{ stepId, missingDepId }`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(stepId: string, missingDepId: string) {
    super(`Step "${stepId}" depends on non-existent step "${missingDepId}"`, 'MISSING_DEPENDENCY', { stepId });
    this.name = 'MissingDependencyError';
    this.tag = 'CompileError';
    this.details = { stepId, missingDepId };
  }
}

export class WorkflowAbortedError extends WorkflowError {
  /** Domain algebra tag — user cancellation has no dedicated member; `AgentError` is the sanctioned fallback (details carry `reason`). */
  readonly tag: 'AgentError';
  /** Domain payload: `{ reason }` when a reason was supplied. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reason?: string) {
    super(`Workflow execution was aborted: ${reason ?? 'User cancellation'}`, 'WORKFLOW_ABORTED');
    this.name = 'WorkflowAbortedError';
    this.tag = 'AgentError';
    this.details = reason !== undefined ? { reason } : {};
  }
}

export class RunNotFoundError extends WorkflowError {
  /** Domain algebra tag — a missing persisted run is the storage face of the algebra. */
  readonly tag: 'StorageError';
  /** Domain payload: `{ runId }`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(runId: string) {
    super(`Run ID not found in store: ${runId}`, 'RUN_NOT_FOUND');
    this.name = 'RunNotFoundError';
    this.tag = 'StorageError';
    this.details = { runId };
  }
}

/** A step called an MCP server that no config source declares. */
export class McpServerNotConfiguredError extends WorkflowError {
  /** Domain algebra tag — every MCP integration failure is an `McpError`. */
  readonly tag: 'McpError';
  /** Domain payload: `{ serverName, knownServers, source }`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(serverName: string, knownServers: readonly string[], source: string) {
    const known = knownServers.length > 0 ? knownServers.join(', ') : 'none';
    super(`MCP server "${serverName}" is not configured (source: ${source}; known: ${known})`, 'MCP_SERVER_NOT_CONFIGURED');
    this.name = 'McpServerNotConfiguredError';
    this.tag = 'McpError';
    this.details = { serverName, knownServers: [...knownServers], source };
  }
}

/** An MCP config source (a `.mcp.json` file or one server entry) is unreadable or malformed. */
export class McpConfigError extends WorkflowError {
  /** Domain algebra tag — every MCP integration failure is an `McpError`. */
  readonly tag: 'McpError';
  /** Domain payload: `{ subject, reason }`; `subject` is a server name or a config file path. Never variable values. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(subject: string, reason: string) {
    super(`MCP config for "${subject}" is invalid: ${reason}`, 'MCP_CONFIG_INVALID');
    this.name = 'McpConfigError';
    this.tag = 'McpError';
    this.details = { subject, reason };
  }
}

/** The handshake with an MCP server failed or timed out; its transport was closed. */
export class McpConnectError extends WorkflowError {
  /** Domain algebra tag — every MCP integration failure is an `McpError`. */
  readonly tag: 'McpError';
  /** Domain payload: `{ serverName, reason }`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(serverName: string, reason: string) {
    super(`MCP server "${serverName}" connect failed: ${reason}`, 'MCP_CONNECT_FAILED', { isRecoverable: true });
    this.name = 'McpConnectError';
    this.tag = 'McpError';
    this.details = { serverName, reason };
  }
}

/** A step called MCP after its run had released every MCP connection. */
export class McpClientClosedError extends WorkflowError {
  /** Domain algebra tag — every MCP integration failure is an `McpError`. */
  readonly tag: 'McpError';
  /** Domain payload: `{ serverName }`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(serverName: string) {
    super(`MCP call to "${serverName}" after the run released its MCP connections`, 'MCP_CLIENT_CLOSED');
    this.name = 'McpClientClosedError';
    this.tag = 'McpError';
    this.details = { serverName };
  }
}

/** An MCP tool answered with `isError: true`: the call failed, so its result must not pass as step output. */
export class McpToolError extends WorkflowError {
  /** Domain algebra tag — every MCP integration failure is an `McpError`. */
  readonly tag: 'McpError';
  /** Domain payload: `{ serverName, toolName, text }`; `text` is the tool's error text, redacted and truncated. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(serverName: string, toolName: string, text: string) {
    super(`MCP tool "${toolName}" on server "${serverName}" reported an error: ${text}`, 'MCP_TOOL_FAILED');
    this.name = 'McpToolError';
    this.tag = 'McpError';
    this.details = { serverName, toolName, text };
  }
}

/**
 * Execute an async operation with exponential backoff retry.
 *
 * Which errors retry: with a `retryableErrorFilter`, the filter decides alone.
 * Without one, an error that marks itself `isRecoverable: false` (for example
 * `McpToolError`, `GateFailureError`, `WorkflowAbortedError`) is rethrown at
 * once: a deterministic failure fails again, and rerunning the step would pay
 * again for every model call before it (Issue #120). Errors without the flag
 * keep retrying as before.
 *
 * Once `signal` is aborted, no further attempt starts and a pending backoff
 * ends early; the last error is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy?: RetryPolicy, signal?: AbortSignal): Promise<T> {
  const maxRetries = policy?.maxRetries ?? 0;
  if (maxRetries <= 0) return fn();

  let attempt = 0;
  let delay = policy?.initialDelayMs ?? 500;
  const factor = policy?.backoffFactor ?? 2;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt > maxRetries) throw err;
      const retryable = policy?.retryableErrorFilter ? policy.retryableErrorFilter(err) : !isNonRecoverable(err);
      if (!retryable || signal?.aborted) throw err;

      await abortableDelay(delay, signal);
      if (signal?.aborted) throw err;
      delay *= factor;
    }
  }
}

/** True when the error marks itself as not worth retrying (`isRecoverable === false`). */
function isNonRecoverable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { isRecoverable?: unknown }).isRecoverable === false;
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
