# Multi-Agent Repository Migration & Breaking API Upgrade Engine (Demo 2)

> **Flagship Demo Application for AI-Workflow**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew Category)*

---

## 🚀 Overview

Upgrading foundational libraries across an enterprise codebase (e.g., migrating AWS SDK v2 to v3, Express to Hono, or CommonJS to ESM) is one of the most tedious and error-prone challenges in software engineering. Monolithic upgrades fail with conversational AI because:
1. Large codebases exceed token limits.
2. Unhandled network drops or crashes lose 100% of progress, requiring expensive re-tokenization.
3. Conversational agents hallucinate method names without compiler feedback.

**AI-Workflow Demo 2** solves this via **"Code, not conversation"**:
- **Durable Event Journaling & Zero-Token Resumption**: Every migrated file is committed to `.workflow/journal.jsonl` and SQLite snapshot store. If interrupted, it resumes instantly from the exact failing step without re-spending tokens.
- **Parallel Fan-Out Workers + Paired Reviewers**: Migrates multiple modules concurrently via `Promise.all` with independent safety review pairs.
- **Deterministic Compiler Gates**: Validates changes using real `tsc --noEmit` and `npm test` cross-platform shell script gates.
- **ZCode UI Parity**: Renders an interactive SVG timeline DAG with Bézier curves and live Kanban dashboard.

---

## 📊 Visual Architecture & Multi-Agent Topology

```
===================================================================================================================
 [AI-WORKFLOW] 5 phases · 4 subagents active | Stage 3: Parallel Fan-Out Migration & Paired Review ⏳
===================================================================================================================

Phase 1: Baseline Gate        Phase 2: Architecture        Phase 3: Parallel Fan-Out Workers & Paired Reviewers
┌───────────────────────┐    ┌─────────────────────┐      ┌─────────────────────────┐    ┌────────────────────────┐
│ [✔] step-1-baseline   │───►│ [✔] step-2-architect│──┬──►│ [✔] step-3a-worker-s3   │───►│ [✔] step-3a-review-s3  │──┐
│     (npm test)        │    │ (Scan AST & MCP)    │  │   │     (S3Client v3 Diff)  │    │ (Safety Audit: 0.98)   │  │
└───────────────────────┘    └─────────────────────┘  │   └─────────────────────────┘    └────────────────────────┘  │
                                                      │   ┌─────────────────────────┐    ┌────────────────────────┐  │
                                                      ├──►│ [✔] step-3b-worker-ddb  │───►│ [✔] step-3b-review-ddb │──┼──┐
                                                      │   │     (LibDynamoDB Diff)  │    │ (Safety Audit: 0.96)   │  │  │
                                                      │   └─────────────────────────┘    └────────────────────────┘  │  │
                                                      │   ┌─────────────────────────┐    ┌────────────────────────┐  │  │
                                                      └──►│ [✔] step-3c-worker-sqs  │───►│ [✔] step-3c-review-sqs │──┘  │
                                                          │     (SQSClient v3 Diff) │    │ (Safety Audit: 0.97)   │     │
                                                          └─────────────────────────┘    └────────────────────────┘     │
                                                                                                                        │
Phase 4: Compiler & Merge Gate                            Phase 5: Release Synthesis                                   │
┌──────────────────────────────────────────────────┐      ┌────────────────────────────────────────────────────────┐   │
│ [✔] step-4-post-merge-gate                       │◄─────┴────────────────────────────────────────────────────────┘   │
│     (tsc --noEmit && npm test on migrated code)  │                                                                   │
└──────────────────────────────────────────────────┘                                                                   │
                         │                                                                                             │
                         ▼                                                                                             │
┌──────────────────────────────────────────────────┐                                                                   │
│ [✔] step-5-summary                               │◄──────────────────────────────────────────────────────────────────┘
│     (Export PULL_REQUEST.md & kanban.json)       │
└──────────────────────────────────────────────────┘
```

---

## ⚡ Quickstart Commands

### 0. Run Facade Script Edition (Recommended)
```bash
# Run complete 5-phase migration workflow with durable event journaling (<4s)
node bin/workflow.js run apps/repo-migration-engine/facade.workflow.ts --cwd apps/repo-migration-engine --approve-cmd node

# Resume completed run at zero token spend:
node bin/workflow.js run apps/repo-migration-engine/facade.workflow.ts --cwd apps/repo-migration-engine --approve-cmd node --resume <runId>
```

> **Windows PowerShell note**: Use `--approve-cmd node` to pre-authorize the sandboxed node command for verification steps (Issue #127 security policy). When passing structured script arguments, prefer `--set key=value` or `--args-file <path>` to bypass PowerShell JSON escaping quirks.

### 1. Run Complete Migration in Offline Mock Mode (<4s)
```bash
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock
```

### 2. Run with Chinese Localization (`--lang zh`)
```bash
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --lang zh
```

### 3. Walkthrough: Zero-Token Durable Resumption
```bash
# Step 1: Simulate network drop after migrating 2 of 3 files
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --interrupt-at 2 --output-dir .workflow/runs/run-demo-resume

# Step 2: Resume workflow using --resume-from-failed
# The engine inspects checkpoints.db, skips files 1 & 2 in 0ms (zero tokens spent),
# converts file 3, and runs compiler gates to completion!
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --resume-from-failed run-demo-resume
```

### 4. Instant Historical Replay (<1s)
```bash
node bin/workflow.js replay run-demo-resume
```

### 5. Run Automated Integration Test Suite (<4s)
```bash
node --experimental-strip-types tests/integration/demo-migration.test.ts
```

---

## 📦 Generated Artifacts & Deliverables

Every workflow run generates verifiable artifacts in `artifacts/`:
1. **`artifacts/PULL_REQUEST.md`**: Publication-ready pull request summary with breaking changes table and rollback runbook.
2. **`artifacts/migration_dag.html`**: Standalone SVG timeline DAG with Bézier curved lines, checkmarks, pan/zoom, and node inspector.
3. **`artifacts/kanban.json`**: 5-column live Kanban dashboard tracking deprecation scans, plans, patches, gates, and deliverables.
4. **`checkpoints.db` & `events.jsonl`**: Durable persistence backing instant zero-token resumption.

> **Verification & Sandbox Isolation**
> Transformed code is written to `.workflow/sandbox/` where it undergoes realistic compiler
> diagnostics and syntax verification prior to post-merge test gating. Repository source fixtures
> remain pristine while pull request deliverables report measured diff statistics directly
> extracted from the sandboxed code transformations.
>
> As with Demo 1 (Issue #181), [`apps/repo-migration-engine/artifacts/`](artifacts) preserves
> this app's standalone run (mock-mode run `run-1795232389468-z6avzz`, 2026-11-21), while the
> repo-root [`artifacts/repo-migration/`](../../artifacts/repo-migration) holds the latest
> outputs of a repo-root demo run — expect different `runId`/timestamps between the two layers;
> that is two runs, not drift.
