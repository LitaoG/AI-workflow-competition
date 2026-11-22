import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLock } from '../../src/git-locks.js';

const FRESH_MS = 10 * 60_000;

test('git locks: a zero-byte lock is stale no matter how fresh — the write never started (Issue #253)', () => {
  assert.equal(classifyLock(0, 0, FRESH_MS), 'stale-empty');
  assert.equal(classifyLock(0, 500, FRESH_MS), 'stale-empty');
});

test('git locks: a non-empty lock older than the freshness threshold is stale (Issue #253)', () => {
  assert.equal(classifyLock(128, FRESH_MS + 1, FRESH_MS), 'stale-old');
  assert.equal(classifyLock(1, FRESH_MS * 10, FRESH_MS), 'stale-old');
});

test('git locks: a non-empty fresh lock is active — a git op may legitimately be running (Issue #253)', () => {
  assert.equal(classifyLock(128, 0, FRESH_MS), 'active');
  assert.equal(classifyLock(1, FRESH_MS, FRESH_MS), 'active', 'exactly at the threshold is still active');
});
