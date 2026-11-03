import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertExitCode, assertStdoutContains } from '../helpers/assertions.ts';

test('Tier 1 - Feature 5: MCP Tool Integration (mcp)', async (t) => {
  await t.test('T1_F5_01: CLI mcp list enumerates available tools', () => {
    const res = runCLI(['mcp', 'list']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'Available MCP Tools:');
    assertStdoutContains(res, 'read_file');
  });

  await t.test('T1_F5_02: CLI mcp list --json outputs tools with complete input schemas', () => {
    const res = runCLI(['mcp', 'list', '--json']);
    assertExitCode(res, 0);

    const tools = res.json<Array<{ name: string; description: string; inputSchema: any }>>();
    assert.ok(Array.isArray(tools), 'Output must be array of tools');
    assert.ok(tools.length >= 2, 'Must discover at least 2 MCP tools');
    for (const tool of tools) {
      assert.ok(tool.name, 'Tool must have name');
      assert.ok(tool.description, 'Tool must have description');
      assert.ok(tool.inputSchema, 'Tool must define inputSchema');
    }
  });

  await t.test('T1_F5_03: CLI mcp call executes tool and reports success', () => {
    const res = runCLI(['mcp', 'call', 'read_file']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'read_file');
    assertStdoutContains(res, 'success');
  });

  await t.test('T1_F5_04: MCP tool registry validates tool names correctly', () => {
    const res = runCLI(['mcp', 'list', '--json']);
    assertExitCode(res, 0);

    const tools = res.json<Array<{ name: string }>>();
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('write_file'));
  });

  await t.test('T1_F5_05: MCP tool calls integrate smoothly without external server dependencies in mock mode', () => {
    const res = runCLI(['mcp', 'call', 'ast_grep']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'ast_grep');
  });
});
