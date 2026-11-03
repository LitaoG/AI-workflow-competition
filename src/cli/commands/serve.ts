/**
 * `/workflow serve <runId>` — live execution view: an HTTP server that
 * renders the run's journal as a self-refreshing page (1.2s polling).
 * Attach it to a PARKED or RUNNING script and watch nodes land in real time;
 * it keeps serving after the run settles (audit view).
 */

import * as path from 'node:path';
import { createSQLiteStore } from '../../state/store.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore } from '../../types.js';
import { startLiveServer } from '../../dwf/live.js';

export interface ServeCommandOptions {
  db?: string;
  port?: string;
  lang?: string;
}

export async function executeServe(runId: string, opts: ServeCommandOptions): Promise<number> {
  const dbPath = opts.db ?? path.join(process.cwd(), '.workflow', 'dwf.sqlite');
  const port = Number(opts.port ?? 4649);
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  try {
    const live = await startLiveServer(store, runId, Number.isFinite(port) ? port : 4649);
    console.log(`Live view: http://127.0.0.1:${live.port}/  (run ${runId})`);
    console.log('Ctrl+C to stop.');
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
