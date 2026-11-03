import { z } from 'zod';
import { RetryPolicy } from '../types.js';
import { domainError } from '../domain/errors.js';

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
  readonly originalError: unknown;

  constructor(stepId: string, phaseId: string, originalError: unknown) {
    const msg = originalError instanceof Error ? originalError.message : String(originalError);
    super(`Step "${stepId}" failed: ${msg}`, 'STEP_EXECUTION_FAILED', {
      stepId,
      phaseId,
      isRecoverable: true,
    });
    this.name = 'StepExecutionError';
    this.originalError = originalError;
  }
}

export class GateFailureError extends WorkflowError {
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
  }
}

/**
 * Agent output failed runtime schema validation after the retry budget was spent.
 *
 * Domain-error migration: instances structurally satisfy the
 * domain algebra's `SchemaValidationError` member (`src/domain/errors.ts`) —
 * they carry `tag: 'SchemaValidationError'` plus a `details` payload built via
 * the `domainError()` factory — while remaining `Error` subclasses so legacy
 * `instanceof` checks and the `../core/error.js` import surface keep working.
 */
export class SchemaValidationError extends WorkflowError {
  /** Domain algebra tag — this value is a first-class `DomainError`. */
  readonly tag: 'SchemaValidationError';
  /** Domain payload: `{ stepId, attemptCount, issueCount }` — never raw model text. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly zodErrors: z.ZodIssue[];
  readonly rawText: string;
  readonly attemptCount: number;

  constructor(stepId: string, rawText: string, issues: z.ZodIssue[], attemptCount: number) {
    super(`Schema validation failed for step "${stepId}" after ${attemptCount} repair attempts`, 'SCHEMA_VALIDATION_FAILED', {
      stepId,
      isRecoverable: false,
    });
    this.name = 'SchemaValidationError';
    this.rawText = rawText;
    this.zodErrors = issues;
    this.attemptCount = attemptCount;
    const tagged = domainError('SchemaValidationError', this.message, {
      details: { stepId, attemptCount, issueCount: issues.length },
    });
    this.tag = tagged.tag as 'SchemaValidationError';
    this.details = tagged.details ?? {};
  }
}

export class ProviderError extends WorkflowError {
  readonly providerId: string;
  readonly statusCode?: number;

  constructor(providerId: string, message: string, statusCode?: number, isRecoverable = true) {
    super(`LLM Provider [${providerId}] error: ${message}`, 'PROVIDER_ERROR', { isRecoverable });
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.statusCode = statusCode;
  }
}

export class CircularDependencyError extends WorkflowError {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Circular dependency detected in workflow DAG: ${cycle.join(' -> ')}`, 'CIRCULAR_DEPENDENCY');
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
  }
}

export class MissingDependencyError extends WorkflowError {
  constructor(stepId: string, missingDepId: string) {
    super(`Step "${stepId}" depends on non-existent step "${missingDepId}"`, 'MISSING_DEPENDENCY', { stepId });
    this.name = 'MissingDependencyError';
  }
}

export class WorkflowAbortedError extends WorkflowError {
  constructor(reason?: string) {
    super(`Workflow execution was aborted: ${reason ?? 'User cancellation'}`, 'WORKFLOW_ABORTED');
    this.name = 'WorkflowAbortedError';
  }
}

export class RunNotFoundError extends WorkflowError {
  constructor(runId: string) {
    super(`Run ID not found in store: ${runId}`, 'RUN_NOT_FOUND');
    this.name = 'RunNotFoundError';
  }
}

/**
 * Execute an async operation with exponential backoff retry.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy?: RetryPolicy): Promise<T> {
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
      if (policy?.retryableErrorFilter && !policy.retryableErrorFilter(err)) throw err;

      await new Promise((res) => setTimeout(res, delay));
      delay *= factor;
    }
  }
}
