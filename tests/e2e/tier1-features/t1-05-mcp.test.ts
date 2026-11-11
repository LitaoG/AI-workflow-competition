import test from 'node:test';
import * as assert from 'node:assert';
import { runCLI } from '../helpers/cli.ts';
import { assertExitCode, assertStdoutContains } from '../helpers/assertions.ts';

test('Tier 1 - Feature 5: MCP Tool Integration (mcp)', async (t) => {
  await t.test('T1_F5_01: CLI mcp list enumerates available tools', () => {
    const res = runCLI(['mcp', 'list']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'Available MCP Tools:');
    // The registry now exposes the real engine tool face (10 workflow_* tools),
    // not filesystem/ast mock tools.
    assertStdoutContains(res, 'workflow_run');
    assertStdoutContains(res, 'workflow_run_script');
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
    // workflow_probe takes no required arguments and runs fully offline.
    const res = runCLI(['mcp', 'call', 'workflow_probe']);
    assertExitCode(res, 0);
    const parsed = res.json<{ content: Array<{ type: string; text: string }> }>();
    assert.ok(Array.isArray(parsed.content) && parsed.content.length > 0, 'Tool call must return content blocks');
  });

  await t.test('T1_F5_04: MCP tool registry validates tool names correctly', () => {
    const res = runCLI(['mcp', 'list', '--json']);
    assertExitCode(res, 0);

    const tools = res.json<Array<{ name: string }>>();
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('workflow_run'));
    assert.ok(toolNames.includes('workflow_run_script'));
  });

  await t.test('T1_F5_05: MCP tool calls integrate smoothly without external server dependencies in mock mode', () => {
    // The builtin server runs over an in-memory transport pair — no external
    // server. workflow_probe is the canonical zero-dependency call.
    const res = runCLI(['mcp', 'call', 'workflow_probe']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '"content"');
  });
});
