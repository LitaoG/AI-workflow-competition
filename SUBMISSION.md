# AI-Workflow — Submission Navigator

> **AWS Kiroween 2026 · Skeleton Crew category** (hosted by Kiro, on Devpost; team: Skeleton Crew
> — the team is deliberately named after the category it competes in)
> Submission deadline: **December 4, 2026, 2:00 PM PT** · Prize pool: **USD 100,000**
> Judged on: Potential Impact · Technological Implementation · Design · Innovation · Presentation
>
> **Working Application URL (Live Showcase)**: [https://litaog.github.io/AI-workflow-competition/](https://litaog.github.io/AI-workflow-competition/)  
> *(Single-page dark-theme interactive showcase: architecture SVG, four failure-mode fixes, cross-engine benchmark, reproducible quality fingerprints, and recorded demo output — zero installation required)*

This file is the judge-facing entry point: one-minute pitch → demo video → one-command
reproduction → repository map → compliance → Kiro usage guide.

---

## 1. The one-minute pitch

**AI-Workflow turns "agentic laziness, self-preferential bias, and goal drift" into compiled code.**
Instead of one agent hallucinating its way through a multi-step job, you write a TypeScript
**facade script**: control flow is real code, every side effect goes through a compile-checked
facade (`agent().ask<T>()`, `files`, `git`, `world.run`, `artifact`), the whole run is journalled,
and a re-run replays completed work at **zero provider calls**.

Three properties carry the whole design:

- **Code, not conversation.** Branching, loops and fan-outs are native TypeScript; the engine
  intercepts only facade calls. The worklist belongs to the script, so coverage is structural,
  not aspirational.
- **Deterministic zero-token replay.** `Date.now`, `Math.random` and `new Date()` fail at compile
  time *and* again in the sandbox realm, so relaunches replay byte-identically — iterating on a
  50-step workflow costs tokens only for the steps you actually changed.
- **Evidence over claims.** Every node carries `(siteId, ordinal, inputHash)`; the journal — not
  the model's word — is the source of truth.

The four conversational failure modes this fixes, structurally:

| Failure mode | Structural fix in AI-Workflow |
| --- | --- |
| **Agentic laziness** — the model skips work | The script owns the worklist: the migration demo scans `aws-sdk` imports with a journalled `files.grep`, then fans out a worker+reviewer pair per file |
| **Self-preferential bias** — the author grades its own work | Every transform is reviewed by a *different* agent; findings survive only if an independent verifier reproduces them |
| **Goal drift** — the plan erodes with context compaction | Each ask gets a fresh, narrow context with the goal restated; the plan lives in the script |
| **Cost drift** *(the fourth, ours)* — iterating re-bills everything | The journal replays completed work at zero provider calls |

The Skeleton Crew thesis: **one skeleton, two applications** — the same engine skeleton carries
two unrelated production domains (DevOps incident response; AWS SDK v2→v3 enterprise migration)
with zero shared demo logic. Write a new facade script in any domain and the skeleton carries it.

---

## 2. Demo video

> **⏳ Placeholder — to be backfilled after recording and uploading to YouTube: `[YouTube link]`**
> Length target: **under 3 minutes**, per the official submission requirements.

Planned recording recipe (already exercised end-to-end on this machine): record `bash scripts/demo.sh`
running its nine self-verifying acts, then open `.workflow/views/demo.html` (the journal-rendered
report) and finish with a live attach via
`node bin/workflow.js serve <runId> --db .workflow/demo-dwf.sqlite` → `http://127.0.0.1:4649/`
(the `--db` flag is required: the demo journals to `.workflow/demo-dwf.sqlite`, while the CLI's
default database path is `.workflow/dwf.sqlite`).

---

## 3. Reproduce the demo: one command, nine self-verifying acts

```bash
git clone https://github.com/LitaoG/AI-workflow-competition.git
cd AI-workflow-competition
npm install && npm run build
bash scripts/demo.sh        # or: npm run demo (Git Bash on Windows / Linux / macOS)
# Cross-platform alternative (pure Node, runs mock demo & opens Studio dashboard in browser):
node bin/workflow.js demo
```

Offline, deterministic, **no API keys** — the script exits non-zero if any act fails.
Measured end-to-end 2026-11-03 (Git Bash on Windows, Node v26.13.0, warm npm cache; fresh
`node_modules`/`dist`): **42 seconds**, exit 0, **`ALL NINE ACTS COMPLETE`**.

| Act | Capability | Evidence line |
| --- | --- | --- |
| 1 | strict compile + phase graph | `✔ facade script compiled clean (35 sites)` |
| 2 | sandbox run (incident demo) | `✔ run dwfrun-… completed` |
| 3 | **zero-token replay** | `⚡ replayed from journal: … (0 provider calls)` |
| 4 | migration demo | `asks: 8 (replayed from journal: 0)` → `result: {"migrated":3,…,"gates":"passed"}` |
| 5 | **amend lineage** | `♻ amended run reused` + `⑂ diverged (executing live)` |
| 6 | **hole growth** | `⏸ parked at hole` → `✔ hole filled; forked run completed` |
| 7 | **human escalation** | `dwfq-…` → `✔ run completed with the answer in hand` |
| 8 | **budget hard enforcement** | `WorkflowBudgetExceededError` caught by the script |
| 9 | journal-rendered report + live attach | `.workflow/views/demo.html` + `workflow serve <runId>` |

### Install reality check (npm)

This repository is **not published to npm** — the `ai-workflow` name on the registry is an unrelated 2021
placeholder (v0.1.19). Supported installs: from source (`git clone` + `npm install && npm run build`, the
three-minute judge path) or from a release tarball: `npm install ./ai-workflow-<version>.tgz` — keep the
`./` prefix (a bare relative path is parsed as a registry spec). Verified 2026-11-20 (Issue #147).

### Reproducible quality-gate fingerprints

All run 2026-11-21 on the v2.10.0 release tree (Issue #186 — main @ `36356d1` plus the release
overlay: package.json/package-lock version fields, the CHANGELOG 2.10.0 fold, this re-pin —
folding the §1.9 mechanical closure, the GitHub Pages showcase & the one-command demo entry),
Windows, Node v26.13.0, from a **fresh build**
(fresh-build numbers are what a judge clone reproduces; full context in
[README](README.md#reproducible-quality-gate-fingerprints)):

```text
npm test                                            → 851 tests, 848 pass, 3 skipped, 0 fail
npm run test:integration (serial)                   → 215 tests, 215 pass, 0 skipped, 0 fail
npm run test:pbt                                    →  18 tests,  18 pass, 0 fail
node --experimental-strip-types tests/e2e/runner.ts → 118/118 passed
npm run test:adversarial                            → 198 tests, 198 pass, 0 fail
npm run test:governance                             →  43 tests,  43 pass, 0 fail
bash scripts/demo.sh                                → exit 0, all nine acts OK
```

### Cross-engine benchmark (measured)

The identical facade mission script was also run against **both** the official ZCode
dynamic-workflow engine and ours, on the same scripted fake model (zero network, zero API keys).
Measured highlights (2 runs each, Windows, Node v26.13.0): mission wall time 167.271/155.256 ms
(official) vs 168.833/154.248 ms (ours); warm compile 51.072 vs **7.206 ms**; peak heapUsed
100.18 vs **40.54 MB**; peak RSS 235.88 vs **147.7 MB**; determinism holds on both sides
(byte-identical settle/event sequences; same normalized settle order across engines, 12 = 12).
Full analysis:
[`docs/research/BILATERAL-CROSS-BENCHMARK-REPORT.md`](docs/research/BILATERAL-CROSS-BENCHMARK-REPORT.md) ·
raw measurements: [`tests/cross-engine/results/`](tests/cross-engine/results/).

---

## 4. Repository map: one skeleton, two applications

**The skeleton** (engine + tooling — domain-agnostic, reused by every application):

| Path | Role |
| --- | --- |
| `src/dwf/` | Facade compiler (`compile.ts`, `schema-synth.ts`: strict TS in a virtual CompilerHost, AST authorization rules — purity bans, literal rules, closed world; `ask<T>` → JSON-Schema synthesis), sandboxed runtime (`runner.ts`: child process + `node:vm` realm, NDJSON IPC, process supervision), deterministic SQLite-WAL journal (`engine.ts`: `(runId, siteId, ordinal, inputHash)` replay, escalate/hole parking, amend lineage), human surface (`view.ts`, `live.ts`: journal-rendered HTML reports, live attach) |
| `bin/` | `workflow` CLI entry (`check`, `run-script`, `--resume/--amend`, `fill`, `answer`, `view`, `serve`, …) |
| `scripts/` | `demo.sh` (the nine-act self-verifying demo) and install/bootstrap helpers |
| `skills/` | `skills/ai-workflow/` — agent skill packaging |
| `.kiro/` | Fully git-tracked Kiro governance root — see §6 |
| `tests/` | Unit + integration, 118-case opaque-box E2E suite (fast-check PBT lives in [`.kiro/pbt/`](.kiro/pbt)) |

**The two applications** (independent facade scripts, pipelines and artifacts — zero shared demo
logic):

| Path | Application |
| --- | --- |
| `apps/incident-triage-remediation/` | P1 database connection pool exhaustion: 100/100 DB connections, 38.5% HTTP 500 spike → deterministic probe → typed triage → planner + independent safety reviewer → recovery gate → post-mortem report (3 scenarios; destructive commands intercepted; automated rollback) |
| `apps/repo-migration-engine/` | AWS SDK v2 → v3 migration (S3, DynamoDB, SQS): baseline test gate → AST/deprecation scan → parallel worker+reviewer fan-out per file → `tsc --noEmit && npm test` merge gate → publication-ready `PULL_REQUEST.md` |
| `apps/capabilities-tour/` | Reusable pattern library powering acts 5–8: amend lineage, hole growth, escalation, budget |

**Category compliance map** — the official Skeleton Crew requirement reads: *"Your repo must
contain 2 separate repo folders for the 2 separate applications."* This repository carries
exactly that:

| Official requirement | This repository |
| --- | --- |
| Repo folder for application #1 | [`apps/incident-triage-remediation/`](apps/incident-triage-remediation/) — self-contained repo folder: own `package.json`, `tsconfig.json`, README (EN / 中文), workflow sources, shell gates, scenarios and committed artifacts |
| Repo folder for application #2 | [`apps/repo-migration-engine/`](apps/repo-migration-engine/) — self-contained repo folder: own `package.json`, `tsconfig.json`, README (EN / 中文), workflow sources, MCP clients, fixtures, tests and committed artifacts |
| One reusable code foundation | the skeleton both import: `src/dwf/` compiler + sandbox + journal, `bin/` CLI, MCP server — zero shared demo logic between the two applications |

**Docs** — [README](README.md) (full feature/architecture tour) ·
[Quickstart (60-second tour)](QUICKSTART.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Integration guide](docs/INTEGRATION.md) ·
[Kiro integration](docs/KIRO_INTEGRATION.md) · [Showcase page](docs/showcase.html)
(single-file dark-theme product page: pitch, failure-mode fixes, architecture SVG, captured demo
output, evidence fingerprints — no build step).

---

## 5. Originality & clean-room compliance

1. **Original clean-room implementation.** The facade compiler, sandbox runtime, deterministic
   journal and view system are original work authored for this project. ZCode's dynamic-workflow
   model is cited as design inspiration only; no third-party proprietary code is incorporated.
2. **Apache-2.0 license.** The entire repository is distributed under the Apache License 2.0
   ([LICENSE](LICENSE)).
3. **Dependency supply chain.** All dependencies are version-pinned via `package-lock.json`. The
   one high advisory (GHSA-mrhx-c7xc-m3w5 in `zod` 3.25.76) is **fixed**: the runtime dependency
   pins `zod` 4.6.7 (the official fix version); `npm audit` now reports 4 moderate advisories,
   all in dev dependencies. Full compliance details: [README §Compliance](README.md#compliance).
4. **Zero private data leakage.** All demo scenarios, telemetry and fixtures are synthetic; every
   demo and test runs offline in mock mode with zero API keys; environment probing redacts
   credentials (`AKIA…`, JWTs → `***REDACTED***`, enforced by a PBT invariant). No private keys,
   credentials, proprietary sources or personal data are committed.

---

## 6. Kiro usage

AI-Workflow treats Kiro as a governance surface, not a chat window. The root [`.kiro/`](.kiro)
directory is **fully tracked in Git** and carries five subsystems — the complete guide is
[`docs/KIRO_INTEGRATION.md`](docs/KIRO_INTEGRATION.md):

- **Specs** (`.kiro/specs/`) — formal workflow-engine semantics: state machine, Kahn-algorithm DAG
  invariant, typed `agent(name).ask<T>(prompt, schema)` RPC contract, machine-readable JSON
  schemas, state-replay invariants (`State(k) = Fold(Events[0..k])`).
- **Hooks** (`.kiro/hooks/`) — lifecycle gates: `SessionStart` (deterministic environment probe),
  `PreToolUse` (destructive-command interception, exit-code-2 blocking), `PostToolUse`
  (append-only event-stream audit), `Stop` (no exit until verification gates pass).
- **Steering** (`.kiro/steering/`) — frontmatter (`inclusion: always`) guardrails: "code, not
  conversation" philosophy, security policy, workflow conventions, bilingual presentation.
- **MCP** (`.kiro/mcp/mcp-server.json`) — mounts the engine's MCP server over stdio with the full
  ten-tool face: five legacy tools (`workflow_run` / `probe` / `inspect` / `replay` / `graph`) plus
  five facade tools (`workflow_script_check` / `workflow_script_run` / `workflow_run_script` /
  `workflow_inspect_run` / `workflow_get_run`), locked to `TOOL_CATALOG` by the governance suite.
- **PBT** (`.kiro/pbt/`) — `fast-check` properties across six property files proving the core
  invariants (per-property `numRuns` tuned 8–3,000 by cost): DAG acyclicity, idempotent zero-token
  replay, typed-RPC soundness, monotonic event-log ordering, credential redaction, and more.

The namesake **Skeleton Crew roster** (`.kiro/crew/`): `inspector`, `architect`, `worker`,
`reviewer`, `gatekeeper` — with least-privilege permission ceilings per role.

### How Kiro was used to build this project

Kiro was not the chat window the work happened in — it was the contract the work had to satisfy.
Concretely, during development:

1. **Specs as the contract** (`.kiro/specs/`): the engine's semantics (state machine, Kahn-algorithm DAG
   invariant, the typed `agent(name).ask<T>(prompt, schema)` RPC contract, `State(k) =
   Fold(Events[0..k])` replay invariant) are written up as formal spec documents with
   machine-readable JSON schemas, and the implementation is tested against them
   (governance + PBT suites).
2. **Hooks as hard gates** (`.kiro/hooks/`): the `PreToolUse` hook blocks destructive shell
   syntax with Kiro's exit-code-2 deny protocol; `PostToolUse` SHA-256-hashes generated
   artifacts for append-only audit; the `Stop` hook refuses to end a session until verification
   gates pass — these handlers run for real (`node .kiro/hooks/*.js`, registered in
   `.kiro/hooks/lifecycle.json`), not as documentation.
3. **Steering as standing policy** (`.kiro/steering/`): `inclusion: always` guardrails — the
   "code, not conversation" philosophy, the security policy (destructive shell syntax banned,
   credentials sanitized) and bilingual presentation rules — injected into every session.
4. **MCP as the integration surface** (`.kiro/mcp/`): `.kiro/mcp/mcp-server.json` mounts the
   engine's MCP server over stdio (`workflow_run` / `probe` / `inspect` / `replay` / `graph`
   declared; the served catalog also includes `workflow_script_check` / `workflow_script_run`)
   — the same server surface ZCode consumes.
5. **PBT as proof, not vibes** (`.kiro/pbt/`): fast-check property suites (wired into
   `npm run test:pbt`) prove DAG acyclicity, idempotent zero-token replay, typed-RPC soundness,
   monotonic event ordering and credential redaction — 8–3,000 randomized cases per property
   (tuned per property).
