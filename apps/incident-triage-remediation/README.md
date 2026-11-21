# Autonomous DevOps Incident Triage & Automated Remediation (Demo 1)

> **Flagship Demo Application for AI-Workflow**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew Category)*

---

## 🚀 Overview

Modern cloud microservices face frequent P1/P2 production incidents—such as database connection exhaustion, crash-looping code regressions, or memory leaks. In traditional organizations, on-call engineers manually query metrics, inspect logs, scramble through Git commit diffs, and execute runbooks under extreme stress. Human error during high-severity outages often worsens the blast radius (e.g., executing accidental destructive commands).

**AI-Workflow Demo 1** is an industrial-grade, autonomous incident response engine built on the principle **"Code, not conversation"**. Rather than relying on unreliable natural language chat loops, Demo 1 treats multi-agent incident response as a **strongly typed imperative execution pipeline** with deterministic environment probing, paired planner-reviewer safety audits, and deterministic shell gates.

---

## 📊 Visual Architecture & Multi-Agent Topology

The workflow executes across **5 distinct phases** with **ZCode UI Parity**:

```
=====================================================================================================
 AI-Workflow: incident-triage-remediation (Run: run-1795232387944-9cqkig)
 Status: 5 phases · 3 active subagents
=====================================================================================================

┌── Phase 1: Detection & Telemetry Probing ──────────────────────────┐
│  └── [✔] ⚡ Gate: Deterministic Metric & Git Diff Probe (42ms)       │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── Phase 2: Triage & Root Cause Analysis ───────────────────────────┐
│  └── [✔] 🤖 Inspector: IncidentInspectorAgent (120ms)               │
│          Diagnosed: P1 DATABASE_EXHAUSTION (Confidence: 0.98)       │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── Phase 3: Remediation Synthesis & Safety Review ──────────────────┐
│  ├── [✔] 🤖 Worker: RemediationPlannerAgent (140ms)                │
│  │       Strategy: EXPAND_CONNECTION_POOL (3 Actions Generated)     │
│  └── [✔] 🛡️ Reviewer: SafetyReviewerAgent (95ms)                   │
│          Audit: PASSED (Score: 0.98, Destructive Patterns: NONE)    │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── Phase 4: Execution & Verification Gate ──────────────────────────┐
│  └── [✔] ⚡ Gate: Deterministic Recovery Healthcheck Gate (35ms)    │
│          Verification: HTTP/1.1 200 OK, Error Rate: 0.02%           │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── Phase 5: Post-Mortem Synthesis & Live Dashboard Export ──────────┐
│  └── [✔] 📦 Coordinator: PostMortemSynthesizer (110ms)             │
│       Exported: artifacts/incident-triage/{PostMortem.md, kanban.json, …} │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🧪 Realistic Incident Scenarios

Demo 1 includes 3 realistic production scenarios defined in `scenarios/`:

| Scenario ID | Severity | Root Cause | Simulated Anomaly | Automated Resolution |
| :--- | :---: | :--- | :--- | :--- |
| `p1_db_pool_exhaustion` | **P1** | Connection pool saturated | 100/100 DB connections, 38.5% HTTP 500 spike | `EXPAND_CONNECTION_POOL` (Scales pool to 250 & restarts pods) |
| `p1_bad_deploy_regression`| **P1** | Null pointer in checkout | 65.4% HTTP 500 spike after release v2.4.12 | `GIT_ROLLBACK` (Rolls back deployment and reverts commit) |
| `p2_high_latency_leak` | **P2** | Unbounded LRU query cache | 96.8% heap consumption, 3.2s GC pauses, P99: 4.2s | `RESTART_PODS` & scale replicas to 12 |

---

## ⚡ Quickstart: Running the Demo

### 0. Run Facade Script Edition (Recommended)
```bash
# Run complete 5-phase incident triage workflow with durable journaling (<2s)
node bin/workflow.js run apps/incident-triage-remediation/facade.workflow.ts \
  --cwd apps/incident-triage-remediation --approve-cmd node --args '{"scenario":"p1_db_pool_exhaustion"}'

# Replay completed run at zero token spend:
node bin/workflow.js run apps/incident-triage-remediation/facade.workflow.ts \
  --cwd apps/incident-triage-remediation --approve-cmd node --args '{"scenario":"p1_db_pool_exhaustion"}' --resume <runId>
```

> **Windows PowerShell note**: In PowerShell, single quotes around JSON strings in `--args` may require escaping (e.g. `--args '{\"scenario\":\"p1_db_pool_exhaustion\"}'`), or prefer `--set scenario=p1_db_pool_exhaustion` or `--args-file <path>` which bypass shell escaping entirely. Pre-authorizing `node` via `--approve-cmd node` is required for verification gates under the Issue #127 security policy.

### 1. Run Default Scenario in Offline Mock Mode (<2s)
```bash
# Using the /workflow slash-command CLI
node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock
```

### 2. Run with Specific Scenario
```bash
# On Linux / macOS
SCENARIO=p1_bad_deploy_regression node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock

# On Windows PowerShell
$env:SCENARIO="p1_bad_deploy_regression"; node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock
```

### 3. Run with Chinese Localization (`--lang zh`)
```bash
node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock --lang zh
```

### 4. Run Automated Integration Test Suite (<4s)
```bash
node --experimental-strip-types tests/integration/demo-incident.test.ts
```

---

## 📦 Generated Artifacts & Deliverables

Every workflow run emits verifiable artifacts to `artifacts/` (and `.workflow/runs/<runId>/`):

> Two layers of demo evidence exist by design (Issue #181): this app's own
> [`apps/incident-triage-remediation/artifacts/`](artifacts) preserves its standalone run
> (mock-mode run `run-1795232387944-9cqkig`, 2026-11-21), while the repo-root
> [`artifacts/incident-triage/`](../../artifacts/incident-triage) holds the latest outputs
> of a repo-root demo run — expect different `runId`/timestamps between the two layers;
> that is two runs, not drift.

1. **`artifacts/incident_dag.html`**: Standalone interactive SVG timeline DAG with cubic Bézier curves, status checkmarks, pan/zoom canvas, and click-to-inspect side drawer.
2. **`artifacts/kanban.json`**: Real-time 5-column Kanban board mirroring ZCode UI parity.
3. **`artifacts/PostMortem.md`**: Formal DevOps post-mortem report complete with executive summary, timeline, 5-Whys RCA, telemetry comparison table, and preventative action items.
4. **`checkpoints.db`**: SQLite database recording step state snapshots for deterministic resumption.
5. **`events.jsonl`**: Append-only event stream recording all lifecycle events.

---

## 🛡️ Kiro Safety Guardrails

Safety policies are enforced at multiple levels:
- **Semantic Paired Review**: `SafetyReviewerAgent` audits all planned commands before execution.
- **Deterministic Steering Gates**: Proposed commands matching destructive patterns (`DROP`, `TRUNCATE`, `rm -rf`, `DELETE without WHERE`) are automatically intercepted and rejected with a `GateFailureError`.
- **Automated Rollback**: If the Phase 4 verification gate fails, `action.rollbackCommand` executes immediately, restoring previous system state.

> Both deterministic guardrails are enforced equally in the facade-script edition
> (`facade.workflow.ts` — the one `scripts/demo.sh` and `workflow demo` actually run): after
> the safety review approves, every model-contributed command (the plan's steps and the
> recommended action) is re-screened in pure code against the destructive blacklist
> (`DROP`, `TRUNCATE`, `rm -rf`, `mkfs`, `format C:`, `DELETE FROM`) — a hit aborts the run
> before anything executes, and an interception self-check (a reference `DROP TABLE`
> command) is evidenced on every run. The remediation applies reversible actions whose
> `undo` runs automatically — a rollback drill (failing probe → undo → prior state
> restored) is evidenced on every run, and a genuinely failed Phase 4 verification gate
> triggers the same rollback before the run fails.
