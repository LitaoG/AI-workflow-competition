/**
 * `/workflow view <runId>` — render a journalled facade-script run as a
 * standalone HTML report (phases, node statuses, ask results, escalation
 * Q&A, gate outputs, replay badges, raw event journal).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSQLiteStore } from '../../state/store.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore } from '../../types.js';
import { renderRunViewHtml } from '../../dwf/view.js';
import { resolveLang } from '../i18n/index.js';

export interface ViewCommandOptions {
  db?: string;
  out?: string;
  lang?: string;
}

export async function executeView(runId: string, opts: ViewCommandOptions): Promise<number> {
  const dbPath = opts.db ?? path.join(process.cwd(), '.workflow', 'dwf.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`Journal not found: ${dbPath}`);
    return 1;
  }
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  try {
    const html = await renderRunViewHtml(store, runId, resolveLang(opts.lang));
    const outPath = opts.out ?? path.join(process.cwd(), '.workflow', 'views', `${runId}.html`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`Run view written: ${outPath}`);
    return 0;
  } catch (err) {
    console.error(`View failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}
