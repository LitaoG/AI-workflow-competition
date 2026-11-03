import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MCPServerConfig } from '../types.js';

export class MCPClientManager {
  private clients = new Map<string, Client>();
  private mockMode: boolean;

  constructor(mockMode = false) {
    this.mockMode = mockMode;
  }

  public async connectServer(serverName: string, config: MCPServerConfig): Promise<void> {
    if (this.mockMode) {
      return; // In offline mock mode, bypass external connections
    }

    let transport;
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error(`MCP stdio transport for "${serverName}" requires "command"`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env,
      });
    } else if (config.transport === 'sse') {
      if (!config.url) {
        throw new Error(`MCP SSE transport for "${serverName}" requires "url"`);
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      throw new Error(`Unsupported MCP transport "${config.transport}"`);
    }

    const client = new Client(
      { name: `ai-workflow-client`, version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    this.clients.set(serverName, client);
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

    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP Server "${serverName}" is not connected`);

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
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (this.mockMode) {
      return { status: 'success', tool: toolName, mockResult: `Success calling ${serverName}:${toolName}`, args };
    }

    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP Server "${serverName}" is not connected`);

    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    return result;
  }

  public async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch (err) {
        console.warn(`Error closing MCP client "${name}":`, err);
      }
    }
    this.clients.clear();
  }
}
