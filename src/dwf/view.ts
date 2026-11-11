/**
 * Run viewer — render a journalled facade-script run as a standalone HTML
 * page (GOAL.md 阶段 7 + Mission D 支柱二).
 *
 * Since Mission D the rendered page IS the AI-Workflow Studio (single-file
 * self-contained SPA, `src/visualizer/studio-renderer.ts`): topology canvas,
 * live event terminal and node inspector in one dark workspace, fully offline
 * from a `file://` URL. Reads ONLY the journal (run row + nodes + events), so
 * it works for live runs, resumed runs, amended runs (lineage shown) and
 * parked runs alike — the journal is the single source of truth.
 */

import { DwfJournalStore } from '../types.js';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { renderStudioHtml } from '../visualizer/studio-renderer.js';
import { buildStudioSnapshot } from './live.js';

export async function renderRunViewHtml(
  store: SQLiteStateStore & DwfJournalStore,
  runId: string,
  lang?: 'en' | 'zh',
): Promise<string> {
  const snap = await buildStudioSnapshot(store, runId, { live: false });
  return renderStudioHtml(snap, { live: false, lang });
}
