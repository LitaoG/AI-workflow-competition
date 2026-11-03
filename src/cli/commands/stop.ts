/**
 * `/workflow stop <runId>` — converge a run: a run owned by a live process is
 * killed (whole tree, via the process supervisor) and marked 'stopped'; an
 * orphaned 'running' row (owning process dead) is simply converged. Either way
 * the resume/amend/fill doors unlock.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSQLiteStore } from '../../state/store.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore, DwfRunRow } from '../../types.js';
import { killTree } from '../../process-supervision.js';

export interface StopCommandOptions {
  db?: string;
  /** Alias so the integration test (and future callers) can pass dbPath directly. */
  dbPath?: string;
  lang?: string;
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function executeStop(runId: string, opts: StopCommandOptions): Promise<number> {
  const dbPath = opts.db ?? opts.dbPath ?? path.join(process.cwd(), '.workflow', 'dwf.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`Journal not found: ${dbPath}`);
    return 1;
  }
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  try {
    const prior: DwfRunRow | null = await store.getDwfRun(runId);
    if (!prior) {
      console.error(`Run "${runId}" not found in the journal.`);
      return 1;
    }
    if (prior.status !== 'running') {
      console.log(`Run "${runId}" is already ${prior.status} — nothing to stop.`);
      return 0;
    }
    if (prior.runnerPid !== undefined && pidAlive(prior.runnerPid)) {
      console.log(`Killing owning process tree (pid ${prior.runnerPid})…`);
      await killTree(prior.runnerPid);
    }
    await store.saveDwfRun({ ...prior, status: 'stopped', runnerPid: undefined, updatedAt: new Date().toISOString() });
    console.log(`✔ run "${runId}" stopped — resume/amend/fill doors are unlocked.`);
    return 0;
  } catch (err) {
    console.error(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}
