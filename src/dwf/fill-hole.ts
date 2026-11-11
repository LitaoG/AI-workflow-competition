/**
 * Hole fill door — splice a fill body into a parked run's script where the
 * hole stands, re-analyze the effective script (diagnostics refuse the fill —
 * nothing is spliced), check site stability (every site before the hole must
 * keep its id), journal the fill, then fork an amend — completed nodes replay
 * from the journal at zero cost and the body runs live.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeFacadeScript } from './compile.js';
import { resolveDwfJournalPath, runFacadeScript } from './runner.js';
import { convergeOrphanRun } from './run-lineage.js';
import { createSQLiteStore } from '../state/store.js';
import type { SQLiteStateStore } from '../state/sqlite-store.js';
import type { DwfJournalStore, WorkflowEventType } from '../types.js';
import type { RunFacadeResult } from './runner.js';

export interface FillHoleOptions {
  runId: string;
  holeName: string;
  /** The fill body's statements — spliced where the hole stands, sees prior bindings. */
  body: string;
  dbPath?: string;
  cwd?: string;
  maxConcurrency?: number;
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}

export interface FillHoleResult {
  /** The forked run's result, when the fill was accepted and executed. */
  run?: RunFacadeResult;
  /** The spliced (effective) script path, when the fill was accepted. */
  effectiveScriptPath?: string;
  status: 'accepted' | 'refused';
  error?: string;
  diagnostics?: Array<{ line: number; column: number; code: number; category: string; message: string; hint?: string }>;
}

export async function fillHoleAndRun(options: FillHoleOptions): Promise<FillHoleResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const store: SQLiteStateStore & DwfJournalStore = createSQLiteStore(
    resolveDwfJournalPath(cwd, options.dbPath),
  ) as SQLiteStateStore & DwfJournalStore;

  try {
    let prior = await store.getDwfRun(options.runId);
    if (!prior) {
      return { status: 'refused', error: `run "${options.runId}" not found` };
    }
    if (prior.status === 'running') {
      const verdict = await convergeOrphanRun(store, prior);
      if (verdict === 'running') {
        return { status: 'refused', error: `run "${options.runId}" is still running (pid ${prior.runnerPid}) — holes are filled after the run parks` };
      }
      // The orphan was converged to a terminal state in the store — refresh the
      // local view so the parked-only guard below reports the true status.
      prior = (await store.getDwfRun(options.runId)) ?? prior;
    }
    if (prior.status !== 'parked') {
      return {
        status: 'refused',
        error: `run "${options.runId}" is ${prior.status} — only a parked run can be filled; start a fresh run or fill the forked amend instead`,
      };
    }
    if (!prior.scriptPath || !fs.existsSync(prior.scriptPath)) {
      return { status: 'refused', error: `run "${options.runId}" has no readable source to splice` };
    }
    const source = fs.readFileSync(prior.scriptPath, 'utf8');

    // Locate the hole in the original analysis (name must exist, must be typed).
    const original = analyzeFacadeScript(source);
    const holeSite = original.sites.find((s) => s.kind === 'hole' && s.holeName === options.holeName);
    if (!holeSite) {
      const known = original.sites.filter((s) => s.kind === 'hole').map((s) => s.holeName);
      return { status: 'refused', error: `no hole named "${options.holeName}" in this script (holes: ${known.join(', ') || 'none'})` };
    }
    if (!holeSite.typed) {
      return { status: 'refused', error: `hole "${options.holeName}" has no explicit type argument — refusing to fill` };
    }

    const { spliceHoleBody } = await import('./lower.js');
    const effective = spliceHoleBody(source, options.holeName, options.body);
    if (effective === null) {
      return { status: 'refused', error: `hole "${options.holeName}" could not be located in the source (compiler internal)` };
    }

    // The effective script must compile — a rejected fill splices nothing.
    const effectiveAnalysis = analyzeFacadeScript(effective);
    if (!effectiveAnalysis.ok) {
      return { status: 'refused', error: 'the fill body failed compilation — nothing was spliced', diagnostics: effectiveAnalysis.diagnostics };
    }

    // Site stability: every site before the hole must keep its identity, so the warm
    // cache replays the whole prefix. Body/suffix sites may renumber — they fork live.
    const holeIndex = original.sites.findIndex((s) => s.siteId === holeSite.siteId);
    const prefix = original.sites.slice(0, holeIndex);
    for (let i = 0; i < prefix.length; i++) {
      const want = prefix[i]!;
      const got = effectiveAnalysis.sites[i];
      if (!got || got.siteId !== want.siteId || got.kind !== want.kind) {
        return {
          status: 'refused',
          error: `site stability check failed: site#${i} was ${want.siteId} (${want.kind}) in the original but is ${got ? `${got.siteId} (${got.kind})` : 'missing'} in the effective script — the fill body must not change code before the hole`,
        };
      }
    }

    // Persist the effective script and journal the fill on the parked run.
    const runDir = path.join(cwd, '.workflow', 'runs', options.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const effectivePath = path.join(runDir, 'script.effective.ts');
    fs.writeFileSync(effectivePath, effective, 'utf8');
    // The fill row must carry the SAME inputHash the engine emitted on
    // dwf_hole_open (pool matching is by content; the ordinal is unique per row).
    const openEvents = await store.getEvents(options.runId);
    const openEv = [...openEvents].reverse().find((e) => e.type === ('dwf_hole_open' as WorkflowEventType) && (e.data as { name?: string })?.name === options.holeName);
    const openHash = (openEv?.data as { inputHash?: string; siteId?: string }).inputHash;
    if (!openHash) {
      return { status: 'refused', error: `no open hole event with an inputHash for "${options.holeName}" on run "${options.runId}" — the park predates pool matching; start a fresh run` };
    }
    const priorHoleRows = (await store.getDwfNodes(options.runId)).filter((n) => n.siteId === holeSite.siteId && n.kind === 'hole');
    await store.saveDwfNode({
      runId: options.runId,
      siteId: holeSite.siteId,
      ordinal: priorHoleRows.length + 1,
      kind: 'hole',
      inputHash: openHash,
      status: 'completed',
      resultJson: JSON.stringify(options.body),
      completedAt: new Date().toISOString(),
    });
    await store.saveDwfRun({ runId: options.runId, scriptHash: prior.scriptHash, status: 'completed', parentRunId: prior.parentRunId });

    // Fork the amend: prefix replays at zero cost, the body (and renumbered suffix)
    // executes live.
    const run = await runFacadeScript({
      scriptPath: effectivePath,
      args: parseArgsJson(prior.argsJson),
      amendRunId: options.runId,
      dbPath: options.dbPath,
      cwd: options.cwd,
      maxConcurrency: options.maxConcurrency,
      onEvent: options.onEvent,
    });
    return { status: 'accepted', effectiveScriptPath: effectivePath, run };
  } finally {
    store.close();
  }
}

function parseArgsJson(argsJson: string | undefined): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
