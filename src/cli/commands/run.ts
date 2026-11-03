import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { EventLogWriter } from '../../state/event-log.js';
import { DAGVisualizerCoordinator } from '../../dag/visualizer.js';
import { t, resolveLang } from '../i18n/index.js';
import { Workflow, defineWorkflow } from '../../core/workflow.js';
import { StateStore, WorkflowEvent, StepCheckpoint, WorkflowArtifact } from '../../types.js';

export interface RunCommandOptions {
  resumeFromFailed?: string;
  mock?: boolean;
  lang?: string;
  out?: string;
  outputDir?: string;
  dryRun?: boolean;
  verbose?: boolean;
  /**
   * Base directory for storage layout (`.workflow/`) and relative path
   * resolution. Defaults to `process.cwd()`; tests inject a workspace so runs
   * never write into the repository.
   */
  cwd?: string;
}

export class DualStateStore implements StateStore {
  constructor(private primary: StateStore, private secondary?: StateStore) {}

  async recordEvent(event: WorkflowEvent): Promise<void> {
    await this.primary.recordEvent(event);
    if (this.secondary) {
      await this.secondary.recordEvent(event).catch(() => {});
    }
  }

  async saveCheckpoint(runId: string, checkpoint: StepCheckpoint): Promise<void> {
    await this.primary.saveCheckpoint(runId, checkpoint);
    if (this.secondary) {
      await this.secondary.saveCheckpoint(runId, checkpoint).catch(() => {});
    }
  }

  async getCheckpoint(runId: string, stepId: string): Promise<StepCheckpoint | null> {
    const cp = await this.primary.getCheckpoint(runId, stepId);
    if (cp) return cp;
    return this.secondary ? this.secondary.getCheckpoint(runId, stepId) : null;
  }

  async getAllCheckpoints(runId: string): Promise<Record<string, StepCheckpoint>> {
    const cps = await this.primary.getAllCheckpoints(runId);
    if (Object.keys(cps).length > 0) return cps;
    return this.secondary ? this.secondary.getAllCheckpoints(runId) : {};
  }

  /**
   * Invalidation must reach every copy: `getCheckpoint` falls back to the
   * secondary mirror, so deleting from the primary alone would leave a
   * surviving mirror checkpoint that silently short-circuits the step the
   * caller asked to genuinely re-execute (replay `--step` / `--force-recompute`).
   */
  async deleteCheckpoints(runId: string, stepId?: string): Promise<void> {
    if (typeof this.primary.deleteCheckpoints === 'function') {
      await this.primary.deleteCheckpoints(runId, stepId);
    }
    if (this.secondary && typeof this.secondary.deleteCheckpoints === 'function') {
      await this.secondary.deleteCheckpoints(runId, stepId).catch(() => {});
    }
  }

  async getRunStatus(runId: string) {
    return this.primary.getRunStatus(runId);
  }

  async saveArtifact(artifact: WorkflowArtifact): Promise<void> {
    if (typeof this.primary.saveArtifact === 'function') {
      await this.primary.saveArtifact(artifact);
    }
    if (this.secondary && typeof this.secondary.saveArtifact === 'function') {
      await this.secondary.saveArtifact(artifact).catch(() => {});
    }
  }

  async getArtifacts(runId: string): Promise<WorkflowArtifact[]> {
    if (typeof this.primary.getArtifacts === 'function') {
      return this.primary.getArtifacts(runId);
    }
    return [];
  }

  close(): void {
    if (typeof this.primary.close === 'function') {
      this.primary.close();
    }
    if (this.secondary && typeof this.secondary.close === 'function') {
      this.secondary.close();
    }
  }
}

export async function executeRun(filePath: string, options: RunCommandOptions): Promise<number> {
  const lang = resolveLang(options.lang);
  const base = path.resolve(options.cwd ?? process.cwd());
  const resolvedPath = path.resolve(base, filePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(t('ERR_FILE_NOT_FOUND', { path: filePath }, lang));
    return 2;
  }

  const runId = options.resumeFromFailed ?? `run-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const outOption = options.out ?? options.outputDir;
  const outDir = outOption ? path.resolve(base, outOption) : path.join(base, '.workflow', 'runs', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const outDbPath = path.join(outDir, 'checkpoints.db');
  const globalDbPath = path.join(base, '.workflow', 'runs.db');
  fs.mkdirSync(path.dirname(globalDbPath), { recursive: true });

  const primaryStore = new SQLiteStateStore(outDbPath);
  const secondaryStore = path.resolve(outDbPath) !== path.resolve(globalDbPath) ? new SQLiteStateStore(globalDbPath) : undefined;
  const store = new DualStateStore(primaryStore, secondaryStore);
  const logWriter = new EventLogWriter(outDir);

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

    if (options.dryRun) {
      wf.validate();
      console.log(lang === 'zh' ? '✔ 演练模式完成 (语法与依赖校验通过)' : '✔ Dry run completed (syntax and dependency validation passed)');
      return 0;
    }

    // Persist the exact definition that produces this run (a byte copy of the
    // source file). Core builder runs have NO other durable definition — the
    // executors are closures — so `replay <runId>` rebuilds the Workflow from
    // this copy (same mechanism as the dwf facade runner persisting the
    // lowered script per run). Without it a replay could only fabricate
    // results, which it must never do.
    const sourceCopyPath = path.join(outDir, `workflow.source${path.extname(resolvedPath)}`);
    fs.copyFileSync(resolvedPath, sourceCopyPath);

    console.log(t('MSG_STARTING_WORKFLOW', { name: wf.name, runId }, lang));
    if (options.mock) {
      console.log(t('MSG_MODE_MOCK', {}, lang));
    }

    // Record all events to the event journal
    wf.on('event', (evt) => {
      logWriter.record({
        workflowId: wf.name,
        runId,
        stepId: evt.stepId,
        phaseId: evt.phaseId,
        type: evt.type,
        data: evt.data,
      });
    });

    // Attach real-time event listeners for CLI terminal output
    wf.on('phase_start', (evt) => {
      console.log(`\n${t('MSG_PHASE_HEADER', { index: evt.phaseId, name: evt.data?.phaseName ?? evt.phaseId }, lang)}`);
    });

    wf.on('step_start', (evt) => {
      if (options.verbose) {
        console.log(`  [Running] ${evt.data?.stepName ?? evt.stepId}...`);
      }
    });

    wf.on('step_complete', (evt) => {
      console.log(`  ${t('MSG_STEP_SUCCESS', { stepId: evt.stepId, duration: evt.data?.durationMs ?? 0 }, lang)}`);
    });

    wf.on('step_skipped', (evt) => {
      console.log(`  ${t('MSG_REPLAY_SKIPPED', { stepId: evt.stepId }, lang)}`);
    });

    wf.on('step_failed', (evt) => {
      console.error(`  ${t('MSG_STEP_FAILED', { stepId: evt.stepId, error: evt.data?.error }, lang)}`);
    });

    const startTime = Date.now();
    const result = await wf.run({
      runId,
      mockMode: options.mock ?? false,
      lang,
      stateStore: store,
    });

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

    if (result.status === 'completed') {
      console.log(`\n${t('MSG_WORKFLOW_SUCCESS', { duration: durationSec }, lang)}`);
      console.log(`[AI-Workflow] Artifacts: ${outDir}`);

      // Export DAG Visualizer HTML
      const visualizer = new DAGVisualizerCoordinator();
      const graph = wf.exportGraph(runId);
      graph.status = 'completed';
      const html = visualizer.renderHTML(graph, lang);
      const htmlPath = path.join(outDir, 'dag.html');
      fs.writeFileSync(htmlPath, html, 'utf-8');
      console.log(`[AI-Workflow] DAG Visualizer: ${htmlPath}`);

      return 0;
    } else {
      console.error(`\n${t('MSG_WORKFLOW_FAILED', { runId }, lang)}`);
      return 1;
    }
  } catch (err: any) {
    console.error(`\nWorkflow Execution Error: ${err.message}`);
    return 1;
  } finally {
    store.close();
    logWriter.close();
  }
}
