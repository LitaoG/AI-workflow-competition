import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertExitCode, assertStderrContains } from '../helpers/assertions.ts';

test('Tier 2 - Boundary: Feature 5 MCP Tool Integration', async (t) => {
  await t.test('T2_F5_01: Unknown MCP subcommand exits with non-zero exit code', () => {
    const res = runCLI(['mcp', 'unknown-subcommand']);
    assert.notStrictEqual(res.exitCode, 0);
  });

  await t.test('T2_F5_02: Calling unknown tool name handled gracefully without crash', () => {
    const res = runCLI(['mcp', 'call', 'non_existent_tool']);
    // Real behavior (Issue #23): a controlled failure — specific non-zero exit
    // code plus a structured error message on stderr, not a crash/stack trace.
    assertExitCode(res, 1);
    assertStderrContains(res, 'Unknown MCP tool');
  });

  await t.test('T2_F5_03: Calling MCP tool with empty parameters runs without error', () => {
    // workflow_probe declares no required arguments — empty params must succeed.
    const res = runCLI(['mcp', 'call', 'workflow_probe']);
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
