# AI-Workflow — Submission Navigator

> **AWS Kiroween 2026 · Skeleton Crew category** (hosted by Kiro, on Devpost; team: Skeleton Crew
> — the team is deliberately named after the category it competes in)
> Submission deadline: **December 4, 2026, 2:00 PM PT** · Prize pool: **USD 100,000**
> Judged on: Potential Impact · Technological Implementation · Design · Innovation · Presentation

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
git clone https://github.com/LitaoG/AI-workflow.git
cd AI-workflow
npm install && npm run build
bash scripts/demo.sh
```

Offline, deterministic, **no API keys** — the script exits non-zero if any act fails.
Measured end-to-end 2026-11-03 (Git Bash on Windows, Node v26.13.0, warm npm cache; fresh
`node_modules`/`dist`): **42 seconds**, exit 0, **`ALL NINE ACTS COMPLETE`**.

| Act | Capability | Evidence line |
| --- | --- | --- |
| 1 | strict compile + phase graph | `✔ facade script compiled clean (28 sites)` |
| 2 | sandbox run (incident demo) | `✔ run dwfrun-… completed` |
| 3 | **zero-token replay** | `⚡ replayed from journal: … (0 provider calls)` |
| 4 | migration demo | `asks: 8 (replayed from journal: 0)` → `result: {"migrated":3,…,"gates":"passed"}` |
| 5 | **amend lineage** | `♻ amended run reused` + `⑂ diverged (executing live)` |
| 6 | **hole growth** | `⏸ parked at hole` → `✔ hole filled; forked run completed` |
| 7 | **human escalation** | `dwfq-…` → `✔ run completed with the answer in hand` |
| 8 | **budget hard enforcement** | `WorkflowBudgetExceededError` caught by the script |
| 9 | journal-rendered report + live attach | `.workflow/views/demo.html` + `workflow serve <runId>` |

### Reproducible quality-gate fingerprints

All run 2026-11-14, Node v26.13.0 (aligned with README for the 2.2.0 release — upstream
feature sync: affectUI visual system, `[wf]` progress channel, research corpus):

```text
npm test                                            → 744 tests, 744 pass, 0 fail
npm run test:pbt                                    →  16 tests,  16 pass, 0 fail
node --experimental-strip-types tests/e2e/runner.ts → 118/118 passed
npm run test:adversarial                            → 158 tests, 158 pass, 0 fail
npm run test:governance                             →  34 tests,  34 pass, 0 fail
bash scripts/demo.sh                                → exit 0, all nine acts OK
```

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
| `tests/` | Unit + integration, fast-check PBT, 118-case opaque-box E2E suite |

**The two applications** (independent facade scripts, pipelines and artifacts — zero shared demo
logic):

| Path | Application |
| --- | --- |
| `demos/incident-triage-remediation/` | P1 database connection pool exhaustion: 100/100 DB connections, 38.5% HTTP 500 spike → deterministic probe → typed triage → planner + independent safety reviewer → recovery gate → post-mortem report (3 scenarios; destructive commands intercepted; automated rollback) |
| `demos/repo-migration-engine/` | AWS SDK v2 → v3 migration (S3, DynamoDB, SQS): baseline test gate → AST/deprecation scan → parallel worker+reviewer fan-out per file → `tsc --noEmit && npm test` merge gate → publication-ready `PULL_REQUEST.md` |
| `demos/capabilities-tour/` | Reusable pattern library powering acts 5–8: amend lineage, hole growth, escalation, budget |

**Docs** — [README](README.md) (full feature/architecture tour) ·
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
3. **Dependency supply chain.** All dependencies are version-pinned via `package-lock.json`. At
   submission time `npm audit` reports 5 known advisories: 4 moderate, all in dev dependencies,
   and 1 high in the runtime dependency `zod` 3.25.76 (GHSA-mrhx-c7xc-m3w5; the official fix,
   `zod@4.6.7`, is a breaking major-version upgrade). The zod@4 migration is scheduled for the
   next release.
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
- **Hooks** (`.kiro/hooks/`) — lifecycle gates: `AgentSpawn` (deterministic environment probe),
  `PreToolUse` (destructive-command interception, exit-code-2 blocking), `PostToolUse`
  (append-only event-stream audit), `Stop` (no exit until verification gates pass).
- **Steering** (`.kiro/steering/`) — frontmatter (`inclusion: always`) guardrails: "code, not
  conversation" philosophy, security policy, workflow conventions, bilingual presentation.
- **MCP** (`.kiro/mcp/mcp-server.json`) — exposes the engine to Kiro over stdio, including
  `workflow_script_check` / `workflow_script_run`.
- **PBT** (`.kiro/pbt/`) — `fast-check` properties proving 5 invariants (50–100 randomized cases
  per property, see `.kiro/pbt/engine-invariants.test.ts`): DAG acyclicity, idempotent zero-token
  replay, typed-RPC soundness, monotonic event-log ordering, credential redaction.

The namesake **Skeleton Crew roster** (`.kiro/crew/`): `Conductor`, `Prober`, `Worker`,
`Reviewer`, `GateKeeper` — with least-privilege permission ceilings per role.
