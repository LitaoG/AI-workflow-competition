import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPClientManager, createDefaultTransport, type McpTransportFactory } from '../../src/mcp/client.js';
import { WorkflowExecutionContext } from '../../src/core/context.js';
import { Workflow } from '../../src/core/workflow.js';
import { actionStep } from '../../src/core/step.js';
import {
  McpClientClosedError,
  McpConfigError,
  McpConnectError,
  McpServerNotConfiguredError,
  McpToolError,
} from '../../src/core/error.js';
import type { ExecutionContext, MCPServerConfig } from '../../src/types.js';

// Issue #106: ctx.mcp.callTool used to build a fresh, never-connected client per
// call, so every real-mode call failed with `MCP Server "x" is not connected`.
// These tests lock the run-scoped lazy pool: explicit-only config sources, one
// handshake per server, a configurable handshake timeout, fail-fast after a
// failed handshake, tool errors as failures, and no stdio child outliving its run.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STDIO_TEST_TIMEOUT_MS = 30_000;

/** A fake credential inside a tool error; the redactor must mask it. */
const TOOL_FAILURE_SECRET = 'hunter2-not-real';

const ALPHA: Record<string, MCPServerConfig> = { alpha: { transport: 'stdio', command: 'unused-by-factory' } };

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

/** In-memory MCP servers with an `echo` tool and a `fail` tool; records every handshake. */
function echoServers(): {
  factory: McpTransportFactory;
  handshakes: Array<{ serverName: string; config: MCPServerConfig }>;
} {
  const handshakes: Array<{ serverName: string; config: MCPServerConfig }> = [];
  const factory: McpTransportFactory = async (serverName, config) => {
    handshakes.push({ serverName, config });
    const server = new Server({ name: `echo-${serverName}`, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'Echo the text argument', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'fail') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `${serverName} failed: password=${TOOL_FAILURE_SECRET}` }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `${serverName}:${String(request.params.arguments?.text ?? '')}` }],
      };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    return clientSide;
  };
  return { factory, handshakes };
}

/** A transport whose handshake never completes: `start()` fails, or succeeds into silence. */
class DeadTransport implements Transport {
  closeCount = 0;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private readonly mode: 'refuse' | 'silent') {}

  async start(): Promise<void> {
    if (this.mode === 'refuse') throw new Error('handshake refused');
  }

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCount++;
    this.onclose?.();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('MCP lazy connect: an undeclared server fails with MCP_SERVER_NOT_CONFIGURED naming the known ones', async () => {
  const { factory, handshakes } = echoServers();
  const manager = new MCPClientManager(false, { servers: ALPHA, transportFactory: factory });
  await assert.rejects(manager.callTool('beta', 'echo', {}), (err: unknown) => {
    assert.ok(err instanceof McpServerNotConfiguredError);
    assert.equal(err.code, 'MCP_SERVER_NOT_CONFIGURED');
    assert.equal(err.tag, 'McpError');
    assert.deepEqual(err.details.knownServers, ['alpha']);
    return true;
  });
  assert.equal(handshakes.length, 0, 'no handshake is attempted for an undeclared server');
});

test('MCP lazy connect: a .mcp.json in the working directory is never read implicitly (pre-review F1)', async () => {
  const dir = tempDir('mcp-lazy-cwd-');
  const previous = process.cwd();
  try {
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['untrusted.js'] } } })
    );
    process.chdir(dir);
    const { factory, handshakes } = echoServers();
    const manager = new MCPClientManager(false, { env: {}, transportFactory: factory });
    await assert.rejects(manager.callTool('tools', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpServerNotConfiguredError);
      assert.match(err.message, /AI_WORKFLOW_MCP_CONFIG/);
      return true;
    });
    assert.equal(handshakes.length, 0, 'nothing from the untrusted file is spawned');
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP lazy connect: AI_WORKFLOW_MCP_CONFIG opts in to a trusted .mcp.json', async () => {
  const dir = tempDir('mcp-lazy-env-');
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node' } } }));
    const { factory, handshakes } = echoServers();
    const manager = new MCPClientManager(false, {
      env: { AI_WORKFLOW_MCP_CONFIG: path.join(dir, '.mcp.json') },
      transportFactory: factory,
    });
    assert.equal(textOf(await manager.callTool('tools', 'echo', { text: 'ok' })), 'tools:ok');
    assert.equal(handshakes[0].config.cwd, dir);
    await manager.disconnectAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP lazy connect: .mcp.json entries expand ${VAR} / ${VAR:-default}, run in the file folder, get CLAUDE_PROJECT_DIR', async () => {
  const dir = tempDir('mcp-lazy-json-');
  try {
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tools: {
            type: 'stdio',
            command: 'node',
            args: ['${TOOLS_HOME:-.}/server.js', '--token=${TOOLS_TOKEN}'],
            env: { MODE: '${TOOLS_MODE:-prod}', LEVEL: '${TOOLS_LEVEL:-info}' },
          },
        },
      })
    );
    const { factory, handshakes } = echoServers();
    const manager = new MCPClientManager(false, {
      configPath: path.join(dir, '.mcp.json'),
      // TOOLS_HOME / TOOLS_LEVEL unset -> defaults; TOOLS_MODE empty counts as set (Claude Code rule).
      env: { TOOLS_TOKEN: 't-1', TOOLS_MODE: '' },
      transportFactory: factory,
    });
    assert.equal(textOf(await manager.callTool('tools', 'echo', { text: 'hi' })), 'tools:hi');
    assert.deepEqual(handshakes[0].config, {
      transport: 'stdio',
      command: 'node',
      args: ['./server.js', '--token=t-1'],
      env: { CLAUDE_PROJECT_DIR: dir, MODE: '', LEVEL: 'info' },
      url: undefined,
      cwd: dir,
    });
    await manager.disconnectAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP lazy connect: bad .mcp.json input fails with MCP_CONFIG_INVALID and never quotes file text', async () => {
  const dir = tempDir('mcp-lazy-bad-');
  try {
    const file = path.join(dir, '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['--token=${TOOLS_TOKEN}'] } } }));
    const unset = new MCPClientManager(false, { configPath: file, env: {} });
    await assert.rejects(unset.callTool('tools', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConfigError);
      assert.equal(err.code, 'MCP_CONFIG_INVALID');
      assert.match(err.message, /TOOLS_TOKEN/);
      return true;
    });

    fs.writeFileSync(file, '{"mcpServers": {"tools": {"env": {"API_KEY": "sk-should-not-leak"}}},,}');
    const broken = new MCPClientManager(false, { configPath: file, env: {} });
    await assert.rejects(broken.callTool('tools', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConfigError);
      assert.ok(!err.message.includes('sk-should-not-leak'), 'the parse error must not quote file text');
      assert.ok(!JSON.stringify(err.details).includes('sk-should-not-leak'));
      return true;
    });

    const missing = new MCPClientManager(false, { configPath: path.join(dir, 'absent', '.mcp.json'), env: {} });
    await assert.rejects(missing.callTool('tools', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConfigError);
      assert.match(err.message, /file not found/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP lazy connect: a stdio entry without a command is a config error, not a spawn', () => {
  assert.throws(
    () => createDefaultTransport('alpha', { transport: 'stdio' }),
    (err: unknown) => err instanceof McpConfigError && err.code === 'MCP_CONFIG_INVALID'
  );
});

test('MCP lazy connect: concurrent first calls share one handshake', async () => {
  const { factory, handshakes } = echoServers();
  const manager = new MCPClientManager(false, { servers: ALPHA, transportFactory: factory });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => manager.callTool('alpha', 'echo', { text: String(i) }))
  );
  assert.deepEqual(results.map(textOf), Array.from({ length: 8 }, (_, i) => `alpha:${i}`));
  assert.equal(handshakes.length, 1);
  await manager.disconnectAll();
});

test('MCP lazy connect: a refused handshake is closed, cached for the run, and cleared by an explicit connect (pre-review F2)', async () => {
  const refused = new DeadTransport('refuse');
  const { factory } = echoServers();
  let attempts = 0;
  const manager = new MCPClientManager(false, {
    servers: ALPHA,
    transportFactory: (name, config) => (++attempts === 1 ? refused : factory(name, config)),
  });
  const errors: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    await manager.callTool('alpha', 'echo', {}).then(
      () => assert.fail('a broken server must not answer'),
      (err: unknown) => {
        errors.push(err);
      }
    );
  }
  assert.ok(errors[0] instanceof McpConnectError);
  assert.equal((errors[0] as McpConnectError).code, 'MCP_CONNECT_FAILED');
  assert.ok(errors.every((err) => err === errors[0]), 'later calls rethrow the first failure');
  assert.equal(attempts, 1, 'one handshake for the whole run');
  assert.ok(refused.closeCount >= 1, 'the failed transport is closed');

  await manager.connectServer('alpha', ALPHA.alpha);
  assert.equal(textOf(await manager.callTool('alpha', 'echo', { text: 'back' })), 'alpha:back');
  assert.equal(attempts, 2);
  await manager.disconnectAll();
});

test('MCP lazy connect: a silent server costs one timeout across repeated calls (pre-review F2)', async () => {
  const silent = new DeadTransport('silent');
  const timeoutMs = 500;
  let handshakes = 0;
  const manager = new MCPClientManager(false, {
    servers: ALPHA,
    connectTimeoutMs: timeoutMs,
    transportFactory: () => {
      handshakes++;
      return silent;
    },
  });
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(manager.callTool('alpha', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConnectError);
      assert.match(err.message, /timed out after 500ms/);
      return true;
    });
  }
  const elapsed = Date.now() - started;
  assert.equal(handshakes, 1);
  assert.ok(silent.closeCount >= 1, 'the timed-out transport is closed');
  assert.ok(elapsed < 2 * timeoutMs, `3 calls took ${elapsed}ms; expected about one ${timeoutMs}ms timeout`);
});

test('MCP lazy connect: AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS sets the handshake timeout and the error says how to raise it (pre-review F6)', async () => {
  const silent = new DeadTransport('silent');
  const manager = new MCPClientManager(false, {
    servers: ALPHA,
    env: { AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS: '120' },
    transportFactory: () => silent,
  });
  const started = Date.now();
  await assert.rejects(manager.callTool('alpha', 'echo', {}), (err: unknown) => {
    assert.ok(err instanceof McpConnectError);
    assert.match(err.message, /timed out after 120ms/);
    assert.match(err.message, /WorkflowOptions\.mcpConnectTimeoutMs/);
    assert.match(err.message, /AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
  assert.ok(silent.closeCount >= 1);
});

test('MCP lazy connect: an invalid handshake timeout is a config error raised before anything is spawned (pre-review F6)', async () => {
  const cases: Array<{ label: string; options: { env?: Record<string, string>; connectTimeoutMs?: number } }> = [
    { label: 'non-numeric env value', options: { env: { AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS: 'soon' } } },
    { label: 'zero option', options: { connectTimeoutMs: 0 } },
    { label: 'fractional option', options: { connectTimeoutMs: 1.5 } },
    { label: 'timer overflow option', options: { connectTimeoutMs: 2_147_483_648 } },
  ];
  for (const { label, options } of cases) {
    let handshakes = 0;
    const manager = new MCPClientManager(false, {
      servers: ALPHA,
      env: {},
      ...options,
      transportFactory: () => {
        handshakes++;
        return new DeadTransport('silent');
      },
    });
    await assert.rejects(manager.callTool('alpha', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConfigError, `${label}: expected McpConfigError, got ${String(err)}`);
      assert.equal(err.code, 'MCP_CONFIG_INVALID');
      return true;
    });
    assert.equal(handshakes, 0, `${label}: nothing is spawned`);
  }
});

test('MCP lazy connect: a tool result with isError fails the call with MCP_TOOL_FAILED and redacted text (pre-review F7)', async () => {
  const { factory } = echoServers();
  const manager = new MCPClientManager(false, { servers: ALPHA, transportFactory: factory });
  try {
    await assert.rejects(manager.callTool('alpha', 'fail', {}), (err: unknown) => {
      assert.ok(err instanceof McpToolError);
      assert.equal(err.code, 'MCP_TOOL_FAILED');
      assert.equal(err.tag, 'McpError');
      assert.equal(err.details.toolName, 'fail');
      assert.match(err.message, /alpha failed: password=\*\*\*REDACTED\*\*\*/);
      assert.ok(!err.message.includes(TOOL_FAILURE_SECRET), 'tool error text is redacted');
      assert.ok(!JSON.stringify(err.details).includes(TOOL_FAILURE_SECRET));
      return true;
    });
    const raw = (await manager.callTool('alpha', 'fail', {}, { allowToolError: true })) as { isError?: boolean };
    assert.equal(raw.isError, true, 'allowToolError returns the raw failed result');
    assert.equal(textOf(await manager.callTool('alpha', 'echo', { text: 'still-up' })), 'alpha:still-up');
  } finally {
    await manager.disconnectAll();
  }
});

test('ExecutionContext: child contexts share the run pool; calls after disposeMcp fail with MCP_CLIENT_CLOSED', async () => {
  const ctx = new WorkflowExecutionContext({ workflowId: 'mcp-dispose', isMock: true });
  const child = ctx.createChildContext('step-1');
  assert.ok(await child.mcp!.callTool('alpha', 'echo', {}));
  await ctx.disposeMcp();
  for (const caller of [ctx, child]) {
    await assert.rejects(caller.mcp!.callTool('alpha', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpClientClosedError);
      assert.equal(err.code, 'MCP_CLIENT_CLOSED');
      return true;
    });
  }
});

test('ExecutionContext: mcpConfigPath reaches the pool (its server is the one spawned)', async () => {
  const dir = tempDir('mcp-lazy-ctx-');
  const ctx = new WorkflowExecutionContext({ workflowId: 'mcp-config-path', mcpConfigPath: path.join(dir, '.mcp.json') });
  try {
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { ghost: { command: path.join(dir, 'no-such-server-binary') } } })
    );
    await assert.rejects(ctx.mcp!.callTool('ghost', 'echo', {}), (err: unknown) => {
      assert.ok(err instanceof McpConnectError, `expected a spawn failure, got ${String(err)}`);
      return true;
    });
  } finally {
    await ctx.disposeMcp();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'MCP lazy connect: the repo .mcp.json reaches the built-in ai-workflow server over stdio from a subdirectory (Issue #106 repro, pre-review F4)',
  { timeout: STDIO_TEST_TIMEOUT_MS },
  async () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR; // resolve `${CLAUDE_PROJECT_DIR:-.}` like a run outside Claude Code
    const spawned: StdioClientTransport[] = [];
    const configs: MCPServerConfig[] = [];
    const manager = new MCPClientManager(false, {
      configPath: path.join(REPO_ROOT, '.mcp.json'),
      env,
      transportFactory: (name, config) => {
        configs.push(config);
        const transport = createDefaultTransport(name, config) as StdioClientTransport;
        spawned.push(transport);
        return transport;
      },
    });
    const previous = process.cwd();
    let pid: number | null = null;
    try {
      process.chdir(path.join(REPO_ROOT, 'docs'));
      const tools = await manager.listTools('ai-workflow');
      assert.ok(tools.some((tool) => tool.name === 'workflow_script_check'));
      pid = spawned[0].pid;
    } finally {
      process.chdir(previous);
      await manager.disconnectAll();
    }
    assert.equal(configs[0].cwd, REPO_ROOT, 'the server runs in the folder holding .mcp.json');
    assert.equal(configs[0].env?.CLAUDE_PROJECT_DIR, REPO_ROOT, 'the server gets CLAUDE_PROJECT_DIR like under Claude Code');
    assert.equal(typeof pid, 'number');
    assert.ok(await waitForExit(pid as number), `stdio server ${pid} must exit after disconnectAll`);
  }
);

// One-line ESM MCP server (imports resolve from cwd = repo root) with an `echo`
// tool and a `fail` tool that answers `isError: true`; it writes its pid so the
// test can prove the process is gone once the run ends.
const ECHO_SERVER_SRC = [
  "import { writeFileSync } from 'node:fs';",
  "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
  "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
  "import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
  'writeFileSync(process.env.ECHO_PID_FILE, String(process.pid));',
  "const server = new Server({ name: 'echo-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });",
  "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));",
  "server.setRequestHandler(CallToolRequestSchema, async (r) => (r.params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'tool failed' }] } : { content: [{ type: 'text', text: 'stdio:' + String(r.params.arguments?.text ?? '') }] }));",
  'await server.connect(new StdioServerTransport());',
].join(' ');

test(
  'Workflow.run: ctx.mcp.callTool reaches a real stdio server, fails on isError unless allowed, and the server exits when the run ends',
  { timeout: STDIO_TEST_TIMEOUT_MS },
  async () => {
    const dir = tempDir('mcp-lazy-run-');
    const pidFile = path.join(dir, 'echo.pid');
    try {
      const wf = new Workflow({ name: 'mcp-real-connect' });
      wf.addPhase({ id: 'p1', name: 'Call MCP' });
      wf.addStep(
        actionStep<unknown, unknown>({
          id: 'call',
          name: 'Call echo and fail over stdio',
          phaseId: 'p1',
          action: async (_input: unknown, ctx: ExecutionContext) => {
            const echo = await ctx.mcp!.callTool('echo', 'echo', { text: 'hello' });
            const failed = await ctx.mcp!.callTool('echo', 'fail', {}, { allowToolError: true });
            const thrown = await ctx.mcp!.callTool('echo', 'fail', {}).then(
              () => 'no error',
              (err: unknown) => (err as Error).name
            );
            return { echo, failed, thrown };
          },
        })
      );
      const { status, context } = await wf.run({
        mcpServers: {
          echo: {
            transport: 'stdio',
            command: process.execPath,
            args: ['--input-type=module', '-e', ECHO_SERVER_SRC],
            env: { ECHO_PID_FILE: pidFile },
            cwd: REPO_ROOT,
          },
        },
      });
      assert.equal(status, 'completed');
      const output = context.getOutput('call') as { echo: unknown; failed: { isError?: boolean }; thrown: string };
      assert.equal(textOf(output.echo), 'stdio:hello');
      assert.equal(output.failed.isError, true, 'allowToolError passes the raw failed result through ctx.mcp');
      assert.equal(output.thrown, 'McpToolError', 'a failed tool call throws by default');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(await waitForExit(pid), `stdio server ${pid} must exit once the run ends`);
      await assert.rejects(
        context.mcp!.callTool('echo', 'echo', {}),
        (err: unknown) => err instanceof McpClientClosedError
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'Workflow.run: mcpConnectTimeoutMs reaches the pool (a mute stdio server times out at the configured limit)',
  { timeout: STDIO_TEST_TIMEOUT_MS },
  async () => {
    const wf = new Workflow({ name: 'mcp-connect-timeout' });
    wf.addPhase({ id: 'p1', name: 'Call MCP' });
    wf.addStep(
      actionStep<unknown, unknown>({
        id: 'call',
        name: 'Call a server that never answers',
        phaseId: 'p1',
        action: async (_input: unknown, ctx: ExecutionContext) =>
          ctx.mcp!.callTool('mute', 'echo', {}).then(
            () => 'connected',
            (err: unknown) => (err as Error).message
          ),
      })
    );
    const { status, context } = await wf.run({
      mcpConnectTimeoutMs: 400,
      mcpServers: {
        // Never speaks MCP and exits on its own after 5 s, so even a failed close cannot leak it.
        mute: { transport: 'stdio', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] },
      },
    });
    assert.equal(status, 'completed');
    assert.match(String(context.getOutput('call')), /timed out after 400ms/);
  }
);
