# Integrating AI-Workflow with agent hosts

The engine is three things at once: a **standalone CLI**, an **MCP server**,
and a **library**. Any host that can spawn a process or speak MCP can drive it.

## 1. Standalone CLI

```bash
npm install && npm run build
node bin/workflow.js --help
# or link it globally:
npm link && workflow --help
```

The facade-script loop (what an agent drives):

```bash
workflow script check <script.ts>                     # must be clean
workflow script run <script.ts> --cwd <ws> --args '{}' # journal records every node
workflow script run <script.ts> --cwd <ws> --resume <runId>  # zero-cost replay
```

## 2. MCP server (Claude Code / ZCode / opencode / Codex CLI / Cursor…)

`workflow mcp serve` speaks MCP over stdio and exposes:
`workflow_run`, `workflow_probe`, `workflow_inspect`, `workflow_replay`,
`workflow_graph`, plus the facade-script pair `workflow_script_check` /
`workflow_script_run`.

```bash
# Claude Code
claude mcp add ai-workflow -- node <repo>/bin/workflow.js mcp serve

# ZCode (settings → MCP servers → stdio)
command: node
args: [<repo>/bin/workflow.js, mcp, serve]
```

```json
// opencode (opencode.json)
{
  "mcp": {
    "ai-workflow": {
      "type": "local",
      "command": ["node", "<repo>/bin/workflow.js", "mcp", "serve"]
    }
  }
}
```

```toml
# Codex CLI (~/.codex/config.toml)
[mcp_servers.ai-workflow]
command = "node"
args = ["<repo>/bin/workflow.js", "mcp", "serve"]
```

Once connected, the host agent authors facade scripts (see
`skills/ai-workflow/SKILL.md`) and drives them with `workflow_script_check`
→ `workflow_script_run` (→ resume). The engine guarantees: strict
compile-time checks before anything runs, sandbox isolation, deterministic
journal replay at zero provider calls, and process-tree-safe supervision.

## 3. Skill install

Point any skill-capable host at `skills/ai-workflow/` (SKILL.md +
`examples/review.facade.ts`):

- **Claude Code**: copy into `~/.claude/skills/` (or a plugin's `skills/`).
- **Codex CLI**: referenced from the host's agent-instruction file / prompt pack.
- Anything else: the SKILL.md is plain markdown an agent can read.

## 4. Routing worker asks to external agent CLIs (provider routing)

By default `agent().ask()` calls go to the provider registry (mock provider
by default; Bedrock available). To route asks through an external agent CLI as
the worker, set the provider before launching:

```bash
AI_WORKFLOW_PROVIDER=codex    workflow script run script.ts ...   # codex exec
AI_WORKFLOW_PROVIDER=gemini   workflow script run script.ts ...   # gemini -p
AI_WORKFLOW_PROVIDER=opencode workflow script run script.ts ...   # opencode run
AI_WORKFLOW_CLI_COMMAND='<path-to-codex.exe>'  # explicit binary override
AI_WORKFLOW_CLI_TIMEOUT_MS=120000
```

Providers spawn the CLI through the process supervisor (own process group on
POSIX, whole-tree kill on Windows, sanitized environment), so worker calls
inherit the same lifecycle guarantees as `world.run` gates.

## Notes and limits

- The sandbox is process/vm isolation for determinism and lifecycle, not a
  security boundary; `world.run` commands are compile-time literals shown for
  approval.
- Everything is Apache-2.0 — embedding is welcome (`exports` map exposes
  `./core`, `./agent`, `./dag`, `./mcp` subpaths).
