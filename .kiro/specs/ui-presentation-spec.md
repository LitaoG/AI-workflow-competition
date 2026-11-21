# Specification: ZCode Dynamic Workflow UI Parity

## 1. Multi-Phase Timeline DAG Visualizer
The dynamic workflow visualizer generates an interactive multi-phase graph matching ZCode execution UI parity:
- **Phases**: Rendered as distinct columns with header badge `Phase N: <Name>`, status checkmark, and active pulse.
- **Curved Bézier Connectors**: Dependency edges between upstream step outputs and downstream step inputs are rendered as cubic Bézier curves:
  $$B(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3$$
  Where $P_0 = (x_1, y_1)$, $P_1 = (x_1 + \Delta x / 2, y_1)$, $P_2 = (x_2 - \Delta x / 2, y_2)$, and $P_3 = (x_2, y_2)$.
- **Status Colors**:
  - Green (`#10b981`): Completed step and verified edge
  - Blue (`#3b82f6`): Active running step (with animated pulse CSS)
  - Red (`#ef4444`): Failed step or blocked gate
  - Gray (`#6b7280`): Pending step

## 2. Role-Based Agent Topologies
Nodes visually display role badges:
- `inspector`: Single inspector agent (e.g. "盘点员 / Inspector")
- `worker`: Parallel fan-out worker pool (e.g. "分诊员-1..5 / Triage Agents 1-5" via `Promise.all`)
- `reviewer`: Paired reviewer agent (e.g. "审查员 / Reviewer")
- `gate`: Deterministic shell script gate (e.g. "测试基线门 / Test Baseline Gate")
- `coordinator`: Merge coordinator (e.g. "合入库管理员 / Merge Coordinator")

## 3. Live Metrics & Artifact Kanban Dashboard
- **Header Badge**: Dynamic, rendered from the live graph (`src/dag/html-renderer.ts`): `${graph.totalPhases} phases · ${graph.activeSubagents} subagents active` — both flagship demos run **5 phases** (incident: 3 active subagents; migration: 4).
- **Live Kanban**: 5 columns per app, mirroring the `kanban.json` artifact column schema (each card carries a SHA-256 fingerprint):
  - Incident triage (`apps/incident-triage-remediation`): `probe` (Ingested Alerts & Probes) → `triage` (Triage & Root Cause Analysis) → `plan` (Synthesized Runbooks & Safety Audit) → `gate` (Execution & Gate Logs) → `deliverable` (Final Deliverables).
  - Repo migration (`apps/repo-migration-engine`): `baseline-scan` (Deprecation & AST Scans) → `architecture` (Migration Architecture & MCP Rules) → `parallel-transforms` (Parallel Workers & Paired Reviewers) → `post-merge-gate` (Compiler & Test Gate Audits) → `release-pr` (Pull Request & Final Deliverables).
- **Bilingual Switch**: Instantaneous toggle between English and Chinese (`EN` / `中文`) across all node titles, descriptions, and metrics.
