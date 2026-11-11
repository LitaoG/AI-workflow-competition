import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { adoptPidIntoJobGuard, type PidGuard } from '../process-supervision.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpCallOptions, MCPServerConfig } from '../types.js';
import { McpConfigError, McpConnectError, McpServerNotConfiguredError, McpToolError } from '../core/error.js';
import { redactText } from '../dwf/redact.js';
import { expandEnvRefs, configFromMcpJsonEntry, createDefaultTransport, isRecord } from './mcp-config.js';
import type { McpEnv } from './mcp-config.js';

// Historical import surface: config parsing resolves from the client module.
export { expandEnvRefs, configFromMcpJsonEntry, createDefaultTransport } from './mcp-config.js';
export type { McpEnv } from './mcp-config.js';

/**
 * Default upper bound for one server handshake. A stdio `connect` has no
 * built-in timeout and can hang under host load (AI-PITFALLS P-TEST-3); the
 * race turns that hang into a fast, named failure.
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 20_000;

/**
 * Environment variable naming a trusted `.mcp.json`. The engine never reads a
 * `.mcp.json` just because it sits in the working directory: that file belongs
 * to whatever repository the run starts in, and its `command` would run with
 * the host's environment (Issue #106 pre-review F1).
 */
export const MCP_CONFIG_ENV = 'AI_WORKFLOW_MCP_CONFIG';

/**
 * Environment variable overriding the handshake timeout in ms. A server with a
 * slow first start (an `npx -y` download, a first image pull) needs more than
 * the default, and a failed handshake is cached for the run (pre-review F6).
 */
export const MCP_CONNECT_TIMEOUT_ENV = 'AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS';

/** Largest delay `setTimeout` honours; above it Node fires after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

/** Longest tool error text an `McpToolError` keeps, counted after redaction. */
const TOOL_ERROR_TEXT_LIMIT = 500;

/** Variables visible to `${VAR}` expansion and the `AI_WORKFLOW_MCP_*` lookups. */

/** Builds the transport for one server. Injectable so tests can connect in memory. */
export type McpTransportFactory = (serverName: string, config: MCPServerConfig) => Transport | Promise<Transport>;

export interface MCPClientManagerOptions {
  /** Explicit server configs. When given, they are the only source. */
  servers?: Record<string, MCPServerConfig>;
  /**
   * Path to a trusted `.mcp.json` (Claude Code format). Default: the
   * {@link MCP_CONFIG_ENV} variable of `env`. Without either, no file is read.
   */
  configPath?: string;
  /**
   * Environment for `${VAR}` expansion and the {@link MCP_CONFIG_ENV} /
   * {@link MCP_CONNECT_TIMEOUT_ENV} lookups (default: `process.env`).
   */
  env?: McpEnv;
  /**
   * Handshake timeout per server in ms. Default: the
   * {@link MCP_CONNECT_TIMEOUT_ENV} variable of `env`, else
   * {@link DEFAULT_MCP_CONNECT_TIMEOUT_MS}.
   */
  connectTimeoutMs?: number;
  /** Transport builder (default {@link createDefaultTransport}). */
  transportFactory?: McpTransportFactory;
}


/**
 * The text parts of a failed tool result, redacted first and then truncated, so
 * an `McpToolError` can travel into events and the journal.
 */
function toolErrorText(result: Record<string, unknown>): string {
  const parts = Array.isArray(result.content)
    ? result.content.flatMap((item: unknown) =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      )
    : [];
  const text = redactText(parts.join('\n').trim() || 'the tool returned no text');
  return text.length > TOOL_ERROR_TEXT_LIMIT ? `${text.slice(0, TOOL_ERROR_TEXT_LIMIT)}...` : text;
}

/**
 * Run-scoped MCP client pool.
 *
 * Servers connect lazily on first use (`callTool` / `listTools`), from the
 * explicit `servers` option or else a trusted `.mcp.json` (`configPath` or
 * {@link MCP_CONFIG_ENV}); the working directory is never searched. Concurrent
 * first calls to one server share one handshake, so a stdio server is spawned
 * once. A failed handshake closes its transport and is cached: later calls to
 * that server fail fast with the same error instead of paying another timeout.
 * A tool result with `isError: true` fails the call with `McpToolError` unless
 * the caller passes `allowToolError`. `disconnectAll()` also waits for
 * handshakes still in flight, so no stdio child outlives the owner.
 */
export class MCPClientManager {
  private clients = new Map<string, Client>();
  /** Issue #117: one kernel watchdog per live stdio child (host-dies-first insurance). */
  private pidGuards = new Map<string, PidGuard>();
  private connecting = new Map<string, Promise<Client>>();
  /** First connect failure per server; later calls reject with it (no repeated handshakes). */
  private failures = new Map<string, unknown>();
  private mockMode: boolean;
  private readonly servers?: Record<string, MCPServerConfig>;
  private readonly configPath?: string;
  private readonly env: McpEnv;
  /** Raw timeout setting and where it came from; validated when a handshake starts. */
  private readonly connectTimeout?: { value: number | string; source: string };
  private readonly transportFactory: McpTransportFactory;
  private mcpJson?: { file: string; entries: Record<string, unknown> };

  constructor(mockMode = false, options: MCPClientManagerOptions = {}) {
    this.mockMode = mockMode;
    this.servers = options.servers;
    this.env = options.env ?? process.env;
    const configPath = options.configPath || this.env[MCP_CONFIG_ENV];
    this.configPath = configPath ? path.resolve(configPath) : undefined;
    const envTimeout = this.env[MCP_CONNECT_TIMEOUT_ENV];
    if (options.connectTimeoutMs !== undefined) {
      this.connectTimeout = { value: options.connectTimeoutMs, source: 'mcpConnectTimeoutMs' };
    } else if (envTimeout) {
      this.connectTimeout = { value: envTimeout, source: MCP_CONNECT_TIMEOUT_ENV };
    }
    this.transportFactory = options.transportFactory ?? createDefaultTransport;
  }

  public async connectServer(serverName: string, config: MCPServerConfig): Promise<void> {
    if (this.mockMode) {
      return; // In offline mock mode, bypass external connections
    }
    const client = await this.openClient(serverName, config);
    this.clients.set(serverName, client);
    this.failures.delete(serverName);
  }

  /**
   * The config for `serverName`: the explicit `servers` option when given,
   * else the `mcpServers` entry of the trusted `.mcp.json`.
   */
  public resolveServerConfig(serverName: string): MCPServerConfig {
    if (this.servers) {
      const config = Object.prototype.hasOwnProperty.call(this.servers, serverName)
        ? this.servers[serverName]
        : undefined;
      if (!config) {
        throw new McpServerNotConfiguredError(serverName, Object.keys(this.servers), 'the mcpServers option');
      }
      return config;
    }
    if (!this.configPath) {
      throw new McpServerNotConfiguredError(
        serverName,
        [],
        `no MCP config; pass mcpServers or mcpConfigPath, or set ${MCP_CONFIG_ENV}`
      );
    }
    const { file, entries } = this.readMcpJson(this.configPath);
    if (!Object.prototype.hasOwnProperty.call(entries, serverName)) {
      throw new McpServerNotConfiguredError(serverName, Object.keys(entries), file);
    }
    return configFromMcpJsonEntry(serverName, entries[serverName], path.dirname(file), this.env);
  }

  public async listTools(serverName: string): Promise<Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>> {
    if (this.mockMode) {
      return [
        {
          name: 'mock_file_read',
          description: 'Mock tool reading file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          name: 'read_file',
          description: 'Read file contents from filesystem',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          name: 'write_file',
          description: 'Write file contents to filesystem',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        {
          name: 'ast_grep',
          description: 'Search AST code patterns',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
        },
      ];
    }

    const client = await this.ensureConnected(serverName);
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  public async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {}
  ): Promise<unknown> {
    if (this.mockMode) {
      return { status: 'success', tool: toolName, mockResult: `Success calling ${serverName}:${toolName}`, args };
    }

    const client = await this.ensureConnected(serverName);
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    // MCP reports a failed tool run inside the result (`isError: true`), not as
    // a protocol error. Treat it as a failed call so the step fails or retries
    // instead of handing error text downstream as output (pre-review F7).
    if (isRecord(result) && result.isError === true && !options.allowToolError) {
      throw new McpToolError(serverName, toolName, toolErrorText(result));
    }
    return result;
  }

  public async disconnectAll(): Promise<void> {
    // Let in-flight handshakes land first, so none of them can register a live
    // client (and a running stdio child) after the close sweep below.
    await Promise.allSettled([...this.connecting.values()]);
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch (err) {
        console.warn(`Error closing MCP client "${name}":`, err);
      }
    }
    this.clients.clear();
    this.failures.clear();
    // Issue #117: retire the watchdogs LAST — killing a helper closes its job
    // handle, and KILL_ON_JOB_CLOSE would terminate a stdio child that is
    // still finishing its own shutdown (the #120 B wait-for-close ordering).
    for (const guard of this.pidGuards.values()) guard.stop();
    this.pidGuards.clear();
  }

  /** The connected client for `serverName`; concurrent first calls share one handshake. */
  private ensureConnected(serverName: string): Promise<Client> {
    const ready = this.clients.get(serverName);
    if (ready) return Promise.resolve(ready);
    if (this.failures.has(serverName)) return Promise.reject(this.failures.get(serverName));
    const inFlight = this.connecting.get(serverName);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<Client> => {
      const client = await this.openClient(serverName, this.resolveServerConfig(serverName));
      this.clients.set(serverName, client);
      return client;
    })()
      .catch((err: unknown) => {
        // Fail fast for the rest of the run: a broken server costs one
        // handshake (at most one timeout), not one per call (pre-review F2).
        this.failures.set(serverName, err);
        throw err;
      })
      .finally(() => {
        this.connecting.delete(serverName);
      });
    this.connecting.set(serverName, pending);
    return pending;
  }

  /** The handshake timeout; an invalid setting fails before anything is spawned. */
  private resolveConnectTimeoutMs(serverName: string): number {
    if (!this.connectTimeout) return DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    const { value, source } = this.connectTimeout;
    const ms = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
    if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) {
      throw new McpConfigError(serverName, `${source} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`);
    }
    return ms;
  }

  /** Open one client; a failed or timed-out handshake closes the transport (no orphan child). */
  private async openClient(serverName: string, config: MCPServerConfig): Promise<Client> {
    const timeoutMs = this.resolveConnectTimeoutMs(serverName);
    const transport = await this.transportFactory(serverName, config);
    const client = new Client({ name: `ai-workflow-client`, version: '1.0.0' }, { capabilities: {} });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new McpConnectError(
              serverName,
              `handshake timed out after ${timeoutMs}ms; raise the limit with WorkflowOptions.mcpConnectTimeoutMs or ${MCP_CONNECT_TIMEOUT_ENV}`
            )
          ),
        timeoutMs
      );
    });
    try {
      await Promise.race([client.connect(transport), timeout]);
      // Issue #117: the SDK spawned the stdio child inside connect() — adopt
      // its pid into a kill-on-close job (Windows) / host-watchdog (POSIX) so
      // a host kill cannot orphan it. The manager's disconnectAll stops the
      // guard after the client's own close.
      if (transport instanceof StdioClientTransport && typeof transport.pid === 'number' && transport.pid > 0) {
        this.pidGuards.set(serverName, adoptPidIntoJobGuard(transport.pid));
      }
      return client;
    } catch (err) {
      await transport.close().catch(() => {});
      if (err instanceof McpConnectError) throw err;
      // The cause can echo the expanded command line or server output: redact
      // before it reaches errors, events and the journal.
      throw new McpConnectError(serverName, redactText(err instanceof Error ? err.message : String(err)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private readMcpJson(file: string): { file: string; entries: Record<string, unknown> } {
    if (this.mcpJson) return this.mcpJson;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : `cannot read file: ${(err as Error).message}`;
      throw new McpConfigError(file, reason);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      // The engine message can quote file text (e.g. an env secret): keep it out.
      throw new McpConfigError(file, 'invalid JSON');
    }
    const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
    let entries: Record<string, unknown> = {};
    if (isRecord(servers)) {
      entries = servers;
    } else if (servers !== undefined) {
      throw new McpConfigError(file, '"mcpServers" must be an object');
    }
    this.mcpJson = { file, entries };
    return this.mcpJson;
  }
}
