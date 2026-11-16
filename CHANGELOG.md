# Changelog

## Unreleased

- **state (SQLite migration race, Issue #72)**: schema migrations on the shared global
  `.workflow/runs.db` were not idempotent across concurrent openers — `node --test` runs
  test files in parallel workers, two openers both saw a migration column missing in
  PRAGMA, raced their ALTERs, and the loser died with `duplicate column name: …` (two CI
  e2e reds on 2026-11-16: `actor_name` on run 43895214141, `persona_json` on run
  43899305221, both intermittent with main green on rerun). All six `ADD COLUMN` migration
  sites now tolerate exactly that error (the losing ALTER's end state is identical to the
  winner's); every other failure still propagates. Locked by
  `tests/integration/sqlite-migration-race.test.ts` — four concurrent opener subprocesses against
  a pre-migration db, all must exit 0 with every column present exactly once.
- **agent (mock schema validation, Issue #53)**: the mockResponse fast path returned plain
  JSON-Schema-shaped canned values UNVALIDATED (the branch only honored schemas with a
  `parse` method) — a structurally violating response (missing required field, enum
  violation, wrong type) masqueraded as a completed step with exit 0 and journaled the bad
  data. Plain shapes now run through the same JSON-Schema→zod converter the dwf compile
  path uses (`zodFromJsonSchema`, moved inward to `src/agent/json-schema-zod.ts` with a
  dwf-side re-export shim — the 依赖向内 layering rule forbids agent→dwf imports);
  violations throw the production `SchemaValidationError`. Objects without JSON-Schema
  markers keep their pass-through semantics; zod branches are unchanged. Locked by
  `tests/unit/agent-mock-json-schema.test.ts` (7 cases) and pitfall P-TEST-10.
- **dwf (child outbound frame budget covers the realm path, Issue #58)**: the
  child's outbound frame-queue budget (16 MiB, added for Issue #17) guarded only
  `sendToParent` — the host's own done/scriptError frames — while every realm
  frame (`log`/`report`/calls, all bootstrap `__emit` shapes) crossed the
  captured `__send` capability straight to `process.stdout.write`, so a
  flooding script could still queue unbounded writes and V8-OOM the child heap
  on POSIX (no Job Object commit cap there) before any parent-side budget saw
  it — the exact scenario the #17 guard claims to fail by name. The
  `writableLength` check now lives on the single outbound choke point
  (`writeOutboundLine`) that both `sendToParent` and `sandbox.__send` route
  through; over the budget the child terminates the script SYNCHRONOUSLY at
  the breach: the terminal `ChildFrameLimitExceeded` scriptError frame is
  written straight to fd 1 (it lands in the kernel and survives the immediate
  exit; a leading newline absorbs a possibly torn in-flight stream frame), the
  ~16 MiB of queued flood frames are discarded with the stream queue, and the
  realm's sync flood loop cannot keep allocating. Review round 2 (CI-proven,
  gate run 43753392889 test 93): bounding the write queue alone still OOMed a
  2,000-frame flood inside the realm's JSON.stringify — neither write-completion
  callbacks nor a throw through `__call`'s promise executor (which only rejects
  the fire-and-forget log promise) can stop a loop that never yields. Review
  round 3: the budget is now queue + SINGLE FRAME (a >16 MiB wire frame is
  terminated by the same path — the parent-side caps all sit after arrival, so
  without it one giant frame OOMs unnamed), `__host.log` gates the source
  message length BEFORE `__call`'s stringify (a giant log cannot double in the
  wire copy; the throw unwinds the script's own stack synchronously), and an
  fd-1 delivery failure/partial write mirrors the terminal frame to stderr
  (runner's close path carries the stderr tail into the error text), so the
  failure stays named under any delivery outcome. The later done frame stays
  suppressed (one terminal frame per run). Locked end-to-end through the real
  child by `tests/unit/dwf/dwf-child-outbound-budget.test.ts` (64/48-frame
  floods plus a 2,000-frame ≈1 GiB tail-flood case locking the breach
  termination — POSIX-only, win32 skips where probe-verified synchronous pipe
  writes can never accumulate the queue; the single-frame, log-source and
  15.7 MiB under-budget positive cases are transport-independent and run on
  both platforms); doc sync: ARCHITECTURE §5.1 now lists the child-side
  budgets.
- **dwf (world.run output cap, Issue #56)**: `spawnCaptured` no longer silently
  discards child output past the 16 MiB per-stream cap. The over-cap verdict is
  byte-accounted (`Buffer` bytes — the MiB constants are byte-denominated;
  `String.length` counts UTF-16 code units, so 16 Mi chars of CJK output is
  ~48 MiB of real bytes) and arrives as a named `SchemaValidationError`
  rejection carrying the cap and the actual size (`op: 'world.run'`, `stream`,
  `bytes`, `cap`); the worldRun node journals as **failed** instead of
  committing a truncated value as the authoritative journalled result. The
  first over-cap chunk also kills the child tree immediately (one-shot) — a
  rejected world.run must not keep mutating the workspace until the timeout
  fires. Exactly-at-cap output still resolves (D8④ boundary convention), and
  the cap is injectable per `WorldBoundary` (second constructor arg, default
  `WORLD_OUTPUT_CAP`) so tests can pin the boundary at 4 KiB. Reuses the
  read-side `SchemaValidationError` precedent — the ten-tag closed set is
  untouched. This makes the code match the module's own "reject, never
  truncate" contract already stated in its header and cap comments.
- **tests (hygiene, Issue #54)**: adversarial `concurrency-stress` tmp dirs now self-clean via
  `t.after` (`run-*-parallel-*` / `run-failure-concurrent-*` residue was invisible to `git status`
  through the `*.db` / `events.jsonl` ignores); `cli.test.ts` writes its mock workflow, exported
  DAG HTML and scaffold into per-test temp dirs instead of the controlled `tests/unit/fixtures/`
  (removes the P-TEST-2 `git restore` ritual's root cause); dead `tests/adversarial/runner.js`
  (zero references; its TAP "PASS (0/0)" counting was the unfixed half of the fake-green pattern
  already guarded in the e2e runner) is deleted — `test:adversarial` is glob-based and unaffected.
- **apps (demo integrity, Issue #40)**: the committed migration deliverable
  `apps/repo-migration-engine/artifacts/PULL_REQUEST.md` now declares at the top that it is a
  simulated demo with **no files written** (未写入任何文件), and its Diff Statistics are marked
  模拟统计（非实际 diff）; the migration README carries the same disclosure. Doc sync: the
  incident-app READMEs (en/zh) now describe the facade edition's real policy gate + reversible
  apply/undo rollback (wired by #39), and the stale act-1 site count / quality-gate
  fingerprints in README & SUBMISSION were refreshed to fresh-build measurements.

## 2.5.0 (2026-11-15) — upstream batch: AST codemod self-healing, thinking-stream SSE, supervised stdin, symlink hardening

Feature/fix sync from the upstream engine line (`78ac366..18eb37e`, patch-ported per the
established two-repo recipe; competition deliverables untouched). Twelve substantive
changes land:

- **dwf**: compiler pre-pass AST codemod (`src/dwf/ast-codemod.ts`) auto-heals forgotten
  destructuring in facade scripts (upstream #300).
- **dwf (comp-side fix, found by this repo's Linux CI)**: `sessions.waitAny` no longer
  lets the done-time unawaited-promise sentinel (upstream #279) flag its own losers.
  waitAny's contract is pure racing without cancellation — a loser may legitimately
  still be in flight when the winner settles and the script finishes, and which reply
  wins the pipe-scheduling race decides pass/fail (first surfaced as an intermittent
  GitHub Actions integration failure; single-file reruns always passed, which made
  the first two root-cause hypotheses — Node/V8 version, Linux platform — both wrong).
  waitAny now marks every turn it owns as consumed and abandons its in-flight entries
  (mirroring the sanctioned-abandonment exemption in `sessions.cancel`); `sessions.race`
  marks its turns upfront the same way. The script-level twin got the same treatment:
  the `goal-adv3-cap-caught` fixture now drains its in-flight Promise.all siblings
  after catching the cap error (`Promise.allSettled`), mirroring the budget-stop
  philosophy "In-flight agents will complete; their results are preserved" — without
  the drain, the cap-boundary round's still-in-flight ok replies raced the done-time
  in-flight net and intermittently failed the newly-gated adversarial test.
- **dwf (comp-side fix, first Linux CI adversarial run)**: `child-main` now drains
  stdout before exiting — `process.exit()` discards pending POSIX pipe writes
  (~64KB kernel buffer), so a queued fire-and-forget frame larger than the buffer
  (a big `log()`/report artifact) was silently torn or lost while the run still
  reported success: the 315KB control-char log round-trip came back empty on CI.
  Windows pipe buffering masked this everywhere else. The child also gains an
  outbound frame-queue budget (16MB, the twin of the parent's backlog budget) so a
  flooding script fails by name (`ChildFrameLimitExceeded`) instead of dying by V8
  OOM on Linux (no Job Object heap cap there); the flood test accepts all three
  bounded-failure outcomes. Concurrent `WorktreePool.mergeIntoBase` calls now
  serialize per pool — git allows one merge per worktree, and on a slow runner two
  swarm merges genuinely overlap into MERGE_HEAD collisions (second CI occurrence
  of the family). All need backflow to the private repo.
- **agent**: thinking-stream deltas flow through the provider contract and propagate
  live over SSE (upstream #304).
- **agent**: `spawnSupervised` accepts a stdin payload; `promptMode` gains `stdin` in
  cli-providers (upstream #291).
- **security**: WorldBoundary rejects symlink path traversal escaping the workspace
  root (upstream #289).
- **dwf**: the unawaited-promise sentry tracks *consumption*, not just in-flight state —
  "settled but discarded" results now also fail loudly with
  `WorkflowUnawaitedPromiseError` instead of reporting fake success (upstream #279).
- **studio**: every inline client `<script>` in rendered output is compile-gated through
  a `new Function` assertion (upstream #284; closes this repo's v2.4.0 boot-script
  white-screen lesson at the gate level).
- **governance**: Tier-1 repo-wide merge-conflict-marker scan with reverse
  discrimination (upstream #277; governance 35 → 36).
- **tests**: the 13-file goal-adv adversarial family joins the adversarial gate and the
  ADV2 world.run side-channel approval is restored (upstream #287; adversarial 158 → 201).
- **execution**: `shell: 'bash'` removal in worktree-pool adjudicated and locked
  (upstream #298; recorded as P-SHELL-2).
- **docs**: ARCHITECTURE Mermaid diagram and dual-engine execution-flow corrections
  (upstream #293); pitfalls P-GIT-3 / P-BUILD-2 / P-SHELL-2 recorded; P-ENV-3 closes
  cross-repo (the private §2.1 revision landed, both junction-sharing triggers removed).

Deliberately not ported: upstream #285 (its premise — the `workflow.js demo` subcommand
being removed — does not hold here: this repo's demo command still exists and
`scripts/demo.sh` exercises it; QUICKSTART already points at `apps/` paths) and the
upstream README/QUICKSTART edits (this repo's judge-facing docs are independent; the
fingerprint tables below were refreshed against the new gate counts instead).

Full gates on this machine (Node v26.13.0, fresh `npm ci` worktree): npm test 805/805
(unit 598 + integration 207), e2e 118/118, adversarial 201/201, PBT 16/16, governance
37/37, `scripts/demo.sh` exit 0.

## 2.4.1 (2026-11-15) — two-repo sync audit closeout, version housekeeping

Housekeeping release. The upstream-sync request for this cycle resolved to a **zero-delta
audit**: the only new private-repo commit since the v2.4.0 alignment point (`78e3b43`) is
`755ae80` (private #282/#283) — itself a patch-port of THIS repo's v2.1.1 round-2 batch
(`5c08923`) and the v2.4.0 Studio boot-script fix back into the private repo, so every
engine file it touched was already byte-identical here. A full-tree blob-hash audit
against the private repo at `78ac366` (441 tracked paths) confirmed parity: 397 paths
byte-identical, 18 diffs are the documented per-repo divergences (this side current or
richer: CI-restored governance locks, `apps/` layout, judge-facing docs, demo command,
e2e 121 vs 90), and the 26 private-only paths are layout pairings (`templates/*` ↔
`basic-workflow/` / `src/cli/scaffolding/multi-agent/`, `tests/pbt/` ↔ `.kiro/pbt/`,
`demos/capabilities-tour/` ↔ `apps/capabilities-tour/`) or deliberate exclusions
(`examples/goal-e2e/` removed in S1, machine-local `.zcode/`). Nothing to migrate.

Also riding since v2.4.0: P-SHELL-1 records its 6th instance — a gate block masked by
`&&` chaining let a merge proceed past the review-gate cooling window (#11/#12).

The gates for this release also surfaced a third instance of the cross-worktree shared
`node_modules` resolution skew (P-ENV-3): a junction into the main checkout pointed
`ai-workflow` imports at the main checkout's stale v2.3.0 `dist`, producing a fake-green
unit fingerprint and 0-step demo runs; fresh `npm ci` per worktree (postinstall self-link)
is the supported isolation. Instance appended to `docs/AI-PITFALLS.md` P-ENV-3.

Full gates on this machine (Node v26.13.0, fresh `npm ci` worktree): npm test 770/770
(unit 563 + integration 207), e2e 118/118, adversarial 158/158, PBT 16/16, governance
34/34.

## 2.4.0 (2026-11-15) — Antigravity primitives absorption, unawaited-promise sentry, affectUI adaptive cards

Feature sync from the upstream engine line (`c7d4b77..78e3b43`, patch-ported per the
established two-repo recipe; competition deliverables untouched). Three things land:

- **dwf**: absorb Google Antigravity native-dynamic-workflow primitives — an in-flight
  promise/agent registry inside the facade sandbox and child executor, with a mandatory
  final-state audit before the done frame. A script that forgets `await` on any async
  primitive now fails loudly with `WorkflowUnawaitedPromiseError` (task label, creation
  site, suggested fix) instead of reporting success without having run the real work —
  the fake-green failure mode eliminated at the engine level
  (`src/dwf/child-bootstrap.ts`, `src/dwf/child-main.ts`, `src/dag/journal-projection.ts`,
  `tests/unit/dwf/unawaited-promise.test.ts`).
- **visualizer**: affectUI adaptive cards — node cards auto-size to wrapped titles, an
  intent summarizer surfaces each node's journalled intent line, and the DAG canvas
  gains the new flow rendering (`src/visualizer/studio-template.ts`,
  `src/visualizer/studio-renderer.ts`, `src/dag/journal-projection.ts`,
  `tests/unit/visualizer/issue-280-affectui-overhaul.test.ts`).
- **research corpus**: `docs/research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md` —
  Antigravity architecture reverse-engineering (dual-process isolation, FD-hijack clean
  RPC, unawaited-promise audit defense) with a four-lineage comparison;
  `docs/absorbed-capabilities.md` registers the fourth lineage (Google Antigravity) and
  CAP-006/CAP-007.
- **fix (regression riding in the sync)**: the #280/#281 client script is embedded in a
  TypeScript template literal, where `[\r\n]` and `\s` are cooked before emission — the
  emitted boot script contained a regex with a literal newline, so the **entire Studio
  boot script failed to parse** (blank canvas in both the static journal view and live
  serve). Escaped to `\\r\\n` / `\\s` in `src/visualizer/studio-template.ts` and verified
  the full render (cards, replay chips, intent lines) in-browser; the flagship screenshot
  was re-shot from the fixed view.

Full gates on this machine (Node v26.13.0): npm test 770/770 (unit 563 + integration 207),
e2e 118/118, adversarial 158/158, PBT 16/16, governance 34/34, demo.sh exit 0.
README/SUBMISSION fingerprints refreshed 763 → 770.

## 2.2.0 (2026-11-14) — affectUI visual system, progress channel, research corpus

Feature sync from the upstream engine line (ported and reconciled with this repo's
competition deliverables, which stay untouched). The DAG/Studio visualization stack
is recast with the affectUI design language, facade runs gain a structured `[wf]`
progress channel, and the documentation corpus grows a research + governance layer.
Full gates on this machine (Node v26.13.0): `npm test` 744/744, e2e 118/118,
adversarial 158/158, PBT 16/16, governance 34/34, demo.sh exit 0.

### Added

- **visualizer**: the affectUI-grade visual system for the DAG and Studio views —
  new `src/visualizer/design-system.ts` design tokens, the light-palette flip with
  number-ticker animations, studio node cards sized to their measured titles (no
  ellipsis truncation), each node's journalled task line surfaced on its card, and
  humanized bilingual event-stream/inspector copy (`src/visualizer/*`,
  `src/dag/html-renderer.ts`, `src/dag/mermaid-renderer.ts`)
- **progress**: structured `[wf]` progress lines on stdout for harness agents —
  `workflow run --progress` mirrors node starts/completions into an agent's todo
  list (`src/dwf/progress.ts` + `run-script.ts` + CLI wiring)
- **docs**: research corpus `docs/research/*` (11 documents) — official-vs-AI-Workflow
  benchmark, bilateral cross-benchmark report, dynamic-workflow whitepaper,
  penetration & security audit, workflow gap matrix, telemetry deep-dives
- **docs**: governance layer — `AGENTS.md`, `GOAL.md`, `QUICKSTART.md`,
  `TEST_INFRA.md`, `docs/AI-PITFALLS.md`, `docs/absorbed-capabilities.md`;
  ARCHITECTURE / DEVELOPER_GUIDE / INTEGRATION / docs index rewritten around a
  five-theme navigation matrix (competition-only entries preserved)
- **tests**: workflow-governance specification suite (`tests/unit/workflow-governance.test.ts`,
  34 tests locking docs/CI/contamination invariants), `tests/unit/dwf/progress.test.ts`,
  and cross-engine benchmark probes (`tests/cross-engine/*`)
- **interop**: tracked `.claude/`, `.codex/`, `.opencode/` integration configs,
  refreshed PR/issue templates, hardened `scripts/pr_review_gate.mjs`

### Changed

- **docs**: the real CLI output strings are taught everywhere (`✔ facade script
  compiled clean (N sites)`) across SKILL.md, QUICKSTART, interop templates and
  `workflow new` hints
- **engine**: `src/dwf/governor.ts` mojibake byte repaired; `exported-dag.html`
  fixture regenerated against the new renderer
- **tests**: `win32-spawn-resolver.test.ts` moved from `tests/unit/` to
  `tests/integration/` per the unit-isolation governance invariant (Issue #198)

## 2.1.1 (2026-11-14) — raw-findings verification round

The 20 review findings that round 1 deferred (never adversarially confirmed) went
through their own verification pass — 18/20 confirmed — and every confirmed
finding with a bounded fix was fixed. Full gates: `npm test` 705/705, e2e 118/118,
PBT 16/16, demo.sh exit 0.

### Fixed

- **dwf**: the retry orchestrator's total attempt budget is enforced per-ask (in the
  ask executor) instead of as a run-lifetime counter in `canAttempt` — 6 cumulative
  failures no longer brick every subsequent ask of a run
- **dwf**: `RunFacadeResult.reportItems` carries the engine's real terminal report()
  snapshot (was hardcoded `[]`)
- **dwf**: the hole/escalation park fallback re-checks engine idle at fire time and
  re-arms instead of parking — a sibling ask started during the 10s window is no
  longer aborted mid-provider-call (double spend)
- **agent**: a `retryPolicy.maxRetries` larger than the ask default is honored (the
  loop bound was silently truncating it), and infra exhaustion on that path rethrows
  the real provider error instead of a mislabeled `SchemaValidationError` with empty
  rawText; a successful turn clears the infra memory
- **agent**: `AI_WORKFLOW_CLI_TIMEOUT_MS` is validated — NaN/0/negative fell through
  to a 1ms `setTimeout` and killed every codex/gemini/opencode ask
- **cli**: `setup --target opencode/zcode` templates are parameterized through
  `engineInvocation` — downstream projects get the global `workflow` bin instead of a
  hardcoded repo-relative `node bin/workflow.js` that cannot start
- **cli**: the claude-skill / codex templates and `workflow new` hint gate on the real
  check marker (`facade script compiled clean`), not the never-printed `Result: OK`
- **cli**: `workflow mcp call` exits 1 when the tool result carries `isError: true`
- **cli**: `workflow run` registers `--interrupt-at <n>` so the documented demo
  resumption walkthrough is executable
- **cli**: `workflow graph` exits 1 on a missing file (was 0 — masked caller errors);
  the e2e mock engine matches
- **core**: `validate()` rejects forward cross-phase dependencies at validation time
  (they passed Kahn's algorithm but deadlocked mid-run)
- **docs/tests**: stale references removed (`workflow-governance.test.ts`, dead commit
  `9de234a0` / branch `feat/dev-workflow` — annotated as private pre-public history);
  t4-05 Kiro compliance asserts against the real shipped `.kiro` files instead of
  fabricated data; t4-06 flaky 4000ms bounds relaxed to 15000ms (matches
  demo-migration.test.ts); tier2 count realigned in round 1

### Deferred (design/moderate, unchanged)

- `workflow demo` packaging for npm consumers (ship demos/ vs scaffold vs degrade —
  needs a packaging decision)
- coverage gate `include` list widening (needs a measured threshold across all modules)
- permission-manager build-mode confirmation resolution (no shipped consumer)

## 2.1.0 (2026-11-14) — self-review repair round

The engine reviewed its own repository (6-dimension parallel review → adversarial
verification → gates; 30 raw findings, 10 confirmed) and every confirmed defect plus
4 meta-bugs hit live during the demo were fixed. Each fix was then re-verified by an
independent adversarial verifier through the same engine (`repair.facade.ts`:
12/12 confirmed), followed by full gates (CLI+version, tsc build, unit suite, PBT).

### Fixed

- **cli**: `--version` derives from package.json (hardcoded 1.0.0 vs 2.0.0 drift)
- **docs**: SKILL.md / docs/INTEGRATION.md / examples / interop-templates teach the real
  commands (`workflow check` / `workflow run-script`) and the real stats-line format
- **agent**: HTTP 500 provider errors classify as transient (were fatal: no retry, failover
  chain skipped); Anthropic `cache_control` rides the system content block — the top-level
  field the previous default sent is rejected by the real Messages API with HTTP 400;
  Bedrock rethrows real API failures instead of silently faking mock success
- **dwf**: actorCreated notify frames carry `model` — the persona model binding was
  silently inert end-to-end; `--mock` is honored for facade runs (run-scoped tier env,
  restored in `finally`); run-lineage import is newest-wins as documented (a stale
  ancestor failure no longer shadows a descendant's completed nodes)
- **core**: `abort()` reports status `aborted` + emits `workflow_aborted` + cancels the
  active batch so in-flight steps observe the abort; `StepDefinition.timeoutMs` is
  enforced (deadline race + composite `AbortSignal.any` signal); `WorkflowOptions.maxConcurrency`
  is enforced via an errgroup worker pool (junk caps degrade to uncapped, not a livelock);
  `fanOutStep` starts no new items after a worker failure or cancellation; aborted runs
  persist their status in the sqlite run store
- **process-supervision**: `resolveWindowsSpawnCommand` routes `.cmd`/`.bat` shims through
  `cmd /c` — `world.run('npm', …)` no longer fails with ENOENT on Windows
- **cli**: `--run-timeout <ms>` and `AI_WORKFLOW_RUN_TIMEOUT_MS` — the whole-run wall clock
  was hardcoded to 600s
- **tests**: the t2-10 Kiro suite was rewritten from five cannot-fail subtests to two real
  executed hook-contract tests (tier2 expectation 50 → 47); new unit suites cover
  abort/concurrency/timeout semantics, Windows spawn resolution and HTTP 500 classification

### Deferred (known, not fixed)

- 20 raw review findings that never went through adversarial confirmation (fixing
  unverified claims risks breaking correct code) — each needs its own confirm-then-fix pass
- run-level `WorkflowOptions.timeoutMs` (per-step timeouts are enforced)
- `--mock` env scoping is process-global: concurrent `runFacadeScript` calls in one host
  process could briefly cross-influence tier routing
- npm registry: the `ai-workflow` name is occupied by an unrelated 0.1.19 package —
  releases are distributed via GitHub
