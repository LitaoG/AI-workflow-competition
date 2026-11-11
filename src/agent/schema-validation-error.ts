/**
 * Agent output failed runtime schema validation after the retry budget was
 * spent (Issue #110). Lives in `src/agent/` — the throw site is the rpc ask
 * loop, and a public error class must be an `Error` instance where it is
 * thrown, not downstream. `src/core/error.ts` re-exports it so the
 * `../core/error.js` import surface and the `src/index.ts` public export are
 * unchanged.
 *
 * Domain-error duality (GOAL.md 5.1, unchanged): instances structurally
 * satisfy the domain algebra's `SchemaValidationError` member — they carry
 * `tag: 'SchemaValidationError'` plus a `details` payload built via the
 * `domainError()` factory — while remaining `Error` subclasses so
 * `instanceof` checks, `stack` and `name` all work.
 *
 * `rawText` (the last raw model output) and `zodErrors` (field paths and
 * codes) are process-only: they never enter `details`, which stays
 * persistence-safe.
 */
import { domainError } from '../domain/errors.js';
import type { z } from 'zod';

export class SchemaValidationError extends Error {
  readonly code = 'SCHEMA_VALIDATION_FAILED';
  readonly stepId: string;
  readonly isRecoverable = false;
  /** WorkflowError face parity (the class left that base in Issue #110). */
  readonly timestamp = new Date().toISOString();
  /**
   * Structural compatibility with `DomainErrorBase` (GOAL.md 5.1): the class
   * satisfies the domain algebra's SchemaValidationError member, whose
   * `cause` is plain text. Error's own `cause?: unknown` is narrowed to match
   * — `declare` keeps this a type-only statement (no field emission), so
   * runtime `cause` semantics are untouched.
   */
  declare readonly cause?: string;
  /** Domain algebra tag — this value is a first-class `DomainError`. */
  readonly tag: 'SchemaValidationError';
  /** Domain payload: `{ stepId, attemptCount, issueCount }` — never raw model text. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly zodErrors: z.ZodIssue[];
  readonly rawText: string;
  readonly attemptCount: number;

  constructor(stepId: string, rawText: string, issues: z.ZodIssue[], attemptCount: number) {
    super(`Schema validation failed for step "${stepId}" after ${attemptCount} repair attempts`);
    this.name = 'SchemaValidationError';
    this.stepId = stepId;
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
