import { RegisteredTool } from '../types.js';

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  public register(
    serverName: string,
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }
  ): void {
    const key = `${serverName}:${tool.name}`;
    this.tools.set(key, {
      serverName,
      toolName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }

  public get(serverName: string, toolName: string): RegisteredTool | undefined {
    return this.tools.get(`${serverName}:${toolName}`);
  }

  public listAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  public clear(): void {
    this.tools.clear();
  }
}

export const toolRegistry = new ToolRegistry();
