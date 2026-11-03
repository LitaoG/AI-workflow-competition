# Multi-Agent Development Workflow Investigation Report: `AI-workflow` Repository Survey

> **Core Findings Summary**: `AI-workflow` is a Node.js 22 LTS / TypeScript 5.6 dynamic workflow slash-command engine inspired by ZCode and an independent reference project, featuring typed agent RPCs, deterministic probing, and durable replay. Currently, **no `AGENT_GUIDELINES.md` or `docs/WORKFLOW.md` development workflow specifications exist** in this repository (existing `.kiro/` files only configure in-engine runtime agent roles). Adapting the proven 8-step lifecycle and discipline system from the reference project `Top Gainers List Model`—while replacing stock/trading-specific elements with Node/TypeScript/PBT/E2E deterministic gates and strict worktree isolation—is the optimal and urgently needed approach to govern multi-agent development here.

---

## 1. Observation

### 1.1 Repository Layout and Existing Files
Direct inspection of `${WORKSPACE_ROOT}\AI-workflow` via `list_dir` and tool queries revealed:
- **Root Directory**:
  - Configuration & Package: `package.json` (56 lines), `package-lock.json`, `tsconfig.json` (1030 bytes), `tsconfig.facade-test.json`.
  - Executable entrypoint: `bin/workflow.js` (CLI entry point).
  - Source code: `src/` (containing `agent/`, `cli/`, `compiler/`, `core/`, `dag/`, `dwf/`, `engine/`, `mcp/`, `prober/`, `runtime/`, `state/`, `index.ts`, `types.ts`).
  - Tests: `tests/` (containing `adversarial/`, `e2e/`, `integration/`, `unit/`).
  - Documentation: `README.md` (525 lines, bilingual EN/ZH), `the engine roadmap doc` (306 lines), `TEST_READY.md` (138 lines), `docs/` (`ARCHITECTURE.md`, `DEVELOPER_GUIDE.md`, `KIRO_INTEGRATION.md`, `i18n/`, `research/workflow-behavior-specification.md`).
  - Templates & Demos: `basic-workflow/`, `multi-agent-workflow/`, `demos/incident-triage-remediation/`, `demos/repo-migration-engine/`.
  - In-engine and metadata dirs: `.workflow/` (SQLite checkpoints `dwf.sqlite`, `runs.db`, and run logs), `.zcode/`, `.agents/`, `.git/`, `artifacts/`, `blog/`, `deliverables/`.
  - Empty directories: `scripts/` (currently empty).

### 1.2 Git Environment & Multi-Session Divergence
Running `git status`, `git branch -a`, `git remote -v`, and `git worktree list` observed:
```text
On branch feat/p1-amend-actors
Changes not staged for commit:
  modified:   artifacts/PULL_REQUEST.md
  modified:   artifacts/PostMortem.md
  modified:   artifacts/kanban.json
  modified:   demos/incident-triage-remediation/artifacts/PostMortem.md
  modified:   demos/incident-triage-remediation/artifacts/kanban.json
  modified:   demos/repo-migration-engine/artifacts/PULL_REQUEST.md
  modified:   demos/repo-migration-engine/artifacts/kanban.json
Untracked files:
  .agents/

Branches:
  feat/dwf-facade-engine
  feat/facade-script-p0
  feat/p0-4-demo-facade
* feat/p1-amend-actors
+ feat/process-supervision
  main
  refactor/engine-deep-overhaul

Worktrees:
  ${WORKSPACE_ROOT}/AI-workflow    081fb23 [feat/p1-amend-actors]
  ${WORKSPACE_ROOT}/AI-workflow-ps c11c57c [feat/process-supervision]

Remote origin: https://github.com/LitaoG/AI-workflow.git
GitHub CLI: Logged in to account LitaoG with full 'repo', 'workflow' scopes
```

### 1.3 Tech Stack, Dependencies, and Target Users
From `package.json` (lines 1-56):
- **Runtime**: Node.js `>=22.0.0` (active version verified: `v22.23.2`), ECMAScript Module (`"type": "module"`).
- **Core Dependencies**:
  - `@modelcontextprotocol/sdk`: `^1.0.4` (MCP client and server)
  - `commander`: `^12.1.0` (CLI argument parsing for `/workflow`)
  - `zod`: `^3.23.8` (runtime schema validation and typed agent RPC contracts)
  - `typescript`: `^5.6.3`
- **Dev Dependencies**:
  - `@types/node`: `^22.8.0`
  - `fast-check`: `^3.22.0` (Property-Based Testing)
- **Built-in Node Features Used**:
  - `node:test` (native test runner)
  - `node:sqlite` (native WAL checkpoint persistence)
  - `--experimental-strip-types` (native TypeScript execution without compilation overhead)
- **Purpose**: Dynamic workflow slash-command engine inspired by ZCode ("Code, not conversation"), an independent reference project (evidence provenance, process supervision), and Claude Dynamic Workflow.
- **Target Users**: DevOps/SRE engineers, software architects, and AI developers building mission-critical, typed, verifiable multi-agent automation pipelines.

### 1.4 Test Suite and Build Health Status
Direct execution of existing verification commands:
1. `node --experimental-strip-types tests/e2e/runner.ts`:
   - 121/121 tests passed (100% pass across 4 tiers: Feature Coverage 50/50, Boundaries 50/50, Combinations 15/15, Scenarios 6/6) in 38.8s.
2. `npm.cmd run test:pbt`:
   - 5/5 PBT invariant suites passed (DAG Acyclicity, Idempotent Replay, Schema Contract, Monotonic Event Logging, Credential Redaction).
3. `npm.cmd run test:unit`:
   - 60/60 tests passed.
4. `npm.cmd run build` (`tsc`):
   - Exited with code 1 on current branch `feat/p1-amend-actors`:
     `src/dwf/engine.ts(418,21): error TS2345: Argument of type '"dwf_amend_hit"' is not assignable to parameter of type 'WorkflowEventType'.`
     `src/dwf/engine.ts(421,19): error TS2345: Argument of type '"dwf_amend_diverged"' is not assignable to parameter of type 'WorkflowEventType'.`
   - *Cause*: Uncommitted branch work diverged on event types.
5. Windows PowerShell Execution Policy Observation:
   - Calling bare `npm` triggers PowerShell script restriction (`UnauthorizedAccess` on `npm.ps1`). Must use `npm.cmd`.

### 1.5 Verification of Existing Workflow & Agent Files in `AI-workflow`
- **Search for `AGENT_GUIDELINES.md`**: `find_by_name` returned **0 results**. There is NO `AGENT_GUIDELINES.md` in `AI-workflow`.
- **Search for `WORKFLOW.md`**: `find_by_name` returned **0 results**. There is NO `docs/WORKFLOW.md` in `AI-workflow`.
- **Search for `docs/README.md`**: Does not exist.
- **In-engine Agent Definitions (`.kiro/`)**:
  - `.kiro/crew/team.json`: Defines runtime execution roles (`inspector`, `architect`, `worker`, `reviewer`, `gatekeeper`) for the *dynamic workflow engine itself*, not for developer agents working on the codebase.
  - `.kiro/crew/permissions.json`: Least-privilege tool access ceilings for engine roles.
  - `.kiro/steering/guidelines.md` & `workflow-conventions.md`: Short guidelines (14-17 lines) specifying engine architectural principles ("Code, Not Conversation", typed RPC, durable persistence).
  - `.kiro/hooks/lifecycle.json` & `pre-commit.cmd`: Hook definitions for Kiro tool interceptors and a basic pre-commit script.

### 1.6 Reference Material Inspection: `Top Gainers List Model`
Inspection of `${WORKSPACE_ROOT}\Top Gainers List Model`:
- `AGENT_GUIDELINES.md` (521 lines):
  - §1.1 不确定先查文档（Docs first, code over docs, zero guessing）
  - §1.2 动手前查踩坑清单（`docs/LESSONS-LEARNED.md`）
  - §1.3 多使用子代理分工（总代理指挥，子代理专项执行与复核）
  - §1.4 最小改动 · 优先复用（常规档就地改/不新建/不夹带；重构档纯搬迁/行为零变更）
  - §1.5 及时清理中间产物与临时 worktree（用完即删，禁止污染桌面）
  - §1.6 假定用户会出错：当场指出（指出 ≠ 越权）
  - §1.9 证据驱动：重要结论必须可复核（`docs/AI-EVIDENCE-STANDARD.md`，三态标注，五态测试结果）
  - §1.10 先建 worktree 再动手：主仓不得编辑任何文件
  - §1.12 盯住自己开的 Issue/PR 评论（逐条甄别、不管对错都得回复）
  - *Trading-specific rules to EXCLUDE*: §1.7 (一切以赚钱为目标), §1.8 (实盘口径净战绩变化), §1.11 (交易逻辑观察票), and all `TRADING-*` docs.
- `docs/WORKFLOW.md` (754 lines):
  - Standard 8-step lifecycle:
    §0 不确定先查文档 → §1 立 Issue → §2 建分支+worktree → §3 实现约束 → §4 本机验证 → §5 提交 → §6 推送+开 PR → §7 等 CI+合入 → §8 清理（用完即删）
  - Machine gates and checklists for pre-merge validation.

---

## 2. Logic Chain

1. **Premise 1 (Existing State)**: As observed in Section 1.5, `AI-workflow` completely lacks a development workflow specification (`AGENT_GUIDELINES.md`, `docs/WORKFLOW.md`, `docs/README.md`, `docs/LESSONS-LEARNED.md`, `docs/AI-EVIDENCE-STANDARD.md`).
2. **Premise 2 (Observed Pain Points)**: As observed in Section 1.2 and 1.4, multiple AI agents working simultaneously across branches (`feat/p1-amend-actors`, `feat/process-supervision`, `refactor/engine-deep-overhaul`) have generated conflicting worktrees (`AI-workflow` and `AI-workflow-ps`), uncommitted dirty test artifacts, and TypeScript compiler errors without pre-flight gates.
3. **Premise 3 (Reference Model Feasibility)**: As observed in Section 1.6, `Top Gainers List Model` provides a battle-tested multi-agent development methodology with an 8-step lifecycle, worktree isolation, pre-merge gate checklists, evidence standards, and strict cleanup protocols.
4. **Premise 4 (Domain Adaptation Requirement)**: `ORIGINAL_REQUEST.md` explicitly mandates adapting the workflow to `AI-workflow` without copying trading-specific logic. `AI-workflow` is a TypeScript/Node 22 engine for dynamic workflows.
5. **Deduction**:
   - The multi-agent workflow for `AI-workflow` must adopt the core discipline framework from `Top Gainers List Model` (Docs-first, Worktree isolation, Minimal changes, Artifact cleanup, Subagent coordination, Evidence standard, Review responsiveness).
   - The mechanical gates must be customized specifically for `AI-workflow`:
     - Windows compatibility: `npm.cmd` instead of `npm`.
     - Static Gate: `npm.cmd run build` (`tsc`) or `npx tsc --noEmit`.
     - Invariant Gate: `npm.cmd run test:pbt` (fast-check property tests).
     - Unit/Integration Gate: `npm.cmd run test:unit`.
     - E2E Gate: `node --experimental-strip-types tests/e2e/runner.ts` (121 tests).
     - Git Cleanliness Gate: `git status --porcelain` to prevent leaving modified `artifacts/` or `demos/`.
   - Worktree isolation must strictly enforce creating worktrees outside the main repo (e.g. `${WORKSPACE_ROOT}\ai-workflow-<branch-short-name>`) from `origin/main`, without spaces in the path.

---

## 3. Caveats

1. **Active Branches**: Currently, `main` on local has 1 commit ahead of `origin/main`. When creating the worktree for `feat/dev-workflow`, the base should be `origin/main` (or local `main` if intended to build upon the latest commit).
2. **Dirty Working Directory**: The current working directory `${WORKSPACE_ROOT}\AI-workflow` on branch `feat/p1-amend-actors` has 7 modified files in `artifacts/` and `demos/`. Developing directly in this directory would violate isolation and risk mixing changes. A dedicated worktree (`feat/dev-workflow`) is strictly mandatory.
3. **PowerShell Execution Policy**: Windows restricts `npm.ps1`. All commands in `docs/WORKFLOW.md` and scripts must explicitly document `npm.cmd` or native `node` invocations.

---

## 4. Conclusion

The repository `AI-workflow` is in urgent need of a standardized, multi-agent development workflow. The proposed delivery should encompass:
1. **Root `AGENT_GUIDELINES.md`**: Core discipline rules (Docs First, AI Pitfalls, Subagent Orchestration, Minimal Change 2-tier system, Cleanup Invariants for temporary files & worktrees, User Error Correction, Evidence Verification Standard, Worktree Isolation, and Review Feedback Obligations).
2. **`docs/WORKFLOW.md`**: The 8-step standardized development lifecycle (§0 Docs-First → §1 Issue → §2 Worktree Isolation → §3 Implementation Constraints → §4 Local Machine Verification Gates → §5 Standardized Commit → §6 Push & PR → §7 CI/Review & Merge → §8 Post-Merge Cleanup).
3. **`docs/README.md`**: Authoritative documentation registry and anti-corruption index for `AI-workflow`.
4. **`docs/LESSONS-LEARNED.md`**: Known lessons learned ledger (e.g. `npm.cmd` vs `npm.ps1`, SQLite experimental warnings, AST sandbox isolation, worktree desktop accumulation).
5. **`docs/AI-EVIDENCE-STANDARD.md`**: Evidence levels (`[已验证]`, `[推断]`, `[未知]`), 5-state test reporting, and 5-class deliverable categorization.
6. **Isolated Implementation**: All files must be authored and verified in a new Git worktree (recommended branch: `feat/dev-workflow`), followed by pushing to `origin/feat/dev-workflow`.

---

## 5. Verification Method

To independently verify these findings:
1. **Inspect Layout & File Absence**:
   ```powershell
   # Confirm no AGENT_GUIDELINES.md or docs/WORKFLOW.md exists
   Test-Path "${WORKSPACE_ROOT}\AI-workflow\AGENT_GUIDELINES.md"           # Returns False
   Test-Path "${WORKSPACE_ROOT}\AI-workflow\docs\WORKFLOW.md"     # Returns False
   Test-Path "${WORKSPACE_ROOT}\AI-workflow\docs\README.md"       # Returns False
   ```
2. **Verify Git State & Worktrees**:
   ```powershell
   git status --short
   git worktree list
   git branch -a
   ```
3. **Verify Node & Test Toolchain**:
   ```powershell
   node -v                                                     # v22.23.2
   npm.cmd run test:pbt                                        # 5/5 pass
   node --experimental-strip-types tests/e2e/runner.ts         # 121/121 pass
   ```
