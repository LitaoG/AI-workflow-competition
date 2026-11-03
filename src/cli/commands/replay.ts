/**
 * `/workflow replay <runId>` — resume a historical run for real.
 *
 * Two mutually exclusive paths, resolved from durable storage (never from the
 * run id's shape):
 *
 * 1. **Facade-script run** — a row in the `dwf_runs` journal (`.workflow/
 *    dwf.sqlite`). The command is a pure entry adapter: it re-delegates to
 *    `run-script --resume` (`executeRunScript`), whose runner already owns
 *    journal short-circuiting, stale-running pid takeover and script-hash
 *    binding. Nothing about resume semantics is re-implemented here.
 * 2. **Core builder run** — checkpoints recorded by `workflow run`. The
 *    definition is rebuilt from the byte copy `workflow run` persisted into
 *    the run directory (`workflow.source.*`), and the rebuilt Workflow is
 *    executed for real against the original run's store: completed steps
 *    short-circuit through the inputHash-bound checkpoints at zero cost,
 *    failed steps genuinely re-execute their executors.
 *
 * If a run's definition/script cannot be rebuilt (cleaned run directory,
 * unreadable script), the command fails with an explicit `[StorageError]`
 * message and a non-zero exit code — it never fabricates a successful replay
 * (the former behavior wrote fabricated completed checkpoints and printed an
 * unconditional verification banner, which is exactly what this command must
 * not do).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { domainError, toDomainError } from '../../domain/errors.js';
import { Workflow, defineWorkflow } from '../../core/workflow.js';
import { WorkflowStatus, DwfRunRow, WorkflowEvent } from '../../types.js';
import { DualStateStore } from './run.js';
import { executeRunScript } from './run-script.js';
import { t, resolveLang, SupportedLang } from '../i18n/index.js';

export interface ReplayCommandOptions {
  step?: string;
  /** Workflow definition file to rebuild a core builder run from (overrides the persisted copy). */
  file?: string;
  mock?: boolean;
  lang?: string;
  forceRecompute?: boolean;
  resumeFromFailed?: boolean | string;
  /**
   * Base directory for `.workflow` storage resolution. Defaults to
   * `process.cwd()`; tests inject a workspace so replays never touch the
   * repository.
   */
  cwd?: string;
}

async function withRetry<T>(fn: () => Promise<T> | T, maxRetries = 3): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isLocked =
        err?.message?.includes('database is locked') ||
        err?.message?.includes('SQLITE_BUSY') ||
        err?.code === 'SQLITE_BUSY';
      if (isLocked && attempt <= maxRetries) {
        const jitter = Math.floor(Math.random() * 50);
        await new Promise((resolve) => setTimeout(resolve, 100 + jitter));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Execute `replay <runId>`: resume the run through its real engine and return
 * the process exit code. Zero when the rebuilt/resumed run completes, non-zero
 * when steps still fail or the run cannot be rebuilt at all.
 *
 * @param runId - The historical run to resume (facade or core builder run).
 * @param options - Replay options (see {@link ReplayCommandOptions}).
 */
export async function executeReplay(runId: string, options: ReplayCommandOptions): Promise<number> {
  const lang = resolveLang(options.lang);
  const base = path.resolve(options.cwd ?? process.cwd());

  try {
    // ---- Path (a): facade-script run — a row in the dwf_runs journal. ----
    // The journal db is only opened when it exists: a replay must never create
    // storage as a side effect of looking for a run.
    const dwfDbPath = path.join(base, '.workflow', 'dwf.sqlite');
    if (fs.existsSync(dwfDbPath)) {
      const dwfStore = new SQLiteStateStore(dwfDbPath);
      let facadeRun: DwfRunRow | null;
      try {
        facadeRun = await withRetry(() => dwfStore.getDwfRun(runId));
      } finally {
        dwfStore.close();
      }
      if (facadeRun) {
        return replayFacadeRun(facadeRun, { runId, dwfDbPath, base, lang });
      }
    }

    // ---- Path (b): core builder run — rebuild + real execution. ----
    return await replayCoreRun(runId, options, base, lang);
  } catch (err: unknown) {
    const tagged = toDomainError(err, 'StorageError');
    console.error(`[${tagged.tag}] ${tagged.message}`);
    return 1;
  }
}

/**
 * Path (a): delegate a facade-script run to `run-script --resume`. The runner
 * replays completed nodes from the journal at zero cost, re-executes failed
 * ones, and takes over stale `running` rows whose host pid is dead — all
 * existing, tested engine behavior that replay only adapts the entry for.
 */
async function replayFacadeRun(
  row: DwfRunRow,
  ctx: { runId: string; dwfDbPath: string; base: string; lang: SupportedLang },
): Promise<number> {
  const { runId, dwfDbPath, base, lang } = ctx;
  if (!row.scriptPath || !fs.existsSync(row.scriptPath)) {
    failStorage(
      t('ERR_REPLAY_SCRIPT_UNREADABLE', { runId, path: row.scriptPath ?? '<not recorded>' }, lang),
      { runId, scriptPath: row.scriptPath ?? null },
    );
    return 1;
  }
  console.log(t('MSG_REPLAY_FACADE_RESUME', { runId }, lang));
  // Pure entry adaptation: the original args ride along so the resumed run
  // sees the same script input; exit-code mapping is run-script's own.
  return executeRunScript(row.scriptPath, {
    resume: runId,
    argsJson: row.argsJson,
    dbPath: dwfDbPath,
    lang,
    cwd: base,
  });
}

/**
 * Path (b): rebuild a core builder run's Workflow from its persisted
 * definition and execute it for real against the original run's store.
 */
async function replayCoreRun(
  runId: string,
  options: ReplayCommandOptions,
  base: string,
  lang: SupportedLang,
): Promise<number> {
  const runDir = path.join(base, '.workflow', 'runs', runId);
  const perRunDbPath = path.join(runDir, 'checkpoints.db');
  const globalDbPath = path.join(base, '.workflow', 'runs.db');

  if (!fs.existsSync(perRunDbPath) && !fs.existsSync(globalDbPath)) {
    failStorage(t('ERR_REPLAY_RUN_NOT_FOUND', { runId }, lang), { runId });
    return 1;
  }
  const primaryDbPath = fs.existsSync(perRunDbPath) ? perRunDbPath : globalDbPath;

  const primary = new SQLiteStateStore(primaryDbPath);
  // Same dual layout the run command wrote (per-run db + global mirror), so a
  // replay leaves the same two stores consistent; the mirror is only opened
  // when it already exists — a replay never creates new storage files.
  const secondary =
    fs.existsSync(globalDbPath) && path.resolve(globalDbPath) !== path.resolve(primaryDbPath)
      ? new SQLiteStateStore(globalDbPath)
      : undefined;
  const store = new DualStateStore(primary, secondary);

  try {
    const checkpoints = await withRetry(() => primary.getAllCheckpoints(runId));
    const stepIds = Object.keys(checkpoints);
    if (stepIds.length === 0) {
      failStorage(t('ERR_REPLAY_RUN_NOT_FOUND', { runId }, lang), { runId, dbPath: primaryDbPath });
      return 1;
    }

    if (options.step && !checkpoints[options.step]) {
      console.error(t('ERR_STEP_NOT_FOUND', { stepId: options.step, runId }, lang));
      return 1;
    }

    // ---- Definition rebuild: the saved copy, or an explicit --file. ----
    const persistedCopy = fs.existsSync(runDir)
      ? fs.readdirSync(runDir).find((name) => /^workflow\.source\./.test(name))
      : undefined;
    const sourcePath = options.file
      ? path.resolve(base, options.file)
      : persistedCopy
        ? path.join(runDir, persistedCopy)
        : undefined;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      failStorage(t('ERR_REPLAY_DEFINITION_MISSING', { runId }, lang), {
        runId,
        runDir,
        hint: 'pass the original workflow file via --file <path>',
      });
      return 1;
    }

    let wf: Workflow;
    try {
      const mod = await import(pathToFileURL(sourcePath).href);
      let loaded: unknown = mod.default ?? mod.workflow;
      if (loaded && !(loaded instanceof Workflow) && typeof loaded === 'object' && ('steps' in loaded || 'phases' in loaded)) {
        loaded = defineWorkflow(loaded as Parameters<typeof defineWorkflow>[0]);
      }
      if (!loaded || !(loaded instanceof Workflow)) {
        failStorage(t('ERR_REPLAY_DEFINITION_INVALID', { path: sourcePath }, lang), { path: sourcePath });
        return 1;
      }
      wf = loaded;
    } catch (err: unknown) {
      failStorage(
        t('ERR_REPLAY_DEFINITION_UNLOADABLE', { path: sourcePath, reason: (err as Error).message }, lang),
        { path: sourcePath },
      );
      return 1;
    }

    // ---- Invalidation: the honest replacement for the old fake re-completion ----
    // ---- writes. A deleted checkpoint makes the engine run the real executor. ----
    // ---- Deleted through the composed store so the mirror (the fallback read ----
    // ---- path) cannot silently cancel the invalidation.                      ----
    if (options.forceRecompute) {
      await withRetry(() => store.deleteCheckpoints(runId));
      console.log(t('MSG_REPLAY_INVALIDATED', { count: stepIds.length }, lang));
    } else if (options.step) {
      await withRetry(() => store.deleteCheckpoints(runId, options.step));
      console.log(t('MSG_REPLAY_INVALIDATED', { count: 1 }, lang));
    }

    // ---- Real execution: the engine's inputHash-bound checkpoint short-circuit ----
    // ---- decides per step — completed+matching steps cost nothing, failed or  ----
    // ---- stale steps run their executors again. Counts below are the real    ----
    // ---- engine events, not a prediction.                                    ----
    const stats = { executed: 0, skipped: 0, failed: 0 };
    const eventStepId = (evt: WorkflowEvent): string => evt.stepId ?? 'unknown';
    const eventData = (evt: WorkflowEvent): Record<string, unknown> =>
      typeof evt.data === 'object' && evt.data !== null ? (evt.data as Record<string, unknown>) : {};
    wf.on('step_complete', (evt: WorkflowEvent) => {
      stats.executed++;
      console.log(`  ${t('MSG_STEP_SUCCESS', { stepId: eventStepId(evt), duration: Number(eventData(evt).durationMs ?? 0) }, lang)}`);
    });
    wf.on('step_skipped', (evt: WorkflowEvent) => {
      stats.skipped++;
      console.log(`  ${t('MSG_REPLAY_SKIPPED', { stepId: eventStepId(evt) }, lang)}`);
    });
    wf.on('step_failed', (evt: WorkflowEvent) => {
      stats.failed++;
      console.error(`  ${t('MSG_STEP_FAILED', { stepId: eventStepId(evt), error: String(eventData(evt).error ?? 'unknown error') }, lang)}`);
    });

    console.log(t('MSG_REPLAY_REBUILD', { runId, path: sourcePath }, lang));

    const startedAt = Date.now();
    let status: WorkflowStatus = 'failed';
    let unexpectedError: string | undefined;
    try {
      const result = await wf.run({
        runId,
        mockMode: options.mock ?? false,
        lang,
        stateStore: store,
      });
      status = result.status;
    } catch (err: unknown) {
      // A step failure already emitted `step_failed` (counted above); any other
      // engine failure (deadlock, abort) surfaces here and must not be hidden.
      status = 'failed';
      unexpectedError = (err as Error).message;
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log('');
    console.log(t('MSG_REPLAY_SUMMARY', { executed: stats.executed, skipped: stats.skipped, failed: stats.failed }, lang));

    if (status === 'completed') {
      console.log(`\n${t('MSG_WORKFLOW_SUCCESS', { duration: seconds }, lang)}`);
      return 0;
    }
    if (unexpectedError !== undefined && stats.failed === 0) {
      console.error(`  ✖ ${unexpectedError}`);
    }
    console.error(`\n${t('MSG_WORKFLOW_FAILED', { runId }, lang)}`);
    return 1;
  } finally {
    store.close();
  }
}

/** Report a replay failure as a tagged StorageError — never a bare throw, never a fabricated success. */
function failStorage(message: string, details: Record<string, unknown>): void {
  const err = domainError('StorageError', message, { details });
  console.error(`[${err.tag}] ${err.message}`);
}
