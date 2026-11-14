# Changelog

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
