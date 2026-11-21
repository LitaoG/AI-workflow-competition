/**
 * `/workflow run-script <script.ts>` — run a facade script in the sandbox with
 * journal-backed deterministic replay.
 */
import * as path from 'node:path';
import { resolveDwfJournalPath, runFacadeScript } from '../../dwf/runner.js';
import { createProgressPrinter } from '../../dwf/progress.js';
import { printDwfEvent } from '../console-events.js';
import { resolveLang } from '../i18n/index.js';
import { serveRunUntilStopped } from './serve.js';

export async function executeRunScript(
  scriptPath: string,
  options: {
    argsJson?: string;
    resume?: string;
    amend?: string;
    /** Rerun a prior run with the same script from `from` (Issue #116). */
    rerun?: string;
    /** Site id where a --rerun starts executing live. */
    from?: string;
    mock?: boolean;
  /** Whole-run wall clock override in ms (see runFacadeOptions.runTimeoutMs). */
  runTimeoutMs?: string;
    dbPath?: string;
    failoverProviders?: string[];
    ultracode?: boolean;
    maxConcurrency?: string;
    /** Run-level output-token budget (read-only inside the script). */
    budgetTotal?: string;
    /** Externally authorized world.run commands (repeatable --approve-cmd, Issue #127). */
    approveCmd?: string[];
    approvedCommands?: string[];
    live?: string;
    /**
     * Rewrite `<runDir>/graph.html` after every emitted event by re-folding the
     * accumulated stream through the same pure journal projection the cold
     * replay uses (GOAL.md 阶段 7.3). ON by default since Issue #168 — the
     * graph opens as the full pending plan (dwf_plan skeleton) and lights up
     * as the run goes; `--no-watch-graph` / explicit false disables it. A
     * failed write degrades to one warning and never fails the run (mirror
     * semantics, see runner.ts).
     */
    watchGraph?: boolean;
    /**
     * `--progress`: swap the human printer for the structured `[wf]` channel
     * (src/dwf/progress.ts) that harness agents mirror into their todo list.
     */
    progress?: boolean;
    lang?: string;
    quiet?: boolean;
    /**
     * Workspace the run executes in (`.workflow/` journal resolution and the
     * sandbox child's cwd). Defaults to `process.cwd()`; `replay` forwards the
     * base directory it resolved the run's journal from.
     */
    cwd?: string;
    /**
     * Mission D `--ui`: once the run settles (completed / parked / failed),
     * serve the AI-Workflow Studio for it and raise the default browser —
     * live SSE stream plus inline A2UI resume for parked runs. Stays in the
     * foreground until Ctrl+C.
     */
    ui?: boolean;
  },
): Promise<number> {
  const progressPrinter = createProgressPrinter();
  let args: Record<string, unknown> = {};
  if (options.argsJson) {
    try {
      args = JSON.parse(options.argsJson);
    } catch (err) {
      console.error(`Error: --args is not valid JSON: ${(err as Error).message}`);
      return 1;
    }
  }
  if (options.resume && options.amend) {
    console.error('Error: pass either --resume or --amend, not both.');
    return 1;
  }
  if (options.rerun && (options.resume || options.amend)) {
    console.error('Error: pass --rerun alone, not with --resume or --amend.');
    return 1;
  }
  if (options.rerun && !options.from) {
    console.error('Error: --rerun needs --from <siteId> (`workflow check <file>` lists the site table).');
    return 1;
  }
  const budgetTotal = options.budgetTotal === undefined ? undefined : Number(options.budgetTotal);
  if (budgetTotal !== undefined && (!Number.isInteger(budgetTotal) || budgetTotal <= 0)) {
    console.error('Error: --budget-total must be a positive integer.');
    return 1;
  }
  const runTimeoutMs = options.runTimeoutMs === undefined ? undefined : Number(options.runTimeoutMs);
  if (runTimeoutMs !== undefined && (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0)) {
    console.error('Error: --run-timeout must be a positive number of milliseconds.');
    return 1;
  }

  const started = Date.now();
  let result;
  try {
    result = await runFacadeScript({
      scriptPath,
      args,
      resumeRunId: options.resume,
      amendRunId: options.amend,
      rerunRunId: options.rerun,
      rerunFromSite: options.from,
      dbPath: options.dbPath,
      cwd: options.cwd,
      failoverProviders: options.failoverProviders,
      budgetTotal,
      approvedCommands: options.approvedCommands ?? options.approveCmd,
      mock: options.mock,
      runTimeoutMs,
      confirmWorldRun: process.stdin.isTTY && process.stdout.isTTY
        ? async (cmd: string, args: string[]) => {
            // Issue #127 direction 1, source ③: interactive per-call confirmation.
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await new Promise<string>((resolve) => {
                rl.question(`[workflow] world.run: run "${cmd} ${args.join(' ')}"? [y/N] `, resolve);
              });
              return /^y(es)?$/i.test(answer.trim());
            } finally {
              rl.close();
            }
          }
        : undefined,
      maxConcurrency: options.ultracode
        ? 16
        : options.maxConcurrency ? Number(options.maxConcurrency) : undefined,
    liveHtmlPath: options.live,
      watchGraph: options.watchGraph,
      onEvent: (e) => {
        if (options.quiet) return;
        if (options.progress) {
          progressPrinter(e);
          return;
        }
        printDwfEvent(e, resolveLang(options.lang));
      },
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  // Issue #146: the journal lives under the RUN's cwd (--cwd), not the CLI
  // process's — resolve it through the same helper the runner used, or the
  // --ui Studio opened a journal at the wrong path and reported
  // "run … not found in the journal" for its own run.
  const journalPath = resolveDwfJournalPath(path.resolve(options.cwd ?? process.cwd()), options.dbPath);

  if (result.status === 'compile_failed') {
    console.error(`✖ facade script failed compilation — ${result.diagnostics?.length ?? 0} diagnostic(s):`);
    if (result.error && (!result.diagnostics || result.diagnostics.length === 0)) {
      console.error(`  ${result.error}`);
    }
    for (const d of result.diagnostics ?? []) {
      console.error(`  ${scriptPath}:${d.line}:${d.column}  ${d.category}(${d.code}): ${d.message}`);
      if (d.hint) console.error(`    💡 ${d.hint}`);
    }
    return 1;
  }

  if (result.status === 'parked') {
    if (result.parkedAt?.kind === 'escalation') {
      console.log(`\n❓ run ${result.runId} parked awaiting an answer in ${seconds}s`);
      console.log(`  question (${result.parkedAt.name}): ${result.parkedAt.prompt}`);
      console.log(`  asks so far: ${result.stats.asks} (journalled — an answer resumes at zero cost)`);
      console.log(`  answer it: node bin/workflow.js answer ${result.runId} ${result.parkedAt.name} "<text>"`);
    } else {
      console.log(`\n⏸ run ${result.runId} parked at hole "${result.parkedAt?.name}" in ${seconds}s`);
      console.log(`  prompt: ${result.parkedAt?.prompt}`);
      console.log(`  asks so far: ${result.stats.asks} (journalled — a fill replays them at zero cost)`);
      console.log(`  fill it: node bin/workflow.js fill ${result.runId} ${result.parkedAt?.name} <bodyFile>`);
    }
    if (options.ui) {
      console.log('  --ui: opening the Studio — submit the answer / hole body right in the browser.');
      return serveRunUntilStopped(result.runId, journalPath);
    }
    return 0;
  }

  if (result.status === 'completed') {
    console.log(`\n✔ run ${result.runId} completed in ${seconds}s`);
    console.log(`  asks: ${result.stats.asks} (replayed from journal: ${result.stats.replayHits})`);
    console.log(`  result: ${JSON.stringify(result.value)}`);
    console.log(`  journal: ${journalPath}`);
    if (options.ui) {
      return serveRunUntilStopped(result.runId, journalPath);
    }
    return 0;
  }

  console.error(`\n✖ run ${result.runId} failed in ${seconds}s: ${result.error}`);
  console.error(`  resume with: /workflow run-script ${scriptPath} --resume ${result.runId}`);
  if (options.ui) {
    return serveRunUntilStopped(result.runId, journalPath);
  }
  return 1;
}
