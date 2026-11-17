/**
 * Interop templates for `workflow setup` (Mission D 支柱三).
 *
 * Each target gets a self-contained, minimal, correct set of files — no
 * dangling references into this repository, so the generated configs work in
 * ANY project that has the `workflow` CLI on PATH (or `node bin/workflow.js`).
 */

/** Compact Claude Code skill body — self-contained (no repo-internal links). */
export const CLAUDE_SKILL_TEMPLATE = `---
name: ai-workflow
description: >-
  Author and run deterministic dynamic-workflow scripts with the AI-Workflow
  engine: compile-checked facade scripts (agent().ask<T>, phases, shell gates,
  artifacts) executed in a sandbox with a journal that replays completed work
  at zero provider calls. Use for multi-step tasks that need real
  orchestration — coverage loops, parallel reviews with verification,
  migration pipelines. Not for single delegated lookups.
---

# AI-Workflow — deterministic dynamic workflows

Write a TypeScript **facade script**, compile-check it, run it in the sandbox,
and resume from the journal on failure. Control flow is your code; every side
effect goes through the facade.

## The authoring loop (every time, in order)

1. **Write** the script to the target workspace (e.g. \`./<task>.facade.ts\`).
2. **Check** — never skip: \`workflow check <script>\`. It must print \`✔ facade script compiled clean (N sites)\`.
3. **Run** — \`workflow run <script>\` (auto-detects facade scripts; \`workflow
   run-script\` is the explicit alias). Pass input via \`--set key=value\`
   (repeatable, type-inferred — the PowerShell-safe default), \`--args-file
   <file.json>\`, or \`--args '<json>'\`. Use \`--cwd <dir>\` when the script's
   workspace root differs from where you invoke.
4. **Resume on failure** — fix the script and re-run with \`--resume <runId>\`:
   completed nodes replay from the journal at zero provider calls.

MCP tools: \`workflow_script_check\`, \`workflow_script_run\`, \`workflow_run_script\`,
\`workflow_inspect_run\`, \`workflow_get_run\` (list all via \`workflow mcp list\`).

## The facade (the ONLY APIs a script may use)

- \`agent('name').ask<T>(prompt)\` — typed subagent turn (JSDoc fields become the
  schema); untyped \`ask\` returns text/object.
- \`phase('Title')\` — compile-time literal, groups the progress view.
- \`log(...)\` / \`report({...})\` — narration + structured progress.
- \`files.glob/grep/read\`, \`git.changedFiles/diff/status/log\` — journalled reads.
- \`world.run('cmd', [args], { timeoutMs })\` — deterministic shell gate; command
  must be a string literal.
- \`artifact.markdown(id, md, { title })\` / \`artifact.file(id, path)\` — outputs.
- \`escalate(question)\` — parks the run for a human answer (\`workflow answer\`).
- \`hole<T>(name, prompt)\` — parks for a JS body (\`workflow fill\`).
- \`args\` — script input; top-level \`await\` + top-level \`return\` allowed.

## Hard rules (the compiler enforces them)

- No \`Date.now()\` / \`Math.random()\` / \`new Date()\` — pass time through args.
- No \`import\` / \`process\` / \`fs\` / \`fetch\` — the facade is the whole surface.
- \`phase()\` titles and \`world.run\` commands must be string literals.
- Pair a worker ask with a separate reviewer ask (fresh eyes).
`;

export const OPENCODE_AGENT_TEMPLATE = `---
description: >
  Deterministic AI-Workflow orchestrator: authors facade scripts, compile-checks
  them, runs them in the sandboxed engine and resumes from the journal.
mode: subagent
---

You orchestrate work through the **AI-Workflow engine**. Write a TypeScript
facade script, check it, run it, and resume from the journal on failure.

## Loop

1. Write \`./<task>.facade.ts\` in the target workspace.
2. \`workflow check <script>\` — must print \`facade script compiled clean\` before any run.
3. \`workflow run <script> --set key=value --cwd <workspace>\` — facade scripts
   are auto-detected (\`workflow run-script\` is the explicit alias). Parse the
   final \`Result:\` JSON and the stats line (\`asks: N (replayed from journal: M)\`).
4. On failure: fix the script, re-run with \`--resume <runId>\` — completed
   nodes replay from the journal at zero provider calls.

## Facade surface (the ONLY APIs inside a script)

agent('name').ask<T>(prompt) · phase('Title') · log/report · files.glob/grep/read ·
git.changedFiles/diff/status/log · world.run('cmd', [args], { timeoutMs }) ·
artifact.markdown/file · escalate(question) · hole<T>(name, prompt) · args ·
top-level await/return.

Banned (compiler-enforced): Date.now/Math.random/new Date · import/process/fs/fetch ·
non-literal phase titles or world.run commands.

## JSON mode

Prefer \`workflow --lang en\` plain output; every command accepts \`--help\`.
List the MCP tool face with \`workflow mcp list\`.
`;

export const OPENCODE_COMMAND_TEMPLATE = `---
description: Run an AI-Workflow facade script (check → run → resume loop)
agent: workflow-runner
---

Run the AI-Workflow loop for: $ARGUMENTS

1. If no script path was given, ask for one (or author a new facade script for
   the task with the facade surface: agent/phase/files/git/world.run/artifact).
2. \`workflow check <script>\` — fix every diagnostic before running.
3. \`workflow run <script> --set key=value --cwd <workspace>\` (use \`--args-file\`
   for JSON input files; \`--args '<json>'\` works but is not PowerShell-safe).
4. Parse the final \`result:\` JSON line + stats line. On failure re-run with
   \`--resume <runId>\`; on an open escalation use \`workflow answer <runId>
   <questionId> "<text>"\`; for a hole use \`workflow fill <runId> <name> <bodyFile>\`.
5. Report the run id, the result value and where the journal lives
   (.workflow/dwf.sqlite).
`;


export const CODEX_INSTRUCTIONS_TEMPLATE = `# AI-Workflow — Codex operating instructions

You can orchestrate deterministic multi-agent work through the **AI-Workflow
engine** CLI (\`workflow\`, or \`node bin/workflow.js\`).

## Loop

1. **Author** a TypeScript facade script in the target workspace.
2. **Check**: \`workflow check <script>\` — must print
   \`✔ facade script compiled clean (N sites)\`; fix all
   diagnostics before running.
3. **Run**: \`workflow run <script> --set key=value --cwd <workspace>\`
   (facade scripts are auto-detected; \`workflow run-script\` is the explicit
   alias; \`--args-file <file.json>\` for JSON files).
4. **Resume**: on failure re-run with \`--resume <runId>\` — completed nodes
   replay from the journal at zero provider calls. Answer parked escalations
   with \`workflow answer <runId> <questionId> "<text>"\`; fill holes with
   \`workflow fill <runId> <holeName> <bodyFile>\`.

## Facade surface (the ONLY APIs inside a script)

- \`agent('name').ask<T>(prompt)\` — typed subagent turn.
- \`phase('Title')\` — compile-time literal.
- \`log(...)\` / \`report({...})\` — narration.
- \`files.glob/grep/read\`, \`git.changedFiles/diff/status/log\` — journalled reads.
- \`world.run('cmd', [args], { timeoutMs })\` — deterministic shell gate.
- \`artifact.markdown(id, md)\` / \`artifact.file(id, path)\` — outputs.
- \`escalate(question)\` / \`hole<T>(name, prompt)\` — human-in-the-loop parks.
- Top-level \`await\` and \`return\` are allowed; \`args\` carries the input.

## Hard rules

- Banned inside scripts: \`Date.now()\`, \`Math.random()\`, \`new Date()\`,
  \`import\`, \`process\`, \`fs\`, \`fetch\` — the facade is the entire surface.
- Phase titles and shell-gate commands must be string literals.
- Inspect runs: \`workflow inspect <runId>\`, \`workflow view <runId>\` (Studio
  HTML), \`workflow serve <runId>\` (live dashboard + inline resume).

## Tool calling

\`.codex/tools.json\` mirrors the engine's 10 MCP tools in OpenAI
function-calling schema (regenerate with \`workflow export-schema --format
openai\`). List them live with \`workflow mcp list\`.
`;

/**
 * ZCode runtime alignment config (.zcode/config.json): declares the
 * engine entry points and journal paths so ZCode can read and run workflows
 * bidirectionally without re-probing the project.
 */
export const ZCODE_CONFIG_TEMPLATE = `{
  "workflow": {
    "cli": "node bin/workflow.js",
    "mcp": {
      "command": "node",
      "args": ["bin/workflow.js", "mcp", "serve"]
    },
    "journal": ".workflow/dwf.sqlite",
    "runsDb": ".workflow/runs.db"
  }
}
`;

