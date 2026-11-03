/**
 * `/workflow run-script <script.ts>` — run a facade script in the sandbox with
 * journal-backed deterministic replay.
 */
import * as path from 'node:path';
import { runFacadeScript } from '../../dwf/runner.js';
import { resolveLang, t } from '../i18n/index.js';

export async function executeRunScript(
  scriptPath: string,
  options: {
    argsJson?: string;
    resume?: string;
    amend?: string;
    mock?: boolean;
    dbPath?: string;
    failoverProviders?: string[];
    ultracode?: boolean;
    maxConcurrency?: string;
    live?: string;
    /**
     * Rewrite `<runDir>/graph.html` after every emitted event by re-folding the
     * accumulated stream through the same pure journal projection the cold
     * replay uses (live-graph projection rule). A failed write degrades to one warning
     * and never fails the run (mirror semantics, see runner.ts).
     */
    watchGraph?: boolean;
    lang?: string;
    quiet?: boolean;
    /**
     * Workspace the run executes in (`.workflow/` journal resolution and the
     * sandbox child's cwd). Defaults to `process.cwd()`; `replay` forwards the
     * base directory it resolved the run's journal from.
     */
    cwd?: string;
  },
): Promise<number> {
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

  const started = Date.now();
  let result;
  try {
    result = await runFacadeScript({
      scriptPath,
      args,
      resumeRunId: options.resume,
      amendRunId: options.amend,
      dbPath: options.dbPath,
      cwd: options.cwd,
      failoverProviders: options.failoverProviders,
      maxConcurrency: options.ultracode
        ? 16
        : options.maxConcurrency ? Number(options.maxConcurrency) : undefined,
    liveHtmlPath: options.live,
      watchGraph: options.watchGraph,
      onEvent: (e) => {
        if (options.quiet) return;
        switch (e.type) {
          case 'dwf_phase':
            console.log(`\n--- ${e.data.phase} ---`);
            break;
          case 'dwf_actor_created':
            console.log(`  agent: ${e.data.name}`);
            break;
          case 'dwf_log':
            console.log(`  log: ${e.data.message}`);
            break;
          case 'dwf_report':
            console.log(`  report: ${JSON.stringify(e.data.item)}`);
            break;
          case 'dwf_ask_start':
            console.log(`  ask → ${e.data.actor} (${e.data.siteId})`);
            break;
          case 'dwf_ask_complete':
            console.log(`  ✔ ask done (${e.data.siteId})`);
            break;
          case 'dwf_replay_hit':
            console.log(`  ⚡ replayed from journal: ${e.data.siteId}#${e.data.ordinal} (0 provider calls)`);
            break;
          case 'dwf_amend_hit':
            console.log(`  ♻ amended run reused: ${e.data.siteId}#${e.data.ordinal} (0 provider calls)`);
            break;
          case 'dwf_amend_diverged':
            console.log(`  ⑂ amended run diverged: ${e.data.siteId}#${e.data.ordinal} (executing live)`);
            break;
          case 'dwf_world_run':
            console.log(`  $ ${e.data.cmd} ${(e.data.args as string[] | undefined)?.join(' ') ?? ''}`);
            break;
          case 'dwf_artifact':
            console.log(`  📄 artifact ${e.data.id} v${e.data.version} (${e.data.bytes} bytes)`);
            break;
          case 'dwf_call_error':
            console.error(`  ✖ ${e.data.siteId ?? e.data.op}: ${e.data.error}`);
            break;
          case 'dwf_resume_takeover':
            // Stale-run takeover (engine crash-recovery rule): the recorded host pid is dead
            // (or the row predates pid recording) — this host is continuing.
            if (e.data.deadPid === undefined) {
              console.log(t('MSG_DWF_RESUME_TAKEOVER_NO_PID', undefined, resolveLang(options.lang)));
            } else {
              console.log(t('MSG_DWF_RESUME_TAKEOVER', { pid: Number(e.data.deadPid) }, resolveLang(options.lang)));
            }
            break;
          default:
            break;
        }
      },
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  if (result.status === 'compile_failed') {
    console.error(`✖ facade script failed compilation — ${result.diagnostics?.length ?? 0} diagnostic(s):`);
    for (const d of result.diagnostics ?? []) {
      console.error(`  ${scriptPath}:${d.line}:${d.column}  ${d.category}(${d.code}): ${d.message}`);
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
    return 0;
  }

  if (result.status === 'completed') {
    console.log(`\n✔ run ${result.runId} completed in ${seconds}s`);
    console.log(`  asks: ${result.stats.asks} (replayed from journal: ${result.stats.replayHits})`);
    console.log(`  result: ${JSON.stringify(result.value)}`);
    console.log(`  journal: ${options.dbPath ?? path.join('.workflow', 'dwf.sqlite')}`);
    return 0;
  }

  console.error(`\n✖ run ${result.runId} failed in ${seconds}s: ${result.error}`);
  console.error(`  resume with: /workflow run-script ${scriptPath} --resume ${result.runId}`);
  return 1;
}
