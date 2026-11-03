import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertExitCode } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 5 MCP Tool Integration', async (t) => {
  await t.test('T2_F5_01: Unknown MCP subcommand exits with non-zero exit code', () => {
    const res = runCLI(['mcp', 'unknown-subcommand']);
    assert.notStrictEqual(res.exitCode, 0);
  });

  await t.test('T2_F5_02: Calling unknown tool name handled gracefully without crash', () => {
    const res = runCLI(['mcp', 'call', 'non_existent_tool']);
    assert.ok(res.exitCode === 0 || res.exitCode === 1);
  });

  await t.test('T2_F5_03: Calling MCP tool with empty parameters runs without error', () => {
    const res = runCLI(['mcp', 'call', 'read_file']);
    assertExitCode(res, 0);
  });

  await t.test('T2_F5_04: MCP list with empty flags works cleanly', () => {
    const res = runCLI(['mcp', 'list']);
    assertExitCode(res, 0);
  });

  await t.test('T2_F5_05: MCP JSON formatting flag produces parseable JSON array', () => {
    const res = runCLI(['mcp', 'list', '--json']);
    assertExitCode(res, 0);
    const json = res.json<any>();
    assert.ok(Array.isArray(json));
  });
});
