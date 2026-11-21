# Changelog

> Scope note: entries below may mention an "upstream" or "private" repo — that always refers
> to this project's own private development repository (the pre-public-history mirror), never
> third-party code. All engine code in this repository is clean-room original work.

## 2.12.0 (2026-11-21) — BedrockProvider native SigV4: the zero-dependency real-model path

- **feat (Issue #209, PR #213)**: the Bedrock provider drops the dynamic `@aws-sdk/client-bedrock-runtime`
  import entirely — AWS SigV4 (canonical request → string-to-sign → HMAC-SHA256 signing chain) is
  implemented in ~200 lines on Node's native `node:crypto`, and `invokeModel` is called over native
  `fetch`. Zero new dependencies (package.json / package-lock.json untouched), `AWS_SESSION_TOKEN`
  supported via `x-amz-security-token`, and every error path redacts all three credentials through
  `redactServerText`. With `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in the environment the
  provider self-registers (region/model via `AWS_REGION` / `BEDROCK_MODEL_ID`, defaults
  `us-east-1` / `anthropic.claude-3-5-sonnet-20241022-v2:0`); the registry default remains the
  offline mock — asks reach bedrock only via an explicit `providerId`, no silent failover. 15 new
  unit tests including the AWS official SigV4 test vectors (+10 net → 867).
- **docs (Issue #214)**: SUBMISSION's "90 seconds to a real model" gains the env-credential direct
  path (ANTHROPIC_API_KEY / OPENAI_API_KEY / AWS_ACCESS_KEY_ID → anthropic / openai / bedrock) and
  docs/INTEGRATION.md §4 documents the bedrock registration — closing the doc-sync debt that
  PR #213's "no doc impact" adjudication left on record.

## 2.11.0 (2026-11-21) — presentation-facts batch: judge-surface truth purge, doctor install-integrity & release tarball assets

- **cli (Issue #205, PR #206)**: `workflow doctor` gains an install-integrity check — when the
  repo dev environment (`apps/` present) is missing the `node_modules/ai-workflow` self-link
  (the postinstall hook is silently skipped under `ignore-scripts=true`), doctor fails loudly
  with the exact repair command instead of letting apps-scope `import 'ai-workflow'` die later
  with ERR_MODULE_NOT_FOUND; four temp-fixture unit tests cover the downstream / link-present /
  stale-copy / missing branches (+4 tests → 857).
- **release (Issue #205/#208)**: a `.tgz` asset is attached to every GitHub Release from v2.11.0
  on; README / QUICKSTART / SUBMISSION install guidance now carries the real
  `gh release download` path (the npm `ai-workflow` name remains an unrelated 2021 placeholder,
  v0.1.19).
- **pages (Issue #205)**: `docs/index.html` is no longer a hand-synced duplicate — `pages.yml`
  materializes it from the single-source `docs/showcase.html` at deploy time (the 742-line
  byte-identical twin was guaranteed drift).
- **showcase truth purge (R5/R6 review)**: the judge landing page now carries only verifiable
  facts — the fabricated `npx ai-workflow demo:studio` hero command (which installs an unrelated
  2021 package) is replaced by the real clone→build→demo path; the MIT footer becomes Apache-2.0;
  the stale v2.9.0 badge and 848 fingerprint are re-pinned to current; the invented dependency
  list (yaml/chalk) is replaced by the real four runtime deps; benchmark cards are re-pinned to
  the measured cross-engine table (7.2 ms warm compile, 40.5 MB peak heap vs the official
  engine); the nine terminal Act panels are verbatim transcripts of a real `bash scripts/demo.sh`
  run; the four failure-mode cards match the README taxonomy; the favicon data-URI is fully
  percent-encoded (root cause of the stray `⚡">` text fragment).
- **docs (Issue #205)**: SUBMISSION gains "90 seconds to a real model" (the mock is the
  deterministic review channel; three real-agent paths); the measurement-date drift (39 s @
  2026-11-03 vs 2026-11-21) is resolved by an honest re-measure (48 s, 2026-11-21) pinned
  identically in README and SUBMISSION; the demo-video section links the ready 180-second cue
  sheet (`deliverables/video_script.md`); README links the Devpost article draft (`blog/post.md`).

## 2.10.0 (2026-11-21) — §1.9 mechanical closure, GitHub Pages showcase & one-command demo entry

- **governance (§1.9 mechanical closure, Issue #173/#124)**: the three-state reply duty is now
  enforced mechanically — `pr_review_gate.mjs` gains a `--ci-comments` CI face (same review
  adjudication assembly — F5 linked-issue comments merged, S2 no-comment claims — skipping
  merge-period-only checks), ci.yml adds the REQUIRED `review-comments` job on every PR update,
  and a new `review-comments-status.yml` flips the `review-gate-comments` commit status on a
  PR's HEAD whenever a comment or review lands: unanswered findings → `failure` → merge blocked
  (enforce_admins covered); a three-state reply re-triggers it → `success` → unblocked. This
  closes the #165 race class (a finding landing between gate runs and merge). Gate execution
  always runs MAIN's script, never PR-author-controlled code; the bootstrap window (main's
  script predating the mode) defers loudly instead of faking green. Branch protection now
  requires `[gate, review-comments, review-gate-comments]`; blocking semantics probe-verified
  live (`failure` → mergeStateStatus=BLOCKED → `success` → unblocked).
- **pages (judge-facing showcase, Issue #178/#180/#179)**: `docs/` deploys to GitHub Pages via
  the official `deploy-pages` workflow (push on `docs/**` or manual dispatch), giving judges a
  live online entry alongside the repo; `npm run demo` lands as the one-command cross-platform
  reproduction entry; the showcase and submission links were aligned to the judge flow.
- **docs (artifact layers, Issue #181)**: README now explains the two-generation demo evidence
  layout — repo-root `artifacts/` holds the latest bucketed `scripts/demo.sh` run, while
  `apps/*/artifacts/` preserves each application's own standalone run (different runIds and
  timestamps by design, not drift).

## 2.9.0 (2026-11-21) — plan-first live graph series: the DAG view becomes a run-long cockpit

- **feat (Issue #168, PR #169)**: plan-first visualization — a facade run journals its compile-time
  site table as the stream's opening `dwf_plan` event, so the run dir's `graph.html` exists from the
  run's first moment as the FULL pending plan (phase columns + ask/hole/escalation nodes) and lights
  up node by node as execution proceeds; planned-but-never-executed branch nodes stay visible as
  pending. The watch view (per-event `graph.html` rewrite through the same pure projection the cold
  replay folds) is now **on by default** (`--no-watch-graph` disables), and both MCP run faces
  surface the live `graphPath`. The live==cold byte-identical projection invariant holds by
  construction — the plan is an ordinary journal event.
- **feat (Issue #171, PR #174)**: `plan(update)` primitive — mid-run plan-graph evolution. Scripts
  declare pending nodes ("boxes") and dependency edges ("lines") at runtime (ids are script-chosen
  runtime values; edges may reference real site ids, e.g. a future `ask#N`); `dwf_plan_update` folds
  into every view immediately. Dangling endpoints buffer and materialize the moment the node appears
  (no mermaid ghost nodes). Engine-side shape validation fails loudly (`PlanUpdateMalformed`,
  per-call 1000-node / 2000-edge caps `PlanCapExceeded`). `plan` is deliberately NOT shadow-banned —
  workflow scripts constantly bind `const plan = ...`, plan() carries no replay keying a shadow
  could desync, and call-site ambiguity is type-checker-guarded. The `[wf]` progress channel grows
  `PLAN ◇ N sites · M phases` and `PLAN+ ◇ +N nodes · +M edges` lines. The other mid-run redirect
  door — hole fill — already re-plans automatically on its forked amend run via the #168 mechanism.
- fingerprints re-pinned on the v2.9.0 release tree (+9 tests vs the 2.8.1 pin: 4 from the
  plan-first graph, 5 from the plan() primitive).

## 2.8.1 (2026-11-21) — pre-submission audit fold: submission-fact sync, research-corpus sanitization, ask-provider observability

- **docs (submission-fact sync, Issue #162)**: 16 judge/npm-facing facts synced to the actual
  release tree — wrong issue/PR anchors (#160 is the Issue, #161 the merge PR), fabricated
  demo commands in the video deliverables replaced with the real `bash scripts/demo.sh`
  entry, fabricated MCP tool names replaced with the real ten-tool face, stale numbers
  re-pinned from live gate output (38.5% HTTP 500 spike, PBT 18 tests / 8–3,000 runs,
  841→current test counts, 4 runtime deps), `AgentSpawn`→`SessionStart`, dangling
  QUICKSTART reference fixed, PROJECT.md given its historical-archive banner, upstream/
  private issue anchors labeled as such.
- **docs (research-corpus sanitization, Issue #163)**: the verbatim closed-source excerpts in
  `docs/research/` (Antigravity prelude Python blocks with original line anchors) are rewritten
  as behavior-level reconstructions; the two Claude Code reverse-engineering notes drop verbatim
  proprietary messages, internal symbol names, telemetry event names and binary offsets in favor
  of behavior descriptions; "同文案/逐字一致" claims recast as semantic equivalence; the leaked-mirror
  name list replaced by a one-line clean-room statement. All conclusions and absorption decisions
  preserved; no filenames renamed (docs/README.md registry untouched).
- **agent (observability, Issue #164)**: `SchemaValidationError` now surfaces the routed provider
  id — the message carries `(routed provider: "<id>")` and `details.provider` is populated; on the
  unconfigured default path (registry fallback to `mock`) the message adds the "set
  AI_WORKFLOW_PROVIDER" hint instead of masking a canned-mock contract failure as a model-output
  failure. One new locking unit test (npm test count 841 → 842).

## 2.8.0 (2026-11-20) — R4 sharp-review series: security hardening, journal convergence, real Kiro wiring, self-verifying fingerprints

- **mcp (resume hint honesty, Issue #142)**: `workflow_run_script` now accepts `resumeRunId` —
  zod used to strip the field while the tool's own resumeHint routed callers into a full-price
  fresh run at "zero cost" (end-to-end A/B verified); the hand-written `workflow_script_run`
  catalog schema documents `approvedCommands` (the executor reads it) and stops drifting from
  the zod-derived twin, locked by field-level catalog consistency tests.
- **studio (loopback guard, Issue #143)**: the live server refused nothing — any web page the
  operator visited could fire no-cors cross-origin POSTs at a parked run (`/api/fill` body =
  arbitrary compilable TS that a forked amend executes) and read raw journal broadcasts.
  Now: a non-loopback Host header → 403 (DNS-rebinding shield); POST `/api/fill`|`/api/answer`
  and `/ws` upgrades validate Origin (same-origin page or origin-less tooling only).
- **dwf (journal convergence, Issue #144)**: the resume ordinal collision guard ran for asks
  only — a non-ask row lost to a `saveDwfNode` write failure re-allocated the missing ordinal
  on the next resume and upsert-overwrote the surviving row, oscillating the journal forever
  (world nodes even re-executed, repeating side effects). The guard now covers all four node
  kinds; deterministic busy-retry regressions lock the #140 branches (converge / non-BUSY
  rethrow / bounded exhaustion).
- **kiro (real wiring, Issue #145)**: `pre-step-gate` read only argv/env — under the real
  PreToolUse protocol (stdin JSON) the deny branch never fired (`rm -rf /` on stdin printed
  GATE ALLOWED). It reads `tool_input.command` now (bounded wait, silent pipes cannot hang
  it); `lifecycle.json` rewritten to the Kiro-native schema (trigger + action.command,
  AgentSpawn→SessionStart); `post-step-audit` stopped printing fabricated "monotonic sequence
  verified" claims; en/zh docs synced (including the stale pre-commit ghost).
- **review batch (Issue #146)**: `probeGit` masks credentials in the origin remote URL (CI
  token URLs no longer reach the CLI probe output); mermaid labels/ids are escaped (a hostile
  node name can no longer inject mermaid statements — the HTML renderer already escaped);
  `run --ui` serves from the run's own journal (`--cwd` + `--ui` used to 404 on its own
  runId); `AI_WORKFLOW_NO_OPEN` test affordance for automated `--ui` harnesses.
- **docs (truth sync, Issue #147)**: the `tests/pbt/` → `.kiro/pbt/` drift fixed across four
  docs; the 600s post-merge audit claim marked as documented-but-unimplemented (only the 900s
  pre-merge gate is real); npm install reality documented — the registry `ai-workflow` name is
  an unrelated 2021 placeholder, tarball installs need the `./` prefix.
- **tests (truth, Issue #148)**: cross-engine `journalEventSequence` was vacuously empty (a
  `limit: "all"` sentinel sliced the real sequence away on read); the official benchmark now
  records 70 real events per run with identical sequences; the e2e mock fallback is loud
  (console warning + `usedMock` on the result) instead of silently grading 121 cases against
  the reference mock engine.
- **demo (artifact buckets, Issue #149)**: the two Builder demos wrote the same `kanban.json`
  into one cwd artifacts dir — running both README commands overwrote the first demo's board;
  bucketed per app (`artifacts/incident-triage/`, `artifacts/repo-migration/`), root showcase
  regenerated.
- **governance (self-verifying fingerprints, Issue #158)**: the merge gate accepted a
  hand-typed `Ran 500 tests` while an honest failing summary was blocked — the fail-blind
  shape is gone and fingerprint numbers are cross-bound to the real npm-test TAP summary in
  `.gate/tap.log` (`AI_WORKFLOW_TAP_LOG` for worktree merges); the gate caught its own
  author's inconsistent PR body on its first merge attempt.

## 2.7.0 (2026-11-18) — compliance scrub, R2 closeout, sharp-review series, mechanical red-gates

- **compliance (private-path scrub, Issue #48)**: 15 tracked files carried machine-local
  absolute paths (`C:\Users\<user>\…`) while README's compliance section claims zero private data
  leakage — all scrubbed to context placeholders (`<workspace>`, `<official-zcode-clone>`,
  `<runId>`); the root cause is fixed where the paths were born (`gate-runner.js` now prints
  the gate target relative to the repo root, so regenerated demo artifacts stay clean);
  cross-engine scripts resolve the official checkout from `OFFICIAL_DWF` (fail-fast, no
  hard-coded author path) with reproduction steps in `tests/cross-engine/README.md`; and a
  Tier 1 governance scanner bans drive-letter user profiles / `/Users/<name>/` / `/home/<name>/`
  shapes in every tracked text file (red-proven by injection), extended by a second pass that
  sanitizes the single-backslash path forms the first pass missed.
- **state (SQLite init race, Issue #140)**: concurrent openers could die with `SQLITE_BUSY`
  ("database is locked") inside the initSchema schema batch — SQLite returns BUSY immediately
  (no busy_timeout wait) around the journal-mode switch window, and the #72 tolerance only
  covered `duplicate column` ALTER races. Observed twice on Linux CI (PR #139 run 44338679305,
  both attempts red). initSchema now retries bounded (5 attempts, 100→400ms backoff) on exactly
  that error — every statement is idempotent (IF NOT EXISTS + guarded ALTERs), so a retry always
  converges; exhausted BUSY and every other failure still propagate.
- **dwf (composition lineage, Issue #62)**: composition lineage import goes recursive — nested
  (depth ≥ 2) subtrees now replay on resume at zero token cost instead of being re-billed; the
  depth-1-only import left grandchild runs live.
- **dwf (ask replay, Issue #63)**: replayed asks revalidate against the current schema (a schema
  edit between resumes no longer blesses stale asks) and `executedAsks` continues across resumes.
- **honesty (prober + locks, Issues #88/#84)**: the prober reports missing npm/git as `undefined`
  instead of fabricated values — measured facts only; the t1-10 Kiro compliance lock asserts
  against real files with no synthetic fallback.
- **tests (residue hygiene, Issues #86/#92)**: integration run outputs moved to `os.tmpdir` with
  after-cleanup — no more gate-invisible residue leaking into the repo; 10 zero-reference residue
  fixtures from the Issue #54 era removed (restore-ritual references synced).
- **refactor (dead-code sweep, Issues #90/#94/#96/#98/#100/#110)**: dead MCP client classes
  (177 lines, zero references), the dead Result monad + KanbanDashboard abstractions, the legacy
  live projection superseded by the Studio snapshot, the write-only toolRegistry singleton with
  its self-referential test, 20 dead i18n keys + dead template exports + unwired demo i18n +
  dead assignments + duplicate collector, and small dead exports across
  governor/schema-synth/agent-schema/engine/child-bootstrap.
- **refactor (single-source, Issues #102/#104/#106/#114/#116)**: the MCP workflow_run/graph
  module loader; the shared facade-run option face of run/run-script; `printDwfEvent` console
  rendering shared by run-script/fill/answer/workflows; the TOOL_CATALOG→OpenAI tool array
  mapping; `rowToDwfNode` shared between the singular and plural getters (per-actor identity
  fields no longer dropped).
- **tests (pbt, Issue #64)**: model-based DAG acyclicity, real typed-ask contract enforcement,
  and a dist freshness guard.
- **governance (behavior locks + red-gates, Issues #68/#118/#124/#128/#134/#136)**: Tier1
  linkage, Tier4 orphan probe, and Tier3 vocabulary/projection became behavior locks; Kiro
  integration docs synced with `.kiro` reality plus a manifest-tool-face governance lock;
  bracket-form supervisor review markers mechanically detected (the #105 silent-skip class
  closed); `pr_review_gate.d.ts` machine-checked against `.mjs` exports with 8 dead hook wrapper
  scripts removed; `scripts/pr_merge.sh` makes the merge entry pipe-safe (exit codes can no
  longer be swallowed); the merge gate blocks when the head CI gate conclusion is failure.
- **gate (failure forensics, Issues #65/#67)**: `npm run gate` archives the failing run's TAP
  output and prints not-ok test names on every red run; `--check-clean` names orphan worktree
  shells — a shell fails the cleanliness gate.
- **ci (win32-signal, Issue #66)**: build+unit signal job on demand — signal, not gate.
- **docs (truth sync, Issues #120/#123/#132)**: TEST_INFRA F8/F9 stand-in coverage,
  DEVELOPER_GUIDE demo/zcode, CLI setup help; parallel surfaces disclosed (core ReAct demo
  subsystem, unwired worktree-pool, twin Studio shells); README/SUBMISSION double-writes
  converged to a single authority and PROJECT.md registered.

## 2.6.0 (2026-11-17) — R2 closeout: engine hardening, demo integrity, governance batch

- **dwf (park deadlock, Issue #31)**: a failed (non-cancelled) ask leaked the runner
  `inFlightAsks` slot — success-only `dwf_ask_complete` plus a `dwf_node_failed` decrement
  guarded on `cancelled:true` meant `engineIdle()` never went true, the park fallback never
  armed, and any run that caught a failed ask then opened a hole/escalation hung to the
  whole-run killTimer as `failed` with the fill door refusing. The counter now settles
  symmetrically; locked by `tests/adversarial/issue-31-park-after-failed-ask.test.ts`.
- **dwf (composition cache, Issue #35/#44)**: `workflow()` composition re-entry imports the
  prior child journal per call site (site-precise matching) — resuming a composed run
  replays the whole subtree at zero token cost instead of re-billing it, so the zero-token
  claim now holds for composition.
- **apps (safety gate wiring, Issue #32)**: the destructive-command policy gate
  (six-pattern blacklist) and reversible apply/undo rollback are wired into the shipped
  facade incident demo — the README intercept+rollback claim is now true of the code path
  judges actually run.
- **apps (real diff statistics, Issue #33)**: the committed migration deliverable replaced
  fabricated Diff Statistics with real per-run measurements from the demo run.
- **tests (e2e assertion hardening, Issue #51)**: the Zero-Token Resumption scenario now
  asserts the actual zero-token replay proof, checkpoint assertions lost their global-db
  fallback, and tier1/tier3 name-vs-assertion mismatches got real assertions.
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
- **docs (governance review-echo batch, Issues #69/#47/#49/#50)**: the supervisor review of
  PR #61 flagged three unaddressed hard findings, all fixed here. ① The 8-gate chain no
  longer defeats itself — artifact restore (`git restore tests/ artifacts/`) now runs at
  step 7 and `--check-clean` at step 8 in both `AGENTS.md` §四 and `docs/WORKFLOW.md` §4
  (check-clean physically cannot pass before the restore it depends on); the restore scope
  is unified verbatim across AGENTS/WORKFLOW/AI-PITFALLS and covers the adversarial
  cli-stress tracked templates discovered in PR #55. ② P-TEST-9's attribution is narrowed
  to the empirically provable sources (adversarial cli-stress templates + the manual demo
  chain; the demo-migration test never writes tracked dirs under mock — supervisor-verified
  against PR #61's original claim). ③ `npm test` gains `--test-concurrency=1`, matching
  `test:integration`/`test:adversarial` so cross-command fingerprint comparison is sound.
  Also: the four judge-facing 404 repo links (blog ×2, video script, storyboard) now point
  at the real repository (#47); `docs/KIRO_INTEGRATION.md`'s hook table and `lifecycle.json`
  example mirror the shipped `.kiro/hooks/lifecycle.json` verbatim — the phantom
  `pre-commit.js` is gone, the real `Stop` hook is `stop-workflow-gate.js` (#49); and
  `QUICKSTART.md` drops the Windows-only `npm.cmd install` premise and re-tags its fences
  `shell` so every command runs verbatim on macOS/Linux (#50).
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
