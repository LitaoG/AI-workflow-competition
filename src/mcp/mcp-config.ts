/**
 * MCP client configuration — the .mcp.json entry schema, env-reference
 * expansion and the default transport factory. Moved verbatim from
 * client.ts; the client module re-exports the historical surface.
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpConfigError } from '../core/error.js';

export type McpEnv = Readonly<Record<string, string | undefined>>;
import { MCPServerConfig } from '../types.js';

/** One `mcpServers` entry of a Claude Code project `.mcp.json`. */
export const McpJsonEntrySchema = z.object({
  type: z.enum(['stdio', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
});

/** `${NAME}` or `${NAME:-default}` (Claude Code `.mcp.json` expansion syntax). */
export const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Expand `${VAR}` and `${VAR:-default}` references as Claude Code does for
 * `.mcp.json`: `${VAR:-default}` takes the default only when VAR is unset (an
 * empty string counts as set). One deliberate difference: Claude Code loads a
 * config whose `${VAR}` is unset and passes the raw `${VAR}` text on with a
 * warning; the engine fails closed with `McpConfigError` instead, so a server
 * never starts with a placeholder in its command line.
 */
export function expandEnvRefs(value: string, env: McpEnv, serverName: string): string {
  return value.replace(
    ENV_REF,
    (_ref: string, name: string, defaultPart: string | undefined, fallback: string | undefined) => {
      const current = env[name];
      if (current !== undefined) return current;
      if (defaultPart !== undefined) return fallback ?? '';
      throw new McpConfigError(serverName, `environment variable "${name}" is not set and has no default`);
    }
  );
}

/**
 * Convert one `.mcp.json` `mcpServers` entry into the engine's server config.
 * A missing `type` means stdio (the Claude Code default). Like Claude Code, the
 * server gets `CLAUDE_PROJECT_DIR` (= the folder holding the `.mcp.json`) in its
 * environment unless the entry sets it, and it is spawned in that folder, so
 * relative paths resolve there whatever the run's working directory is.
 */
export function configFromMcpJsonEntry(
  serverName: string,
  entry: unknown,
  projectDir: string,
  env: McpEnv
): MCPServerConfig {
  const parsed = McpJsonEntrySchema.safeParse(entry);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
      .join('; ');
    throw new McpConfigError(serverName, issues);
  }
  const raw = parsed.data;
  const expand = (value: string): string => expandEnvRefs(value, env, serverName);
  const entryEnv =
    raw.env === undefined
      ? {}
      : Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, expand(value)]));
  return {
    transport: raw.type ?? 'stdio',
    command: raw.command === undefined ? undefined : expand(raw.command),
    args: raw.args?.map(expand),
    env: { CLAUDE_PROJECT_DIR: projectDir, ...entryEnv },
    url: raw.url === undefined ? undefined : expand(raw.url),
    cwd: projectDir,
  };
}

/** Default transport builder: a stdio child process or an SSE endpoint. */
export function createDefaultTransport(serverName: string, config: MCPServerConfig): Transport {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new McpConfigError(serverName, 'stdio transport requires "command"');
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env,
      cwd: config.cwd,
    });
  }
  if (config.transport === 'sse') {
    if (!config.url) {
      throw new McpConfigError(serverName, 'SSE transport requires "url"');
    }
    return new SSEClientTransport(new URL(config.url));
  }
  throw new McpConfigError(serverName, `unsupported transport "${String(config.transport)}"`);
}
