# AI-Workflow — Submission Navigator

> **AWS Kiroween 2026 · Skeleton Crew category** (hosted by Kiro, on Devpost; team: Skeleton Crew
> — the team is deliberately named after the category it competes in)
> Submission deadline: **December 4, 2026, 2:00 PM PT** · Prize pool: **USD 100,000**
> Judged on: Potential Impact · Technological Implementation · Design · Innovation · Presentation
>
> **Working Application URL (Live Showcase)**: [https://litaog.github.io/AI-workflow-competition/](https://litaog.github.io/AI-workflow-competition/)  
> *(Single-page porcelain-white interactive showcase: architecture SVG, four failure-mode fixes, cross-engine benchmark, reproducible quality fingerprints, and recorded 9-Act demo output — zero installation required)*

This file is the judge-facing entry point: 3-minute golden path → one-minute pitch → demo video → one-command reproduction → repository map → compliance → Kiro usage guide.

---

## 🧭 Judge's 3-Minute Golden Path · 评委 3 分钟黄金审阅路径

> **专为评委打造的 3 分钟极速通道**：三级递进式审阅路径，从 30 秒免安装在线体验到 90 秒深度探查可视化时间旅行与子应用：

| 通道 | 耗时与方式 | 核心体验与验证要点 | 快速入口 |
| :--- | :--- | :--- | :--- |
| ⚡ **Path A** | **30 秒** · 零安装直达 | **全景矢量拓扑、四大失效结构解法、真实 9 幕实录**<br>浏览器零依赖即开即阅，微拟态纯白美学，完整呈现架构分层、基准测试与 9 幕运行实录证据链 | 🔗 [Live Showcase 交互演示单页](https://litaog.github.io/AI-workflow-competition/) |
| 🚀 **Path B** | **60 秒** · 单命令全景实测 | **48 秒九幕全景直通，零 Token 确定性重放**<br>本地克隆后一键运行，离线验证严格编译、沙箱隔离、时间旅行、孔洞填补与预算硬门禁 | `git clone ...`<br>`npm install && npm run build`<br>`npm run demo` *(或 `bash scripts/demo.sh`)* |
| 📊 **Path C** | **90 秒** · 可视化看板与实测应用 | **时间旅行可视化画布，直达两个真实子应用**<br>自动唤起浏览器 Studio 看板，探索 DevOps 突发故障自愈（[Incident Triage](apps/incident-triage-remediation/README.md)）与 AWS SDK v2→v3 自动化迁移（[Repo Migration](apps/repo-migration-engine/README.md)） | `npm run demo:studio`<br>*(自动在浏览器打开 Studio)* |

```bash
# 🚀 评委本地极速复现（Path B & Path C）：
git clone https://github.com/LitaoG/AI-workflow-competition.git && cd AI-workflow-competition
npm install && npm run build

npm run demo          # ⚡ Path B: 60秒全景实测（零网络、零 Token、确定性重放）
npm run demo:studio   # 📊 Path C: 90秒可视化看板（自动唤起时间旅行 Studio 画布）
```

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
> Recording assets are ready: the 180-second second-by-second cue sheet (393-word voiceover,
> six scenes) lives in [`deliverables/video_script.md`](deliverables/video_script.md), with the
> storyboard in [`deliverables/storyboard.md`](deliverables/storyboard.md).

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


# Option A: One-command cross-platform demo (~2s, Windows/macOS/Linux native)
# Runs the flagship incident-triage facade offline & auto-raises Studio in your default browser:
node bin/workflow.js demo
# or: npm run demo
# or: npm run demo:studio

# Option B: Comprehensive nine-act self-verifying showcase (~42-51s, requires Bash / Git Bash on Windows):
bash scripts/demo.sh
# or: npm run demo:nine-acts
```

Offline, deterministic, **no API keys** — both entries self-verify and exit non-zero if any act fails.
The nine-act suite measured end-to-end 2026-11-21 (Git Bash on Windows, Node v26.13.0, warm npm cache
with preinstalled `node_modules` and a current `dist`; 42 s, 47 s, 48 s and 51 s across four runs): **exit 0,
`ALL NINE ACTS COMPLETE`, both runs** — well inside the three-minute budget.

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
three-minute judge path) or from a release tarball — a `.tgz` asset is attached to every GitHub Release
since v2.11.0:

```bash
gh release download --repo LitaoG/AI-workflow-competition --pattern "*.tgz"   # latest release asset
npm install ./ai-workflow-<version>.tgz   # keep the ./ prefix — a bare relative path is parsed as a registry spec
```

The tarball ships the engine CLI, the MCP server, the library exports and the agent skill; the
two-application demo suite is part of the source tree, so the demo paths above are a source clone.
Verified 2026-11-21.

### 90 seconds to a real model (the mock is the deterministic review channel, not the ceiling)

Everything above runs on the built-in **deterministic mock provider** — zero network, zero API keys,
byte-identical reruns. That is deliberate: it makes every claim on this page mechanically verifiable
by a judge. The same facade scripts run unchanged against real agents — no script edits, four paths:

```bash
# Path 0 — direct HTTP providers, registered from environment credentials (no extra dependency):
export ANTHROPIC_API_KEY=sk-ant-…   # → provider `anthropic` (optional ANTHROPIC_MODEL / ANTHROPIC_BASE_URL)
export OPENAI_API_KEY=sk-…          # → provider `openai`   (optional OPENAI_MODEL / OPENAI_BASE_URL)
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…   # → provider `bedrock` (native SigV4, zero-dep;
#                            optional AWS_SESSION_TOKEN / AWS_REGION / BEDROCK_MODEL_ID)
# …then route asks explicitly: providerId: 'bedrock' in the ask options (the registry default
# remains the offline mock — no silent failover).

# Path 1 — delegate every ask to an external coding-agent CLI already on your PATH
AI_WORKFLOW_PROVIDER=codex    node bin/workflow.js run-script my-flow.facade.ts
AI_WORKFLOW_PROVIDER=gemini   node bin/workflow.js run-script my-flow.facade.ts
AI_WORKFLOW_PROVIDER=opencode node bin/workflow.js run-script my-flow.facade.ts
# AI_WORKFLOW_CLI_COMMAND='C:\bin\codex.exe'  — optional explicit executable override

# Path 2 — mount the engine as an MCP server inside any MCP host (Claude Code / ZCode /
# opencode / Codex CLI / Cursor): the host's own model powers every ask, through the
# workflow_script_check / workflow_script_run tools.

# Path 3 — Kiro: .kiro/mcp/mcp-server.json wires the engine into Kiro's MCP surface,
# alongside .kiro/ hooks, steering and specs (see docs/KIRO_INTEGRATION.md).
```

Provider routing, per-host config snippets and health probes: [docs/INTEGRATION.md](docs/INTEGRATION.md).
Kiro-native wiring: [docs/KIRO_INTEGRATION.md](docs/KIRO_INTEGRATION.md).

### Reproducible quality-gate fingerprints

All run 2026-11-21 on the **v2.13.0 release tree** (main @ `86486f2` — the v2.13.0 release tree,
with the #228 CLI-approve and #230/#232 CLI graph/list interleaves folded into the release;
fingerprints measured on this exact tagged tree; base `b9bb498` = the
R7 sharp-review fix batch tip #225, folding the redaction dual-profile #219/#222 (worldRead
content fidelity — ADV3 contract intact plus a package.json regression), the review-author
integrity #220/#223 (closing the #215 supervision-independence hole) and the self-contained
showcase #224/#225 (Tailwind compiled inline, CDN removed; the fingerprint tree label
corrected) — on top of the v2.12.0 lineage #209/#213 (native-SigV4 BedrockProvider
zero-dependency real-model path), #210/#217 (stdlib-AST compile cache) and #211/#218 (judge
golden-path docs)), Windows, Node v26.13.0, from a **fresh build**
(fresh-build numbers are what a judge clone reproduces; full context in
[README](README.md#reproducible-quality-gate-fingerprints)):

```text
npm test                                            → 876 tests, 873 pass, 3 skipped, 0 fail
npm run test:integration (serial)                   → 215 tests, 215 pass, 0 skipped, 0 fail
npm run test:pbt                                    →  18 tests,  18 pass, 0 fail
node --experimental-strip-types tests/e2e/runner.ts → 118/118 passed
npm run test:adversarial                            → 198 tests, 198 pass, 0 fail
npm run test:governance                             →  44 tests,  44 pass, 0 fail
bash scripts/demo.sh                                → ~48s, exit 0, all nine acts OK
```

### Cross-engine benchmark (measured)

The identical facade mission script was also run against **both** the official ZCode
dynamic-workflow engine and ours, on the same scripted fake model (zero network, zero API keys).
The official-engine track runs against a local checkout of the official engine (not ours to
redistribute, so that side is evidence-backed but not re-runnable from this clone); our side is
fully reproducible from this repository. Measured highlights (2 runs each, Windows, Node v26.13.0): mission wall time 167.271/155.256 ms
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
([Live](https://litaog.github.io/AI-workflow-competition/): single-file porcelain-white interactive product page — pitch, failure-mode fixes, architecture SVG, captured 9-act demo output, evidence fingerprints, zero build step).

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
  ten-tool face: five legacy tools (`workflow_run` / `workflow_probe` / `workflow_inspect` /
  `workflow_replay` / `workflow_graph`) plus
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
   engine's MCP server over stdio with the full ten-tool face declared (`workflow_run` /
   `workflow_probe` / `workflow_inspect` / `workflow_replay` / `workflow_graph` plus the five
   `workflow_script_*` / `workflow_*_run` facade tools — identical to §6 above, locked to
   `TOOL_CATALOG` by the governance suite) — the same server surface ZCode consumes.
5. **PBT as proof, not vibes** (`.kiro/pbt/`): fast-check property suites (wired into
   `npm run test:pbt`) prove DAG acyclicity, idempotent zero-token replay, typed-RPC soundness,
   monotonic event ordering and credential redaction — 8–3,000 randomized cases per property
   (tuned per property).
