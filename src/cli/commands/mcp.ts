import { MCPClientManager } from '../../mcp/client.js';
import { BuiltinWorkflowMCPServer } from '../../mcp/server.js';
import { resolveLang } from '../i18n/index.js';

export interface MCPCommandOptions {
  lang?: string;
  mock?: boolean;
  json?: boolean;
}

export async function executeMCPList(options?: MCPCommandOptions): Promise<number> {
  const _lang = resolveLang(options?.lang);
  const clientManager = new MCPClientManager(options?.mock ?? true);

  try {
    const tools = await clientManager.listTools('builtin');
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
  const _lang = resolveLang(options?.lang);

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

  const clientManager = new MCPClientManager(options?.mock ?? true);
  try {
    const res = await clientManager.callTool(server, tool, parsedArgs);
    console.log(JSON.stringify(res, null, 2));
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
