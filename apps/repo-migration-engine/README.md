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
┌───────────────────────────┐    ┌───────────────────────┐      ┌───────────────────────────┐    ┌─────────────────────────────┐  │
│ [✔] step-1-baseline-gate  │───►│ [✔] step-2a-ast-scan  │──┬──►│ [✔] step-3a-worker-s3     │───►│ [✔] step-3a-reviewer-s3     │──┐
│     (npm test)            │    │ [✔] step-2b-architect │  │   │     (S3Client v3 Diff)    │    │ (Safety Audit: 0.98)        │  │
└───────────────────────────┘    └───────────────────────┘  │   └───────────────────────────┘    └─────────────────────────────┘  │
                                                            │   ┌───────────────────────────┐    ┌─────────────────────────────┐  │
                                                            ├──►│ [✔] step-3b-worker-dynamo │───►│ [✔] step-3b-reviewer-dynamo │──┼──┐
                                                            │   │     (LibDynamoDB Diff)    │    │ (Safety Audit: 0.96)        │  │  │
                                                            │   └───────────────────────────┘    └─────────────────────────────┘  │  │
                                                            │   ┌───────────────────────────┐    ┌─────────────────────────────┐  │  │
                                                            └──►│ [✔] step-3c-worker-sqs    │───►│ [✔] step-3c-reviewer-sqs    │──┘  │
                                                                │     (SQSClient v3 Diff)   │    │ (Safety Audit: 0.97)        │     │
                                                                └───────────────────────────┘    └─────────────────────────────┘     │
                                                                                                                                     │
Phase 4: Compiler & Merge Gate                            Phase 5: Release Synthesis                                                 │
┌──────────────────────────────────────────────────┐      ┌────────────────────────────────────────────────────────┐                 │
│ [✔] step-4-post-merge-gate                       │◄─────┴────────────────────────────────────────────────────────┘                 │
│     (tsc --noEmit && npm test on migrated code)  │                                                                                 │
└──────────────────────────────────────────────────┘                                                                                 │
                         │                                                                                                           │
                         ▼                                                                                                           │
┌──────────────────────────────────────────────────┐                                                                                 │
│ [✔] step-5-summary                               │◄─────────────────────────────────────────────────────────────────────────────────┘
│     (Export PULL_REQUEST.md & kanban.json)       │
└──────────────────────────────────────────────────┘
```

---

## ⚡ Quickstart Commands

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

> **ℹ️ Demo Integrity Note · 模拟迁移演示口径**
> This is an **offline mock-agent demo against the committed fixture app**
> (`fixtures/legacy-aws-sdk-app`): the migration transforms are deterministic engine
> substitutions — the `transformedCode` each worker produces and the gate logs quoted in
> [`artifacts/PULL_REQUEST.md`](artifacts/PULL_REQUEST.md) are real engine outputs of this
> run — but **no fixture or repository source file is ever migrated on disk** (the facade
> edition, `facade.workflow.ts`, writes no files at all). The §5 Diff Statistics in that
> artifact are **measured from the fixture's source on disk vs the transformed output of
> the same run** ("measured, not synthesized" — stated in the artifact itself), and the §4
> gate output is the real mock-mode `GateRunner` execution log of the fixture's own unit
> tests. As with Demo 1 (Issue #181), [`apps/repo-migration-engine/artifacts/`](artifacts)
> preserves this app's standalone run (mock-mode run `run-1795227449381-9yo5s2`,
> 2026-11-21) while the repo-root
> [`artifacts/repo-migration/`](../../artifacts/repo-migration) holds the latest outputs
> of a repo-root demo run — two runs, not drift.
