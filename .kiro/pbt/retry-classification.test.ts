import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fc from 'fast-check';

import { withRetry } from '../../dist/src/index.js';

// Issue #120 invariant for `withRetry` (src/core/error.ts), with no
// `retryableErrorFilter`: attempt i (0-based) is followed by another attempt
// exactly when i < maxRetries and the error of attempt i is not marked
// `isRecoverable: false`. Errors marked `true` and errors without the flag
// both keep retrying.

type Kind = 'recoverable' | 'unflagged' | 'nonRecoverable';

function failure(kind: Kind): Error {
  const err = new Error(kind) as Error & { isRecoverable?: boolean };
  if (kind === 'recoverable') err.isRecoverable = true;
  if (kind === 'nonRecoverable') err.isRecoverable = false;
  return err;
}

/** Reference model: how many attempts run before withRetry gives up. */
function expectedAttempts(kinds: Kind[], maxRetries: number): number {
  let attempts = 0;
  for (let i = 0; ; i++) {
    attempts++;
    const kind = kinds[Math.min(i, kinds.length - 1)];
    if (i >= maxRetries || kind === 'nonRecoverable') return attempts;
  }
}

describe('Engine PBT: retry classification invariants (Issue #120)', () => {
  test('PBT: withRetry stops at the first non-recoverable error and otherwise uses every retry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Kind>('recoverable', 'unflagged', 'nonRecoverable'), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 6 }),
        async (kinds, maxRetries) => {
          let attempts = 0;
          let finalError: unknown;
          await withRetry(
            async () => {
              const kind = kinds[Math.min(attempts, kinds.length - 1)];
              attempts++;
              throw failure(kind);
            },
            { maxRetries, initialDelayMs: 0 }
          ).then(
            () => assert.fail('the operation never succeeds'),
            (err: unknown) => {
              finalError = err;
            }
          );
          assert.equal(attempts, expectedAttempts(kinds, maxRetries));
          const lastKind = kinds[Math.min(attempts - 1, kinds.length - 1)];
          assert.equal((finalError as Error).message, lastKind, 'the last error is the one rethrown');
        }
      ),
      { numRuns: 150 }
    );
  });
});
