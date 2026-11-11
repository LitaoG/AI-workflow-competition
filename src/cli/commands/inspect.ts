import * as fs from 'node:fs';
import * as path from 'node:path';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore, DwfRunRow } from '../../types.js';
import { t, resolveLang } from '../i18n/index.js';

export interface InspectCommandOptions {
  step?: string;
  events?: boolean;
  json?: boolean;
  db?: string;
  lang?: string;
}

export async function executeInspect(runId: string, options?: InspectCommandOptions): Promise<number> {
  const lang = resolveLang(options?.lang);
  let dbPath: string;
  if (options?.db) {
    // Explicit journal: a facade run's telemetry lives in dwf_runs/dwf_nodes,
    // never in the per-run checkpoints.db — without this override the runId is
    // invisible to inspect even when the journal path is handed in directly.
    dbPath = options.db;
  } else {
    // Default journal probe, resolved by CONTENT (review round 1: facade runs
    // journal to .workflow/dwf.sqlite — resolveDwfJournalPath — and never
    // create checkpoints.db, while a pre-existing builder runs.db must not
    // shadow them). Priority: the run's own checkpoints.db, then the facade
    // journal, then the global builder runs.db; the first store that actually
    // knows the runId wins, and with no match the legacy default applies so
    // the "not found" error path stays exactly as before.
    const probes = [
      path.join(process.cwd(), '.workflow', 'runs', runId, 'checkpoints.db'),
      path.join(process.cwd(), '.workflow', 'dwf.sqlite'),
      path.join(process.cwd(), '.workflow', 'runs.db'),
    ].filter((p) => fs.existsSync(p));
    dbPath = probes[0] ?? path.join(process.cwd(), '.workflow', 'runs.db');
    for (const candidate of probes) {
      const probeStore = new SQLiteStateStore(candidate) as SQLiteStateStore & DwfJournalStore;
      try {
        const knownFacade = (await probeStore.getDwfRun(runId)) !== null;
        const knownBuilder =
          !knownFacade && Object.keys(await probeStore.getAllCheckpoints(runId)).length > 0;
        if (knownFacade || knownBuilder) {
          dbPath = candidate;
          break;
        }
      } finally {
        probeStore.close();
      }
    }
  }
  const store = new SQLiteStateStore(dbPath) as SQLiteStateStore & DwfJournalStore;

  try {
    // Facade-script journal takes priority: SQLiteStateStore provisions the dwf
    // tables in every db it opens, so a builder journal answers null here and
    // falls through to the builder logic below with zero behavior change.
    const dwfRun = await store.getDwfRun(runId);
    if (dwfRun) {
      return await renderFacadeInspect(store, dwfRun, options);
    }

    const checkpoints = await store.getAllCheckpoints(runId);
    if (Object.keys(checkpoints).length === 0) {
      console.error(t('ERR_RUN_NOT_FOUND', { runId }, lang));
      return 1;
    }

    const events = options?.events ? await store.getEvents(runId) : [];
    const artifacts = await store.getArtifacts(runId);
    const runStatus = await store.getRunStatus(runId);

    if (options?.json) {
      console.log(
        JSON.stringify(
          {
            runId,
            status: runStatus.status,
            checkpoints: options.step ? { [options.step]: checkpoints[options.step] } : checkpoints,
            artifacts,
            events,
          },
          null,
          2
        )
      );
      return 0;
    }

    console.log(`========================================================================`);
    console.log(` AI-Workflow Run Inspection: ${runId}`);
    console.log(` Overall Status: ${runStatus.status}`);
    console.log(` Completed Steps: ${runStatus.completedSteps.join(', ') || 'None'}`);
    console.log(` Failed Steps: ${runStatus.failedSteps?.join(', ') || 'None'}`);
    console.log(`========================================================================`);

    if (options?.step) {
      const cp = checkpoints[options.step];
      if (!cp) {
        console.error(t('ERR_STEP_NOT_FOUND', { stepId: options.step, runId }, lang));
        return 1;
      }
      console.log(`\nStep: ${cp.stepId} (Phase: ${cp.phaseId})`);
      console.log(`  Role:     ${cp.role ?? 'worker'}`);
      console.log(`  Status:   ${cp.status}`);
      console.log(`  Duration: ${cp.durationMs}ms`);
      if (cp.error) console.log(`  Error:    ${cp.error}`);
      console.log(`  Input:    ${JSON.stringify(cp.input, null, 2)}`);
      console.log(`  Output:   ${JSON.stringify(cp.output, null, 2)}`);
      return 0;
    }

    console.log(`\nCheckpoints (${Object.keys(checkpoints).length} steps):`);
    for (const [stepId, cp] of Object.entries(checkpoints)) {
      const icon = cp.status === 'completed' ? '✔' : cp.status === 'failed' ? '✖' : '●';
      console.log(`  ${icon} [${cp.status.toUpperCase()}] ${stepId} (${cp.durationMs}ms)`);
      if (cp.error) console.log(`     Error: ${cp.error}`);
    }

    if (artifacts.length > 0) {
      console.log(`\nArtifacts (${artifacts.length}):`);
      for (const art of artifacts) {
        console.log(`  - ${art.name} (${art.artifactType}, step: ${art.stepId})`);
      }
    }

    if (options?.events && events.length > 0) {
      console.log(`\nEvent Stream (${events.length} events):`);
      for (const evt of events) {
        console.log(`  [${evt.sequence ?? 0}] ${evt.timestamp} - ${evt.type} (${evt.stepId ?? 'root'})`);
      }
    }

    return 0;
  } catch (err: any) {
    console.error(`Inspect Error: ${err.message}`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * Facade-journal branch: the run was found in dwf_runs, so render its status
 * plus the dwf_nodes rows (kind × status tally, per-node summaries and the
 * raw event stream under --events). JSON output is the same shape.
 */
async function renderFacadeInspect(
  store: SQLiteStateStore & DwfJournalStore,
  run: DwfRunRow,
  options?: InspectCommandOptions
): Promise<number> {
  const nodes = await store.getDwfNodes(run.runId);
  const events = options?.events ? await store.getEvents(run.runId) : [];

  const counts = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const byStatus = counts.get(node.kind) ?? new Map<string, number>();
    byStatus.set(node.status, (byStatus.get(node.status) ?? 0) + 1);
    counts.set(node.kind, byStatus);
  }

  if (options?.json) {
    console.log(
      JSON.stringify(
        {
          runId: run.runId,
          store: 'facade-journal',
          status: run.status,
          parentRunId: run.parentRunId,
          scriptPath: run.scriptPath,
          nodes: nodes.map((node) => ({
            siteId: node.siteId,
            ordinal: node.ordinal,
            kind: node.kind,
            status: node.status,
            durationMs: node.durationMs,
            errorText: node.errorText,
          })),
          events,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(`========================================================================`);
  console.log(` AI-Workflow Run Inspection: ${run.runId}`);
  console.log(` Overall Status: ${run.status}`);
  console.log(` Store: facade journal (dwf_runs/dwf_nodes)`);
  if (run.parentRunId) console.log(` Parent Run: ${run.parentRunId}`);
  console.log(`========================================================================`);

  console.log(`\nNodes (${nodes.length}):`);
  for (const node of nodes) {
    const icon = node.status === 'completed' ? '✔' : '✖';
    const duration = node.durationMs !== undefined ? ` (${node.durationMs}ms)` : '';
    console.log(`  ${icon} [${node.status.toUpperCase()}] ${node.siteId}(#${node.ordinal}) ${node.kind}${duration}`);
    if (node.errorText) console.log(`     Error: ${node.errorText}`);
  }

  if (counts.size > 0) {
    console.log(`\nNodes by kind × status:`);
    for (const [kind, byStatus] of counts) {
      const parts = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`);
      console.log(`  ${kind}: ${parts.join(', ')}`);
    }
  }

  if (options?.events && events.length > 0) {
    console.log(`\nEvent Stream (${events.length} events):`);
    for (const evt of events) {
      console.log(`  [${evt.sequence ?? 0}] ${evt.timestamp} - ${evt.type} (${evt.stepId ?? 'root'})`);
    }
  }

  return 0;
}
