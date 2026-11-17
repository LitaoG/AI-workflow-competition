import { MCPClientManager } from '../../mcp/client.js';
import { BuiltinWorkflowMCPServer } from '../../mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export interface MCPCommandOptions {
  lang?: string;
  mock?: boolean;
  json?: boolean;
}

/**
 * Open a real MCP session against the built-in engine server over an in-memory
 * transport pair (no process spawn, no network) and run `fn(client)`. This is
 * the honest `workflow mcp list` path: the tools shown are what the server
 * actually exposes over the protocol, never a hardcoded mock list.
 */
async function withBuiltinServerSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ai-workflow-cli', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    server.getServer().connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  }
}

export async function executeMCPList(options?: MCPCommandOptions): Promise<number> {

  try {
    let tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    if (options?.mock) {
      // Only an explicit --mock/-m shows the mock client's fake tool list.
      const clientManager = new MCPClientManager(true);
      tools = await clientManager.listTools('builtin');
    } else {
      tools = await withBuiltinServerSession(async (client) => {
        const res = await client.listTools();
        return res.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        }));
      });
    }
    if (options?.json) {
      console.log(JSON.stringify(tools, null, 2));
      return 0;
    }
    console.log(`========================================================================`);
    console.log(` Available MCP Tools:`);
    console.log(`========================================================================`);
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`MCP List Error: ${err.message}`);
    return 1;
  }
}

export async function executeMCPCall(
  serverOrTool?: string,
  toolOrArgs?: string,
  argsJson?: string,
  options?: MCPCommandOptions
): Promise<number> {

  let server = 'builtin';
  let tool = serverOrTool ?? '';
  let effectiveArgs = toolOrArgs;

  if (toolOrArgs && !toolOrArgs.startsWith('{')) {
    // Two positional arguments: mcp call <server> <tool> [argsJson]
    server = serverOrTool ?? 'builtin';
    tool = toolOrArgs;
    effectiveArgs = argsJson;
  }

  let parsedArgs: Record<string, unknown> = {};
  if (effectiveArgs) {
    try {
      parsedArgs = JSON.parse(effectiveArgs);
    } catch {
      console.error(`Error: Invalid JSON arguments: ${effectiveArgs}`);
      return 1;
    }
  }

  try {
    let res: unknown;
    if (options?.mock) {
      const clientManager = new MCPClientManager(true);
      res = await clientManager.callTool(server, tool, parsedArgs);
    } else {
      res = await withBuiltinServerSession((client) =>
        client.callTool({ name: tool, arguments: parsedArgs })
      );
    }
    console.log(JSON.stringify(res, null, 2));
    // The builtin server reports in-band tool failures via isError:true (the
    // MCP SDK only throws on protocol errors) — surface them in the exit code
    // so CI/scripting callers can distinguish failure (2026-11-14 round 2).
    if ((res as { isError?: boolean } | null | undefined)?.isError === true) {
      return 1;
    }
    return 0;
  } catch (err: any) {
    console.error(`MCP Call Error: ${err.message}`);
    return 1;
  }
}

export async function executeMCPServe(): Promise<number> {
  const server = new BuiltinWorkflowMCPServer();
  try {
    await server.start();
  } catch (err: any) {
    console.error(`MCP Server Error: ${err.message}`);
    return 1;
  }
  // A stdio MCP server must OUTLIVE the handshake: returning here would exit
  // the CLI immediately and every host (ZCode included) would log
  // "Connection closed" right after connecting. Stay alive until the host
  // closes stdin (its shutdown signal) or the process is terminated. A stdin
  // that is already gone (readableEnded) must not park forever.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const stdin = process.stdin;
    if (stdin.readableEnded) {
      finish();
      return;
    }
    stdin.once('end', finish);
    stdin.once('close', finish);
    stdin.resume();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  return 0;
}
