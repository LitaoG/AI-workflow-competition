import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertStderrContains } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 6 Slash Command CLI', async (t) => {
  await t.test('T2_F6_01: Invoking unknown CLI subcommand exits with code 1', () => {
    const res = runCLI(['nonexistent-command']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'Unknown command');
  });

  await t.test('T2_F6_02: Invoking run without workflow file argument exits with code 1', () => {
    const res = runCLI(['run']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'file required');
  });

  await t.test('T2_F6_03: Invoking run with non-existent file path exits with code 1', () => {
    const res = runCLI(['run', 'totally-bogus-file-does-not-exist.ts']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'File not found');
  });

  await t.test('T2_F6_04: Invoking replay without runId exits with code 1', () => {
    const res = runCLI(['replay']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'run-id required');
  });

  await t.test('T2_F6_05: Invoking inspect without runId exits with code 1', () => {
    const res = runCLI(['inspect']);
    assert.strictEqual(res.exitCode, 1);
    assertStderrContains(res, 'run-id required');
  });
});
