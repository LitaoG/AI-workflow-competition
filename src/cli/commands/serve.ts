/**
 * `/workflow serve <runId>` — live execution view: an HTTP server serving the
 * AI-Workflow Studio with SSE event streaming. Attach it to a PARKED or
 * RUNNING script and watch nodes land in real time, answer escalations /
 * fill holes inline (A2UI), and it keeps serving after the run settles
 * (audit view).
 */

import * as path from 'node:path';
import { createSQLiteStore } from '../../state/store.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore, DwfRunRow } from '../../types.js';
import { startLiveServer, LiveServerActions } from '../../dwf/live.js';
import { executeAnswer } from './answer.js';
import { executeFill } from './fill.js';
import { openInBrowser } from './open-browser.js';

export interface ServeCommandOptions {
  db?: string;
  port?: string;
  lang?: string;
  /** commander `--no-open` lands here as `open: false` (default true). */
  open?: boolean;
  noOpen?: boolean;
  /** Issue #156: SVG canvas + zero-dep WebSocket push + time travel (default off). */
  studio?: boolean;
}

/**
 * After a hole fill the continuation lives under a NEW amend run id; find it
 * so the Studio can follow the lineage (`?run=<child>`).
 */
async function findChildRun(
  store: SQLiteStateStore & DwfJournalStore,
  parentRunId: string,
): Promise<string | undefined> {
  if (!store.listDwfRuns) return undefined;
  const runs: DwfRunRow[] = await store.listDwfRuns({ limit: 25 });
  const child = runs.find((r) => r.parentRunId === parentRunId);
  return child?.runId;
}

export async function executeServe(runId: string, opts: ServeCommandOptions): Promise<number> {
  const dbPath = opts.db ?? path.join(process.cwd(), '.workflow', 'dwf.sqlite');
  return serveRunUntilStopped(runId, dbPath, {
    port: opts.port,
    noOpen: opts.noOpen || opts.open === false,
    studio: opts.studio === true,
    lang: opts.lang,
  });
}

/**
 * Serve the Studio for `runId` until Ctrl+C. Shared by `workflow serve` and
 * `run/run-script --ui` (Mission D: the run's settled state opens straight
 * into the live dashboard — A2UI resume included).
 */
export async function serveRunUntilStopped(
  runId: string,
  dbPath: string,
  opts: { port?: string; noOpen?: boolean; studio?: boolean; lang?: string } = {},
): Promise<number> {
  const port = Number(opts.port ?? 4649);
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  // A2UI wiring: the forms POST here and reuse the exact answer/fill cores the
  // CLI uses — one journal, one replay pool, no parallel implementation.
  const actions: LiveServerActions = {
    answer: async (answerRunId, questionId, text) => {
      const exit = await executeAnswer(answerRunId, questionId, [text], { dbPath });
      return { ok: exit === 0, message: exit === 0 ? 'answer journalled — run resuming, streaming…' : `answer failed (exit ${exit}) — see the serve console` };
    },
    fill: async (fillRunId, holeName, body) => {
      const exit = await executeFill(fillRunId, holeName, undefined, { body, dbPath });
      if (exit !== 0) return { ok: false, message: `fill failed (exit ${exit}) — see the serve console` };
      const childRunId = await findChildRun(store, fillRunId);
      return { ok: true, message: 'hole filled — amend fork resuming…', ...(childRunId ? { childRunId } : {}) };
    },
  };
  try {
    // Issue #156 studio mode: the time-travel data source is the run's
    // append-only events.jsonl mirror (the runner writes it next to
    // .workflow/dwf.sqlite under .workflow/runs/<runId>/); when the mirror is
    // absent the SQLite journal stays the fallback source.
    const eventsJsonlPath = path.join(path.dirname(dbPath), 'runs', runId, 'events.jsonl');
    const live = await startLiveServer(store, runId, Number.isFinite(port) ? port : 4649, '127.0.0.1', actions, {
      studio: opts.studio === true,
      eventsJsonlPath,
      lang: opts.lang === 'zh' ? 'zh' : 'en',
    });
    const url = `http://127.0.0.1:${live.port}/`;
    console.log(`AI-Workflow Studio: ${url}  (run ${runId})`);
    if (opts.studio === true) {
      console.log('SVG canvas + WebSocket push (`/ws`) + time-travel seek · Ctrl+C to stop.');
    } else {
      console.log('SSE streaming from the journal · A2UI forms can resume parked runs · Ctrl+C to stop.');
    }
    if (!opts.noOpen) openInBrowser(url);
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await live.close();
    store.close();
    return 0;
  } catch (err) {
    console.error(`Serve failed: ${err instanceof Error ? err.message : String(err)}`);
    store.close();
    return 1;
  }
}
