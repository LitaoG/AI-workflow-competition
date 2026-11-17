/**
 * Run identity + lineage resolution — the resume / amend / rerun doors.
 *
 * - resume: same runId, same script (sha256 enforced — fail loudly instead of
 *   misbinding journal entries). A `running` row is only a lock while its host
 *   is alive: alive → refuse; dead → crash takeover; never recorded → takeover
 *   too, so legacy pre-pid journals are never locked out.
 * - amend: NEW runId, edited script allowed; unchanged nodes replay from the
 *   prior run's journal at zero cost. The import walks the WHOLE parentRunId
 *   lineage (oldest → newest, newest wins on key conflicts), so a chained
 *   amend inherits its ancestors' warm nodes too.
 * - rerun (#116): shares the amend fork but requires the SAME script and
 *   drops imported nodes from the --from site on — those calls run live even
 *   where they succeeded before.
 */
import { isPidAlive } from '../process-supervision.js';
import type { FacadeAnalysis } from './diagnostics.js';
import type { DwfNode, DwfRunRow, DwfJournalStore } from '../types.js';
import type { SQLiteStateStore } from '../state/sqlite-store.js';
import type { RunFacadeOptions, RunFacadeResult } from './runner.js';
import { domainError } from '../domain/errors.js';
import { mintRunId } from './author-position.js';

export function emptyRunStats(): RunFacadeResult['stats'] {
  return { asks: 0, replayHits: 0, amendHits: 0, diverged: 0, phases: [] };
}

/**
 * Orphan convergence: a 'running' row whose owning process is dead can never
 * settle on its own — the resume/amend/fill doors would stay locked forever.
 * Converge it to 'stopped' (the honest terminal state: the run was
 * interrupted; its journalled nodes replay on the next resume). A row owned by
 * a LIVE process is genuinely running elsewhere — leave it alone.
 */
export async function convergeOrphanRun(store: SQLiteStateStore & DwfJournalStore, prior: DwfRunRow): Promise<'converged' | 'running'> {
  if (prior.status !== 'running') return 'converged';
  if (prior.runnerPid !== undefined && prior.runnerPid > 0 && isPidAlive(prior.runnerPid)) {
    return 'running';
  }
  await store.saveDwfRun({ ...prior, status: 'stopped', runnerPid: undefined, updatedAt: new Date().toISOString() });
  return 'converged';
}

export interface LineageResolution {
  runId: string;
  importedCache?: Map<string, DwfNode>;
  amendedFrom?: string;
  priorRunParent?: string;
  priorSpentTokens?: number;
  /** Issue #63: the prior run's executed (live) ask count — restores the call cap on continuation doors. */
  priorExecutedAsks?: number;
  priorBudgetTotal?: number;
  /** Stale-run takeover (GOAL.md §1.5): a resumed `running` row whose host is gone. */
  resumeTakeover?: { reason: 'dead-pid' | 'no-recorded-pid'; deadPid?: number };
}

export type LineageOutcome =
  | { ok: true; resolution: LineageResolution }
  | { ok: false; result: RunFacadeResult };

export async function resolveRunLineage(
  options: RunFacadeOptions,
  cwd: string,
  store: SQLiteStateStore & DwfJournalStore,
  analysis: FacadeAnalysis,
  scriptHash: string,
): Promise<LineageOutcome> {
  const resumeRunId = options.resumeRunId;
  const amendRunId = options.amendRunId;
  const rerunRunId = options.rerunRunId;
  let runId: string;
  let importedCache: Map<string, DwfNode> | undefined;
  let amendedFrom: string | undefined;
  let priorRunParent: string | undefined;
  let priorSpentTokens: number | undefined;
  let priorExecutedAsks: number | undefined;
  // Issue #118: the recorded cap of the run being continued — inherited when
  // the caller does not pass an explicit --budget-total (the caller always wins).
  let priorBudgetTotal: number | undefined;
  let resumeTakeover: LineageResolution['resumeTakeover'];
  const stats = emptyRunStats();
  const emptyReportItems: unknown[] = [];

  if (resumeRunId && amendRunId) {
    return { ok: false, result: { runId: 'unknown', status: 'failed', error: 'pass either --resume or --amend, not both', stats, reportItems: emptyReportItems } };
  }
  if (rerunRunId && (resumeRunId || amendRunId)) {
    return { ok: false, result: { runId: 'unknown', status: 'failed', error: 'pass --rerun alone, not with --resume or --amend', stats, reportItems: emptyReportItems } };
  }

  if (resumeRunId) {
    const prior = await store.getDwfRun(resumeRunId);
    if (!prior) {
      return { ok: false, result: { runId: resumeRunId, status: 'failed', error: `run "${resumeRunId}" not found — nothing to resume`, stats, reportItems: emptyReportItems } };
    }
    if (prior.status === 'running') {
      const probe = options.pidLivenessProbe ?? isPidAlive;
      if (prior.runnerPid !== undefined && probe(prior.runnerPid)) {
        const refusal = domainError(
          'StorageError',
          `run "${resumeRunId}" is already running (pid ${prior.runnerPid}) — another host is executing this run; stop that host (or wait for it to finish) before resuming`,
          { details: { runId: resumeRunId, pid: prior.runnerPid } },
        );
        return { ok: false, result: { runId: resumeRunId, status: 'failed', error: refusal.message, stats, reportItems: emptyReportItems } };
      }
      resumeTakeover = prior.runnerPid === undefined
        ? { reason: 'no-recorded-pid' }
        : { reason: 'dead-pid', deadPid: prior.runnerPid };
      // An orphaned row converges into this takeover — fall through and resume.
    }
    if (prior.scriptHash !== scriptHash) {
      throw new Error(
        `script mismatch for run ${resumeRunId}: the script changed since the run started (sha256 differs). ` +
        `Fail loudly instead of misbinding journal entries. Use --amend to fork a new run with the edited script, or restore the original script.`,
      );
    }
    runId = resumeRunId;
    priorRunParent = prior.parentRunId;
    // Issue #118: a continuation continues the RUN — its recorded cap and its
    // spent baseline come with it (the caller's explicit --budget-total wins).
    priorBudgetTotal = prior.budgetTotal;
    priorSpentTokens = prior.outputTokensSpent;
    priorExecutedAsks = prior.executedAsks;
    return { ok: true, resolution: { runId, amendedFrom, priorRunParent, priorSpentTokens, priorExecutedAsks, priorBudgetTotal, resumeTakeover } };
  }

  if (options.parentRunId) {
    runId = mintRunId();
    amendedFrom = options.parentRunId;
    // Issue #35: a composition re-entry — the parent resuming (takeover) or
    // re-running a failed composition site re-invokes this child — must not
    // re-bill the whole subtree at full provider cost. Find the newest prior
    // child run of the same script within the parent's run lineage and import
    // its journal as the replay cache: the same mechanism amend uses, and
    // safe for the same reason — re-executing the same script produces the
    // same siteId#ordinal stream, so imported warm entries align 1:1. An
    // edited child script hashes differently, finds no prior run, and simply
    // runs live (the documented diverge behavior).
    //
    // The match is per composition CALL SITE: composeWorkflow stamps the
    // parent-site coordinates into the child's args (workflowParentSite /
    // workflowParentOrdinal), so two workflow() calls to the same saved
    // workflow under one parent never cross-import each other's journals
    // (the Issue #124 budget-composition scenario bills both sites). The
    // parent lineage chains through the parentRunId column, which carries
    // the amend source for an amended run and the composition parent for a
    // composed child — walking it reaches the prior parent of an amended
    // composition too. Rows without the site stamps (pre-#35 children) never
    // match: they fall back to the live run instead of a blind import.
    const lineageParents: string[] = [];
    {
      const seen = new Set<string>();
      let cursor: string | null | undefined = options.parentRunId;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        lineageParents.push(cursor);
        const row: DwfRunRow | null = await store.getDwfRun(cursor);
        if (!row) break;
        cursor = row.parentRunId ?? null;
      }
    }
    const siteArgs = (options.args ?? {}) as { workflowParentSite?: string; workflowParentOrdinal?: number };
    const expectedSite = siteArgs.workflowParentSite;
    const expectedOrdinal = siteArgs.workflowParentOrdinal;
    const matchesSite = (r: DwfRunRow, parent: string): boolean => {
      if (expectedSite === undefined || expectedOrdinal === undefined) return false;
      try {
        const args = JSON.parse(r.argsJson ?? '{}') as { workflowParent?: string; workflowParentSite?: string; workflowParentOrdinal?: number };
        return args.workflowParent === parent && args.workflowParentSite === expectedSite && args.workflowParentOrdinal === expectedOrdinal;
      } catch {
        return false;
      }
    };
    const runs = await store.listDwfRuns({ limit: 1000 });
    for (const parent of lineageParents) {
      // listDwfRuns returns newest-first; the first candidate is the newest
      // prior child run of this call site under this parent. `running` rows
      // are skipped: their journals are still being written by a live host.
      const priorChild = runs.find(
        (r) => r.parentRunId === parent && r.scriptHash === scriptHash && r.status !== 'running' && matchesSite(r, parent),
      );
      if (priorChild) {
        const priorNodes: DwfNode[] = await store.getDwfNodes(priorChild.runId);
        importedCache = new Map(priorNodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
        break;
      }
    }
    return { ok: true, resolution: { runId, importedCache, amendedFrom, priorRunParent, priorSpentTokens, priorBudgetTotal, resumeTakeover } };
  }

  if (amendRunId || rerunRunId) {
    const sourceRunId = (amendRunId || rerunRunId) as string;
    const verb = rerunRunId ? 'rerun' : 'amend';
    const prior = await store.getDwfRun(sourceRunId);
    if (!prior) {
      return { ok: false, result: { runId: 'unknown', status: 'failed', error: `run "${sourceRunId}" not found — nothing to ${verb}`, stats, reportItems: emptyReportItems } };
    }
    if (prior.status === 'running') {
      const verdict = await convergeOrphanRun(store, prior);
      if (verdict === 'running') {
        return { ok: false, result: { runId: 'unknown', status: 'failed', error: `run "${sourceRunId}" is still running (pid ${prior.runnerPid}) — stop it before ${rerunRunId ? 'rerunning' : 'amending'}`, stats, reportItems: emptyReportItems } };
      }
    }
    // Which imported nodes may replay. amend: all of them. rerun: only nodes at
    // sites BEFORE the --from site in source order. The --from site and every
    // later site run live even where they succeeded before: an absent warm
    // entry is a cache miss, which also puts that call's actor live (engine.ts
    // journalled(), per-actor divergence), so no half-warm conversation forms.
    let keepImported: (node: DwfNode) => boolean = () => true;
    if (rerunRunId) {
      if (prior.scriptHash !== scriptHash) {
        return { ok: false, result: { runId: 'unknown', status: 'failed', error: `script mismatch for run ${rerunRunId}: --rerun replays the same script, but the sha256 differs. Use --amend to fork a new run with the edited script.`, stats, reportItems: emptyReportItems } };
      }
      const siteOrder = new Map<string, number>(analysis.sites.map((site, index) => [site.siteId, index] as [string, number]));
      const boundary = options.rerunFromSite === undefined ? undefined : siteOrder.get(options.rerunFromSite);
      if (boundary === undefined) {
        return { ok: false, result: { runId: 'unknown', status: 'failed', error: `--rerun needs --from <siteId> naming a site of this script; known sites: ${analysis.sites.map((site) => site.siteId).join(', ')}`, stats, reportItems: emptyReportItems } };
      }
      const boundaryIndex: number = boundary;
      keepImported = (node) => {
        const index = siteOrder.get(node.siteId);
        return index !== undefined && index < boundaryIndex;
      };
      // Pre-flight quote (Issue #116 F2): what replays, what runs live, the
      // spend baseline and the ceiling actually in effect — printed before any
      // model call so the operator can abort cheaply. Also names the live
      // world.run commands (F4) whose side effects will execute again.
      const liveSites = analysis.sites.filter((site) => (siteOrder.get(site.siteId) ?? Number.POSITIVE_INFINITY) >= boundaryIndex);
      const liveWorldRuns = liveSites.filter((site) => site.kind === 'worldRun' && site.command);
      const replayCount = analysis.sites.length - liveSites.length;
      console.warn(
        `[dwf] rerun quote: ${replayCount} site(s) replay from the parent journal, ${liveSites.length} run live` +
        ((prior.outputTokensSpent ?? 0) > 0 ? `, parent spend baseline ${prior.outputTokensSpent} output tokens` : '') +
        ((options.budgetTotal ?? priorBudgetTotal) === undefined ? ', NO budget ceiling (--budget-total not set)' : `, ceiling ${options.budgetTotal ?? priorBudgetTotal} output tokens`) +
        (liveWorldRuns.length > 0 ? `; live world.run commands re-execute: ${liveWorldRuns.map((site) => site.command).join(', ')}` : ''),
      );
    }
    const priorNodes: DwfNode[] = [];
    const lineageSeen = new Set<string>();
    let lineageCursor: string = sourceRunId;
    while (lineageCursor && !lineageSeen.has(lineageCursor)) {
      lineageSeen.add(lineageCursor);
      const row: DwfRunRow | null = await store.getDwfRun(lineageCursor);
      if (!row) break;
      priorNodes.push(...(await store.getDwfNodes(lineageCursor)).filter(keepImported));
      lineageCursor = row.parentRunId ?? '';
    }
    // The walk above collects rows newest-run-first, so the cache map is built
    // in REVERSE (oldest ancestor first): `new Map` lets the LAST entry win
    // each siteId#ordinal key, and the documented contract (header: "newest
    // wins on key conflicts") requires the NEWEST run's node to win. The old
    // build let a stale ancestor row — e.g. a journalled FAILURE from a run
    // that was later rerun successfully — shadow the newer run's completed
    // node and replay its rejection (observed live in the 2026-11-14 repair
    // round: rerun-from-gates replayed an ancestor's network failure instead
    // of the descendant's 12/12 confirmed verdicts).
    importedCache = new Map(priorNodes.slice().reverse().map((n) => [`${n.siteId}#${n.ordinal}`, n]));
    amendedFrom = sourceRunId;
    priorBudgetTotal = prior.budgetTotal; // amend/rerun inherit the cap (Issue #118)
    priorExecutedAsks = prior.executedAsks; // and the ask-cap baseline (Issue #63)
    runId = mintRunId();
    return { ok: true, resolution: { runId, importedCache, amendedFrom, priorRunParent, priorSpentTokens, priorExecutedAsks, priorBudgetTotal, resumeTakeover } };
  }

  return { ok: true, resolution: { runId: mintRunId(), amendedFrom, priorRunParent, priorSpentTokens, priorBudgetTotal, resumeTakeover } };
}
