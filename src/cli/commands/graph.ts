import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DAGVisualizerCoordinator } from '../../dag/visualizer.js';
import { HTMLRenderer } from '../../dag/html-renderer.js';
import { ASCIIRenderer } from '../../dag/ascii-renderer.js';
import { MermaidRenderer } from '../../dag/mermaid-renderer.js';
import { projectEventsToGraph } from '../../dag/journal-projection.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { EventLogReader } from '../../state/event-log.js';
import type { WorkflowEvent } from '../../domain/events.js';
import { DwfJournalStore } from '../../types.js';
import { resolveDwfJournalPath } from '../../dwf/runner.js';
import { t, resolveLang } from '../i18n/index.js';
import { Workflow, defineWorkflow } from '../../core/workflow.js';

export interface GraphCommandOptions {
  format?: 'html' | 'mermaid' | 'ascii';
  output?: string;
  db?: string;
  lang?: string;
}

/**
 * Resolve a dwf journal target for the graph command (GOAL.md 阶段 7.3):
 * a run directory (`.workflow/runs/<runId>/`) or an `events.jsonl` file.
 *
 * `events.jsonl` is the preferred stream (the mirror written per event); when
 * it is absent — e.g. the mirror degraded during the run — the stream is
 * rebuilt from the authoritative SQLite journal, resolving the run dir name as
 * the runId and the workspace journal db two levels up from the run dir.
 * Returns `undefined` when the target is not a dwf journal, so the caller can
 * fall through to the core-builder path untouched.
 */
async function loadDwfJournalEvents(resolvedPath: string): Promise<WorkflowEvent[] | undefined> {
  let isDir = false;
  try {
    isDir = fs.statSync(resolvedPath).isDirectory();
  } catch {
    return undefined;
  }

  let runDir: string;
  let jsonlPath: string;
  if (isDir) {
    runDir = resolvedPath;
    jsonlPath = path.join(resolvedPath, 'events.jsonl');
  } else if (path.basename(resolvedPath) === 'events.jsonl') {
    runDir = path.dirname(resolvedPath);
    jsonlPath = resolvedPath;
  } else {
    return undefined;
  }

  if (fs.existsSync(jsonlPath)) {
    return EventLogReader.readAll(jsonlPath);
  }

  // Mirror degraded or pruned: rebuild from the authoritative SQLite journal.
  const dbPath = path.join(runDir, '..', '..', 'dwf.sqlite');
  if (!fs.existsSync(dbPath)) return undefined;
  const store = new SQLiteStateStore(dbPath);
  try {
    return await store.getEvents(path.basename(runDir));
  } finally {
    store.close();
  }
}

/**
 * Facade runId → journal events (telemetry hookup, gap-matrix D2): the missing
 * sibling of `view`/`serve`/`stop`, which all resolve a bare runId against the
 * journal db. Resolves the journal via the shared `resolveDwfJournalPath`
 * (explicit --db or `.workflow/dwf.sqlite` under cwd) and returns undefined
 * when the db or the run is absent, so the caller keeps its file-based
 * behavior untouched.
 */
async function loadFacadeRunEvents(filePath: string, db?: string): Promise<WorkflowEvent[] | undefined> {
  const journalPath = resolveDwfJournalPath(process.cwd(), db);
  if (!fs.existsSync(journalPath)) return undefined;
  const store = new SQLiteStateStore(journalPath) as SQLiteStateStore & DwfJournalStore;
  try {
    const run = await store.getDwfRun(filePath);
    if (!run) return undefined;
    return await store.getEvents(filePath);
  } finally {
    store.close();
  }
}

/** Fold dwf events through the shared projection and render/export the result. */
async function renderDwfProjection(
  dwfEvents: WorkflowEvent[],
  options: GraphCommandOptions,
  lang: string
): Promise<number> {
  try {
    const graph = projectEventsToGraph(dwfEvents);
    const format = options.format ?? 'ascii';
    const rendered =
      format === 'html'
        ? new HTMLRenderer().render(graph, lang === 'zh' ? 'zh' : 'en')
        : format === 'mermaid'
          ? new MermaidRenderer().render(graph, 'TD')
          : new ASCIIRenderer().render(graph);
    if (options.output) {
      const outPath = path.resolve(process.cwd(), options.output);
      fs.writeFileSync(outPath, rendered, 'utf-8');
      console.log(`[AI-Workflow] dwf run graph exported (${dwfEvents.length} events): ${outPath}`);
    } else {
      console.log(rendered);
    }
    return 0;
  } catch (err) {
    console.error(`Graph Export Error: ${(err as Error).message}`);
    return 1;
  }
}

export async function executeGraph(filePath: string, options: GraphCommandOptions): Promise<number> {
  const lang = resolveLang(options.lang);
  const resolvedPath = path.resolve(process.cwd(), filePath);

  // Explicit --db: the positional argument is a facade runId, never a file —
  // an unresolved runId errors out instead of falling into the builder import.
  if (options.db) {
    const events = await loadFacadeRunEvents(filePath, options.db);
    if (events === undefined) {
      console.error(`Run not found in journal: ${filePath} (db: ${options.db})`);
      return 1;
    }
    return renderDwfProjection(events, options, lang);
  }

  // dwf journal targets fold through the SAME pure projection the live
  // `--watch-graph` view uses — a watched run and this cold replay of the same
  // stream render byte-identically by construction.
  const dwfEvents = await loadDwfJournalEvents(resolvedPath);
  if (dwfEvents !== undefined) {
    return renderDwfProjection(dwfEvents, options, lang);
  }

  if (!fs.existsSync(resolvedPath)) {
    // Default-journal discovery (D2 full closure): a non-existent path gets one
    // chance as a dwf_runs.run_id in the default journal — the same bare-runId
    // resolution `view <runId>` already performs. Unknown ids keep the
    // pre-existing not-found error and exit code.
    const events = await loadFacadeRunEvents(filePath);
    if (events !== undefined) {
      return renderDwfProjection(events, options, lang);
    }
    console.error(t('ERR_FILE_NOT_FOUND', { path: filePath }, lang));
    // A missing file is a caller error — the T2_F4_02 boundary contract names
    // non-zero; the old `return 0` masked the failure (2026-11-14 round 2).
    return 1;
  }

  try {
    const fileUrl = pathToFileURL(resolvedPath).href;
    const mod = await import(fileUrl);
    let wf = mod.default ?? mod.workflow;

    if (wf && !(wf instanceof Workflow) && (wf.steps || wf.phases)) {
      wf = defineWorkflow(wf);
    }

    if (!wf || !(wf instanceof Workflow)) {
      console.error(`Error: File "${filePath}" does not export a valid Workflow default export.`);
      return 2;
    }

    wf.validate();

    const visualizer = new DAGVisualizerCoordinator();
    const graph = wf.exportGraph('static-graph');
    const format = options.format ?? 'ascii';

    if (format === 'html') {
      const html = visualizer.renderHTML(graph, lang);
      if (options.output) {
        const outPath = path.resolve(process.cwd(), options.output);
        fs.writeFileSync(outPath, html, 'utf-8');
        console.log(`[AI-Workflow] Standalone DAG Visualizer exported: ${outPath}`);
      } else {
        console.log(html);
      }
    } else if (format === 'mermaid') {
      const mermaid = visualizer.renderMermaid(graph, 'TD');
      if (options.output) {
        fs.writeFileSync(path.resolve(process.cwd(), options.output), mermaid, 'utf-8');
        console.log(`[AI-Workflow] Mermaid diagram exported: ${options.output}`);
      } else {
        console.log(mermaid);
      }
    } else {
      const ascii = visualizer.renderASCII(graph);
      if (options.output) {
        fs.writeFileSync(path.resolve(process.cwd(), options.output), ascii, 'utf-8');
        console.log(`[AI-Workflow] ASCII graph exported: ${options.output}`);
      } else {
        console.log(ascii);
      }
    }

    return 0;
  } catch (err: any) {
    console.error(`Graph Export Error: ${err.message}`);
    return 1;
  }
}
