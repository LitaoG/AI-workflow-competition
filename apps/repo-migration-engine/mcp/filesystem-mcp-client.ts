import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionContext } from 'ai-workflow';

export interface FileReadResult {
  filePath: string;
  content: string;
  lines: number;
}

export interface FileWriteResult {
  filePath: string;
  bytesWritten: number;
  success: boolean;
}

export class FilesystemMCPClient {
  private ctx?: ExecutionContext;
  private serverName: string;
  private isMock: boolean;

  constructor(options?: { ctx?: ExecutionContext; serverName?: string; isMock?: boolean }) {
    this.ctx = options?.ctx;
    this.serverName = options?.serverName || 'filesystem-mcp-server';
    this.isMock = options?.isMock ?? options?.ctx?.isMock ?? false;
  }

  public async readFile(targetPath: string): Promise<string> {
    if (this.ctx && !this.isMock && this.ctx.mcp?.callTool) {
      try {
        const res: any = await this.ctx.mcp.callTool(this.serverName, 'read_file', { path: targetPath });
        if (res && res.content) return res.content;
      } catch {
        // Fall back to local file read
      }
    }
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    return fs.readFileSync(resolved, 'utf-8');
  }

  public async writeFile(targetPath: string, content: string): Promise<FileWriteResult> {
    if (this.ctx && !this.isMock && this.ctx.mcp?.callTool) {
      try {
        await this.ctx.mcp.callTool(this.serverName, 'write_file', { path: targetPath, content });
      } catch {
        // Fall back to local file write
      }
    }
    const resolved = path.resolve(targetPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    return {
      filePath: resolved,
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
      success: true,
    };
  }

  public async applyPatch(targetPath: string, transformedCode: string): Promise<boolean> {
    const res = await this.writeFile(targetPath, transformedCode);
    return res.success;
  }
}
