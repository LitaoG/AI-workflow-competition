/**
 * FacadeEngine — the parent-side executor of the child's `__host.*` boundary calls.
 *
 * The deterministic core, modeled on ZCode's engine: every journalled operation is
 * identified by `(runId, siteId, ordinal)` plus an `inputHash` of its inputs. On
 * resume the journal hit short-circuits — the recorded result is returned with zero
 * provider calls and zero process spawns — and an inputHash mismatch fails loudly
 * instead of silently misbinding. Replay is not a special mode; it is the normal
 * path hitting the cache.
 *
 * Journalled kinds: ask, worldRead, worldRun, artifact. Presentation calls (phase,
 * log) are recorded as events only; report() additionally journals each item as
 * its own `report` node, fire-and-forget — a journal failure must never kill the
 * presentation channel. Every journalled node also appends an entry to the
 * evidence ledger (`dwf_evidence`) at its saveNode point.
 *
 * What this engine deliberately does NOT have: a phase-dependency DAG. Phases are
 * presentation markers only (`enterPhase` emits an event and nothing else) and
 * orchestration control flow is the compiled script's native TypeScript — the
 * engine intercepts boundary calls alone. Kahn-style dependency validation and
 * cycle rejection belong to the declarative `defineWorkflow` engine
 * (`validate()` in src/core/workflow.ts), not here.
 *
 * Submodule map (this file = facade + dispatch + ask orchestration + journalled core):
 * - `replay-pool.ts`              — settle pools + the NUL-template inputHash
 * - `ask-executor.ts`             — one live ask's failover/retry/AIMD execution
 * - `budget-ledger.ts`            — output-token accounting + live-call caps
 * - `host-boundary-dispatcher.ts` — world read ops and supervised spawn
 * - `artifact-ledger.ts`          — artifact identity, versions, caps
 * - `evidence-ledger.ts`          — evidence entries at saveNode points
 */
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveAskConcurrency } from '../execution/swarm-dispatcher.js';
import { providerRegistry } from '../agent/provider.js';
import { HostCallFrame, WorldRunResult } from './protocol.js';
import { redactText, redactValue } from './redact.js';
import { domainError, toDomainError, toSerializableError } from '../domain/errors.js';
import { listSavedWorkflows } from './saved.js';
import { RetryOrchestrator } from './retry-orchestrator.js';
import { SettlePools, journalInputHash } from './replay-pool.js';
import { WorldBoundary } from './host-boundary-dispatcher.js';
import { ArtifactLedger } from './artifact-ledger.js';
import { BudgetLedger } from './budget-ledger.js';
import { executeAsk } from './ask-executor.js';
import { zodFromJsonSchema } from './json-schema-zod.js';
import { recordNodeEvidence } from './evidence-ledger.js';
import { StateStore, DwfJournalStore, DwfNode, LLMMessage, TokenUsage, WorkflowEventType } from '../types.js';
import { WORKFLOW_EVENT } from '../domain/events.js';
import { resolveModelToProvider } from '../agent/model-router.js';

/**
 * Boundary payload cap for ask prompts and log messages (GOAL.md 差距矩阵 D4,
 * "ask/log 入口同款上限"): mirrors the runner's 16MB single-frame budget
 * (MAX_CHILD_FRAME_CHARS in runner.ts). The wire budget rejects an oversize
 * frame first on the real pipeline; this op-level check names the failure at
 * the op itself (ChildFrameLimitExceeded via details.errorName) for direct
 * engine drives and any future transport that bypasses the frame pump.
 */
const BOUNDARY_PAYLOAD_CAP_CHARS = 16 * 1024 * 1024;

export interface FacadeEngineOptions {
  runId: string;
  workspace: string;
  store: StateStore & DwfJournalStore;
  args: Record<string, unknown>;
  /**
   * Commands EXTERNALLY authorized for world.run (Issue #127 direction 1).
   * The script's self-declared list is an intent hint, never authorization —
   * every entry must come from the caller (--approve-cmd / the MCP
   * approvedCommands parameter) or the project allowlist
   * (.workflow/approved-commands.json), and the source is recorded per call.
   * Allowlist entries may carry a parameter shape (`args: string[]`, Issue
   * #194 P1): the declared sequence must match the actual args element-wise
   * (prefix) — an empty array authorizes only the bare zero-arg call. Entries
   * without `args` authorize every argument list of that binary.
   */
  approvedCommands: Array<{ name: string; source: 'explicit' | 'allowlist'; args?: string[] }>;
  /**
   * Interactive confirmation for world.run commands that no external source
   * authorized (TTY runs only — there is NO mock exemption, because mock only
   * stubs the provider while world.run still executes real commands). Absent
   * in non-TTY contexts (tests, MCP) — unlisted commands are then refused
   * with guidance.
   */
  confirmWorldRun?: (cmd: string, args: string[]) => Promise<boolean>;
  /**
   * Failover chain for actor asks: when the routed provider's ask fails with a
   * retryable classified error, subsequent providers are tried in order
   * (retry-orchestrator policy: per-provider + total attempt budgets, circuit
   * breaker, Retry-After aware backoff).
   */
  failoverProviders?: string[];
  /**
   * Output tokens already spent by this runId's earlier attempts (audit gap #4):
   * restored on resume so the budget hard-cap stays continuous across resumes
   * instead of resetting to zero.
   */
  restoreOutputTokensSpent?: number;
  /**
   * Executed (live) asks already counted by this runId's earlier attempts
   * (Issue #63): restored on resume so the agent() call cap and the one-shot
   * size warning continue across resumes instead of restarting from zero.
   */
  restoreExecutedAsks?: number;
  /**
   * Run-level output-token budget (canonical parity: read-only in the sandbox).
   * Omit/null for unlimited. The runner seeds the child and the enforcer with
   * the same value so the script can read but never raise its cap.
   */
  budgetTotal?: number;
  /** Whole-run deadline (epoch ms); a quota reset beyond it is not waited for. */
  deadlineMs?: number;
  maxConcurrency?: number;
  /**
   * Per-ask stall clock (90s default parity). 0 disables it. The runner
   * resolves the default from AI_WORKFLOW_STALL_MS or 90000ms.
   */
  stallMs?: number;
  onEvent?: (event: { type: WorkflowEventType; data: Record<string, unknown> }) => void;
  /** When false, the journal is bypassed entirely (fresh run semantics on a reused runId is rejected by the runner, not here). */
  replayEnabled?: boolean;
  /**
   * Warm cache imported from a prior run for an amend (keyed `siteId#ordinal`).
   * A node whose inputHash matches replays at zero cost; a mismatch marks the
   * node diverged and executes live — the amend never fails loudly, it forks.
   */
  importedCache?: Map<string, DwfNode>;
  /** workflow() composition: nesting depth (root = 0). */
  /**
   * Issue #38 D8-③: the run's model directory — modelId → providerId bindings
   * persona model() ids resolve against. Every registered provider id is
   * implicitly a model of the same name (provider self-map).
   */
  modelDirectory?: Readonly<Record<string, string>>;
  workflowDepth?: number;
  /**
   * workflow() composition: saved-workflow names from the root run down to this
   * run (exclusive of this run). Used for cycle detection and the depth cap.
   */
  workflowAncestry?: string[];
}

export class FacadeEngine {
  private readonly ordinals = new Map<string, number>();
  /** Persistent actor sessions: one conversation per agent(name), kept across asks. */
  private readonly actors = new Map<string, { name: string; provider?: string; tier?: 'fast' | 'deep'; model?: string; modelProvider?: string; history: LLMMessage[]; chain: Promise<unknown>; personaJson?: string; asks: number }>();

  /**
   * Issue #39: per-actor named-cache consumption state (amend import path).
   * Attached lazily at the actor's first ask: a candidate exists when the
   * imported lineage carries ask rows under the SAME effective name and the
   * canonical persona matches (canonical matchImportedActor parity — an
   * anonymous actor never attaches). Divergence is monotonic: one content
   * miss detaches the actor for good.
   */
  private actorImportState?: Map<string, { attached: boolean; diverged: boolean; cursor: number; rows: DwfNode[] }>;
  /** In-flight ask abort controllers keyed by the child's call id (sessions.cancel). */
  private readonly inFlight = new Map<number, AbortController>();
  private askQueue: Array<() => void> = [];
  private inFlightAsks = 0;
  /** Retry/failover policy brain above the classifier (see retry-orchestrator.ts). */
  private readonly retryOrchestrator = new RetryOrchestrator();
  private readonly settlePools: SettlePools;
  private readonly boundary: WorldBoundary;
  private readonly budget: BudgetLedger;
  private readonly artifacts: ArtifactLedger;
  /**
   * Import-closure gate (ZCode parity): true after the first world.run execution —
   * the prior-run world the imported cache described no longer exists, so
   * world-derived nodes stop consulting it. One-way; re-fires on worldRun replays.
   */
  private importClosed = false;
  /**
   * Amend divergence monotonicity (P0-3): actors whose warm-cache prefix has
   * diverged. The first ask warm-cache miss marks the actor; every later ask of
   * that actor skips the imported cache and executes live, so an amend never
   * produces a half-warm, half-live conversation prefix. The
   * `dwf_amend_diverged` event fires once per actor, at the first diverging node.
   */
  private readonly divergedActors = new Set<string>();
  /**
   * Same-script replay strictness (P0-2): true when no amend warm cache is in
   * play — a fresh run or a same-runId resume. The runner refuses a same-runId
   * resume whose scriptHash differs before any engine is constructed, so under
   * this flag the journal pool is guaranteed to describe the CURRENT script and
   * ask replays enforce positional (siteId, ordinal) matching on top of the
   * content pool. Amend runs (importedCache present; scriptHash intentionally
   * different) keep the legacy content-only matching.
   */
  private readonly sameScriptResume: boolean;

  /** Maximum composed workflows in one chain (the root run is not counted). */
  private static readonly MAX_WORKFLOW_NESTING_DEPTH = 5;

  private reportCount = 0;
  private reportBytes = 0;
  private readonly reportHashes = new Set<string>();
  private readonly reportItems: unknown[] = [];
  private readonly reportOrdinals = new Map<string, number>();

  constructor(private readonly options: FacadeEngineOptions) {
    this.sameScriptResume = options.importedCache === undefined;
    this.settlePools = new SettlePools(options.importedCache);
    this.boundary = new WorldBoundary(options.workspace);
    this.budget = new BudgetLedger({
      restoreOutputTokensSpent: options.restoreOutputTokensSpent,
      restoreExecutedAsks: options.restoreExecutedAsks,
      budgetTotal: options.budgetTotal,
    });
    this.artifacts = new ArtifactLedger(this.boundary);
  }

  /** Abort the provider request behind a pending ask (sessions.cancel from the realm). */
  onCancelCall(cancelId: number): void {
    // The reason string distinguishes a race-loser cancellation from a
    // caller/settle abort: only the race loser gets the conservative
    // estimated-usage entry (Issue #125) — settle aborts must NOT bill past
    // the settle point (#107's contract).
    this.inFlight.get(cancelId)?.abort('race-loser');
  }

  /**
   * The run settled (Issue #107, phenomenon B): stop paying for orphaned
   * in-flight asks. Every registered controller aborts — the provider round
   * trip unwinds (the rpc layer passes the signal down and re-checks it
   * between attempts), the seat waiters resolve straight into their (already
   * aborted) asks, and nothing bills past the settle point. Observability
   * rides the dwf_inflight_abort event.
   */
  abortInFlight(): void {
    const count = this.inFlight.size;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    const waiters = this.askQueue.splice(0);
    for (const wake of waiters) wake();
    if (count > 0) this.emit('dwf_inflight_abort', { aborted: count });
  }

  /** Registry size for tests and settle-time diagnostics. */
  inFlightSize(): number {
    return this.inFlight.size;
  }

  /** Terminal snapshot: the last 256 report items (deduplicated). */
  getReportItems(): unknown[] {
    return [...this.reportItems];
  }

  /** Output tokens spent so far — persisted at settle for cross-resume continuity. */
  getOutputTokensSpent(): number {
    return this.budget.spent;
  }

  /**
   * workflow(name) — compose a saved workflow as a CHILD run (host-style composition): own runId (lineage → this run), own
   * compile-checked approvals, own sandbox. Composition is multi-level but bounded:
   * at most MAX_WORKFLOW_NESTING_DEPTH saved workflows in a chain, and a name may
   * not repeat in the chain (cycle guard). The base contract hard-rejects any
   * nesting; this is a deliberate, documented extension.
   */
  private async composeWorkflow(siteId: string, name: string): Promise<unknown> {
    const ancestry = this.options.workflowAncestry ?? [];
    if (ancestry.includes(name)) {
      throw new Error(`workflow() cycle detected: ${[...ancestry, name].join(' -> ')}. Each workflow may appear only once in a composition chain.`);
    }
    if (ancestry.length >= FacadeEngine.MAX_WORKFLOW_NESTING_DEPTH) {
      throw new Error(`workflow() nesting depth limit reached (${FacadeEngine.MAX_WORKFLOW_NESTING_DEPTH}); chain: ${[...ancestry, name].join(' -> ')}. Inline deeper steps or split into separate runs.`);
    }
    const saved = listSavedWorkflows(this.options.workspace).find((w) => w.name === name);
    if (!saved) {
      const known = listSavedWorkflows(this.options.workspace).map((w) => w.name);
      throw new Error(`workflow() could not resolve "${name}" — saved workflows: ${known.join(', ') || 'none (register via .workflow/workflows/)'}`);
    }
    const { runFacadeScript } = await import('./runner.js');
    const ordinal = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, ordinal);
    const child = await runFacadeScript({
      scriptPath: saved.scriptPath,
      cwd: this.options.workspace,
      // Issue #35: the parent-site coordinates ride in the child's args (and
      // therefore its journal row's argsJson) — the composition re-entry cache
      // import (run-lineage.ts) matches prior child runs per call SITE, so two
      // workflow() calls to the same saved workflow under one parent never
      // cross-import each other's journals.
      args: { ...this.options.args, workflowParent: this.options.runId, workflowParentSite: siteId, workflowParentOrdinal: ordinal },
      parentRunId: this.options.runId,
      workflowDepth: (this.options.workflowDepth ?? 0) + 1,
      workflowAncestry: [...ancestry, name],
      stallMs: this.options.stallMs,
      // The child gets what remains of the parent's cap, not a fresh total.
      budgetTotal: this.budget.childBudgetRemainder(),
      dbPath: path.join(this.options.workspace, '.workflow', 'dwf.sqlite'),
      onEvent: (e) => this.emit(e.type as WorkflowEventType, { ...e.data, childWorkflow: name }),
    });
    this.emit('dwf_child_workflow', { siteId, name, childRunId: child.runId, status: child.status });
    // Issue #124: the child billed against the parent's remaining budget —
    // without absorbing its spend here the parent's own counter (and the
    // budget check) never saw it, so N sequential workflow() calls could
    // bill N+1x the cap. Absorb, then re-announce the parent-level total so
    // the runner's settlement and the script's budget view (both driven by
    // dwf_budget_spent events) include child spend too.
    if (typeof child.outputTokensSpent === 'number' && child.outputTokensSpent > 0) {
      const spent = this.budget.absorbChildSpend(child.outputTokensSpent);
      this.emit('dwf_budget_spent', { spent, total: this.budget.total });
    }
    if (child.status !== 'completed') {
      throw new Error(`child workflow "${name}" (${child.runId}) ended ${child.status}${child.error ? `: ${child.error}` : ''}`);
    }
    return child.value;
  }

  /** Dispatch one boundary call from the child; resolves with the reply value. */
  async handleCall(frame: HostCallFrame): Promise<unknown> {
    const p = frame.payload as unknown[];
    switch (frame.op) {
      case 'createActor':
        return this.createActor(String(frame.siteId), String(p[0] ?? ''), p[1] === null || p[1] === undefined ? undefined : String(p[1]), p[2] === null || p[2] === undefined ? undefined : String(p[2]), p[3] === null || p[3] === undefined ? undefined : String(p[3]));
      case 'escalate':
        return this.escalate(String(frame.siteId), String(p[0] ?? ''));
      case 'ask':
        return this.ask(String(frame.siteId), p[0], String(p[1] ?? ''), (p[2] as string | null) ?? null, frame.id, p[3] === true);
      case 'enterPhase':
        return this.enterPhase(String(p[0] ?? ''), p[1] === undefined ? undefined : Number(p[1]));
      case 'log':
        return this.log(p[0]);
      case 'report':
        return this.report(String(frame.siteId), p[0], p[1] === null || p[1] === undefined ? undefined : String(p[1]));
      case 'declareArtifact':
        // Issue #38 D8-③ preset family: a declaration, not an effect — validate,
        // journal once, and answer immediately (the script never awaits a value).
        return this.declareArtifact(String(frame.siteId), String(p[0] ?? ''), (p[1] as unknown[]) ?? []);
      case 'artifact':
        return this.artifact(String(frame.siteId), String(p[0]), (p[1] as unknown[]) ?? []);
      case 'worldRead':
        return this.worldRead(String(frame.siteId), String(p[0]), (p[1] as unknown[]) ?? []);
      case 'worldRun':
        return this.worldRun(String(frame.siteId), String(p[0] ?? ''), (p[1] as string[] | undefined) ?? [], p[2] as { timeoutMs?: number } | undefined);
      case 'hole':
        return this.hole(String(frame.siteId), String(p[0] ?? ''), String(p[1] ?? ''));
      case 'workflow':
        return this.composeWorkflow(String(frame.siteId), String(p[0] ?? ''));
      case 'banned':
        // Runtime backstop of the compiler's construct ban → CompileError, the
        // same tag the child realm's purity shims use.
        throw domainError('CompileError', String(p[0] ?? 'banned construct'), {
          details: { construct: String(p[0] ?? 'banned construct') },
        });
      default:
        throw domainError('AgentError', `unknown host op: ${(frame as { op: string }).op}`, {
          details: { op: (frame as { op: string }).op },
        });
    }
  }

  // ---------------------------------------------------------------- actors

  /**
   * Register an actor created synchronously in the child realm (notify frame).
   * The child owns actor identity; the parent keeps the persistent session
   * (conversation history) and validates ask() receivers against this set. An
   * unknown provider fails loudly — routing is part of the approved run shape.
   */
  onActorCreated(siteId: string, name?: string, provider?: string, tier?: string, model?: string): void {
    const display = name && name !== siteId ? name : `agent-${siteId}`;
    if (provider !== undefined && !providerRegistry.list().includes(provider)) {
      throw domainError('AgentError', `unknown provider "${provider}" for actor "${display}" — registered providers: ${providerRegistry.list().join(', ')}`, {
        details: { provider, actor: display, registeredProviders: providerRegistry.list() },
      });
    }
    if (tier !== undefined && tier !== 'fast' && tier !== 'deep') {
      throw domainError('AgentError', `unknown tier "${tier}" for actor "${display}" — expected "fast" | "deep"`, {
        details: { tier, actor: display },
      });
    }
    // Issue #38: the persona model binding resolves against the run's model
    // directory at CREATION time (canonical 9011 parity — an unresolved id fails
    // the run before any ask spends tokens); the resolved provider wins routing
    // over provider/tier (canonical precedence: persona model binding first).
    const modelProvider = model === undefined ? undefined : resolveModelToProvider(model, this.options.modelDirectory);
    this.actors.set(siteId, {
      name: display,
      provider,
      tier: tier as 'fast' | 'deep' | undefined,
      model,
      modelProvider,
      history: [],
      chain: Promise.resolve(),
      // Issue #39: canonical persona for the named-cache attach check
      personaJson: canonicalPersonaJson({ name: display, provider, tier, model }),
      asks: 0,
    });
    this.emit('dwf_actor_created', { siteId, name: display, provider: provider ?? '(default)', tier: tier ?? '(none)', ...(model !== undefined ? { model, modelProvider } : {}) });
  }

  private createActor(siteId: string, name: string, provider?: string, tier?: string, model?: string): unknown {
    this.onActorCreated(siteId, name, provider, tier, model);
    return { __actor: siteId };
  }

  /**
   * Issue #38 D8-③ preset family (artifact.chart/table/metrics/board): a
   * DECLARATION, not an effect. Official parity (declarePresetArtifact):
   * spec validation → kind mismatch → identical re-declaration is a no-op →
   * a different spec is ArtifactRedeclared → literal primary conflict →
   * per-run id cap → one journal row + dwf_artifact event. Any problem fails
   * the whole run (presets are void — there is no rejection channel).
   */
  private async declareArtifact(siteId: string, op: string, args: unknown[]): Promise<null> {
    await this.artifacts.ensureRestored(this.options.store, this.options.runId, this.options.replayEnabled !== false);
    const record = this.artifacts.declarePreset(op, args, siteId);
    if (!record.fresh) return null; // identical re-declaration: no row, no event
    const { id, canonical } = record;
    await this.journalled('artifact', siteId, `preset:${op}:${id}:${canonical}`, async () => {
      this.emit('dwf_artifact', { id, kind: op, preset: true, primary: record.primary === true });
      return record;
    });
    return null;
  }

  // ------------------------------------------------------------------- ask

  private async ask(
    siteId: string,
    actorValue: unknown,
    prompt: string,
    schemaJson: string | null,
    callId?: number,
    /** swarm() task: no FIFO wait, no conversation read or write. */
    swarm = false,
  ): Promise<unknown> {
    // Boundary payload cap: an oversize prompt is rejected by name BEFORE any
    // seat/FIFO/budget machinery — no journalled node, no in-flight
    // registration, no provider call.
    if (prompt.length > BOUNDARY_PAYLOAD_CAP_CHARS) {
      throw domainError('AgentError', `ask prompt is ${prompt.length} chars, over the ${BOUNDARY_PAYLOAD_CAP_CHARS}-char boundary payload cap`, {
        details: { errorName: 'ChildFrameLimitExceeded', siteId, promptChars: prompt.length },
      });
    }
    const actorSiteId = (actorValue as { __actor?: string } | null | undefined)?.__actor ?? '';
    const actor = this.actors.get(actorSiteId);
    if (!actor) {
      throw domainError('AgentError', `ask() receiver is not an actor created by agent() in this run (site ${siteId})`, {
        details: { siteId },
      });
    }

    // Per-actor FIFO: asks issued while the actor is busy wait their turn — the
    // canonical facade contract. The chain stays alive across failures. The abort
    // controller registers synchronously (at frame-processing time), so a
    // sessions.cancel arriving immediately after the call still finds it.
    //
    // swarm() tasks bypass the chain AND the conversation: the tasks are
    // independent, so waiting behind the actor's current turn would cap the
    // swarm's concurrency at the agent count, and reading/appending history
    // would grow each task's prompt quadratically with the task count. Their
    // concurrency is the seat pool's job; provider routing still comes from
    // the actor.
    const controller = new AbortController();
    if (callId !== undefined) this.inFlight.set(callId, controller);
    const enqueue = (fn: () => Promise<unknown>): Promise<unknown> => (swarm ? fn() : actor.chain.then(fn));
    // Per-ask metadata box: tokenUsage is filled DURING executeAsk and read by
    // journalled() when it records the node's evidence entry. A swarm task
    // carries no conversation, so it never keys the per-actor divergence flag —
    // one changed task prompt must not warm-flush the actor's ordinary asks.
    const meta: {
      tokenUsage?: TokenUsage;
      actorSiteId?: string;
      actorCache?: { name: string; seq: number; contentHash: string; personaJson: string };
    } = { actorSiteId: swarm ? undefined : actorSiteId };
    if (!swarm && actor.name) {
      // Issue #39: the per-actor named-cache identity — a SITE-INDEPENDENT
      // content hash (the site-keyed inputHash changes when an amend
      // renumbers sites; the (name + persona + content) triple does not).
      const seq = actor.asks;
      actor.asks = seq + 1;
      meta.actorCache = {
        name: actor.name,
        seq,
        contentHash: createHash('sha256').update(`ask${CHR0}${CHR0}${prompt}`).digest('hex'),
        personaJson: actor.personaJson ?? '',
      };
    }
    const turn: Promise<unknown> = enqueue(() => {
      return this.withAskSeat(() =>
        this.journalled('ask', siteId, prompt, () =>
          executeAsk({
            siteId,
            actor,
            prompt,
            schemaJson,
            swarm,
            controller,
            meta,
            ledger: this.budget,
            retryOrchestrator: this.retryOrchestrator,
            stallMs: this.options.stallMs,
            deadlineMs: this.options.deadlineMs,
            failoverProviders: this.options.failoverProviders,
            aimdRun: { runId: this.options.runId, bound: this.options.maxConcurrency },
            emit: (type, data) => this.emit(type, data),
          }),
        meta,
        schemaJson,
        ),
      ).finally(() => {
        if (callId !== undefined) this.inFlight.delete(callId);
      });
    });
    if (!swarm) actor.chain = turn.catch(() => undefined);

    // History is appended AFTER journalled() resolves — on both the live path and
    // the replay path — so a resumed run reconstructs the identical conversation.
    // A swarm task is conversationless: it neither reads nor writes the actor's
    // history, so its prompt never grows with the task index.
    const reply = await turn;
    if (!swarm) {
      actor.history.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: JSON.stringify(reply ?? null) },
      );
    }
    return reply;
  }

  private async withAskSeat<T>(fn: () => Promise<T>): Promise<T> {
    const max = resolveAskConcurrency(this.options.maxConcurrency);
    if (this.inFlightAsks >= max) {
      await new Promise<void>((resolve) => this.askQueue.push(resolve));
    }
    this.inFlightAsks++;
    try {
      return await fn();
    } finally {
      this.inFlightAsks--;
      const next = this.askQueue.shift();
      if (next) next();
    }
  }

  // ---------------------------------------------------------- presentation

  /**
   * Phase entry is a PRESENTATION marker, nothing more. The facade engine keeps
   * no phase table and no dependency edges, and performs no topological
   * validation — the compiled script's native TypeScript control flow IS the
   * execution order. Phases exist for observability only; conflating them with
   * ordering would imply a guarantee this layer does not make.
   */
  private enterPhase(name: string, index?: number): null {
    this.emit('dwf_phase', { phase: name, index, kind: 'phase' });
    return null;
  }

  private log(message: unknown): null {
    const text = typeof message === 'string' ? message : safeJson(message);
    // Boundary payload cap (ask/log 入口同款上限): named rejection before the
    // message reaches the journal — see BOUNDARY_PAYLOAD_CAP_CHARS.
    if (text.length > BOUNDARY_PAYLOAD_CAP_CHARS) {
      throw domainError('AgentError', `log message is ${text.length} chars, over the ${BOUNDARY_PAYLOAD_CAP_CHARS}-char boundary payload cap`, {
        details: { errorName: 'ChildFrameLimitExceeded' },
      });
    }
    this.emit('dwf_log', { message: text });
    return null;
  }

  /**
   * report() journals each item as its own node — hash-deduplicated (a resumed
   * run never re-shows one), capped at 65,536 items / 1 MiB per item / 1 GiB per
   * run with NAMED failures, and surfaced in the terminal snapshot (first 256).
   */
  private report(siteId: string, item: unknown, artifactId?: string): null {
    const itemJson = JSON.stringify(item ?? null);
    if (itemJson.length > 1_000_000) {
      const e = new Error(`report item is ${itemJson.length} bytes, over the 1,000,000-byte per-item cap`);
      e.name = 'ReportCapExceeded';
      throw e;
    }
    if (this.reportCount >= 65_536) {
      const e = new Error(`report item count reached the 65,536 per-run cap`);
      e.name = 'ReportCapExceeded';
      throw e;
    }
    if (this.reportBytes + itemJson.length > 1_073_741_824) {
      const e = new Error(`report items total ${this.reportBytes + itemJson.length} bytes, over the 1 GiB per-run cap`);
      e.name = 'ReportCapExceeded';
      throw e;
    }
    const itemHash = createHash('sha256').update(itemJson).digest('hex');
    if (this.reportHashes.has(itemHash)) {
      this.emit('dwf_report', { item, ...(artifactId !== undefined ? { artifactId } : {}), deduplicated: true });
      return null;
    }
    this.reportHashes.add(itemHash);
    this.reportCount++;
    this.reportBytes += itemJson.length;
    this.reportItems.push(item);
    if (this.reportItems.length > 256) this.reportItems.shift();
    this.emit('dwf_report', { item, ...(artifactId !== undefined ? { artifactId } : {}) });
    void this.options.store.saveDwfNode({
      runId: this.options.runId,
      siteId,
      ordinal: (this.reportOrdinals.get(siteId) ?? 0) + 1,
      kind: 'report',
      inputHash: itemHash,
      status: 'completed',
      resultJson: itemJson,
      completedAt: new Date().toISOString(),
    }).catch(() => { /* journal failure must not kill the run's presentation channel */ });
    this.reportOrdinals.set(siteId, (this.reportOrdinals.get(siteId) ?? 0) + 1);
    return null;
  }

  // -------------------------------------------------------------- artifact

  private async artifact(siteId: string, kind: string, args: unknown[]): Promise<unknown> {
    await this.artifacts.ensureRestored(this.options.store, this.options.runId, this.options.replayEnabled !== false);
    const { id, opts } = this.artifacts.admit(kind, args, siteId);
    const input = String(args[1] ?? '');
    return this.journalled('artifact', siteId, kind === 'file' ? `file:${input}` : `md:${input}`, () =>
      this.artifacts.publish(kind, id, input, opts, siteId, {
        store: this.options.store,
        runId: this.options.runId,
        emit: (type, data) => this.emit(type, data),
      }),
    );
  }

  // ------------------------------------------------------ world boundaries

  private async worldRead(siteId: string, readOp: string, args: unknown[]): Promise<unknown> {
    return this.journalled('worldRead', siteId, safeJson(args), () => this.boundary.read(readOp, args, siteId));
  }

  private async worldRun(siteId: string, cmd: string, args: string[], opts: { timeoutMs?: number } | undefined): Promise<WorldRunResult> {
    // Issue #127 direction 1: three authorization sources, resolved per call —
    // ① explicit (caller CLI/MCP parameter), ② the project allowlist, both
    // merged into options.approvedCommands by the runner with their source;
    // ③ an interactive TTY confirmation via confirmWorldRun. The script's own
    // command list authorizes nothing.
    // Issue #194 P1: an allowlist entry may constrain the call to a parameter
    // shape — the declared args sequence must match element-wise (prefix);
    // an empty declared array authorizes only the bare zero-arg call.
    const preApproved = this.options.approvedCommands.find((a) =>
      a.name === cmd && (
        a.args === undefined ||
        (a.args.length > 0
          ? a.args.every((declared, i) => args[i] === declared)
          : args.length === 0)
      ));
    let source: 'explicit' | 'allowlist' | 'tty';
    if (preApproved) {
      source = preApproved.source;
    } else if (this.options.confirmWorldRun) {
      const ok = await this.options.confirmWorldRun(cmd, args);
      if (!ok) {
        // Issue #194 P3: the refusal is journaled as its own auth event so the
        // audit replay shows WHO tried to run WHAT and how it was stopped —
        // not just a failure error afterwards.
        this.emit(WORKFLOW_EVENT.DWF_WORLD_RUN_AUTH, { cmd, source: 'tty-declined', siteId });
        throw domainError('SchemaValidationError', `world.run command "${cmd}" was declined interactively`, {
          details: { cmd, siteId, source: 'tty-declined' },
        });
      }
      source = 'tty';
    } else {
      this.emit(WORKFLOW_EVENT.DWF_WORLD_RUN_AUTH, { cmd, source: 'unauthorized', siteId });
      throw domainError('SchemaValidationError', (
        `world.run command "${cmd}" is not authorized — the script's own command list no longer authorizes anything ` +
        `(Issue #127). Authorize it by: 1) passing --approve-cmd ${cmd} (or the MCP approvedCommands parameter), ` +
        '2) adding it to .workflow/approved-commands.json, or 3) running interactively so the call can be confirmed.'
      ), {
        details: { cmd, siteId, source: 'unauthorized' },
      });
    }
    return this.journalled('worldRun', siteId, safeJson([cmd, args]), async () => {
      // The event is recorded verbatim (runner emit → store.recordEvent →
      // SQLite): redact the args at this boundary too. The spawn below keeps
      // the original args — masking is observability-only.
      this.emit('dwf_world_run', { cmd, args: args.map((a) => redactText(String(a))) });
      // Authorization provenance rides the journal (Issue #127 parameter 4):
      // every call names the source that authorized it.
      this.emit(WORKFLOW_EVENT.DWF_WORLD_RUN_AUTH, { cmd, source, siteId });
      return this.boundary.spawnCaptured(cmd, args, opts?.timeoutMs);
    });
  }

  // ---------------------------------------------------------- parking ops

  /**
   * A hole parks its BRANCH until filled: the engine reports `dwf_hole_open` and
   * returns a promise that never settles, while sibling branches keep running. When
   * the child realm has nothing left but parked holes it signals idle, and the
   * runner finishes the run as `parked`. `fill` splices the body into the source
   * and forks an amend, whose journal replay skips everything already completed
   * (zero cost) and executes the body live.
   */
  private async hole(siteId: string, name: string, prompt: string): Promise<unknown> {
    // Hash WITHOUT the ordinal (multi-instance fanout parking) — the settle
    // pool matches this park to a fill/answer row by (kind, hash) content,
    // consumed 1:1, so parallel holes at one call site cannot misbind.
    const inputHash = journalInputHash('hole', siteId, name);

    if (this.options.replayEnabled !== false) {
      const pool = await this.settlePools.journalPool(siteId, this.journalRowLoader());
      const cached = this.settlePools.take(pool, 'hole', inputHash);
      if (cached && cached.status === 'completed' && cached.resultJson !== undefined) {
        this.emit('dwf_replay_hit', { siteId, ordinal: cached.ordinal, kind: 'hole' });
        return JSON.parse(cached.resultJson);
      }
      const importedPool = this.settlePools.importedPool(siteId);
      const imported = this.settlePools.take(importedPool, 'hole', inputHash);
      if (imported && imported.status === 'completed' && imported.resultJson !== undefined) {
        this.emit('dwf_amend_hit', { siteId, ordinal: imported.ordinal, kind: 'hole' });
        return JSON.parse(imported.resultJson);
      }
    }

    this.emit('dwf_hole_open', { siteId, name, prompt, inputHash });
    return new Promise<never>(() => {}); // parks until the runner finishes as 'parked'
  }

  /**
   * escalate(question) — a human gate that parks the run like a hole, but the fill is
   * a VALUE: `workflow answer <runId> <questionId> <text>` journals the answer on the
   * run and a resume replays the prefix at zero cost, resolving this call to the text.
   * Mirrors ZCode's dwfq-… flow (the id lives on the open event; the answer lives in
   * the journal so a resumed run never re-asks).
   */
  private async escalate(siteId: string, question: string): Promise<unknown> {
    const inputHash = journalInputHash('escalation', siteId, question);

    if (this.options.replayEnabled !== false) {
      const pool = await this.settlePools.journalPool(siteId, this.journalRowLoader());
      const cached = this.settlePools.take(pool, 'escalation', inputHash);
      if (cached && cached.status === 'completed' && cached.resultJson !== undefined) {
        this.emit('dwf_replay_hit', { siteId, ordinal: cached.ordinal, kind: 'escalation' });
        return JSON.parse(cached.resultJson);
      }
      const importedPool = this.settlePools.importedPool(siteId);
      const imported = this.settlePools.take(importedPool, 'escalation', inputHash);
      if (imported && imported.status === 'completed' && imported.resultJson !== undefined) {
        this.emit('dwf_amend_hit', { siteId, ordinal: imported.ordinal, kind: 'escalation' });
        return JSON.parse(imported.resultJson);
      }
    }

    const questionId = `dwfq-${randomBytes(4).toString('hex')}`;
    this.emit('dwf_escalation_open', { siteId, questionId, question, inputHash });
    return new Promise<never>(() => {}); // parks until the runner finishes as 'parked'
  }

  // -------------------------------------------------------------- journal

  /** Rows of the current run's journal, or undefined when replay is off. */
  private journalRowLoader(): (() => Promise<DwfNode[]>) | undefined {
    return this.options.replayEnabled !== false ? () => this.options.store.getDwfNodes(this.options.runId) : undefined;
  }

  /**
   * Issue #63: a replayed ask must still satisfy the ask's CURRENT contract.
   * The replay identity is (siteId, inputHash) — the prompt — so tightening
   * `ask<T>`'s schema after a node was recorded would otherwise return a stale
   * answer that no longer parses, bypassing rpc.ts's safeParse entirely. Only
   * typed asks (schemaJson present) are checked; a validation failure — or a
   * corrupt row / unusable schema — degrades that ONE node to a live
   * execution instead of failing the resume (the live path journals at a
   * fresh ordinal and the amend path's divergence rules take over). No journal
   * migration: recorded rows stay byte-identical.
   */
  private replayedAskValid(resultJson: string, schemaJson: string | null | undefined): boolean {
    if (!schemaJson) return true;
    try {
      const parsed = JSON.parse(resultJson);
      const schema = zodFromJsonSchema(JSON.parse(schemaJson) as Parameters<typeof zodFromJsonSchema>[0]);
      return schema.safeParse(parsed).success;
    } catch {
      return false;
    }
  }

  /**
   * Journal short-circuit: `(siteId, ordinal, inputHash)` — a completed hit returns the
   * recorded result without executing; a hash mismatch fails loudly; a miss executes
   * once and records. With an importedCache (amend), a matching prior-run node replays
   * at zero cost and a mismatch marks the node diverged and executes live. Replay is
   * not a special mode; it is the normal path hitting the cache.
   *
   * Import-closure gate: the first LIVE world.run execution closes the import
   * cache for world-derived nodes — after it, worldRead/worldRun nodes stop
   * consulting the imported (prior-run) table, because the world those entries
   * described has just been mutated. Pure nodes (asks, which carry no world
   * tools in this engine) keep consulting. Closure also re-fires on a
   * journal/amend hit for a worldRun, so a crash-resumed run re-closes it.
   */
  private async journalled<T>(
    kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact',
    siteId: string,
    input: string,
    execute: () => Promise<T>,
    meta?: {
      tokenUsage?: TokenUsage;
      actorSiteId?: string;
      actorCache?: { name: string; seq: number; contentHash: string; personaJson: string };
    },
    schemaJson?: string | null,
  ): Promise<T> {
    const inputHash = journalInputHash(kind, siteId, input);

    if (this.options.replayEnabled !== false) {
      const pool = await this.settlePools.journalPool(siteId, this.journalRowLoader());
      const cached = this.settlePools.take(pool, kind, inputHash);
      if (cached) {
        const ordinal = cached.ordinal;
        // Same-script resume: pin the arrival cursor to the replayed row so the
        // next call at this site lines up with position ordinal+1 (asks only).
        if (kind === 'ask' && this.sameScriptResume) {
          const cursor = this.ordinals.get(siteId) ?? 0;
          if (ordinal > cursor) this.ordinals.set(siteId, ordinal);
        }
        if (kind === 'worldRun') this.importClosed = true; // the recorded world mutation happened
        // Issue #63: the journal identity is (siteId, inputHash) = the prompt —
        // not the ask's schema. A same-script resume whose synthesized contract
        // drifted (compiler change) must not replay an answer that no longer
        // satisfies the CURRENT schema; consume the row and run that one node
        // live instead (the live write allocates a fresh ordinal, no fork).
        if (cached.status === 'completed' && cached.resultJson !== undefined && this.replayedAskValid(cached.resultJson, schemaJson)) {
          this.emit('dwf_replay_hit', { siteId, ordinal, kind });
          return JSON.parse(cached.resultJson) as T;
        }
        if (cached.status === 'failed' && cached.errorText !== undefined) {
          // Replay the SAME rejection instead of re-executing: deterministic
          // resume (ZCode settleCachedAsk). Retrying means amend/new run.
          if (kind === 'worldRun') this.importClosed = true; // world state uncertain
          this.emit('dwf_node_failed', { siteId, ordinal, kind, error: cached.errorText, replayed: true });
          throw new Error(`${cached.errorText} (journalled failure at ${siteId}#${ordinal} — it replays on resume; edit the script or start a fresh run to retry)`);
        }
      } else if (kind === 'ask' && this.sameScriptResume) {
        // Positional replay defense (P0-2, the canonical InputHashMismatch
        // subset): on a same-script resume the ask sequence is deterministic,
        // so the journal row at this call's arrival position must be its own
        // row. A content miss with an UNCONSUMED ask row at that position means
        // the replay input drifted — fail loudly instead of silently running
        // live and forking the journal. The runner's --amend path is the
        // sanctioned fork for edited inputs and bypasses this gate (its
        // scriptHash differs, so sameScriptResume is false there).
        const pos = (this.ordinals.get(siteId) ?? 0) + 1;
        const positional = this.settlePools.rowAt(pool, siteId, pos);
        if (positional && positional.kind === kind && !this.settlePools.isConsumed(siteId, pos)) {
          throw domainError(
            'JournalMismatchError',
            `InputHashMismatch at ${siteId}#${pos}: the journal recorded inputHash ${positional.inputHash.slice(0, 12)}… for this position, but the replayed call hashes to ${inputHash.slice(0, 12)}… — a same-script resume refuses to misbind or silently re-run. Restore the original input, or fork with --amend.`,
            { details: { siteId, ordinal: pos, kind, journalInputHash: positional.inputHash, inputHash } },
          );
        }
      }

      // Amend path: warm cache from the prior-run lineage — same pool matching.
      // After the import gate closes, world-derived nodes (worldRead/worldRun)
      // bypass this table: the prior-run world they described no longer exists.
      // Divergence is per-actor and monotonic (P0-3): a hash miss AND a
      // beyond-prefix ask both diverge, and a diverged actor never consults the
      // cache again — one warm-cache miss puts the whole actor live, so no
      // half-warm conversation prefix can form.
      const actorSiteId = meta?.actorSiteId;
      const actorDiverged = kind === 'ask' && actorSiteId !== undefined && this.divergedActors.has(actorSiteId);
      if ((!this.importClosed || kind === 'ask') && !actorDiverged) {
        const importedPool = this.settlePools.importedPool(siteId);
        const imported = this.settlePools.take(importedPool, kind, inputHash);
        if (imported) {
          // Issue #63: an amend keeps the prompt hash but the edited script may
          // carry a tightened ask schema — a warm entry whose answer no longer
          // satisfies the CURRENT contract falls through to the divergence
          // rules below (the actor goes live) instead of replaying stale data.
          if (imported.status === 'completed' && imported.resultJson !== undefined && this.replayedAskValid(imported.resultJson, schemaJson)) {
            // Issue #39 persona guard: a same-site ask row stamped with a
            // DIFFERENT canonical persona belongs to another actor identity —
            // re-run live instead of replaying the lineage's answer. Old rows
            // without the stamp keep the legacy replay (compat).
            const personaMismatch = kind === 'ask' && meta?.actorCache !== undefined
              && imported.personaJson !== undefined && imported.personaJson !== meta.actorCache.personaJson;
            if (!personaMismatch) {
              if (kind === 'worldRun') this.importClosed = true;
              this.emit('dwf_amend_hit', { siteId, ordinal: imported.ordinal, kind });
              return JSON.parse(imported.resultJson) as T;
            }
          }
          if (imported.status === 'failed' && imported.errorText !== undefined) {
            // The warm cache knows this exact input fails — replay instead of a
            // doomed live call (ZCode: unchanged failed nodes replay too).
            this.emit('dwf_node_failed', { siteId, ordinal: imported.ordinal, kind, error: imported.errorText, replayed: true });
            throw new Error(`${imported.errorText} (journalled failure from the amended run at ${siteId}#${imported.ordinal})`);
          }
        }
        // Issue #39: per-actor named-cache second chance — the site-keyed pool
        // misses whenever an amend renumbers sites, but a named actor whose
        // canonical persona matches the lineage still consumes its prior asks
        // 1:1 by position + content hash (canonical matchImportedActor parity).
        // Issue #63: the replayed answer must also satisfy the ask's current
        // schema — an invalid warm entry is consumed and the actor diverges
        // (fall-through) instead of replaying it.
        const actorHit = kind === 'ask' && actorSiteId !== undefined && meta?.actorCache !== undefined && !this.divergedActors.has(actorSiteId)
          ? this.takeActorImport(actorSiteId, meta.actorCache)
          : undefined;
        if (actorHit !== undefined && this.replayedAskValid(actorHit, schemaJson)) {
          const hitActor = meta?.actorCache?.name ?? '';
          this.emit('dwf_amend_hit', { siteId, kind, actor: hitActor, via: 'actor' });
          return JSON.parse(actorHit) as T;
        }
        if (kind === 'ask' && actorSiteId !== undefined && this.options.importedCache !== undefined) {
          // The `dwf_amend_diverged` event is per-actor at most once, fired at
          // the first diverging node. Asks are the only actor-carried nodes;
          // non-ask kinds keep the legacy per-site event below. An ATTACHED
          // actor whose content missed (Issue #39) diverges with it — the
          // conversation is no longer the lineage's.
          if (!this.divergedActors.has(actorSiteId)) {
            this.divergedActors.add(actorSiteId);
            this.emit('dwf_amend_diverged', { siteId, kind, actor: actorSiteId });
          }
        } else if (importedPool.size > 0) {
          this.emit('dwf_amend_diverged', { siteId, kind });
        }
      }
    }
    if (kind === 'worldRun') this.importClosed = true; // a live world.run is about to mutate the world
    // A LIVE node allocates its ordinal by arrival (fresh runs and genuinely new
    // calls); replayed nodes keep their original journal ordinal via the pool.
    let ordinal = (this.ordinals.get(siteId) ?? 0) + 1;
    // Same-script resumes must never claim an ordinal the journal already holds —
    // saveDwfNode upserts on (runId, siteId, ordinal), so a colliding live row
    // would silently overwrite a journal row. Allocate past every row the pool
    // carries, consumed or not (a not-yet-replayed sibling keeps its ordinal).
    // Issue #144: this guard used to run for asks only. A non-ask row lost to a
    // saveDwfNode write failure (row missing in the journal) then re-allocated
    // the missing ordinal on the next resume and upsert-overwrote the surviving
    // row — every further resume cascaded the swap and the journal never
    // converged (worldRun nodes even re-executed, repeating side effects).
    if (this.sameScriptResume && this.options.replayEnabled !== false) {
      const pool = this.settlePools.peekJournalPool(siteId);
      if (pool) {
        for (const n of pool.values()) {
          if (n.ordinal >= ordinal) ordinal = n.ordinal + 1;
        }
      }
    }
    this.ordinals.set(siteId, ordinal);

    const startedAtMs = Date.now();
    let value: T;
    try {
      value = await execute();
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      // sessions.cancel contract: a caller-cancelled turn establishes nothing.
      // Leave no failed node and no failed evidence — a resumed run must
      // re-execute the turn, not replay a phantom rejection. The event still
      // fires (with cancelled:true) so live views can settle the ask, and the
      // runner uses that flag to release its in-flight counter.
      if ((err as Error | null | undefined)?.name === 'AbortError') {
        this.emit('dwf_node_failed', {
          siteId,
          ordinal,
          kind,
          error: redactText((err as Error).message || 'ask cancelled'),
          cancelled: true,
        });
        throw err;
      }
      // Persisted as an event AND as a failed journal node — redact before
      // either crosses the boundary. error_text stores the Tagged Error
      // Algebra (serialized JSON, read back with tryParseStoredError);
      // plain-text legacy rows stay readable. The row carries the SAME
      // inputHash, and under the settle pool a failed row replays its
      // rejection on resume instead of re-executing (deterministic, no
      // repeated side effects); the tagged detail just survives the round trip.
      const tagged = toDomainError(err);
      const safeTagged = redactValue(toSerializableError(tagged));
      // A world.run failure leaves the world in an uncertain state — close the
      // import gate conservatively (audit gap #3).
      if (kind === 'worldRun') this.importClosed = true;
      try {
        await this.options.store.saveDwfNode({
          runId: this.options.runId,
          siteId,
          ordinal,
          kind,
          inputHash,
          status: 'failed',
          errorText: JSON.stringify(safeTagged),
          durationMs,
          completedAt: new Date().toISOString(),
        });
      } catch {
        /* best-effort persistence — the primary failure must keep propagating */
      }
      this.emit('dwf_node_failed', { siteId, ordinal, kind, error: redactText(tagged.message) });
      // A failed node establishes nothing — recorded as an explicit 'unknown'
      // evidence entry so the ledger shows the attempt AND its non-result.
      await recordNodeEvidence(this.options.store, this.options.runId, {
        kind,
        siteId,
        ordinal,
        inputHash,
        input,
        status: 'failed',
        durationMs,
        errorMessage: tagged.message,
      });
      throw err; // the original value rethrows: the pool replays it on resume
    }
    const durationMs = Date.now() - startedAtMs;
    // The journalled value is the redaction boundary (redact.ts: strings bound
    // for SQLite, the live view or the run result must pass here): masking once
    // makes the journal the authority AND lets every downstream channel (script
    // view, log/report/return, the CLI result line) inherit the mask — replay
    // then deterministically inherits the masked value.
    value = redactValue(value);
    await this.options.store.saveDwfNode({
      runId: this.options.runId,
      siteId,
      ordinal,
      kind,
      inputHash,
      status: 'completed',
      resultJson: JSON.stringify(value ?? null),
      durationMs,
      completedAt: new Date().toISOString(),
      // Issue #39: per-actor named-cache identity rides ask rows.
      ...(kind === 'ask' && meta?.actorCache !== undefined
        ? { actorName: meta.actorCache.name, actorSeq: meta.actorCache.seq, contentHash: meta.actorCache.contentHash, personaJson: meta.actorCache.personaJson }
        : {}),
    });
    await recordNodeEvidence(this.options.store, this.options.runId, {
      kind,
      siteId,
      ordinal,
      inputHash,
      input,
      status: 'completed',
      durationMs,
      tokenUsage: meta?.tokenUsage,
    });
    return value;
  }

  /**
   * Issue #39: consume the next imported ask for this actor (canonical
   * ImportedActorState.take parity): attached by (effective name + canonical
   * persona), consumed by per-actor position + site-independent content
   * hash, monotonic divergence on any miss. Returns the recorded reply JSON
   * on a hit, undefined otherwise.
   */
  private takeActorImport(actorSiteId: string, cache: { name: string; seq: number; contentHash: string; personaJson: string }): string | undefined {
    if (this.options.importedCache === undefined) return undefined;
    this.actorImportState ??= new Map();
    let state = this.actorImportState.get(actorSiteId);
    if (state === undefined) {
      // attach once: candidate = imported ask rows under the same name with
      // the same canonical persona; anonymous actors never attach.
      const rows: DwfNode[] = [];
      for (const node of this.options.importedCache.values()) {
        if (node.kind === 'ask' && node.actorName === cache.name && node.personaJson === cache.personaJson) rows.push(node);
      }
      rows.sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0));
      state = { attached: rows.length > 0, diverged: false, cursor: 0, rows };
      this.actorImportState.set(actorSiteId, state);
    }
    if (!state.attached || state.diverged) return undefined;
    const entry = state.rows[state.cursor];
    if (entry === undefined || entry.contentHash !== cache.contentHash) {
      // hash mismatch (instructions changed) or a NEW ask beyond the prefix —
      // both diverge; the cascade is free and dynamic (canonical parity).
      state.diverged = true;
      // divergedActors registration happens in the caller's diverge block (so
      // the dwf_amend_diverged event keeps its at-most-once semantics).
      return undefined;
    }
    state.cursor += 1;
    return entry.resultJson;
  }

  /**
   * The engine's event seam — the second persistence channel. Journalled node
   * rows reach SQLite directly via `store.saveDwfNode`; everything else (phase/
   * log presentation, replay/amend hits, holes, escalations, budget telemetry)
   * crosses this single seam to the runner's emit closure, which dual-writes
   * each event into the authoritative `dwf_event` table AND the append-only
   * `events.jsonl` mirror carrying byte-identical event ids/sequences. Masking
   * is deliberately NOT centralized here: it is applied at the boundaries
   * feeding this seam — the journalled value passes `redactValue` before
   * saveDwfNode, and individual emit sites mask their own error and world-arg
   * payloads with `redactText` (see redact.ts for the boundary discipline).
   */
  private emit(type: WorkflowEventType, data: Record<string, unknown>): void {
    this.options.onEvent?.({ type, data });
  }
}

/** NUL separator — the journalInputHash family's field delimiter. */
const CHR0 = String.fromCharCode(0);

/** Canonical persona JSON (sorted keys, undefined members skipped) — Issue #39 attach check. */
function canonicalPersonaJson(persona: { name: string; provider?: string; tier?: string; model?: string }): string {
  const entries = Object.entries(persona).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}
