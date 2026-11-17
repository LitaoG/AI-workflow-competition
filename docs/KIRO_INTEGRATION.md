# AI-Workflow Kiro Integration & Hackathon Compliance Guide

> **Official Integration Guide for AWS Kiroween 2026 (Skeleton Crew Category)**  
> *Tracked Git Configuration · Formal Specifications · Lifecycle Hooks · Steering Guardrails · MCP Protocol · PBT Invariants · Skeleton Crew Roster*

---

## 1. Overview & Hackathon Alignment

**AWS Kiroween 2026** introduces the **Skeleton Crew** hackathon category, dedicated to creating *"flexible, clean structural code templates"* that empower autonomous multi-agent engineering without chaotic prompt-chasing.

AI-Workflow integrates natively with **Kiro** via a root `/.kiro/` governance directory that is **fully tracked in Git**. Rather than treating AI agents as unconstrained conversational chatbots, AI-Workflow uses Kiro's formal specifications, lifecycle hooks, frontmatter steering guardrails, and property-based testing to guarantee deterministic execution, safety, and reproducible workflows.

```
AI-workflow/
└── .kiro/                          # R3: Mandatory Kiro root configuration (TRACKED IN GIT)
    ├── specs/                      # Formal specifications & JSON schemas
    │   ├── workflow-engine-spec.md
    │   ├── typed-rpc-schemas.json
    │   ├── state-replay-invariants.md
    │   └── ui-presentation-spec.md
    ├── hooks/                      # Kiro lifecycle hooks & deterministic shell gates
    │   ├── lifecycle.json          # the live hook surface: binds the .js gates by event
    │   ├── pre-workflow-gate.js    # AgentSpawn — deterministic environment probe
    │   ├── pre-step-gate.js        # PreToolUse — destructive-command interception
    │   ├── post-step-audit.js      # PostToolUse — append-only event-stream audit
    │   └── stop-workflow-gate.js   # Stop — verification gates before session exit
    ├── steering/                   # Frontmatter-driven steering guardrails (inclusion: always)
    │   ├── guidelines.md
    │   ├── policy-guardrails.md
    │   ├── workflow-conventions.md
    │   └── bilingual-presentation.md
    ├── mcp/                        # MCP server integration
    │   └── mcp-server.json
    ├── pbt/                        # Fast-check Property-Based Testing suite (6 property files)
    │   ├── dag-topology.test.ts
    │   ├── engine-invariants.test.ts
    │   ├── mcp-lazy-connect.test.ts
    │   ├── ndjson-roundtrip.test.ts
    │   ├── redact-differential.test.ts
    │   └── retry-classification.test.ts
    └── crew/                       # Skeleton Crew team roster & permissions
        ├── team.json
        └── permissions.json
```

---

## 2. Formal Specifications Subsystem (`/.kiro/specs/`)

The `specs/` directory establishes machine-readable and mathematically rigorous specifications governing the dynamic workflow engine:

### 2.1 `workflow-engine-spec.md`
Formal operational semantics of the `/workflow` slash command:
- **State Machine**:
  $$\text{INITIALIZING} \longrightarrow \text{PROBING} \longrightarrow \text{SCHEDULED} \longrightarrow \text{EXECUTING\_STEP} \longleftrightarrow \text{VALIDATING\_GATE} \longrightarrow \text{COMPLETED} \ (\text{or } \text{FAILED})$$
- **RPC Contract**: All agent interactions must conform to `agent(name).ask<T>(prompt, schema)` returning strongly typed, runtime-validated JSON.
- **Dependency Graph Invariant**: The workflow graph $G = (V, E)$ must be a strict directed acyclic graph verified via Kahn's algorithm before any execution starts.

### 2.2 `typed-rpc-schemas.json`
Machine-readable JSON Schemas for standard agent RPC requests, responses, and structured error envelopes (`WorkflowError`, `SchemaValidationError`, `GateFailureError`).

### 2.3 `state-replay-invariants.md`
Mathematical formulation of durable state persistence:
$$\forall k \in [0, N], \quad \text{State}(k) = \text{Fold}(\text{Events}[0..k])$$
Defines the prefix-caching contract: when resuming execution from step $m > k$, cached outputs for steps $0..k$ are reused in **0 milliseconds** with **zero LLM tokens expended**.

### 2.4 `ui-presentation-spec.md`
Visual standards for ZCode Dynamic Workflow UI parity:
- Exact cubic Bézier formula for inter-step connectors:
  $$C(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3$$
- Visual indicators for role-based topology badges (`inspector`, `worker`, `reviewer`, `gate`, `coordinator`).
- Kanban board lifecycle states (`Discovered`, `In-Progress`, `Verified`, `Committed`).

---

## 3. Kiro Lifecycle Hooks Subsystem (`/.kiro/hooks/`)

Kiro provides native lifecycle event triggers that automate verification gates and guardrails:

| Hook Event | Purpose in AI-Workflow | Script Invoked | Behavior & Exit Code Semantics |
|---|---|---|---|
| `AgentSpawn` | Deterministic environment probing | `pre-workflow-gate` | Probes OS, Git, and sanitized env; injects into turn context |
| `PreToolUse` | Intercept dangerous tool executions | `pre-step-gate` | Intercepts `rm -rf`, raw disk writes, or unsanitized tokens (**exit code 2 blocks**) |
| `PostToolUse` | Append-only event stream audit | `post-step-audit` | Audits state transitions and flushes to `events.jsonl` |
| `Stop` | Enforce completion gates | `stop-workflow-gate` | Blocks session exit until all verification gates pass |

### `lifecycle.json` Configuration

The block below mirrors the shipped `.kiro/hooks/lifecycle.json` verbatim (Issue #49:
the example previously referenced a non-existent `pre-commit.js` — the real `Stop`
hook is `stop-workflow-gate.js`):

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "deterministic-env-probe",
      "event": "AgentSpawn",
      "command": "node .kiro/hooks/pre-workflow-gate.js",
      "timeout": 30,
      "enabled": true
    },
    {
      "name": "enforce-tool-gate",
      "event": "PreToolUse",
      "matcher": "execute_bash*",
      "command": "node .kiro/hooks/pre-step-gate.js",
      "timeout": 15,
      "enabled": true
    },
    {
      "name": "durable-journal-audit",
      "event": "PostToolUse",
      "matcher": "*",
      "command": "node .kiro/hooks/post-step-audit.js",
      "timeout": 15,
      "enabled": true
    },
    {
      "name": "workflow-completion-gate",
      "event": "Stop",
      "command": "node .kiro/hooks/stop-workflow-gate.js",
      "timeout": 30,
      "enabled": true
    }
  ]
}
```

---

## 4. Steering Guardrails Subsystem (`/.kiro/steering/`)

Steering documents use official YAML frontmatter (`inclusion: always`) to provide standing instructions to Kiro agents:

1. **`guidelines.md`**: Core engineering philosophy: "Code, not conversation", typed agent RPC contracts, and zero unvalidated string passing.
2. **`policy-guardrails.md`**: Security boundaries: prohibition of destructive shell syntax (`DROP DATABASE`, `rm -rf /`), strict sanitization of AWS and GitHub credentials, and sandbox isolation.
3. **`workflow-conventions.md`**: ZCode dynamic workflow design rules: pure functional step runners, deterministic shell gates, and Kahn's algorithm DAG validation.
4. **`bilingual-presentation.md`**: Localization standards: English code/identifiers with seamless EN/ZH dual-presentation in docs, CLI outputs, and UI visualizers.

---

## 5. Model Context Protocol (MCP) Integration (`/.kiro/mcp/`)

AI-Workflow exposes its capabilities to Kiro via `mcp-server.json`:

```json
{
  "mcpServers": {
    "ai-workflow-engine": {
      "command": "node",
      "args": ["dist/src/cli/index.js", "mcp", "serve"],
      "env": {
        "AI_WORKFLOW_ENV": "production"
      }
    }
  }
}
```

### Exposed MCP Tools

The served catalog is the full ten-tool face, locked to `TOOL_CATALOG` by the governance suite (Issue #118):

1. `workflow_run` *(legacy)*: Executes dynamic workflows by file path with persistent state and event logging.
2. `workflow_probe` *(legacy)*: Performs deterministic system, git, and toolchain probing with secret redaction.
3. `workflow_inspect` *(legacy)*: Inspects step checkpoints, events, and artifacts of a run from the SQLite store.
4. `workflow_replay` *(legacy)*: Replays or resumes a workflow run from failure with zero re-token spend.
5. `workflow_graph` *(legacy)*: Generates static DAG graph visualization without execution (HTML, Mermaid, or ASCII).
6. `workflow_script_check`: Compile-checks a facade script (strict TS against the workflow facade, purity bans, literal rules) and returns diagnostics, phases, and the site table — without executing anything.
7. `workflow_script_run`: Runs a facade script in the sandbox (deterministic journal; `--resume` replays completed nodes at zero provider calls).
8. `workflow_run_script`: Runs a facade script through the sandboxed engine and returns runId, final status, per-site summaries, and stats.
9. `workflow_inspect_run`: Inspects a facade-script run's journal — the status row, the per-site nodes table (redacted), and an evidence-ledger summary.
10. `workflow_get_run`: Fetches a run's journal short-circuit statistics — asks, replay hits, amend hits, divergences, and `world.run` executions.

---

## 6. Property-Based Testing (PBT) Subsystem (`/.kiro/pbt/`)

Using `fast-check`, the PBT suite (six property files under `.kiro/pbt/`) formally proves the core invariants with randomized iterations — per-property `numRuns` tuned by cost, ranging 8 (the heavyweight engine-invariant properties) to 3,000 (the credential-redaction differential):

```bash
npm run test:pbt
```

### The Formally Proven Invariants
1. **DAG Acyclicity & Topological Sort**: For any randomly generated workflow graph, Kahn's algorithm either returns a valid topological order or catches cycles with `CircularDependencyError`.
2. **Idempotent Replay**: Replaying an executed step prefix produces identical state to the original run without triggering secondary side-effects or re-spending model tokens.
3. **Typed RPC Contract Soundness**: For arbitrary JSON generated by `fc.jsonValue()`, `agent(name).ask<T>` either returns a valid instance of schema $T$ or a typed `SchemaValidationError`. It never throws untyped runtime exceptions.
4. **Monotonic Event Log Ordering**: Sequence numbers in `events.jsonl` are strictly monotonically increasing ($S_{i+1} > S_i$).
5. **Credential Redaction Invariance**: Injected strings containing AWS access keys (`AKIA[0-9A-Z]{16}`) or JWT tokens are strictly redacted to `***REDACTED***` in persisted logs.

---

## 7. Skeleton Crew Team Roster & Permissions (`/.kiro/crew/`)

Aligned with the **Skeleton Crew** theme, `crew/` establishes role-based multi-agent topologies and least-privilege capability ceilings:

### 7.1 Team Roster (`team.json`)
- **`inspector`**: System, git, toolchain, and telemetry environment prober (`workflow_probe` / `workflow_inspect` / `fs_read`).
- **`architect`**: Dynamic workflow DAG decomposition, schema design, and graph visualization (`workflow_graph` / `fs_read`).
- **`worker`**: Domain task executor for code migration, incident patching, and remediation (`workflow_run` / `fs_read` / `fs_write` / `edit_file`).
- **`reviewer`**: Code review auditor, schema compliance verifier, and safety inspector (`fs_read` / `diff_inspect` / `workflow_inspect`).
- **`gatekeeper`**: Deterministic shell gate executor, journal hash auditor, and test baseline verifier (`execute_gate_script` / `workflow_inspect` / `workflow_replay`).

### 7.2 Permission Ceilings (`permissions.json`)
- `inspector`: read-only filesystem scope; `execute_bash*` / `fs_write*` / `rm*` / `git_commit*` denied.
- `architect`: graph tooling + schema validation; filesystem scope limited to `./src`, `./apps`, `./.kiro`; network fetch denied.
- `worker`: sandboxed workspace write scoped to `./apps`, `./tests`, `./src`; `rm_rf*` / `format*` / `mkfs*` / `git_force_push*` denied.
- `reviewer`: read-only diff/AST access; `fs_write*` / `execute_bash*` / `network_fetch*` denied.
- `gatekeeper`: execution restricted to gate scripts plus journal audit/replay; `fs_write*` / `edit_file*` / `rm_rf*` denied.

---

## 8. Git Tracking Compliance

To satisfy Requirement R3, `/.kiro` is **explicitly tracked in Git**. The root `.gitignore` enforces this rule:

```gitignore
# DO NOT IGNORE .kiro! Tracked for AWS Kiroween 2026 Hackathon
!/.kiro/
!/.kiro/**

# Ignore only transient session logs and lockfiles
/.kiro/**/*.lock
/.kiro/**/*.tmp
/.kiro/logs/
```

Verify git tracking status at any time:
```bash
git status --porcelain .kiro/
```