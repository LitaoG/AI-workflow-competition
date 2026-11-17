import * as fs from 'node:fs';
import * as path from 'node:path';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore, DwfRunRow } from '../../types.js';
import { resolveDwfJournalPath } from '../../dwf/runner.js';

export interface ListCommandOptions {
  limit?: number;
  status?: string;
  json?: boolean;
  db?: string;
  lang?: string;
}

/** One listing row tagged with its journal surface (builder runs vs dwf_runs). */
interface TaggedRunRow {
  store: 'builder' | 'facade-journal';
  runId: string;
  workflowName: string;
  status: string;
  createdAt: string;
  /** Verbatim source row — emitted as-is under --json (plus `store`). */
  raw: Record<string, unknown>;
}

/**
 * Status glyph for the table view. Builder rows only ever carry
 * running/completed/failed (rendered exactly as before); stopped/parked are
 * facade-journal-only states and get their own glyphs instead of a lying
 * "running".
 */
function statusIcon(status: string): string {
  if (status === 'completed') return '✔ completed';
  if (status === 'failed') return '✖ failed';
  if (status === 'stopped') return '⏹ stopped';
  if (status === 'parked') return '◐ parked';
  return '● running';
}

/** Facade rows show the script file as their "Workflow" column. */
function facadeDisplayName(row: DwfRunRow): string {
  return row.scriptPath ? path.basename(row.scriptPath) : 'facade-script';
}

export async function executeList(options?: ListCommandOptions): Promise<number> {
  const limit = options?.limit ? Number(options.limit) : 10;
  const query = { limit, status: options?.status };

  // Two journal surfaces: builder runs live in runs.db, facade runs in the dwf
  // journal (gap-matrix D2). An explicit --db scopes BOTH surfaces to that one
  // file; without it each surface reads its own default. Read-side creation is
  // three-valued: an explicit --db pointing nowhere is a caller error (same
  // message as `view`, no file created); the default dwf journal is skipped
  // when absent (no file created); the default builder runs.db keeps the
  // pre-existing main behavior of being created on open by the SQLiteStateStore
  // constructor — deliberately unchanged here, as fixing that side effect is a
  // behavior change outside this issue's scope.
  if (options?.db && !fs.existsSync(options.db)) {
    console.error(`Journal not found: ${options.db}`);
    return 1;
  }
  const builderDbPath = options?.db ?? path.join(process.cwd(), '.workflow', 'runs.db');
  const journalDbPath = resolveDwfJournalPath(process.cwd(), options?.db);

  try {
    const rows: TaggedRunRow[] = [];

    const builderStore = new SQLiteStateStore(builderDbPath);
    try {
      for (const r of builderStore.listRuns(query)) {
        rows.push({
          store: 'builder',
          runId: r.runId,
          workflowName: r.workflowName,
          status: r.status,
          createdAt: r.createdAt,
          raw: { ...r },
        });
      }
    } finally {
      builderStore.close();
    }

    if (fs.existsSync(journalDbPath)) {
      const journalStore = new SQLiteStateStore(journalDbPath) as SQLiteStateStore & DwfJournalStore;
      try {
        for (const r of await journalStore.listDwfRuns(query)) {
          rows.push({
            store: 'facade-journal',
            runId: r.runId,
            workflowName: facadeDisplayName(r),
            status: r.status,
            createdAt: r.createdAt ?? '',
            raw: { ...r, workflowName: facadeDisplayName(r) },
          });
        }
      } finally {
        journalStore.close();
      }
    }

    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const runs = rows.slice(0, limit);

    if (options?.json) {
      // JSON rows keep their verbatim source fields (builder listRuns shape /
      // facade DwfRunRow shape) plus one additive `store` marker — existing
      // builder consumers keep every field they read today.
      console.log(JSON.stringify(runs.map((r) => ({ store: r.store, ...r.raw })), null, 2));
      return 0;
    }

    if (runs.length === 0) {
      console.log('No historical runs found in database.');
      return 0;
    }

    console.log(`========================================================================`);
    console.log(` AI-Workflow Historical Runs (${runs.length} displayed)`);
    console.log(`========================================================================`);
    console.log(
      'Run ID'.padEnd(28) +
      'Workflow'.padEnd(24) +
      'Status'.padEnd(14) +
      'Created At'
    );
    console.log('-'.repeat(80));

    for (const r of runs) {
      console.log(
        r.runId.padEnd(28) +
        r.workflowName.slice(0, 22).padEnd(24) +
        statusIcon(r.status).padEnd(14) +
        r.createdAt
      );
    }

    return 0;
  } catch (err: any) {
    console.error(`List Error: ${err.message}`);
    return 1;
  }
}
