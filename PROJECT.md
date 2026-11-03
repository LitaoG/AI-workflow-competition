# Project: AI-workflow Multi-Agent Development Workflow Governance System

## Architecture
- **Governance Framework**: Two-tier governance: Root governance charter (mandatory session discipline & P0 red lines) + `docs/WORKFLOW.md` (standard 8-step engineering lifecycle).
- **Documentation Single Source of Truth**: `docs/README.md` index + anti-corruption lookup table.
- **Continuous Knowledge Accumulation**: append-only pitfall ledger doc with G1/G2/G3 gate thresholds.
- **Evidence-Driven Standard**: `docs/AI-EVIDENCE-STANDARD.md` (3-tier assertions, 5-state test outcomes, A/B/C/D/E deliverables).
- **Execution & Isolation Environment**: Physical Git Worktree isolation (`$WORKTREE_ROOT/feat-dev-workflow`) on branch `feat/dev-workflow`, keeping main tree unpolluted.
- **Mechanical Gates & Lock-in**:
  - `scripts/pr_review_gate.mjs`: CLI enforcement of review responses, 15-minute merge cooling period, test fingerprints.
  - `tests/unit/workflow-governance.test.ts`: Automated tests asserting governance rules, keywords, and worktree isolation invariants.
  - Toolchain integration: Node 22 / TypeScript / native `node:test` / `npm.cmd`.

## Feature Inventory
Every feature discovered during Survey is mapped to the implementation milestone:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Worktree Isolation Setup | Establish clean Git worktree at sibling directory for branch `feat/dev-workflow` | M1 | survey (R2) |
| 2 | Docs-First Consultation Rule | Invariant: Consult authoritative docs before modifying code/paths/configs | M1 | survey (Top Gainers §0) |
| 3 | Single Source of Truth & Anti-Corruption | Centralized doc index in `docs/README.md`, code > docs principle | M1 | survey (Top Gainers docs/README) |
| 4 | AI Pitfalls Ledger | Centralized, append-only pitfall ledger with G1/G2/G3 criteria | M1 | survey (Top Gainers §1.2) |
| 5 | Subagent Orchestration Discipline | Main orchestrator coordinates & checks; subagents handle dedicated scopes | M1 | survey (Top Gainers §1.3) |
| 6 | Minimal Change Two-Tier System | Regular tier: in-place modification; Refactor tier: zero-behavior change | M1 | survey (Top Gainers §1.4) |
| 7 | User Error Correction & Frankness | Assume users can err, point out contradictions politely with evidence | M1 | survey (Top Gainers §1.6) |
| 8 | Evidence-Driven Standards (3-tier) | Explicit tagging: [已验证], [推断], [未知]; stop after 3 consecutive failures | M1 | survey (Top Gainers §1.9) |
| 9 | Issue-Driven Task Initiation | Task scoping via Issue tracking, real numbers to avoid branch collision | M1 | survey (Top Gainers §1) |
| 10 | Git Worktree Physical Isolation Discipline | Never edit controlled files directly in main checkout | M1 | survey (Top Gainers §1.10) |
| 11 | Disposable External Workspace Cleanup | Worktrees and scratch dirs deleted when done ("用完即删") | M1 | survey (Top Gainers §1.5) |
| 12 | Pre-Merge Machine Verification Checklist | 5-tier test execution checklist (build, unit, PBT, E2E, status restore) | M1 | survey (Top Gainers §4) |
| 13 | PR Review Response Duty | Mandatory review comment check & 3-state resolution before merge | M1 | survey (Top Gainers §1.12) |
| 14 | PR Template & Zero-Placeholder Policy | Structured PR template requiring test fingerprints (`Ran N tests`) | M1 | survey (Top Gainers §5) |
| 15 | Merge Cooling Period & Review Gate | PR review gate script enforcing review feedback and cooling period | M1 | survey (Top Gainers pr_review_gate) |
| 16 | Rule Lock-in Automated Test Suite | Unit tests locking down governance terms and worktree isolation rules | M1 | survey (Top Gainers test_*.py) |
| 17 | Git Commit & Status Hygiene | Commit in worktree with Conventional Commits, clean worktree status | M1 | survey (R2) |
| 18 | Remote Push & Upstream Tracking | Push `feat/dev-workflow` to `origin/feat/dev-workflow` and verify | M1 | survey (R2) |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Multi-Agent Workflow Implementation, Worktree Isolation & Remote Push | Full delivery: Worktree setup (`feat/dev-workflow`), authoring the root governance charter, `docs/WORKFLOW.md`, `docs/README.md`, the pitfall ledger doc, `docs/AI-EVIDENCE-STANDARD.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `scripts/pr_review_gate.mjs`, `tests/unit/workflow-governance.test.ts`, running builds/tests, committing, pushing to `origin/feat/dev-workflow`, and gate verification | none | DONE |

### Milestone 1 Key Outputs
- **Worktree**: `$WORKTREE_ROOT/feat-dev-workflow` (branch `feat/dev-workflow`).
- **Commit**: `9de234a0d1b2e7bc46e5ddd6d75f1dacc2bba1ff` ("feat(workflow): establish standardized multi-agent development workflow and governance system").
- **Remote Push**: `origin/feat/dev-workflow` verified via `git ls-remote`.
- **Delivered Files (10 files, 1546 insertions)**:
  - the root governance charter
  - `docs/WORKFLOW.md`
  - `docs/README.md`
  - the pitfall ledger doc
  - `docs/AI-EVIDENCE-STANDARD.md`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `scripts/pr_review_gate.mjs` (+ `.d.ts`, `.d.mts`)
  - `tests/unit/workflow-governance.test.ts`
- **Gate Verdicts**:
  - `auditor_1`: CLEAN
  - `reviewer_1`: APPROVE
  - `reviewer_2`: APPROVE
  - `challenger_1`: APPROVE
  - `challenger_2`: APPROVE
- **Gate Result**: **PASS**

## Interface Contracts
### Main Repository ↔ Worktree
- Working directory: `$WORKTREE_ROOT/feat-dev-workflow`
- Branch: `feat/dev-workflow` (based on `main`)
- Remote upstream: `origin/feat/dev-workflow`
- No cross-pollution: main repo `$MAIN_REPO_ROOT` git status remained completely unpolluted (`Test-Path` on the root charter -> `False`).

### Developer Agents ↔ Governance Specifications
- Root governance charter: mandatory entrance guidelines for all developer agents.
- `docs/WORKFLOW.md`: 8-step lifecycle procedure:
  - Input: User requirement or issue
  - Process: §0 Docs-First → §1 Issue → §2 Worktree → §3 Minimal Change → §4 Local Gates → §5 Commit → §6 PR → §7 Review Gate → §8 Cleanup
  - Output: Verified, reviewed, cleanly merged feature with disposable worktree removed.

## Code Layout
```
$WORKTREE_ROOT/feat-dev-workflow/
├── governance charter                                # Root developer agent guidelines & P0 redlines
├── .github/
│   └── PULL_REQUEST_TEMPLATE.md             # PR template with test fingerprints & self-check
├── docs/
│   ├── WORKFLOW.md                          # 8-step standardized development lifecycle
│   ├── README.md                            # Single source of truth index & navigation
│   ├── pitfall ledger                       # Known AI pitfalls ledger (append-only)
│   └── AI-EVIDENCE-STANDARD.md              # 3-tier assertion & deliverable standards
├── scripts/
│   ├── pr_review_gate.mjs                   # PR review obligation and cooling period gate CLI
│   ├── pr_review_gate.d.ts                  # TypeScript definitions
│   └── pr_review_gate.d.mts                 # TypeScript ESM definitions
└── tests/
    └── unit/
        └── workflow-governance.test.ts      # Automated unit tests locking down governance rules
```
