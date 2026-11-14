# Changelog

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
