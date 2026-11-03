/**
 * Parent-side runner for facade scripts: compile → lower → sandbox child → pump the
 * NDJSON protocol → engine (journal short-circuit) → result.
 *
 * Mirrors the standard agent-CLI launch path: diagnostics never reach the user un-mapped, a run's
 * identity is its scriptHash, resume reuses the same runId and replays from the
 * journal, and the child is spawned with ELECTRON_RUN_AS_NODE=1 so an Electron-hosted
 * CLI never boots a Chromium helper.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { analyzeFacadeScript } from './compile.js';
import { LiveGraph } from '../dag/live.js';
import { HTMLRenderer } from '../dag/html-renderer.js';
import { projectEventsToGraph } from '../dag/journal-projection.js';
import { lowerFacadeScript } from './lower.js';
import { FacadeEngine } from './engine.js';
import { redactText, redactValue } from './redact.js';
import { ChildToParent, HostReply, encodeFrame } from './protocol.js';
import { fromSerializableError, isDomainError, toDomainError, toSerializableError, domainError } from '../domain/errors.js';
import type { SerializableError } from '../domain/errors.js';
import { createSQLiteStore } from '../state/store.js';
import { EventLogWriter } from '../state/event-log.js';
import { buildSanitizedEnv, isPidAlive, killTree, onHostSignals } from '../process-supervision.js';
import { sanitizeEnv } from '../prober/index.js';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { DwfJournalStore, DwfNode, DwfRunRow, WorkflowEvent, WorkflowEventType } from '../types.js';

export interface RunFacadeOptions {
  scriptPath: string;
  args?: Record<string, unknown>;
  /** Resume this runId (journal replay; the script must be byte-identical). */
  resumeRunId?: string;
  /**
   * Amend this run: start a NEW runId with this run as lineage. The script may be
   * edited — nodes whose inputs are unchanged replay from the prior run's journal
   * at zero cost; changed nodes execute live and their downstream diverges.
   */
  amendRunId?: string;
  dbPath?: string;
  cwd?: string;
  maxConcurrency?: number;
  /**
   * Per-ask stall clock. Defaults to AI_WORKFLOW_STALL_MS, else 90000ms;
   * 0 disables it.
   */
  stallMs?: number;
  /**
   * Failover chain for actor asks: after the routed provider fails with a
   * retryable classified error, these providers are tried in order
   * (retry-orchestrator: per-provider + total budgets, circuit breaker).
   */
  failoverProviders?: string[];
  /** Restored output-token counter for a resumed run (audit gap #4). */
  restoreOutputTokensSpent?: number;
  /** Whole-run wall clock; the child is killed and the run fails when it fires. */
  runTimeoutMs?: number;
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  /** Test hook: override the compiled child entry path. */
  childEntryPath?: string;
  /**
   * V8 heap cap in MB for the sandbox child, passed as `--max-old-space-size`
   * (process-safety rule: an unbounded sandbox heap is an OOM the process
   * supervisor cannot see). Default 512; when unset, the
   * `AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB` environment variable is honored;
   * the explicit option always wins. Must be a positive number.
   */
  sandboxMaxOldSpaceSizeMb?: number;
  /** Write a live execution view (HTML + state JSON) at this path while the run goes. */
  liveHtmlPath?: string;
  /**
   * Watch the run's graph (live-view requirement): after EVERY emit, re-fold the
   * accumulated event stream through the same pure journal projection the cold
   * replay uses (`projectEventsToGraph`) and rewrite `graph.html` inside the
   * run dir — a watched run and a later `workflow graph <run-dir>` render
   * byte-identically by construction. On a resumed run the journal prefix is
   * seeded first, so the watched graph covers the whole run, not just this
   * invocation. Write failures degrade to ONE StorageError-tagged warning and
   * the rebuild is skipped for the rest of the run — the view never fails the
   * run and never pollutes the journal stream.
   */
  watchGraph?: boolean;
  /**
   * Liveness probe for the host pid recorded on a stale `running` row during
   * resume (the engine's crash-takeover rule). Defaults to the real OS probe
   * (`isPidAlive`); tests inject a stub so the takeover semantics are verified
   * without spawning or killing real processes.
   */
  pidLivenessProbe?: (pid: number) => boolean;
  /** workflow() composition: lineage parent (fresh child run — no cache import). */
  parentRunId?: string;
  /** workflow() composition: nesting depth (children cannot compose further). */
  workflowDepth?: number;
}

export interface RunFacadeResult {
  runId: string;
  status: 'completed' | 'failed' | 'compile_failed' | 'parked' | 'stopped';
  value?: unknown;
  error?: string;
  /** Compile diagnostics when status === 'compile_failed'. */
  diagnostics?: Array<{ line: number; column: number; code: number; category: string; message: string }>;
  /** When this run amended a prior run: the parent run id (lineage). */
  amendedFrom?: string;
  /** When status === 'parked': the hole or escalation the run is waiting on. */
  parkedAt?: { siteId: string; name: string; prompt: string; kind: 'hole' | 'escalation' };
  /** Terminal snapshot: the last 256 report() items (deduplicated). */
  reportItems: unknown[];
  stats: { asks: number; replayHits: number; amendHits: number; diverged: number; phases: string[] };
}

/**
 * The journal database path a facade run executes against: the caller's explicit
 * `dbPath`, or `.workflow/dwf.sqlite` under the run's workspace. Single source of
 * truth shared by the runner and every journal-reading surface (MCP inspect/get
 * tools), so readers resolve the same file the writer wrote.
 */
export function resolveDwfJournalPath(cwd: string, dbPath?: string): string {
  return dbPath ?? path.join(cwd, '.workflow', 'dwf.sqlite');
}

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/** Default V8 heap cap (MB) for the sandbox child — see buildSandboxChildArgs. */
const DEFAULT_SANDBOX_MAX_OLD_SPACE_MB = 512;
/**
 * Frame budget for the child stdout pump (协议加固):
 *
 * NDJSON 单行即一帧 —— 单行预算取 16MB 消息组装上限
 * 残留积压预算取 32MB staged 上限；
 * 另有 1MB 物理帧档上限，
 * 属分片传输层预留 —— 本协议无分片，单行即完整消息，故取
 * 16MB 消息档；1MB 帧必须完整到达是既有活跃断言
 * (tests/adversarial/goal-poc3-oversize-frames.test.ts)。字符长度作字节预算
 * 的代理（setEncoding('utf8') 后 code units ≤ 字节数；UTF-8 每字符 1-4 字节
 * 对 1-2 code units，多字节内容最多宽松 3 倍 —— CJK 等三字节字符，16M code
 * units ≈ 48MB 字节才触发闸）。防线方向为宽松（不误杀合法帧）；ASCII 超限
 * 拒绝路径由 goal-poc3 实测锁定，整跑超时让位独立兜底。
 */
const MAX_CHILD_FRAME_CHARS = 16 * 1024 * 1024;
const MAX_CHILD_FRAME_BUFFER_CHARS = 32 * 1024 * 1024;
/** Pump yield granularity: lines parsed per event-loop tick before yielding. */
const CHILD_FRAME_LINES_PER_TICK = 512;
/** Grace window for sibling work after a hole opens before the run parks (P1 semantics). */
const HOLE_PARK_DRAIN_MS = 750; // brief settle after the child's idle signal

/** Existence probe for a pid (signal 0) — cross-platform, treats EPERM as alive. */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Orphan convergence (audit gap #2): a 'running' row whose owning process is
 * dead can never settle on its own — the resume/amend/fill doors would stay
 * locked forever. Converge it to 'stopped' (the honest terminal state: the
 * run was interrupted; its journalled nodes replay on the next resume). A row
 * owned by a LIVE process is genuinely running elsewhere — leave it alone.
 */
async function convergeOrphanRun(store: SQLiteStateStore & DwfJournalStore, prior: DwfRunRow): Promise<'converged' | 'running'> {
  if (prior.status !== 'running') return 'converged';
  if (pidAlive(prior.runnerPid)) {
    return 'running';
  }
  await store.saveDwfRun({ ...prior, status: 'stopped', runnerPid: undefined, updatedAt: new Date().toISOString() });
  return 'converged';
}

export async function runFacadeScript(options: RunFacadeOptions): Promise<RunFacadeResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const store: SQLiteStateStore & DwfJournalStore = createSQLiteStore(
    resolveDwfJournalPath(cwd, options.dbPath),
  ) as SQLiteStateStore & DwfJournalStore;

  try {
    return await runInner(options, cwd, store);
  } finally {
    store.close();
  }
}

async function runInner(
  options: RunFacadeOptions,
  cwd: string,
  store: SQLiteStateStore & DwfJournalStore,
): Promise<RunFacadeResult> {
  const absoluteScript = path.resolve(cwd, options.scriptPath);
  let source: string;
  try {
    source = fs.readFileSync(absoluteScript, 'utf8');
  } catch (err) {
    return { runId: 'unknown', status: 'compile_failed', error: `cannot read script: ${(err as Error).message}`, stats: { asks: 0, replayHits: 0, amendHits: 0, diverged: 0, phases: [] }, reportItems: [] };
  }

  // ---- Compile (diagnostics never reach the approval/exec path) ----
  const analysis = analyzeFacadeScript(source);
  if (!analysis.ok) {
    return { runId: 'unknown', status: 'compile_failed', diagnostics: analysis.diagnostics, error: 'facade script failed compilation', stats: { asks: 0, replayHits: 0, amendHits: 0, diverged: 0, phases: [] }, reportItems: [] };
  }

  // ---- Run identity + lineage ----
  const { hashScriptSource } = await import('./compile.js');
  const scriptHash = hashScriptSource(source);
  const resumeRunId = options.resumeRunId;
  const amendRunId = options.amendRunId;
  let runId: string;
  let importedCache: Map<string, import('../types.js').DwfNode> | undefined;
  let amendedFrom: string | undefined;
  let priorRunParent: string | undefined;
  let priorSpentTokens: number | undefined;

  const emptyStats = { asks: 0, replayHits: 0, amendHits: 0, diverged: 0, phases: [] as string[] };
  /**
   * Stale-run takeover (the engine's crash-takeover rule): set when a resumed run's row said
   * `running` but its host is gone. Announced as the first event of the
   * resumed stream once the emit closure exists.
   */
  let resumeTakeover: { reason: 'dead-pid' | 'no-recorded-pid'; deadPid?: number } | undefined;
  const emptyReportItems: unknown[] = [];

  if (resumeRunId && amendRunId) {
    return { runId: 'unknown', status: 'failed', error: 'pass either --resume or --amend, not both', stats: emptyStats, reportItems: emptyReportItems };
  }

  if (resumeRunId) {
    const prior = await store.getDwfRun(resumeRunId);
    if (!prior) {
      return { runId: resumeRunId, status: 'failed', error: `run "${resumeRunId}" not found — nothing to resume`, stats: emptyStats, reportItems: emptyReportItems };
    }
    if (prior.status === 'running') {
      // A `running` row is only a permanent lock while its host is alive.
      // Probe the recorded pid: alive → another host is executing, refuse;
      // dead → the host crashed, take the run over and replay the journal;
      // never recorded (legacy pre-pid row, `runnerPid === undefined`) → treat
      // as crash takeover too, so old journals are never locked out.
      const probe = options.pidLivenessProbe ?? isPidAlive;
      if (prior.runnerPid !== undefined && probe(prior.runnerPid)) {
        const refusal = domainError(
          'StorageError',
          `run "${resumeRunId}" is already running (pid ${prior.runnerPid}) — another host is executing this run; stop that host (or wait for it to finish) before resuming`,
          { details: { runId: resumeRunId, pid: prior.runnerPid } },
        );
        return { runId: resumeRunId, status: 'failed', error: refusal.message, stats: emptyStats, reportItems: emptyReportItems };
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
  } else if (options.parentRunId) {
    runId = mintRunId();
    amendedFrom = options.parentRunId; // lineage without cache import
  } else if (amendRunId) {
    const prior = await store.getDwfRun(amendRunId);
    if (!prior) {
      return { runId: 'unknown', status: 'failed', error: `run "${amendRunId}" not found — nothing to amend`, stats: emptyStats, reportItems: emptyReportItems };
    }
    if (prior.status === 'running') {
      const verdict = await convergeOrphanRun(store, prior);
      if (verdict === 'running') {
        return { runId: 'unknown', status: 'failed', error: `run "${amendRunId}" is still running (pid ${prior.runnerPid}) — stop it before amending`, stats: emptyStats, reportItems: emptyReportItems };
      }
    }
    // No scriptHash check: editing the script is the whole point of amend. Unchanged
    // nodes are matched by (siteId, ordinal, inputHash) and replay from the warm cache.
    // The import walks the WHOLE parentRunId lineage (oldest → newest, newest wins on
    // key conflicts): a chained amend inherits its ancestors' warm nodes too, so a
    // pure ask from run 1 still replays in run 3.
    const priorNodes: DwfNode[] = [];
    const lineageSeen = new Set<string>();
    let lineageCursor: string = amendRunId;
    while (lineageCursor && !lineageSeen.has(lineageCursor)) {
      lineageSeen.add(lineageCursor);
      const row: DwfRunRow | null = await store.getDwfRun(lineageCursor);
      if (!row) break;
      priorNodes.push(...(await store.getDwfNodes(lineageCursor)));
      lineageCursor = row.parentRunId ?? '';
    }
    importedCache = new Map(priorNodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
    amendedFrom = amendRunId;
    priorSpentTokens = prior.outputTokensSpent; // amend inherits the spend baseline
    runId = mintRunId();
  } else {
    runId = mintRunId();
  }

  await store.saveDwfRun({
    runId,
    scriptHash,
    scriptPath: absoluteScript,
    argsJson: JSON.stringify(options.args ?? {}),
    status: 'running',
    parentRunId: amendedFrom,
    runnerPid: process.pid,
    createdAt: new Date().toISOString(),
  });

  // ---- Lower + write the entry file (on disk, not argv — Windows argv limits) ----
  const { js } = lowerFacadeScript(source);
  const runDir = path.join(cwd, '.workflow', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const scriptJsPath = path.join(runDir, 'script.js');
  fs.writeFileSync(scriptJsPath, js, 'utf8');

  // G4 fix (a hard-won 'Process and entry file' lesson): args JSON goes into the entry
  // file, never argv — argv dies at Windows' 32,767-character limit.
  const argsJsPath = path.join(runDir, 'args.json');
  fs.writeFileSync(argsJsPath, JSON.stringify(options.args ?? {}), 'utf8');

  // ---- Spawn the sandbox child ----
  const childEntry = options.childEntryPath ?? fileURLToPath(new URL('./child-main.js', import.meta.url));
  // Memory cap first (node options must precede the entry path): a runaway
  // facade script must die of its own OOM instead of exhausting the host.
  // The child receives the args.json PATH (G4 contract above), not the inline
  // JSON — an inline payload re-dies at Windows' 32,767-char argv limit.
  const childArgs = buildSandboxChildArgs(childEntry, scriptJsPath, argsJsPath, options.sandboxMaxOldSpaceSizeMb);
  const child = spawn(process.execPath, childArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Supervised spawn (process-safety rule): POSIX process group leader
    // so a tree kill reaches grandchildren; a whitelisted AND value-masked env
    // (buildSandboxEnv) so the caller's shell secrets never reach the sandbox
    // (环境双层加固铁律 — host-only credentials like the Bedrock provider's
    // AWS_* stay in the parent process).
    detached: process.platform !== 'win32',
    env: buildSandboxEnv(),
  });

  // Stdin EPIPE guard (same settle-race family as the settled guards on
  // reply/pushToChild below, which it complements): a guarded write can pass
  // its settled check while the child is alive, the child then exits without
  // draining its stdin pipe, and libuv surfaces the lost write as an 'error'
  // ("write EPIPE") on the stream — asynchronously, AFTER the write itself
  // succeeded. Without a listener that error escalates to an uncaughtException
  // in the host process (the cross-boundary EPIPE that fails whole test/CLI
  // runs). Nothing reads the pipe anymore at that point and the run's outcome
  // is decided by the frame pump and the close handler, never by this write —
  // so the error is swallowed into a harmless log. A healthy pipe never emits
  // 'error': the normal path is unchanged.
  child.stdin.on('error', (err) => {
    console.warn(`[dwf] sandbox stdin write discarded (child gone): ${(err as Error).message}`);
  });

  let seq = 0;
  // Append-only event ids: a resumed run must CONTINUE the sequence, not
  // restart it — restarting re-uses ids and ON CONFLICT overwrites the first
  // run's events (e.g. dwf_escalation_open lost its question payload). Seed
  // from the id suffix (event.sequence was not persisted before this fix).
  if (options.resumeRunId) {
    try {
      const prior = await store.getEvents(options.resumeRunId);
      seq = prior.reduce((m, e) => {
        const suffix = Number(e.id.slice(e.id.lastIndexOf('-') + 1));
        return Math.max(m, Number.isFinite(suffix) ? suffix : 0, e.sequence ?? 0);
      }, 0);
    } catch {
      /* fresh journal — nothing to continue */
    }
  }
  let asks = 0;
  let replayHits = 0;
  let amendHits = 0;
  let lastSpentTokens: number | undefined;
  let diverged = 0;
  let inFlightAsks = 0;
  /**
   * Malformed child stdout frames (unparseable lines) — counted instead of
   * silently dropped (协议加固项) and emitted as a
   * `dwf_frame_malformed` diagnostic when the run settles, so tearing/garbage
   * leaves an explicit trace in the event stream.
   */
  let malformedFrameCount = 0;
  let parkedAt: { siteId: string; name: string; prompt: string; kind: 'hole' | 'escalation' } | undefined;
  /** Tagged error of the terminal scriptError frame, carried on the dwf_failed event. */
  let scriptErrorTagged: SerializableError | undefined;
  let childIdleSeen = false;
  let notifyActivity: () => void = () => {};

  // ---- Dual persistence (the engine's crash-recovery rule): SQLite + append-only events.jsonl ----
  // Every event the runner emits goes to SQLite (the authoritative journal) AND
  // to `.workflow/runs/<runId>/events.jsonl` (a crash-safe, tooling-readable
  // mirror carrying byte-identical event ids/sequences via appendEvent, so the
  // two stores stay directly comparable — a resume continues the same stream in
  // both because `seq` is seeded from SQLite and the file already holds the
  // earlier lines). The writer uses the default flushSync=true (one
  // appendFileSync per event, no held fd), so there is nothing to close.
  const eventsJsonlPath = path.join(runDir, 'events.jsonl');
  const eventLog = new EventLogWriter(runDir);

  // ---- Watch-graph (live-view requirement): live journal projection → graph.html ----
  // Every emitted event re-folds the accumulated stream through the SAME pure
  // projection the cold replay uses (src/dag/journal-projection.ts) and rewrites
  // graph.html in the run dir — a watched run and its `workflow graph` replay
  // render byte-identically by construction. Re-folding the prefix (instead of
  // patching a mutable graph) is what makes that equality trivially true; runs
  // are bounded by the agent-call cap, so the quadratic total cost is negligible.
  // Failure policy (same style as the events.jsonl mirror below): the graph is
  // a derived VIEW, not journal integrity — a failed write degrades with ONE
  // StorageError-tagged warning and the rebuild is skipped for the rest of this
  // run; it never fails the run and never adds a journal event (a view failure
  // is not a journal fact, and a synthetic event would be seen by the cold
  // replay too, corrupting the projection for tooling that never asked to watch).
  let watchGraphDegraded = false;
  const watchedEvents: WorkflowEvent[] = [];
  const watchGraphPath = path.join(runDir, 'graph.html');
  const renderWatchGraph = options.watchGraph
    ? (event: WorkflowEvent): void => {
        if (watchGraphDegraded) return;
        watchedEvents.push(event);
        try {
          const graph = projectEventsToGraph(watchedEvents);
          fs.writeFileSync(watchGraphPath, new HTMLRenderer().render(graph), 'utf8');
        } catch (err) {
          watchGraphDegraded = true;
          const storageError = domainError(
            'StorageError',
            `graph.html write failed for run ${runId} — the watch-graph view is degraded for the rest of this run; the run itself is unaffected and the journal remains authoritative`,
            { details: { runId, path: watchGraphPath }, cause: (err as Error).message },
          );
          console.warn(`[dwf] ${storageError.message} (cause: ${(err as Error).message})`);
        }
      }
    : undefined;
  // A resumed run continues the SAME stream: seed the watcher with the journal
  // prefix so the watched graph covers the whole run — exactly what a later
  // `workflow graph <run-dir>` cold replay folds. An amend forks a NEW stream
  // (new runId), so it correctly starts empty; its warm hits appear as
  // dwf_amend_hit events in the new stream.
  if (renderWatchGraph && resumeRunId) {
    try {
      watchedEvents.push(...(await store.getEvents(resumeRunId)));
    } catch {
      /* fresh journal — the watcher starts from this invocation's stream */
    }
  }
  /**
   * JSONL-write failure policy (StorageError semantics, locked by
   * tests/integration/dwf-run.test.ts): a failed append must neither silently
   * lose the event — SQLite still holds it — nor blow up the whole run. On the
   * FIRST failure the mirror is marked degraded: one StorageError-tagged
   * `dwf_event_log_write_failed` event is recorded into the authoritative
   * SQLite stream (never into the broken file, which would recurse), a warning
   * goes to stderr, and further appends are skipped for the rest of this run
   * invocation (no per-event failure spam; the degradation marker bounds the
   * gap so it is never silent). The next runner invocation starts a fresh
   * writer and resumes appending.
   */
  let eventLogDegraded = false;
  /**
   * Settled guard for the whole run, hoisted ABOVE the promise executor so the
   * emit closure (defined here, before the executor body runs) and the frame
   * pump's guards (reply/pushToChild/handleChildFrame inside the executor) all
   * read ONE flag. finish() remains the only writer — it flips this exactly
   * once, when the run's terminal state is decided.
   */
  let settled = false;
  const emit = (type: WorkflowEventType, data: Record<string, unknown>): void => {
    options.onEvent?.({ type, data });
    const n = ++seq;
    const event: WorkflowEvent = {
      id: `dwf-${runId}-${n}`,
      runId,
      workflowId: 'facade-script',
      type,
      sequence: n,
      timestamp: new Date().toISOString(),
      data,
    };
    // Watch-graph view (live-view requirement): re-fold the accumulated stream after
    // every emit — the same pure projection the cold replay uses, so the watched
    // render and a later `workflow graph` of the same run agree byte for byte.
    renderWatchGraph?.(event);
    // SQLite — the authoritative copy (pre-existing behavior). The write stays
    // fire-and-forget, but its rejection is not dropped blindly: BEFORE the run
    // settles a storage failure keeps its original loud behavior (rethrown, so
    // it still surfaces as an unhandledRejection), while AFTER the settle it is
    // the close race below and degrades to a warning.
    void store.recordEvent(event).catch((err) => {
      if (!settled) throw err;
      // Settle race (the SIGINT "database is not open" flake): the run is
      // already decided and runFacadeScript's finally has closed the store, but
      // an engine continuation that was still awaiting an in-flight frame can
      // emit one more event here. Its journal write then hits the closed
      // database and used to surface as an unhandledRejection that polluted the
      // host process exit and the parallel test output. The settled result no
      // longer reads the journal, so the late write is dropped with a warning.
      console.warn(`[dwf] journal write for ${event.id} after run settle dropped: ${(err as Error).message}`);
    });
    // events.jsonl — best-effort mirror with explicit, non-silent degradation.
    if (!eventLogDegraded) {
      try {
        eventLog.appendEvent(event);
      } catch (err) {
        eventLogDegraded = true;
        const storageError = domainError(
          'StorageError',
          `events.jsonl append failed for event ${event.id} — the JSONL mirror is degraded for the rest of this run; the SQLite journal remains authoritative`,
          { details: { runId, event: event.id, path: eventsJsonlPath }, cause: (err as Error).message },
        );
        const fn = ++seq;
        // Same settle-race guard as the authoritative write above: post-settle
        // the store may already be closed — degrade to the warning, never to an
        // unhandledRejection.
        void store.recordEvent({
          id: `dwf-${runId}-${fn}`,
          runId,
          workflowId: 'facade-script',
          type: 'dwf_event_log_write_failed',
          sequence: fn,
          timestamp: new Date().toISOString(),
          data: { error: storageError.message, taggedError: redactValue(toSerializableError(storageError)) },
        }).catch((err) => {
          if (!settled) throw err;
          console.warn(`[dwf] degradation marker for ${`dwf-${runId}-${fn}`} after run settle dropped: ${(err as Error).message}`);
        });
        console.warn(`[dwf] ${storageError.message} (cause: ${(err as Error).message})`);
      }
    }
  };

  // Stale-run takeover (the engine's crash-takeover rule): announce the adoption of a `running`
  // row whose host died (or never recorded a pid). Emitted as the FIRST event
  // of the resumed stream — after the journal sequence was seeded above — so
  // the journal shows why this host continued the run.
  if (resumeTakeover !== undefined) {
    emit('dwf_resume_takeover', {
      resumedRunId: runId,
      scriptHash,
      reason: resumeTakeover.reason,
      ...(resumeTakeover.deadPid !== undefined ? { deadPid: resumeTakeover.deadPid } : {}),
    });
  }

  const live = options.liveHtmlPath ? new LiveGraph(options.liveHtmlPath, runId) : undefined;

  const stallMs = resolveStallMs(options.stallMs);

  const engine = new FacadeEngine({
    runId,
    workspace: cwd,
    store,
    args: options.args ?? {},
    approvedCommands: analysis.commands,
    maxConcurrency: options.maxConcurrency ?? (process.env.AI_WORKFLOW_MAX_CONCURRENT_AGENTS ? Number(process.env.AI_WORKFLOW_MAX_CONCURRENT_AGENTS) : undefined),
    stallMs,
    failoverProviders: options.failoverProviders,
    restoreOutputTokensSpent: options.restoreOutputTokensSpent ?? priorSpentTokens,
    importedCache,
    workflowDepth: options.workflowDepth ?? 0,
    onEvent: (e) => {
      if (e.type === 'dwf_ask_start') { asks++; inFlightAsks++; }
      if (e.type === 'dwf_ask_complete') inFlightAsks--;
      if (e.type === 'dwf_replay_hit') replayHits++;
      if (e.type === 'dwf_amend_hit') amendHits++;
      if (e.type === 'dwf_amend_diverged') diverged++;
      if (e.type === 'dwf_budget_spent' && typeof e.data.spent === 'number') lastSpentTokens = e.data.spent;
      if (e.type === 'dwf_hole_open') {
        parkedAt = { siteId: String(e.data.siteId), name: String(e.data.name), prompt: String(e.data.prompt ?? ''), kind: 'hole' };
      }
      if (e.type === 'dwf_escalation_open') {
        parkedAt = { siteId: String(e.data.siteId), name: String(e.data.questionId), prompt: String(e.data.question ?? ''), kind: 'escalation' };
      }
      if (e.type === 'dwf_escalation_open') {
        parkedAt = { siteId: String(e.data.siteId), name: String(e.data.questionId), prompt: String(e.data.question ?? ''), kind: 'escalation' };
      }
      emit(e.type, e.data);
      live?.handle(e.type, e.data);
      if (e.type === 'dwf_budget_spent') {
        // keep the child's budget mirror in sync (spent totals and cap enforcement live here)
        replySafe({ t: 'notify', op: 'budgetSync', spent: Number(e.data.spent ?? 0) });
      }
      notifyActivity();
    },
  });

  let pushToChild: ((frame: unknown) => void) | undefined;
  const replySafe = (frame: unknown): void => pushToChild?.(frame);

  // Assigned when the host-signal handlers are registered at the bottom of the
  // run promise below; finish() — the single choke point every settle path
  // flows through — removes them again. Initialized to a no-op so a pre-
  // registration settle (cannot happen today: child events are async) is safe.
  let removeHostSignalHandlers: () => void = () => {};

  const result = await new Promise<{ status: 'completed' | 'failed' | 'parked' | 'stopped'; value?: unknown; error?: string }>((resolve) => {
    // `settled` is the run-scope flag hoisted above the emit closure — finish()
    // below remains its only writer; the guards here (frame pump, reply,
    // pushToChild, close handler) and the journal-write guards all share it.
    let drainTimer: NodeJS.Timeout | undefined;
    const engineIdle = (): boolean => inFlightAsks === 0;
    const finish = (r: { status: 'completed' | 'failed' | 'parked' | 'stopped'; value?: unknown; error?: string }): void => {
      if (settled) return;
      settled = true;
      // The run is decided — the host-signal handlers have nothing left to
      // protect: remove them so a later Ctrl+C keeps its default meaning and
      // back-to-back runs in one process (node --test runs a whole file in one
      // process) never inherit each other's handlers.
      removeHostSignalHandlers();
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      // The run is decided on every terminal state, so the child's residual life
      // (it would exit on its own milliseconds after done/scriptError) must not
      // linger as post-run async activity — under node --test file-concurrency a
      // lingering child surfaces as a cross-boundary EPIPE / uncaughtException.
      // Nothing observable is lost: the journal and result are already decided.
      // Unified tree kill (零孤儿进程铁律): the ONLY kill path, so a
      // sandbox that spawned its own children cannot leave orphans behind a
      // settled run (POSIX group kill / Windows taskkill /T both cover the
      // direct child too).
      if (child.pid !== undefined) void killTree(child.pid);
      resolve(r);
    };

    const killTimer = setTimeout(() => {
      // The tree kill itself is finish()'s job — the single unified kill path.
      finish({ status: 'failed', error: `run exceeded the whole-run timeout (${options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms)` });
    }, options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);

    // Branch-level hole parking (P2): the child's idle signal is the precise trigger —
    // sibling branches keep running until the realm has nothing left but parked holes.
    // The 10s fallback covers a missed signal (e.g. the child crashed mid-reply).
    const maybePark = (): void => {
      if (!parkedAt || settled || !engineIdle()) return;
      if (drainTimer) return;
      drainTimer = setTimeout(() => {
        if (parkedAt && !settled) {
          finish({ status: 'parked', value: { parked: true, hole: parkedAt } });
        }
      }, childIdleSeen ? HOLE_PARK_DRAIN_MS : 10_000);
    };
    notifyActivity = maybePark;

    let stdoutBuffer = '';
    /**
     * Named frame-budget failure (协议加固): over-budget frames stop
     * the run with ChildFrameLimitExceeded and the unified kill path in finish()
     * tears the child tree down — the parent never absorbs unbounded output.
     */
    const failChildFrameLimit = (detail: string): void => {
      if (settled) return;
      finish({ status: 'failed', error: `ChildFrameLimitExceeded: ${detail}` });
    };
    /**
     * Frame pump (协议加固): frames are parsed one event-loop tick at
     * a time (CHILD_FRAME_LINES_PER_TICK rows, then `setImmediate` yields) so a
     * flooding child can no longer starve the timers phase — the whole-run
     * timeout stays schedulable under sustained output (previously a flood held
     * the loop in the poll phase and the killTimer never fired: measured 213.1s
     * vs a 10s bound). Budgets are enforced before parsing: one line over
     * MAX_CHILD_FRAME_CHARS, or a backlog over MAX_CHILD_FRAME_BUFFER_CHARS,
     * fails the run by name instead of being absorbed.
     */
    let pumping = false;
    const pumpStdout = (): void => {
      if (pumping) return;
      pumping = true;
      setImmediate(() => {
        pumping = false;
        if (settled) {
          stdoutBuffer = '';
          return;
        }
        let lines = 0;
        let idx: number;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          if (idx > MAX_CHILD_FRAME_CHARS) {
            stdoutBuffer = '';
            failChildFrameLimit(`child stdout frame of ${idx} chars exceeds the ${MAX_CHILD_FRAME_CHARS}-char single-frame budget`);
            return;
          }
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line.trim()) continue;
          let frame: ChildToParent;
          try {
            frame = JSON.parse(line);
          } catch {
            // Malformed frames are counted and surfaced as a run-end diagnostic
            // (dwf_frame_malformed) — tearing/garbage is never silently dropped.
            malformedFrameCount++;
            continue;
          }
          void handleChildFrame(frame);
          if (++lines >= CHILD_FRAME_LINES_PER_TICK) {
            pumpStdout(); // yield — timers/signals stay schedulable, resume next tick
            return;
          }
        }
        if (stdoutBuffer.length > MAX_CHILD_FRAME_BUFFER_CHARS) {
          const backlog = stdoutBuffer.length;
          stdoutBuffer = '';
          failChildFrameLimit(`child stdout backlog of ${backlog} chars exceeds the ${MAX_CHILD_FRAME_BUFFER_CHARS}-char buffered-frame budget`);
        }
      });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      // Backlog guard before the pump tick: an unterminated flood must hit the
      // named budget instead of growing the buffer without bound.
      if (stdoutBuffer.length > MAX_CHILD_FRAME_BUFFER_CHARS) {
        const backlog = stdoutBuffer.length;
        stdoutBuffer = '';
        failChildFrameLimit(`child stdout backlog of ${backlog} chars exceeds the ${MAX_CHILD_FRAME_BUFFER_CHARS}-char buffered-frame budget`);
        return;
      }
      pumpStdout();
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Redact at accumulation time (irreversible, before any serialization):
      // everything built from this tail — the close-handler error, the
      // dwf_failed event, the returned RunFacadeResult — inherits the masked
      // form. Idempotent, so re-running it per chunk is safe.
      stderrTail = redactText((stderrTail + chunk).slice(-4000));
    });

    const handleChildFrame = async (frame: ChildToParent): Promise<void> => {
      // Once the run settled, buffered stdout frames are garbage: the store is
      // closed and the child is being killed — touching the engine or replying
      // would either throw or write into a dead pipe.
      if (settled) return;
      if (frame.t === 'notify') {
        if (frame.op === 'actorCreated') engine.onActorCreated(frame.siteId, frame.name, frame.provider);
        if (frame.op === 'cancelCall' && typeof frame.cancelId === 'number') engine.onCancelCall(frame.cancelId);
        if (frame.op === 'budgetSync') engine.setBudgetTotal(frame.total === undefined ? null : frame.total);
        // Branch-level hole parking: the child itself reports "nothing left but
        // parked holes" — precise, no heuristic timers.
        if (frame.op === 'childIdle') { childIdleSeen = true; maybePark(); }
        return;
      }
      if (frame.t === 'call') {
        try {
          const value = await engine.handleCall(frame);
          reply({ t: 'ok', id: frame.id, value });
        } catch (err) {
          // Settle race (same family as the EPIPE guards on this file): the run
          // can settle — SIGINT, whole-run timeout, child exit — while this call
          // is still awaiting engine.handleCall. The engine's continuation then
          // runs after finish() and after runFacadeScript's finally has closed
          // the store, so its journal write (saveDwfNode / evidence row) rejects
          // with "database is not open" and the rejection used to escape here as
          // an unhandledRejection that failed or polluted the host process exit
          // and the parallel test output. The run's result is already decided
          // and nothing reads the journal afterwards, so the continuation
          // exception is swallowed into a harmless warning. Normal pre-settle
          // failures keep the tagged-error path below untouched.
          if (settled) {
            console.warn(`[dwf] engine call ${String(frame.op)} (site ${String(frame.siteId)}) continued after run settle — discarded: ${(err as Error).message}`);
            return;
          }
          // One redaction for persistence (dwf_call_error → SQLite), the
          // child-facing reply and the journal (the engine stores the tagged
          // error on the failed node's error_text): the tagged structure rides
          // the err frame (`error`), the event stream (`taggedError`) and the
          // child may surface it again as a scriptError, which is persisted too.
          // Legacy `name` survives: details.errorName for legacy-named errors
          // (WorkflowBudgetExceededError), the tag itself otherwise.
          const tagged = toDomainError(err);
          const safeTagged = redactValue(toSerializableError(tagged));
          const message = redactText(tagged.message);
          const errorName = tagged.details?.['errorName'];
          const name = typeof errorName === 'string' ? errorName : tagged.tag;
          reply({ t: 'err', id: frame.id, message, name, error: safeTagged });
          emit('dwf_call_error', { op: frame.op, siteId: frame.siteId, error: message, taggedError: safeTagged });
        }
        return;
      }
      if (frame.t === 'done') {
        finish({ status: 'completed', value: frame.value });
        return;
      }
      if (frame.t === 'scriptError') {
        // G7: a policy stop (quota/auth/invalid_request) settles as stopped(provider) —
        // resumable once the user fixes the cause, never a plain failure.
        if (frame.name === 'WorkflowPolicyStopError') {
          finish({ status: 'stopped', error: redactText(frame.message ?? 'provider policy stop') });
          return;
        }
        // Keep the tagged error for the dwf_failed event; the run error text is
        // unchanged (message stays authoritative for old children).
        if (isDomainError(frame.error)) {
          scriptErrorTagged = redactValue(fromSerializableError(frame.error));
        }
        finish({ status: 'failed', error: frame.message ? `script error: ${redactText(frame.message)}` : 'script error (no message)' });
        return;
      }
    };

    // A reply resolving AFTER finish (e.g. a journal replay awaiting the store
    // while the child has already exited) must not write into the dead pipe —
    // that is the EPIPE that fails the whole test/CLI process as uncaughtException.
    const reply = (r: HostReply): void => {
      if (settled) return;
      child.stdin.write(encodeFrame(r));
    };
    pushToChild = (frame: unknown): void => {
      if (settled) return;
      child.stdin.write(encodeFrame(frame));
    };
    // P3 run identity, parent half (contract promised by bea9a05): exactly one
    // runInfo push per child — the realm freezes runState on first receipt, so
    // a second push would throw. resumedFrom mirrors the store's parentRunId
    // lineage (see saveDwfRun below).
    pushToChild({ t: 'notify', op: 'runInfo', runId, resumedFrom: amendedFrom ?? priorRunParent });

    child.on('error', (err) => {
      finish({ status: 'failed', error: `sandbox child failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      if (!settled) {
        finish({ status: 'failed', error: `sandbox child exited before finishing (code ${code})${stderrTail ? `: ${redactText(stderrTail.slice(-800))}` : ''}` });
      }
    });

    // Host-signal supervision (零孤儿进程铁律): Ctrl+C / service stop
    // must not orphan the sandbox tree — the handler kills the whole child tree and
    // settles the run as failed before the host process exits. Registered LAST in
    // the executor so nothing between registration and the await below can throw
    // and leak the handlers; removed again by finish() (every settle path — done,
    // scriptError, close, error, timeout, interrupt — flows through it), which is
    // the "run ended" guarantee the try/finally rule asks for.
    removeHostSignalHandlers = onHostSignals((signal) => {
      if (child.pid !== undefined) void killTree(child.pid);
      finish({ status: 'failed', error: `run interrupted by ${signal} — sandbox process tree killed` });
    });
  });

  await store.saveDwfRun({
    runId,
    scriptHash,
    scriptPath: absoluteScript,
    status: result.status,
    // Settlement rewrites the row; without this the UPSERT would null out the
    // parentRunId recorded at launch and sever the amend lineage.
    parentRunId: amendedFrom ?? (options.resumeRunId ? priorRunParent : undefined),
    runnerPid: undefined, // a settled run has no owning process
    outputTokensSpent: lastSpentTokens,
    updatedAt: new Date().toISOString(),
  });

  // The run error is redacted once and used everywhere it leaves the runner:
  // the dwf_failed event (→ SQLite), the live view (→ HTML) and the returned
  // result (→ CLI console).
  const safeError = result.error === undefined ? undefined : redactText(result.error);
  // Malformed-frame diagnostic (协议加固项): the counted
  // unparseable frames leave an explicit trace in the event stream when the run
  // settles — tearing/garbage is never silent.
  if (malformedFrameCount > 0) {
    emit('dwf_frame_malformed', { count: malformedFrameCount });
  }
  emit(result.status === 'completed' ? 'dwf_completed' : 'dwf_failed', {
    status: result.status,
    error: safeError,
    ...(scriptErrorTagged !== undefined ? { taggedError: scriptErrorTagged } : {}),
    asks,
    replayHits,
  });
  live?.finish({ status: result.status, value: result.value, error: safeError });

  return {
    runId,
    status: result.status,
    value: result.value,
    error: safeError,
    amendedFrom,
    parkedAt: result.status === 'parked' ? parkedAt : undefined,
    stats: { asks, replayHits, amendHits, diverged, phases: analysis.phases },
    reportItems: [],
  };
}

function mintRunId(): string {
  const now = new Date();
  const ts = now.getTime().toString(36);
  return `dwfrun-${ts}-${randomBytes(3).toString('hex')}`;
}

/**
 * The sandbox child's environment — two independent layers (环境双层加固铁律):
 * ① buildSanitizedEnv whitelist (process-supervision): only the platform-critical
 *    base plus explicit allows; the caller's shell credentials never pass by NAME.
 * ② prober sanitizeEnv: whatever survived the whitelist is value-masked
 *    (sensitive keys → ***REDACTED***, credentialed URLs → ://***:***@), so a
 *    sensitive-shaped value cannot slip through by SHAPE.
 * ELECTRON_RUN_AS_NODE is re-set here so an Electron-hosted CLI never boots a
 * Chromium helper in the sandbox. Exported for the redaction test-suite.
 */
export function buildSandboxEnv(): NodeJS.ProcessEnv {
  return sanitizeEnv(buildSanitizedEnv([], { ELECTRON_RUN_AS_NODE: '1' }));
}

/**
 * The sandbox child's node argv — `--max-old-space-size=<cap>` FIRST (node
 * options must precede the entry path), then the child entry, the lowered
 * script path and the run-args JSON file path (G4: args live on disk, never
 * argv — argv dies at Windows' 32,767-character limit; child-main still
 * accepts an inline JSON payload from an older parent).
 *
 * The cap bounds the sandbox heap (process-safety rule): a runaway facade
 * script dies of its own OOM instead of exhausting the host — lifecycle
 * supervision (killTree) bounds WHEN a process dies, the heap cap bounds HOW
 * BIG it may grow first. Resolution order: explicit runner option
 * (`RunFacadeOptions.sandboxMaxOldSpaceSizeMb`) → `AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB`
 * environment variable → 512 MB. Exported for the supervision test-suite.
 */
export function buildSandboxChildArgs(
  childEntry: string,
  scriptJsPath: string,
  argsJson: string,
  maxOldSpaceSizeMb?: number,
): string[] {
  const cap = maxOldSpaceSizeMb ?? parsePositiveInt(process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB) ?? DEFAULT_SANDBOX_MAX_OLD_SPACE_MB;
  return [`--max-old-space-size=${cap}`, childEntry, scriptJsPath, argsJson];
}

/** Strictly-positive integer parse: junk, zero and negatives yield undefined. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Stall window default (90000ms); 0 disables the clock. */
const DEFAULT_STALL_MS = 90_000;

/** explicit option wins, then AI_WORKFLOW_STALL_MS, then the 90s default. */
function resolveStallMs(explicit: number | undefined): number {
  if (explicit !== undefined) return Math.max(0, Math.floor(explicit));
  const raw = process.env.AI_WORKFLOW_STALL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_STALL_MS;
}

// ---------------------------------------------------------------------------
// Holes: fill a parked run and continue it as an amend
// ---------------------------------------------------------------------------

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
  diagnostics?: Array<{ line: number; column: number; code: number; category: string; message: string }>;
}

/**
 * Fill a hole a run is parked at: splice the body where the hole stands, re-analyze
 * the effective script (diagnostics refuse the fill — nothing is spliced), check site
 * stability (every site before the hole must keep its id), journal the fill, then fork
 * an amend — completed nodes replay from the journal at zero cost and the body runs live.
 */
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
      maxConcurrency: options.maxConcurrency ?? (process.env.AI_WORKFLOW_MAX_CONCURRENT_AGENTS ? Number(process.env.AI_WORKFLOW_MAX_CONCURRENT_AGENTS) : undefined),
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
