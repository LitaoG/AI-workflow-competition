/**
 * `workflow export-schema --format openai [--out <file>]` — export the
 * built-in engine MCP tool face as an OpenAI function-calling tool array
 * (Mission D 支柱三：Codex / Structured Outputs 适配).
 *
 * The descriptors come from the SAME `TOOL_CATALOG` the MCP server serves —
 * validation and documentation can never drift apart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_CATALOG } from '../../mcp/server.js';

export interface ExportSchemaCommandOptions {
  format?: string;
  out?: string;
}

export async function executeExportSchema(options?: ExportSchemaCommandOptions): Promise<number> {
  const format = (options?.format ?? 'openai').toLowerCase();
  if (format !== 'openai') {
    console.error(`Error: unsupported --format "${format}". Supported: openai`);
    return 1;
  }
  const tools = TOOL_CATALOG.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
  const json = JSON.stringify(tools, null, 2) + '\n';
  if (options?.out) {
    const abs = path.resolve(options.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json);
    console.log(`✔ exported ${tools.length} tool schema(s) → ${abs}`);
  } else {
    console.log(json);
  }
  return 0;
}
