/**
 * `workflow setup --target [claude|opencode|codex|zcode|all]` — one-command
 * interop installer (Mission D 支柱三：全编程助手互通适配体系).
 *
 * Generates the per-host configuration files in the current project so any
 * coding assistant can drive the engine out of the box.
 *
 * Ownership model (Issue #114): files under workflow-owned paths (skills,
 * agents, commands, tools.json, zcode config) are ours — always overwritten,
 * regeneration is the upgrade path. SHARED user configs (`.mcp.json`,
 * `.claude/settings.json`) are MERGED, never replaced: the user's other MCP
 * servers, deny rules and hooks must survive, with our own entries added or
 * upgraded in place. A shared config that exists but is not valid JSON aborts
 * the target with a clear error — setup never destroys a file it cannot read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_CATALOG } from '../../mcp/server.js';
import {
  CLAUDE_SKILL_TEMPLATE,
  OPENCODE_AGENT_TEMPLATE,
  OPENCODE_COMMAND_TEMPLATE,
  CODEX_INSTRUCTIONS_TEMPLATE,
  ZCODE_CONFIG_TEMPLATE,
} from '../interop-templates.js';

export interface SetupCommandOptions {
  target?: string;
  /** Destination project root (defaults to process.cwd()). */
  dir?: string;
}

type Target = 'claude' | 'opencode' | 'codex' | 'zcode';

/** Our own entry in the user's `.mcp.json` (upgraded in place on re-setup). */
interface AiWorkflowServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

/**
 * Resolve the engine invocation for the TARGET project (Issue #114, #84
 * leftover): inside the engine repo `bin/workflow.js` exists and stays the
 * invocation (its `.mcp.json` keeps the runtime-resolved
 * `${CLAUDE_PROJECT_DIR:-.}` form); any other project gets the global
 * `workflow` bin — a hardcoded repo-relative path pointed at a file that does
 * not exist there.
 */
function engineInvocation(root: string): { cli: string; localBin: boolean; mcp: AiWorkflowServerEntry } {
  const localBin = fs.existsSync(path.join(root, 'bin', 'workflow.js'));
  return localBin
    ? {
        cli: 'node bin/workflow.js',
        localBin,
        mcp: { type: 'stdio', command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/bin/workflow.js', 'mcp', 'serve'] },
      }
    : { cli: 'workflow', localBin, mcp: { type: 'stdio', command: 'workflow', args: ['mcp', 'serve'] } };
}

/**
 * Read a shared user config. Absent → undefined; unparseable → throw (the
 * caller aborts the target): overwriting a file we cannot understand would
 * destroy user data we cannot reconstruct (Issue #114).
 */
function readSharedJsonConfig(abs: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(abs)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${abs} exists but is not valid JSON (${(err as Error).message}) — ` +
        'fix or remove it before running setup; setup will not overwrite a config it cannot read'
    );
  }
}

/** Deep-merge our `mcpServers.ai-workflow` entry, preserving every other server. */
function mergeMcpJson(existing: Record<string, unknown> | undefined, entry: AiWorkflowServerEntry): string {
  const base = existing ?? {};
  const servers: Record<string, unknown> = { ...((base.mcpServers as Record<string, unknown>) ?? {}) };
  servers['ai-workflow'] = entry;
  return `${JSON.stringify({ ...base, mcpServers: servers }, null, 2)}\n`;
}

/** Union our allow entries into the user's settings, preserving deny/hooks/all else. */
function mergeClaudeSettings(
  existing: Record<string, unknown> | undefined,
  invocation: ReturnType<typeof engineInvocation>,
): string {
  const base = existing ?? {};
  const permissions: Record<string, unknown> = { ...((base.permissions as Record<string, unknown>) ?? {}) };
  const allow = new Set<string>((permissions.allow as string[]) ?? []);
  allow.add('Bash(workflow:*)');
  // Issue #127: NO blanket `mcp__ai-workflow` allow — the face contains
  // execute-capable tools (workflow_script_run / workflow_run_script /
  // workflow_replay) that would bypass Claude Code's per-command Bash
  // confirmations. Only the read-only tools are pre-approved; the execute
  // tools keep surfacing their confirmation prompts.
  for (const tool of ['workflow_script_check', 'workflow_inspect_run', 'workflow_get_run', 'workflow_graph', 'workflow_probe', 'workflow_inspect']) {
    allow.add(`mcp__ai-workflow__${tool}`);
  }
  if (invocation.localBin) allow.add('Bash(node bin/workflow.js:*)');
  permissions.allow = [...allow];
  return `${JSON.stringify({ ...base, permissions }, null, 2)}\n`;
}

function writeMerged(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeFileIfExistsGuard(
  files: Array<{ rel: string; content: string }>,
  root: string,
): number {
  let written = 0;
  for (const f of files) {
    const abs = path.join(root, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    console.log(`  ✔ wrote ${f.rel}`);
    written++;
  }
  return written;
}

function claudeFiles(): Array<{ rel: string; content: string }> {
  return [
    { rel: path.join('.claude', 'skills', 'ai-workflow', 'SKILL.md'), content: CLAUDE_SKILL_TEMPLATE },
  ];
}

function opencodeFiles(invocation: ReturnType<typeof engineInvocation>): Array<{ rel: string; content: string }> {
  // The mcp entry comes from engineInvocation, NOT the hardcoded
  // `node bin/workflow.js` of the old static template — a downstream project
  // without this repo checked out got configs that could not start
  // (2026-11-14 round 2; same root cause as the Issue #114 claude fix).
  const serverCommand = [invocation.mcp.command, ...(invocation.mcp.args ?? [])]
    .map((part) => JSON.stringify(part))
    .join(', ');
  const json = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai-workflow": {
      "type": "local",
      "command": [${serverCommand}]
    }
  }
}
`;
  return [
    { rel: path.join('.opencode', 'agent', 'workflow-runner.md'), content: OPENCODE_AGENT_TEMPLATE },
    { rel: path.join('.opencode', 'command', 'workflow.md'), content: OPENCODE_COMMAND_TEMPLATE },
    { rel: path.join('.opencode', 'opencode.json'), content: json },
  ];
}

function codexFiles(): Array<{ rel: string; content: string }> {
  const tools = TOOL_CATALOG.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  // Pure JSON only — OpenAI function-calling consumers JSON.parse this file
  // verbatim; a `//` comment prefix made the committed copy unparseable
  // (review round 1, HIGH). Regeneration hint lives in .codex/instructions.md.
  return [
    { rel: path.join('.codex', 'instructions.md'), content: CODEX_INSTRUCTIONS_TEMPLATE },
    {
      rel: path.join('.codex', 'tools.json'),
      content: `${JSON.stringify(tools, null, 2)}\n`,
    },
  ];
}

function zcodeFiles(invocation: ReturnType<typeof engineInvocation>): Array<{ rel: string; content: string }> {
  // Same engineInvocation parameterization as opencodeFiles above: the cli
  // line and the mcp entry must start in ANY project (global `workflow` bin
  // when this repo is not checked out), not at a hardcoded repo-relative path.
  const content = ZCODE_CONFIG_TEMPLATE.replace(
    '"cli": "node bin/workflow.js"',
    `"cli": ${JSON.stringify(invocation.cli)}`,
  ).replace(
    '"command": "node",\n      "args": ["bin/workflow.js", "mcp", "serve"]',
    `"command": ${JSON.stringify(invocation.mcp.command)},\n      "args": ${JSON.stringify(invocation.mcp.args ?? [])}`,
  );
  return [
    { rel: path.join('.zcode', 'config.json'), content },
  ];
}

export async function executeSetup(options?: SetupCommandOptions): Promise<number> {
  const targetInput = (options?.target ?? 'all').toLowerCase();
  const root = options?.dir ? path.resolve(options.dir) : process.cwd();

  let targets: Target[];
  if (targetInput === 'all') {
    targets = ['claude', 'opencode', 'codex', 'zcode'];
  } else if (targetInput === 'claude' || targetInput === 'opencode' || targetInput === 'codex' || targetInput === 'zcode') {
    targets = [targetInput];
  } else {
    console.error(`Error: unknown --target "${targetInput}". Use claude | opencode | codex | zcode | all.`);
    return 1;
  }

  console.log(`Setting up AI-Workflow interop in ${root}`);
  let count = 0;
  try {
    // One invocation resolution for every target — the opencode/zcode
    // templates need it as much as the claude merge did (Issue #114 family).
    const invocation = engineInvocation(root);
    for (const target of targets) {
      console.log(`  target: ${target}`);
      if (target === 'claude') {
        // Shared user configs — merge, never replace (Issue #114). Both reads
        // happen BEFORE any write so an unparseable config aborts the whole
        // target without a partial write.
        const mcpExisting = readSharedJsonConfig(path.join(root, '.mcp.json'));
        const settingsExisting = readSharedJsonConfig(path.join(root, '.claude', 'settings.json'));
        writeMerged(path.join(root, '.mcp.json'), mergeMcpJson(mcpExisting, invocation.mcp));
        console.log('  ✔ merged .mcp.json (ai-workflow entry added/updated; other servers preserved)');
        writeMerged(
          path.join(root, '.claude', 'settings.json'),
          mergeClaudeSettings(settingsExisting, invocation)
        );
        console.log('  ✔ merged .claude/settings.json (allow entries unioned; deny/hooks preserved)');
        count += 2;
        count += writeFileIfExistsGuard(claudeFiles(), root);
      } else {
        const files =
          target === 'opencode'
            ? opencodeFiles(invocation)
            : target === 'codex'
              ? codexFiles()
              : zcodeFiles(invocation);
        count += writeFileIfExistsGuard(files, root);
      }
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
  console.log(`\nDone — ${count} file(s) written. Restart your assistant so it discovers the new config.`);
  return 0;
}
