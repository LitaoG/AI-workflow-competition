/**
 * (Issue #140): swarm dispatch policy — the single source
 * the engine's seat gate and agent cap resolve through. Formula, option, env
 * override precedence, and invalid-override fallback.
 */
import { test } from 'node:test';
import { availableParallelism } from 'node:os';
import assert from 'node:assert/strict';
import { resolveAskConcurrency, SWARM_AGENT_CAP } from '../../../src/execution/swarm-dispatcher.js';

const ENV_NAME = 'AI_WORKFLOW_MAX_CONCURRENT_AGENTS';

test('no option and no env falls back to the formula min(16, max(2, cores-2))', () => {
  const saved = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
  try {
    const expected = Math.min(16, Math.max(2, availableParallelism() - 2));
    assert.equal(resolveAskConcurrency(), expected);
  } finally {
    if (saved !== undefined) process.env[ENV_NAME] = saved;
  }
});

test('explicit option wins over env; env wins over the formula', () => {
  const saved = process.env[ENV_NAME];
  process.env[ENV_NAME] = '5';
  try {
    assert.equal(resolveAskConcurrency(), 5, 'env override applies without an explicit option');
    assert.equal(resolveAskConcurrency(3), 3, 'the explicit option beats the env');
  } finally {
    if (saved === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = saved;
  }
});

test('invalid overrides (NaN, zero, negative, non-integer) fall back instead of poisoning the gate', () => {
  const saved = process.env[ENV_NAME];
  process.env[ENV_NAME] = 'not-a-number';
  try {
    const expected = Math.min(16, Math.max(2, availableParallelism() - 2));
    assert.equal(resolveAskConcurrency(), expected, 'garbage env falls back to the formula');
    assert.equal(resolveAskConcurrency(0), expected);
    assert.equal(resolveAskConcurrency(-4), expected);
    assert.equal(resolveAskConcurrency(Number.NaN), expected);
    assert.equal(resolveAskConcurrency(2.5), expected, 'non-integer caps are ignored');
    process.env[ENV_NAME] = '0';
    assert.equal(resolveAskConcurrency(), expected, 'zero env is not a usable cap');
  } finally {
    if (saved === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = saved;
  }
});

test('the swarm agent cap is 1000', () => {
  assert.equal(SWARM_AGENT_CAP, 1000);
});
