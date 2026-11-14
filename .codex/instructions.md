# AI-Workflow — Codex operating instructions

You can orchestrate deterministic multi-agent work through the **AI-Workflow
engine** CLI (`workflow`, or `node bin/workflow.js`).

## Loop

1. **Author** a TypeScript facade script in the target workspace.
2. **Check**: `workflow check <script>` — must print
   `✔ facade script compiled clean (N sites)`; fix all
   diagnostics before running.
3. **Run**: `workflow run <script> --set key=value --cwd <workspace>`
   (facade scripts are auto-detected; `workflow run-script` is the explicit
   alias; `--args-file <file.json>` for JSON files).
4. **Resume**: on failure re-run with `--resume <runId>` — completed nodes
   replay from the journal at zero provider calls. Answer parked escalations
   with `workflow answer <runId> <questionId> "<text>"`; fill holes with
   `workflow fill <runId> <holeName> <bodyFile>`.

## Facade surface (the ONLY APIs inside a script)

- `agent('name').ask<T>(prompt)` — typed subagent turn.
- `phase('Title')` — compile-time literal.
- `log(...)` / `report({...})` — narration.
- `files.glob/grep/read`, `git.changedFiles/diff/status/log` — journalled reads.
- `world.run('cmd', [args], { timeoutMs })` — deterministic shell gate.
- `artifact.markdown(id, md)` / `artifact.file(id, path)` — outputs.
- `escalate(question)` / `hole<T>(name, prompt)` — human-in-the-loop parks.
- Top-level `await` and `return` are allowed; `args` carries the input.

## Hard rules

- Banned inside scripts: `Date.now()`, `Math.random()`, `new Date()`,
  `import`, `process`, `fs`, `fetch` — the facade is the entire surface.
- Phase titles and shell-gate commands must be string literals.
- Inspect runs: `workflow inspect <runId>`, `workflow view <runId>` (Studio
  HTML), `workflow serve <runId>` (live dashboard + inline resume).

## Tool calling

`.codex/tools.json` mirrors the engine's 10 MCP tools in OpenAI
function-calling schema (regenerate with `workflow export-schema --format
openai`). List them live with `workflow mcp list`.
