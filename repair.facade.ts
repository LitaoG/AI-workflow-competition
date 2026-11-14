// Repair verification: the AI-Workflow engine verifying its own repair round.
//
// Every fix from the 2026-11-14 self-review gets an independent adversarial
// verifier (fresh agent, reads the code itself, does not trust the claim);
// then real gates run in the worktree: CLI entry, tsc build, unit suite, PBT.
//
//   workflow check repair.facade.ts
//   workflow run-script repair.facade.ts --cwd . \
//     --max-concurrency 4 --approve-cmd node --approve-cmd npm
//
// Run from the MAIN repo's runner with --cwd pointing at this worktree so the
// journal, world reads and gates all execute here.

interface Verdict {
  /** true only if the original problem cannot recur given the changed code. */
  fixed: boolean;
  /** Risk the change regresses existing behavior: none | low | medium | high. */
  regressionRisk: 'none' | 'low' | 'medium' | 'high';
  /** One or two sentences of concrete evidence (file:line), or why not fixed. */
  evidence: string;
}

const REPO = 'C:/Users/86183/Desktop/AI-workflow-fixes';

const fixes: Array<{ key: string; claim: string; changed: string }> = [
  {
    key: 'cli-version',
    claim: 'workflow --version printed the hardcoded "ai-workflow 1.0.0" while package.json says 2.0.0 (src/cli/index.ts:70).',
    changed: 'src/cli/index.ts now derives the version from package.json at runtime (cliVersion() helper, tries dist and src layouts).',
  },
  {
    key: 'skill-doc-drift',
    claim: 'SKILL.md and docs/INTEGRATION.md instructed `workflow script check/run`, commands that do not exist (real: check / run-script); the described stats line format was also wrong.',
    changed: 'skills/ai-workflow/SKILL.md (authoring loop + worked example), docs/INTEGRATION.md (both blocks), skills/ai-workflow/examples/review.facade.ts header — all now use `workflow check` / `workflow run-script` and the real `asks: N (replayed from journal: M)` stats line.',
  },
  {
    key: 'http-500-transient',
    claim: 'attempt-classifier.ts TRANSIENT regex listed 502/503/504 but not 500, so HTTP 500 provider errors were fatal: never retried, failover chain skipped.',
    changed: 'src/agent/attempt-classifier.ts:20 added \\b500\\b to TRANSIENT; test added in tests/unit/dwf/attempt-classifier.test.ts.',
  },
  {
    key: 'cache-control-400',
    claim: 'anthropic-provider sent a top-level body.cache_control field (default true), which the real Messages API rejects with HTTP 400.',
    changed: 'src/agent/anthropic-provider.ts: default cacheControl is now false; when enabled the marker rides the SYSTEM CONTENT BLOCK (the only valid form) and no top-level field is ever sent; tests updated in tests/unit/agent-providers.test.ts.',
  },
  {
    key: 'bedrock-fake-success',
    claim: 'bedrock-provider.ts:90 catch-all swallowed every AWS failure and returned MockProvider output as a successful response, violating the rpc.ts never-silently-degrade pillar.',
    changed: 'src/agent/bedrock-provider.ts generate() now rethrows from the real-API path; the mock fallback remains ONLY for missing credentials (disclosed by checkHealth); test flipped in tests/unit/bedrock-provider.test.ts.',
  },
  {
    key: 'model-binding-dropped',
    claim: 'runner.ts:597 forwarded actorCreated notify frames without the model field (protocol.ts had no model member), making the Issue #38 persona model binding silently inert.',
    changed: 'src/dwf/protocol.ts ChildNotifyFrame gained `model?: string`; src/dwf/runner.ts:597 forwards frame.model as the 5th argument to engine.onActorCreated. child-bootstrap.ts already sent it.',
  },
  {
    key: 'mock-flag-noop',
    claim: '--mock was accepted and silently dropped for facade runs (run-script.ts declared mock but never read it; RunFacadeOptions had no mock field) — with a real provider configured, a "mock" run made real provider calls.',
    changed: 'src/dwf/runner.ts RunFacadeOptions gained mock?: boolean; runFacadeScript scopes AI_WORKFLOW_FAST/DEEP_PROVIDER=mock for the run and restores them in finally; src/cli/commands/run-script.ts passes options.mock; run-script/run CLI commands expose --mock.',
  },
  {
    key: 'abort-reports-completed',
    claim: 'core/workflow.ts:201 assigned finalStatus from failedSteps only, so an aborted run returned "completed" and emitted workflow_complete; in-flight steps also never observed the abort.',
    changed: 'src/core/workflow.ts: abort now yields status "aborted" and emits workflow_aborted; abort() additionally aborts the active batch (this.activeBatch) so in-flight steps see the signal; tests in tests/unit/core-abort-concurrency-timeout.test.ts.',
  },
  {
    key: 'tautological-kiro-tests',
    claim: 't2-10-kiro.test.ts: five subtests asserted fs.existsSync / stringified literals / hardcoded constants — none could fail, none touched the product, all counted toward the tier pass total.',
    changed: 'tests/e2e/tier2-boundaries/t2-10-kiro.test.ts rewritten: two REAL executed tests (spawnSync the hook, assert exit 0/2 contract + stderr reason) with a comment documenting why the four cannot-fail subtests were removed (src has no Kiro surface at all).',
  },
  {
    key: 'timeouts-never-enforced',
    claim: 'core/workflow.ts:335 executed steps with no timeout wrapper and no concurrency cap: StepDefinition.timeoutMs and WorkflowOptions.maxConcurrency were accepted but silently ignored.',
    changed: 'src/core/workflow.ts executePhaseSteps: withStepTimeout race enforces timeoutMs (with AbortSignal.any composite signal so MCP/gate children stop), and a worker pool bounds in-flight steps to maxConcurrency; actionStep builder now forwards timeoutMs; tests in tests/unit/core-abort-concurrency-timeout.test.ts.',
  },
  {
    key: 'fanout-ghost-workers',
    claim: 'core/step.ts:283 fanOutStep kept pulling queued items after a worker failure or cancellation (no signal check, no stop flag) — ghost workers ran side effects whose results were discarded.',
    changed: 'src/core/step.ts executeWorker: stops on `stopped` flag (set on first error) or ctx.signal.aborted before each pull; test in tests/unit/core-abort-concurrency-timeout.test.ts.',
  },
  {
    key: 'win32-spawn-and-run-timeout',
    claim: 'world.run("npm") failed ENOENT on Windows (npm is npm.cmd; shell:false spawn), and the whole-run timeout was hardcoded 600s with no CLI/env override.',
    changed: 'src/process-supervision.ts gained resolveWindowsSpawnCommand (PATH/PATHEXT lookup routes .cmd/.bat shims through cmd /c; used by spawnSupervised); src/dwf/runner.ts resolves runTimeoutMs from options ?? AI_WORKFLOW_RUN_TIMEOUT_MS ?? 600s; CLI --run-timeout added to run and run-script; test in tests/unit/win32-spawn-resolver.test.ts.',
  },
];

phase('Verify fixes');
const verdicts = await Promise.all(
  fixes.map((f, i) =>
    agent(`fix-verifier-${i}`).ask<Verdict>(
      `You are adversarially verifying a bug fix in the repository checked out at ${REPO} ` +
        `(a git worktree of the AI-Workflow engine). Read the actual code there yourself — do NOT trust the claim. ` +
        `ORIGINAL PROBLEM: ${f.claim} ` +
        `FIX APPLIED (claim by the fixer): ${f.changed} ` +
        `Open the cited files (absolute paths under ${REPO}) plus enough surrounding context, including the updated tests where mentioned. ` +
        `fixed=true only if the original problem cannot recur as described. Judge regressionRisk honestly (a behavior change like a flipped default counts as low/medium if intentional and tested).`,
    ),
  ),
);
const confirmed = verdicts.filter((v) => v.fixed).length;
log(`${confirmed}/${fixes.length} fixes independently confirmed`);

phase('Gates');
const cliGate = await world.run('node', ['bin/workflow.js', '--version'], { timeoutMs: 30_000 });
if (cliGate.exitCode !== 0 || !cliGate.stdout.includes('2.0.0')) {
  throw new Error(`CLI gate failed (want exit 0 + "2.0.0", got ${cliGate.exitCode}: ${cliGate.stdout} ${cliGate.stderr})`);
}
log('CLI entry OK — version fix live');
// npm directly now: exercises resolveWindowsSpawnCommand (the win32 .cmd fix) live.
const build = await world.run('npm', ['run', 'build'], { timeoutMs: 300_000 });
if (build.exitCode !== 0) throw new Error(`build gate failed: ${build.stderr.slice(-2000)}`);
log('tsc build clean');
const unit = await world.run('npm', ['run', 'test:unit'], { timeoutMs: 900_000 });
if (unit.exitCode !== 0) throw new Error(`unit gate failed: ${unit.stderr.slice(-2000)}`);
const unitLine = unit.stdout.split(/\r?\n/).reverse().find((l) => l.includes('ℹ tests')) ?? '';
log(`unit suite green ${unitLine.trim()}`);
const pbt = await world.run('npm', ['run', 'test:pbt'], { timeoutMs: 600_000 });
if (pbt.exitCode !== 0) throw new Error(`pbt gate failed: ${pbt.stderr.slice(-2000)}`);
log('property-based suite green');

phase('Report');
const rows = fixes.map((f, i) => {
  const v = verdicts[i]!;
  return `| ${v.fixed ? '✔' : '✖'} | ${f.key} | ${v.regressionRisk} | ${v.evidence} |`;
});
const markdown = [
  `# AI-Workflow repair round — verification report`,
  ``,
  `**Result:** ${confirmed}/${fixes.length} fixes independently confirmed. Gates: CLI+version ✔, build ✔, unit ✔, PBT ✔.`,
  ``,
  `| fixed | fix | regression risk | verifier evidence |`,
  `| --- | --- | --- | --- |`,
  ...rows,
  ``,
  `## Deferred (raw findings never adversarially confirmed — not blindly fixed)`,
  ``,
  `- 20 unverified raw findings from the 6-dimension review (medium/low; incl. retry-orchestrator total-attempt budget never reset, RunFacadeResult.reportItems hardcoded [], run-lineage import order, cross-phase forward-dependency deadlock, permission-manager stateless confirmation, SUBMISSION.md fingerprints, demo README --interrupt-at, mcp call exit-code masking, setup-interop bin path, coverage-gate include list).`,
  `- Each needs its own confirm-then-fix pass; fixing unverified claims risks breaking correct code.`,
].join('\n');
await artifact.markdown('repair-verification', markdown, { title: 'Repair round verification' });
report({ fixes: fixes.length, confirmed, gates: 4 });

return { fixes: fixes.length, confirmed, gates: { cli: cliGate.exitCode, build: build.exitCode, unit: unit.exitCode, pbt: pbt.exitCode } };
