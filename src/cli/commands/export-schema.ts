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

/**
 * TOOL_CATALOG → OpenAI function-calling array — the single mapping both the
 * export-schema command and the setup codex target render (Issue #114), so
 * `.codex/tools.json` and the export output cannot drift apart.
 */
export function openAiToolArray(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return TOOL_CATALOG.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export async function executeExportSchema(options?: ExportSchemaCommandOptions): Promise<number> {
  const format = (options?.format ?? 'openai').toLowerCase();
  if (format !== 'openai') {
    console.error(`Error: unsupported --format "${format}". Supported: openai`);
    return 1;
  }
  const tools = openAiToolArray();
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
