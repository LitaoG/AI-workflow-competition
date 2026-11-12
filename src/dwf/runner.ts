/**
 * Parent-side runner for facade scripts: compile → lower → sandbox child → pump the
 * NDJSON protocol → engine (journal short-circuit) → result.
 *
 * Mirrors ZCode's launch path: diagnostics never reach the user un-mapped, a run's
 * identity is its scriptHash, resume reuses the same runId and replays from the
 * journal, and the child is spawned with ELECTRON_RUN_AS_NODE=1 so an Electron-hosted
 * CLI never boots a Chromium helper.
 *
 * Lifecycle ownership: the runner marks the run row `running` under the host pid
 * at spawn (saveDwfRun) and finish() — the single choke point every settle path
 * flows through — settles it into exactly one terminal: completed, failed,
 * parked or stopped (compile_failed returns before any row is written).
 *
 * Parked is a first-class terminal, strictly isolated from `failed` (Issue #35):
 * a script calling `hole<T>()` or `escalate()` makes the engine open the site
 * (dwf_hole_open / dwf_escalation_open) and park the branch on a never-settling
 * promise; once the realm has nothing left but parked holes the run settles as
 * `parked` and emits its OWN terminal event `dwf_parked` — never `dwf_failed`,
 * so event-type statistics never count a park as a failure and the two human
 * doors (fillHoleAndRun and `workflow answer`, both admitting parked runs only)
 * stay open. The park trigger and its 10s fallback are documented on maybePark.
 *
 * Submodule map (this file = launch orchestration + the settle state machine):
 * - `run-lineage.ts`      — resume/amend/rerun identity doors + orphan convergence
 * - `run-events.ts`       — RunEventStream: SQLite + events.jsonl dual write
 * - `frame-pump.ts`       — ChildFramePump: NDJSON transport + frame budgets
 * - `sandbox-launch.ts`   — child env/argv/clock knobs
 * - `author-position.ts`  — source-map error mapping + runId mint
 * - `fill-hole.ts`        — the hole-fill door (re-exported below)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFacadeScript } from './compile.js';
import { LiveGraph } from '../dag/live.js';
import { lowerFacadeScript } from './lower.js';
import { FacadeEngine } from './engine.js';
import { aimdGovernor } from './governor.js';
import { redactText, redactValue } from './redact.js';
import { ChildToParent, HostReply, encodeFrame } from './protocol.js';
import { fromSerializableError, isDomainError, toDomainError, toSerializableError } from '../domain/errors.js';
import type { SerializableError } from '../domain/errors.js';
import { createSQLiteStore } from '../state/store.js';
import { killTree, onHostSignals, queryJobGuardStatus, spawnJobGuarded } from '../process-supervision.js';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { RunEventStream } from './run-events.js';
import { ChildFramePump } from './frame-pump.js';
import { resolveRunLineage, emptyRunStats } from './run-lineage.js';
import { buildSandboxChildArgs, buildSandboxEnv, resolveStallMs } from './sandbox-launch.js';
import { describeAuthorPosition } from './author-position.js';
import { DwfJournalStore, WorkflowEventType } from '../types.js';

// Public surface preserved for existing importers (tests, CLI): the
// implementations live in the submodules named in the header map.
export { fillHoleAndRun } from './fill-hole.js';
export type { FillHoleOptions, FillHoleResult } from './fill-hole.js';
export { buildSandboxEnv, buildSandboxChildArgs } from './sandbox-launch.js';
export { firstFacadeStackFrame, mapToAuthorPosition } from './author-position.js';

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
  /**
   * Rerun a prior run with the SAME script from a chosen site (Issue #116).
   * Forks a new runId with the prior run as lineage, like amend. Nodes at
   * sites before `rerunFromSite` (source order) replay from the warm cache
   * when their inputHash matches; that site and every later site run live,
   * even where they succeeded before. Exclusive with resume/amend.
   */
  rerunRunId?: string;
  /** Site id (e.g. "ask#3") where a rerun starts executing live; required with rerunRunId. */
  rerunFromSite?: string;
  dbPath?: string;
  cwd?: string;
  maxConcurrency?: number;
  /**
   * Per-ask stall clock. Defaults to AI_WORKFLOW_STALL_MS, else 90000ms
   * (reference parity); 0 disables it.
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
  /**
   * Run-level output-token budget (canonical parity: the script cannot set it).
   * Injected into the sandbox as a frozen, read-only `budget` object; omit for
   * unlimited. A resumed run must pass the same value again to keep the cap
   * continuous (spent is restored separately).
   */
  budgetTotal?: number;
  /**
   * Externally authorized world.run command names (Issue #127 direction 1):
   * the caller's explicit authorization (--approve-cmd / the MCP
   * approvedCommands parameter). The script's own command list is an intent
   * hint and never authorizes.
   */
  approvedCommands?: string[];
  /**
   * Issue #38 D8-③: the run's model directory — modelId → providerId bindings
   * persona model() ids resolve against (e.g. { "opus": "bedrock" }). Every
   * registered provider id is implicitly a model of the same name.
   */
  modelDirectory?: Readonly<Record<string, string>>;
  /**
   * Interactive confirmation for world.run commands no external source
   * authorized (TTY runs). Absent in non-TTY contexts — unlisted commands are
   * then refused with guidance. NOTE: no mock exemption — mock only stubs the
   * provider while world.run still executes real commands.
   */
  confirmWorldRun?: (cmd: string, args: string[]) => Promise<boolean>;
  /** Whole-run wall clock; the child is killed and the run fails when it fires. */
  runTimeoutMs?: number;
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  /** Test hook: override the compiled child entry path. */
  childEntryPath?: string;
  /**
   * V8 heap cap in MB for the sandbox child, passed as `--max-old-space-size`
   * (GOAL.md process safety: an unbounded sandbox heap is an OOM the process
   * supervisor cannot see). Default 512; when unset, the
   * `AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB` environment variable is honored;
   * the explicit option always wins. Must be a positive number.
   */
  sandboxMaxOldSpaceSizeMb?: number;
  /** Write a live execution view (HTML + state JSON) at this path while the run goes. */
  liveHtmlPath?: string;
  /**
   * Watch the run's graph (GOAL.md 阶段 7.3): after EVERY emit, re-fold the
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
   * resume (GOAL.md §1.5 crash takeover). Defaults to the real OS probe
   * (`isPidAlive`); tests inject a stub so the takeover semantics are verified
   * without spawning or killing real processes.
   */
  pidLivenessProbe?: (pid: number) => boolean;
  /** workflow() composition: lineage parent (fresh child run — no cache import). */
  parentRunId?: string;
  /** workflow() composition: nesting depth (root = 0). */
  workflowDepth?: number;
  /** workflow() composition: saved-workflow names from root to the parent run. */
  workflowAncestry?: string[];
}

export interface RunFacadeResult {
  runId: string;
  status: 'completed' | 'failed' | 'compile_failed' | 'parked' | 'stopped';
  value?: unknown;
  error?: string;
  /** Compile diagnostics when status === 'compile_failed' (hint = Smart Diagnostics Quick Fix). */
  diagnostics?: Array<{ line: number; column: number; code: number; category: string; message: string; hint?: string }>;
  /** When this run amended a prior run: the parent run id (lineage). */
  amendedFrom?: string;
  /** When status === 'parked': the hole or escalation the run is waiting on. */
  parkedAt?: { siteId: string; name: string; prompt: string; kind: 'hole' | 'escalation' };
  /** Terminal snapshot: the last 256 report() items (deduplicated). */
  reportItems: unknown[];
  stats: { asks: number; replayHits: number; amendHits: number; diverged: number; phases: string[] };
  /** Output tokens this run itself spent (workflow() composition, Issue #124:
   * the parent engine absorbs this into its own budget accounting). */
  outputTokensSpent?: number;
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
 * Grace window for sibling work after a hole opens before the run parks (P1
 * semantics) — a brief settle after the child's idle signal. Currently
 * unreachable: the Issue #35 measurement (see the maybePark design conclusion)
 * showed childIdle never fires for any park, so every park rides the 10s
 * fallback arm of the drain timer instead of this 750ms branch.
 */
const HOLE_PARK_DRAIN_MS = 750; // brief settle after the child's idle signal

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
    return { runId: 'unknown', status: 'compile_failed', error: `cannot read script: ${(err as Error).message}`, stats: emptyRunStats(), reportItems: [] };
  }

  // ---- Compile (diagnostics never reach the approval/exec path) ----
  const analysis = analyzeFacadeScript(source);
  if (!analysis.ok) {
    return { runId: 'unknown', status: 'compile_failed', diagnostics: analysis.diagnostics, error: 'facade script failed compilation', stats: emptyRunStats(), reportItems: [] };
  }

  // ---- Run identity + lineage (resume/amend/rerun doors in run-lineage.ts) ----
  const { hashScriptSource } = await import('./compile.js');
  const scriptHash = hashScriptSource(source);
  const lineage = await resolveRunLineage(options, cwd, store, analysis, scriptHash);
  if (!lineage.ok) return lineage.result;
  const { runId, importedCache, amendedFrom, priorRunParent, priorSpentTokens, priorBudgetTotal, resumeTakeover } = lineage.resolution;
  // Issue #118: the effective ceiling — the caller's explicit --budget-total
  // wins; otherwise the run's recorded cap rides every continuation door.
  const effectiveBudgetTotal = options.budgetTotal ?? priorBudgetTotal;

  await store.saveDwfRun({
    runId,
    scriptHash,
    scriptPath: absoluteScript,
    argsJson: JSON.stringify(options.args ?? {}),
    status: 'running',
    parentRunId: amendedFrom,
    runnerPid: process.pid,
    budgetTotal: effectiveBudgetTotal,
    createdAt: new Date().toISOString(),
  });

  // ---- Lower + write the entry file (on disk, not argv — Windows argv limits) ----
  const { js, sourceMap } = lowerFacadeScript(source);
  const runDir = path.join(cwd, '.workflow', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const scriptJsPath = path.join(runDir, 'script.js');
  fs.writeFileSync(scriptJsPath, js, 'utf8');
  const scriptMapPath = path.join(runDir, 'script.js.map');
  if (sourceMap) {
    // F5 (#126): the map must never carry the script's source text — script
    // literals (occasionally tokens) would land on disk. The author source
    // already exists at scriptPath; strip defensively even though the emitter
    // omits sourcesContent by default.
    const mapJson = JSON.parse(sourceMap) as Record<string, unknown>;
    delete mapJson.sourcesContent;
    fs.writeFileSync(scriptMapPath, JSON.stringify(mapJson), 'utf8');
  }

  // G4 fix (ZCode 'Process and entry file' lesson): args JSON goes into the entry
  // file, never argv — argv dies at Windows' 32,767-character limit.
  const argsJsPath = path.join(runDir, 'args.json');
  fs.writeFileSync(argsJsPath, JSON.stringify(options.args ?? {}), 'utf8');

  // ---- Spawn the sandbox child ----
  const childEntry = options.childEntryPath ?? fileURLToPath(new URL('./child-main.js', import.meta.url));
  // Memory cap first (node options must precede the entry path): a runaway
  // facade script must die of its own OOM instead of exhausting the host.
  // The child receives the args.json PATH (G4 contract above), not the inline
  // JSON — an inline payload re-dies at Windows' 32,767-char argv limit.
  const childArgs = buildSandboxChildArgs(childEntry, scriptJsPath, argsJsPath, options.sandboxMaxOldSpaceSizeMb, effectiveBudgetTotal);
  // Supervised spawn (GOAL.md process safety): POSIX process group leader so a
  // tree kill reaches grandchildren; a whitelisted AND value-masked env
  // (buildSandboxEnv) so the caller's shell secrets never reach the sandbox.
  // On win32 the child runs under the Job Object helper (kernel tree-kill + a
  // commit cap at 1.5× the V8 heap cap — non-heap RSS headroom); the fallback
  // path keeps the exact legacy spawn options.
  const child = spawnJobGuarded(process.execPath, childArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSandboxEnv(),
    processMemoryLimitMb: Math.round((options.sandboxMaxOldSpaceSizeMb ?? DEFAULT_SANDBOX_MAX_OLD_SPACE_MB) * 1.5),
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

  // ---- Dual persistence + watch-graph view (run-events.ts) ----
  let settled = false;
  const stream = new RunEventStream(store, runId, runDir, options.onEvent, options.watchGraph, () => settled);
  await stream.seedSequence(options.resumeRunId);
  const emit = (type: WorkflowEventType, data: Record<string, unknown>): void => stream.emit(type, data);

  // Stale-run takeover (GOAL.md §1.5): announce the adoption of a `running`
  // row whose host died (or never recorded a pid). Emitted as the FIRST event
  // of the resumed stream — after the journal sequence was seeded — so the
  // journal shows why this host continued the run.
  if (resumeTakeover !== undefined) {
    emit('dwf_resume_takeover', {
      resumedRunId: runId,
      scriptHash,
      reason: resumeTakeover.reason,
      ...(resumeTakeover.deadPid !== undefined ? { deadPid: resumeTakeover.deadPid } : {}),
    });
  }

  // Win32 Job Object supervision diagnostics: one event per run announcing how
  // the sandbox child is supervised — 'job-object' (kernel kill-tree + commit
  // cap via the compiled job helper) or 'fallback-taskkill'. Degradation is
  // legitimate (e.g. a machine without csc.exe) and must stay observable.
  if (process.platform === 'win32') {
    const guard = queryJobGuardStatus();
    emit('dwf_job_guard', { mode: guard.mode, ...(guard.reason !== undefined ? { reason: guard.reason } : {}) });
  }

  const live = options.liveHtmlPath ? new LiveGraph(options.liveHtmlPath, runId) : undefined;

  const stallMs = resolveStallMs(options.stallMs);

  let asks = 0;
  let replayHits = 0;
  let amendHits = 0;
  let lastSpentTokens: number | undefined;
  let diverged = 0;
  let inFlightAsks = 0;
  let parkedAt: { siteId: string; name: string; prompt: string; kind: 'hole' | 'escalation' } | undefined;
  /** Tagged error of the terminal scriptError frame, carried on the dwf_failed event. */
  let scriptErrorTagged: SerializableError | undefined;
  let childIdleSeen = false;
  let notifyActivity: () => void = () => {};

  const engine = new FacadeEngine({
    runId,
    workspace: cwd,
    store,
    args: options.args ?? {},
    // Issue #127 direction 1: the script's self-declared command list is an
    // intent hint, NOT authorization. The authorized set comes from the
    // caller (--approve-cmd / the MCP approvedCommands parameter, source
    // 'explicit') and the project allowlist (.workflow/approved-commands.json,
    // source 'allowlist'); explicit wins on conflict. Unlisted commands are
    // confirmed interactively when a TTY callback is wired, refused otherwise.
    approvedCommands: (() => {
      const merged = new Map<string, { name: string; source: 'explicit' | 'allowlist'; args?: string[] }>();
      for (const name of options.approvedCommands ?? []) merged.set(name, { name, source: 'explicit' });
      const allowlistPath = path.join(cwd, '.workflow', 'approved-commands.json');
      if (fs.existsSync(allowlistPath)) {
        try {
          // Issue #194 P1: allowlist entries are name + optional parameter
          // shape ({name, args}) per the #127 ruling — a bare string or an
          // entry without args authorizes the whole binary; an entry with args
          // authorizes only invocations whose arguments start with the
          // declared sequence (an empty array = the bare zero-arg call).
          const parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as { approved?: Array<string | { name: string; args?: unknown }> };
          for (const entry of parsed.approved ?? []) {
            const name = typeof entry === 'string' ? entry : entry?.name;
            if (typeof name !== 'string') continue;
            // A compound name like "git status" can NEVER match (world.run's
            // cmd is the binary name) — the old parser silently dropped it and
            // the project author believed the command was authorized. Warn
            // loudly and keep it unauthorized (fail-closed, Issue #194 P1
            // consequence B); parameter shapes go in `args`.
            if (/\s/.test(name)) {
              console.warn(
                `[dwf] approved-commands.json entry "${name}" contains whitespace and can never match a command name — ` +
                'use {"name": "<binary>", "args": ["status"]} for a parameter shape; the entry is ignored',
              );
              continue;
            }
            if (merged.has(name)) continue;
            const rawArgs = (typeof entry === 'object' && entry !== null && Array.isArray(entry.args)) ? entry.args : undefined;
            const shape = rawArgs === undefined
              ? undefined
              : rawArgs.map((a) => String(a));
            merged.set(name, { name, source: 'allowlist', ...(shape !== undefined ? { args: shape } : {}) });
          }
        } catch (err) {
          console.warn(`[dwf] approved-commands.json is not valid JSON and was ignored: ${(err as Error).message}`);
        }
      }
      return [...merged.values()];
    })(),
    maxConcurrency: options.maxConcurrency,
    stallMs,
    failoverProviders: options.failoverProviders,
    budgetTotal: effectiveBudgetTotal,
    confirmWorldRun: options.confirmWorldRun,
    // Quota-reset waits must never outlive the whole-run clock: the engine uses
    // this deadline to decline a wait that the runner would kill anyway.
    deadlineMs: Date.now() + (options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
    restoreOutputTokensSpent: options.restoreOutputTokensSpent ?? priorSpentTokens,
    importedCache,
    modelDirectory: options.modelDirectory,
    workflowDepth: options.workflowDepth ?? 0,
    workflowAncestry: options.workflowAncestry ?? [],
    onEvent: (e) => {
      if (e.type === 'dwf_ask_start') { asks++; inFlightAsks++; }
      if (e.type === 'dwf_ask_complete') inFlightAsks--;
      // A cancelled ask is settled by the engine's cancelled event (no failed
      // node is journalled), so release its in-flight slot here.
      if (e.type === 'dwf_node_failed' && e.data.cancelled === true && e.data.kind === 'ask') {
        inFlightAsks = Math.max(0, inFlightAsks - 1);
      }
      if (e.type === 'dwf_replay_hit') replayHits++;
      if (e.type === 'dwf_amend_hit') amendHits++;
      if (e.type === 'dwf_amend_diverged') diverged++;
      // Issue #124: child-workflow events carry childWorkflow (the engine's
      // re-emit tag) — a child's spend must not overwrite this run's own
      // settlement accounting (the parent engine absorbs it explicitly).
      if (e.type === 'dwf_budget_spent' && typeof e.data.spent === 'number' && e.data.childWorkflow === undefined) {
        lastSpentTokens = e.data.spent;
      }
      // Park-site capture: the open events record WHERE the run is suspended;
      // the parking itself happens in maybePark (below) once the engine is idle.
      // The snapshot feeds the parked result value and result.parkedAt, and
      // `kind` routes the human door (hole → fillHoleAndRun, escalation →
      // `workflow answer`).
      if (e.type === 'dwf_hole_open') {
        parkedAt = { siteId: String(e.data.siteId), name: String(e.data.name), prompt: String(e.data.prompt ?? ''), kind: 'hole' };
      }
      if (e.type === 'dwf_escalation_open') {
        parkedAt = { siteId: String(e.data.siteId), name: String(e.data.questionId), prompt: String(e.data.question ?? ''), kind: 'escalation' };
      }
      emit(e.type, e.data);
      live?.handle(e.type, e.data);
      if (e.type === 'dwf_budget_spent' && e.data.childWorkflow === undefined) {
        // keep the child's budget mirror in sync (spent totals and cap
        // enforcement live here). Issue #124: child spend is absorbed by the
        // parent engine and re-announced untagged — the script's budget view
        // must never be overwritten by a child's own totals.
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

  // Hoisted so the settle path (below the promise) can read the final
  // malformed-frame count; the pump is constructed synchronously inside the
  // executor, so it is always set once the promise resolves.
  let pump: ChildFramePump | undefined;

  const result = await new Promise<{ status: 'completed' | 'failed' | 'parked' | 'stopped'; value?: unknown; error?: string }>((resolve) => {
    // `settled` is the run-scope flag hoisted above the emit closure — finish()
    // below remains its only writer; the guards here (frame pump, reply,
    // pushToChild, close handler) and the journal-write guards all share it.
    let drainTimer: NodeJS.Timeout | undefined;
    const engineIdle = (): boolean => inFlightAsks === 0;
    const finish = (r: { status: 'completed' | 'failed' | 'parked' | 'stopped'; value?: unknown; error?: string }): void => {
      if (settled) return;
      settled = true;
      // Issue #37 layer 3: the run's AIMD growth bound leaves the derivation
      // when the run settles — every settle path flows through this choke point.
      aimdGovernor.retireRun(runId);
      // Issue #107 (phenomenon B): the run is decided — in-flight asks must
      // not keep running (and billing) for results nobody will read. Every
      // registered controller aborts, so provider round trips unwind and the
      // post-settle continuations become the harmless swallowed warnings the
      // settle-race guards below already anticipate.
      engine.abortInFlight();
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
      // Unified tree kill (GOAL.md 铁律 3 — 零孤儿进程): the ONLY kill path, so a
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
    //
    // Issue #35 design conclusion (escalate fast path): measured hole-only parking
    // 10521ms and escalation-only parking 10436ms — the childIdle signal never
    // fires for ANY park, so every park rides the 10s fallback and the 750ms drain
    // below is currently unreachable. Root cause: a parking call (hole/escalate)
    // itself occupies the child's __pending forever (the host never replies to it),
    // so `__pending.size === 0 && __openHoles > 0` cannot hold while parked, and no
    // inbound frame follows a parking call to re-run that check. Deliberately NOT
    // fixed here: a live signal needs the child to exclude parking calls from its
    // in-flight accounting, count escalations alongside holes, and re-check after
    // the microtask queue drains (the stall-check moment) —
    // plus a host-side re-arm when the signal lands after this timer did. That is
    // a parking-latency behavior change needing its own design round; the 10s
    // fallback is semantically correct (the park happens, resumption recovers) and
    // stays until then.
    //
    // What the fallback actually buys: parkedAt alone settles nothing — without
    // this timer a park would hang at the open hole until the whole-run killTimer
    // (DEFAULT_RUN_TIMEOUT_MS) tore the child down as `failed`, misfiling a
    // human-interaction pause as a failure and locking both human doors
    // (fillHoleAndRun and `workflow answer` gate on status === 'parked'). The
    // fallback converts that dead hang into a proper dwf_parked settle: the
    // journal records the park, the child tree is reaped through the unified
    // kill path in finish(), and the fill/answer amend replays the journal at
    // zero cost. Arming is gated on engineIdle() — the countdown starts only
    // once no ask is in flight — and the timer is one-shot: engine events re-run
    // these guards (notifyActivity) but never re-arm or extend it.
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

    /**
     * Named frame-budget failure: over-budget frames stop the run with
     * ChildFrameLimitExceeded and the unified kill path in finish() tears the
     * child tree down — the parent never absorbs unbounded output.
     */
    const failChildFrameLimit = (detail: string): void => {
      if (settled) return;
      finish({ status: 'failed', error: `ChildFrameLimitExceeded: ${detail}` });
    };
    pump = new ChildFramePump(child.stdout, {
      isSettled: () => settled,
      onFail: failChildFrameLimit,
      onFrame: (frame) => void handleChildFrame(frame),
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
        if (frame.op === 'actorCreated') engine.onActorCreated(frame.siteId, frame.name, frame.provider, frame.tier);
        if (frame.op === 'cancelCall' && typeof frame.cancelId === 'number') engine.onCancelCall(frame.cancelId);
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
        // #126 §2.2: surface the author's original row/column for the failing
        // frame. Unmappable errors (no map on disk, no facade frame) keep the
        // message byte-identical to the pre-map behavior.
        const where = describeAuthorPosition(runDir, frame.stack);
        const suffix = frame.message ? `script error: ${redactText(frame.message)}` : 'script error (no message)';
        finish({ status: 'failed', error: `${suffix}${where}` });
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
    // P3 run identity, parent half: exactly one runInfo push per child — the
    // realm freezes runState on first receipt, so a second push would throw.
    // resumedFrom mirrors the store's parentRunId lineage.
    pushToChild({ t: 'notify', op: 'runInfo', runId, resumedFrom: amendedFrom ?? priorRunParent });

    child.on('error', (err) => {
      finish({ status: 'failed', error: `sandbox child failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      // By the time 'close' fires every byte the child wrote is in the pump's
      // buffer, but the pump yields every CHILD_FRAME_LINES_PER_TICK lines, so
      // complete frames (a done frame among them) can still be queued. Decide
      // only after the pump has drained them; a done frame it reaches settles
      // the run first and this verdict never fires.
      const settleIfUnfinished = (): void => {
        if (settled) return;
        if (pump?.hasPending) {
          pump.pump();
          setImmediate(settleIfUnfinished);
          return;
        }
        finish({ status: 'failed', error: `sandbox child exited before finishing (code ${code})${stderrTail ? `: ${redactText(stderrTail.slice(-800))}` : ''}` });
      };
      settleIfUnfinished();
    });

    // Host-signal supervision (GOAL.md 铁律 3 — 零孤儿进程): Ctrl+C / service stop
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
    outputTokensSpent: lastSpentTokens ?? priorSpentTokens,
    // Same UPSERT hazard as parentRunId: without this the settlement would
    // null the cap recorded at launch (Issue #118).
    budgetTotal: effectiveBudgetTotal,
    updatedAt: new Date().toISOString(),
  });

  // The run error is redacted once and used everywhere it leaves the runner:
  // the dwf_failed event (→ SQLite), the live view (→ HTML) and the returned
  // result (→ CLI console).
  const safeError = result.error === undefined ? undefined : redactText(result.error);
  // Malformed-frame diagnostic: the counted unparseable frames leave an
  // explicit trace in the event stream when the run settles — tearing/garbage
  // is never silent.
  if (pump !== undefined && pump.malformedFrames > 0) {
    emit('dwf_frame_malformed', { count: pump.malformedFrames });
  }
  // Terminal event per status (Issue #35): parked gets its own dwf_parked —
  // emitting dwf_failed{status:"parked"} made event-type statistics count every
  // park as a failure. The payload keeps status:"parked" so consumers keyed on
  // data.status stay valid. The isolation is end-to-end and pinned by the
  // workflow-governance Tier 3 test (terminal selection, DWF_PARKED vocabulary,
  // this design conclusion), so a regression to the legacy shape cannot merge
  // silently.
  emit(result.status === 'completed' ? 'dwf_completed' : result.status === 'parked' ? 'dwf_parked' : 'dwf_failed', {
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
    outputTokensSpent: lastSpentTokens ?? priorSpentTokens,
  };
}
