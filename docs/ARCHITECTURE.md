# AI-Workflow Architecture & System Design

> **"Code, Not Conversation": Building Resilient, Typed, and Deterministic Multi-Agent Workflows**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew Category)*

---

## 1. Executive Summary & Philosophy

Modern agentic systems rely predominantly on conversational multi-agent loops—autonomous chat rooms where LLM agents pass free-form natural language messages back and forth. While conversational agents excel at open-ended brainstorming, they fail catastrophically when applied to mission-critical software engineering tasks such as infrastructure triage, automated refactoring, or compliance audits.

### The Failure Modes of Conversational Loops
1. **Context Compaction Amnesia**: As conversation length grows, token limits force lossy summarization. Intermediate execution parameters (e.g. database connection counts, Git SHA hashes) are silently dropped.
2. **Hallucinated Control Flow**: Natural language does not provide native branching, looping, or concurrency primitives. LLMs hallucinate completion states, skip verification steps, or loop indefinitely.
3. **Fragile String Parsing**: Passing unvalidated JSON or regex-parsed strings between agents causes cascading failures when models alter keys, inject markdown greetings, or omit closing delimiters.
4. **Non-Deterministic Resumption**: When an external network request fails in step 9 of a 10-step chat, the entire conversation must be restarted from step 1, re-spending thousands of tokens and risking different decisions.

### The ZCode Dynamic Workflow Alternative: "Code, Not Conversation"
**AI-Workflow** adopts the architectural paradigm of **ZCode Dynamic Workflows**:
- **Workflows are executable TypeScript programs**: Control flow, conditional branching, iteration, and parallel fan-outs (`Promise.all`) are governed by compiled code, not prompt steering.
- **Agents are typed RPC microservices**: Calling an agent is identical to invoking a typed remote procedure call: `agent(name).ask<T>(prompt, schema)`.
- **Deterministic environment probing**: Model generation is grounded by empirical system and repository telemetry rather than conversational guesses.
- **Dual-layer durable persistence**: Execution state is snapshotted into SQLite (WAL mode) and an append-only JSONL event stream, enabling zero-token prefix replay and resumability.
- **Visual timeline DAG with ZCode UI parity**: Every run generates an interactive standalone HTML/SVG timeline with cubic Bézier connectors, node status drawers, and real-time Kanban artifact boards.

---

## 2. Multi-Phase DAG Compiler & Execution Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Workflow Lifecycle                               │
└─────────────────────────────────────────────────────────────────────────────┘
  1. Define     ──►  2. Validate   ──►  3. Probe      ──►  4. Execute & Gate  ──►  5. Persist & Replay
  (Phases/Steps)     (Kahn's Acyclic)   (System/Git/Env)   (Agent RPC & Gates)    (WAL SQLite & JSONL)
```

### 2.1 Graph Formulation & Validation
A workflow is formulated as a directed acyclic graph $G = (V, E)$, where vertices $V$ represent discrete execution steps and directed edges $E = \{(u, v) \mid v \text{ depends on } u\}$ represent data or ordering dependencies.

Before executing any step, the compiler runs **Kahn's algorithm for topological sorting**:
1. Computes the in-degree $\text{deg}^-(v)$ for every step $v \in V$.
2. Enqueues all vertices with $\text{deg}^-(v) = 0$.
3. Successively dequeues vertices, reducing the in-degree of downstream dependents.
4. If the count of visited vertices is strictly less than $|V|$, the compiler immediately halts with `CircularDependencyError`, identifying the cycle.
5. If any step references an unknown dependency ID, the compiler halts with `MissingDependencyError`.

### 2.2 Phase Boundaries & Step Types
Steps are grouped into ordered **Phases** representing logical milestones:
- `probe`: Safe, read-only telemetry gathering.
- `agent`: Strongly typed LLM reasoning and code generation.
- `gate`: Deterministic cross-platform shell script verification.
- `fanout`: Concurrent execution of identical worker topologies over a partitioned dataset.
- `action`: State-modifying operations (file writes, Git commits, PR creation).

---

## 3. Typed Agent RPC Layer

The typed agent RPC layer abstracts LLM interactions behind strict runtime type contracts:

```typescript
export interface AgentRPCClient {
  readonly name: string;
  ask<T>(prompt: string, schema: z.ZodType<T>, options?: AgentCallOptions): Promise<T>;
}
```

### 3.1 Execution Pipeline
When `agent(name).ask<T>(prompt, schema)` is called:
1. **System Prompt Enforcement**: Injects a strict system boundary requiring pure JSON output matching schema $T$, explicitly prohibiting conversational chatter or markdown fences.
2. **Provider Dispatch**: Sends the payload to the registered LLM provider (Bedrock Claude 3.5 Sonnet, Claude 3.5 Haiku, or deterministic offline mock provider).
3. **Resilient JSON Extraction**: Extracts the JSON payload even if wrapped in markdown codeblocks (````json ... ````) or surrounded by leading/trailing text using greedy bracket scanning.
4. **Heuristic Syntax Repair**: If `JSON.parse` fails due to trailing commas, missing quotes on keys, or single quotes, the engine applies `repairJsonString()` before parsing.
5. **Runtime Zod Validation**: Evaluates `schema.safeParse(parsedJson)`.
   - If successful, returns typed data $T$.
   - If validation fails, enters the **Automated Schema Self-Repair Loop**.

### 3.2 Automated Schema Self-Repair Loop
Instead of crashing or yielding untyped errors, the RPC client automatically compiles Zod validation issues into a targeted error correction prompt:

```typescript
messages.push({ role: 'assistant', content: response.content });
messages.push({
  role: 'user',
  content: [
    'Your JSON response failed runtime schema validation with the following errors:',
    formatZodErrors(lastIssues),
    'Please correct these specific fields and return the updated JSON object.',
  ].join('\n'),
});
```

The model is given up to `maxRetries` (default: 3) opportunities to self-correct. If all retries fail, a structured `SchemaValidationError` is thrown, capturing the raw model output and the complete Zod issue list for offline inspection.

---

## 4. Deterministic Environment Prober

AI agents must never guess the execution environment. The `Prober` subsystem gathers ground truth before workflow execution:

```typescript
export interface ProberResult {
  timestamp: string;
  system: SystemProbe;
  git: GitProbe;
  toolchain: ToolchainProbe;
  env: Record<string, string>;
}
```

### Probed Dimensions
1. **System Telemetry**: OS platform (`win32`, `linux`, `darwin`), CPU architecture, core count, memory allocation (total and free MB), and system uptime.
2. **Git Ground Truth**: Repository root verification, current branch name, full commit SHA, short SHA, dirty file counts, and tracking remote URL.
3. **Toolchains**: Discovers and records binary versions for `node`, `npm`, `git`, `python`, `tsc`, and `docker`.
4. **Environment Sanitization & Credential Redaction**:
   - Matches keys against sensitive patterns (`key`, `token`, `secret`, `password`, `auth`, `credential`, `private`).
   - Matches values against credential regexes (JWT tokens `ey...`, AWS access keys `AKIA[0-9A-Z]{16}`, GitHub tokens `ghp_...`, and hex keys).
   - Sanitizes URI credentials (`https://user:password@host` $\to$ `https://***:***@host`).
   - Masks sensitive values strictly to `***REDACTED***`.

---

## 5. Dual-Layer Persistence & Zero-Token Replay Engine

### 5.1 Storage Architecture
AI-Workflow implements a dual-layer persistence model separating low-latency transactional checkpoints from append-only audit streams:

1. **Transactional SQLite Checkpoint Store (`node:sqlite`)**:
   - Configured with `PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;`.
   - Stores runs, step checkpoints (status, inputs, outputs, execution duration, token counts), and emitted artifacts.
   - Enables atomic single-step status lookups and fast indexing.
2. **Append-Only Event Stream (`events.jsonl`)**:
   - High-throughput, human-readable newline-delimited JSON log.
   - Emits events for every state transition: `workflow_start`, `step_start`, `agent_rpc_request`, `agent_rpc_response`, `gate_eval`, `step_complete`, `workflow_complete`.
   - Guarantees crash survivability even if an unhandled OS signal terminates the Node.js process.

### 5.2 Mathematical Formulation of Replay
State at step $k$ is a deterministic fold over prior events:
$$\text{State}(k) = \text{Fold}(\text{Events}[0..k])$$

When executing with `--resume-from-failed <runId>`:
1. The `ReplayEngine` inspects SQLite checkpoints for `runId`.
2. Steps are partitioned into:
   - $\text{Steps}_{\text{skip}} = \{v \in V \mid \text{Checkpoint}(v).\text{status} = \text{'completed'} \land \text{Order}(v) < \text{Order}(\text{firstFailedStep})\}$
   - $\text{Steps}_{\text{exec}} = \{v \in V \mid v \notin \text{Steps}_{\text{skip}}\}$
3. For all $v \in \text{Steps}_{\text{skip}}$, cached outputs are injected directly into `ExecutionContext` in **0 milliseconds** with **zero LLM tokens expended**.
4. Execution resumes exclusively starting at the failed step.

---

## 6. ZCode SVG Bézier Timeline Visualizer

Visual presentation parity with ZCode Dynamic Workflows is implemented in `dag/html-renderer.ts` and `dag/kanban.ts`.

### 6.1 Cubic Bézier Connectors
Edges between dependent steps are rendered on an SVG canvas as smooth cubic Bézier curves:
$$C(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3, \quad t \in [0, 1]$$

Where:
- $P_0 = (x_1, y_1)$ is the right anchor of the upstream step card: $(x_{\text{src}} + w_{\text{src}}, y_{\text{src}} + h_{\text{src}} / 2)$.
- $P_3 = (x_2, y_2)$ is the left anchor of the downstream step card: $(x_{\text{dst}}, y_{\text{dst}} + h_{\text{dst}} / 2)$.
- Horizontal control offset: $\Delta x = \max(0.5 \cdot |x_2 - x_1|, 40)$.
- Control points: $P_1 = (x_1 + \Delta x, y_1)$ and $P_2 = (x_2 - \Delta x, y_2)$.

```
   Upstream Card [P0] ────────╮
                              │ (Cubic Bézier)
                              ╰────────► Downstream Card [P3]
```

### 6.2 Interactive Canvas & Artifact Dashboard
- **Pan and Zoom**: Pure CSS/SVG matrix transforms with mousewheel and drag navigation.
- **Node Inspector Drawer**: Clicking any step opens a slide-out drawer rendering JSON inputs, outputs, runtime durations, agent roles, and error traces.
- **Live Kanban Dashboard (`artifacts/kanban.json`)**: Columnar board mirroring ZCode UI tracking artifacts across 4 lifecycle states: `Discovered`, `In-Progress`, `Verified`, `Committed`.
- **Multi-Format Export**: Generates standalone single-file HTML/SVG, Mermaid markdown diagrams, and terminal ASCII trees.

---

## 7. Model Context Protocol (MCP) Architecture

AI-Workflow integrates Anthropic's `@modelcontextprotocol/sdk` to bridge dynamic workflows with the emerging standard for LLM tooling:

### 7.1 MCP Client Capability
Dynamic workflows can discover and invoke tools hosted on external MCP servers:
```typescript
const result = await ctx.mcp?.callTool('aws-cloudwatch', 'query_metrics', {
  namespace: 'AWS/RDS',
  metric: 'DatabaseConnections',
});
```

### 7.2 Built-In MCP Server (`workflow mcp serve`)
The engine exposes its own core capabilities as an MCP server over `stdio`:
1. `workflow_run`: Executes dynamic workflows with persistent state.
2. `workflow_probe`: Performs deterministic environment and dependency probing.
3. `workflow_replay`: Resumes or replays historical executions.
4. `workflow_render_dag`: Compiles workflow graphs into standalone HTML/SVG.
5. `workflow_list_artifacts`: Queries live Kanban artifact states.