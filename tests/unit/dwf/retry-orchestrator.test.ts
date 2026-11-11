import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryOrchestrator } from '../../../src/dwf/retry-orchestrator.js';
import { classifyFailure } from '../../../src/agent/attempt-classifier.js';

/** Deterministic error factory: messages the classifier maps to a category. */
function errOf(kind: 'rate_limit' | 'transient' | 'auth' | 'fatal'): Error {
  const map = {
    rate_limit: 'Error: 429 too many requests, retry-after: 200ms',
    transient: 'Error: ETIMEDOUT network socket hang up',
    auth: 'Error: 401 unauthorized — invalid credentials',
    fatal: 'Error: schema mismatch on field x',
  } as const;
  return new Error(map[kind]);
}

test('circuit breaker: opens at threshold, blocks during cooldown, recovers after', () => {
  let clock = 1_000_000;
  const o = new RetryOrchestrator({ circuitThreshold: 3, circuitCooldownMs: 5_000, now: () => clock });

  // Three consecutive transient failures → the circuit opens on the third.
  const d1 = o.decide('p1', 0, errOf('transient'));
  assert.equal(d1.action, 'retry');
  o.decide('p1', 1, errOf('transient'));
  const d3 = o.decide('p1', 2, errOf('transient'));
  assert.equal(d3.action, 'give-up');
  assert.match(d3.reason, /circuit opened/);
  assert.equal(o.isCircuitOpen('p1'), true);
  assert.equal(o.canAttempt('p1').allowed, false);

  // Inside the cooldown the circuit stays open.
  clock += 4_000;
  assert.equal(o.isCircuitOpen('p1'), true);

  // After the cooldown it half-opens: attempts are allowed again.
  clock += 2_000;
  assert.equal(o.isCircuitOpen('p1'), false);
  assert.equal(o.canAttempt('p1').allowed, true);

  // A success closes it for good.
  o.recordSuccess('p1');
  assert.equal(o.isCircuitOpen('p1'), false);
});

test('non-retryable classifications fail the ask outright, without counting as budget moves', () => {
  const o = new RetryOrchestrator({ maxAttemptsPerProvider: 3 });
  const auth = o.decide('p1', 0, errOf('auth'));
  assert.equal(auth.action, 'give-up');
  assert.equal(auth.classification.retryable, false);
  assert.match(auth.reason, /not retryable/);

  const fatal = o.decide('p1', 1, errOf('fatal'));
  assert.equal(fatal.action, 'give-up');
});

test('total attempt budget gates the chain via canAttempt; limits are exposed', () => {
  const o = new RetryOrchestrator({ maxAttemptsPerProvider: 2, maxTotalAttempts: 4 });
  assert.equal(o.limits.maxAttemptsPerProvider, 2);
  assert.equal(o.limits.maxTotalAttempts, 4);

  // Four failed attempts across four providers spend the total budget of 4;
  // canAttempt then refuses any further provider in the chain.
  for (const pid of ['a', 'b', 'c', 'd']) {
    assert.equal(o.canAttempt(pid).allowed, true);
    o.decide(pid, 0, errOf('transient'));
  }
  const blocked = o.canAttempt('e');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /total attempt budget exhausted \(4\)/);
  assert.equal(o.attemptsSpent, 4);
});

test('Retry-After hints override the exponential backoff', () => {
  const o = new RetryOrchestrator({});
  const d = o.decide('p1', 0, errOf('rate_limit'));
  assert.equal(d.action, 'retry');
  assert.equal(d.waitMs, 200, 'the parsed retry-after: 200ms must win over the default backoff');
  assert.equal(d.classification.retryAfterMs, 200);
});

test('successes keep the circuit closed across many rounds', () => {
  const o = new RetryOrchestrator({ circuitThreshold: 2 });
  for (let i = 0; i < 5; i++) {
    assert.equal(o.decide('p1', 0, errOf('transient')).action, 'retry');
    o.recordSuccess('p1');
    assert.equal(o.isCircuitOpen('p1'), false, 'the streak must reset on success');
  }
});

test('classifyFailure stays importable from the orchestrator module', () => {
  const c = classifyFailure(new Error('429 throttled'), 0);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryable, true);
});
