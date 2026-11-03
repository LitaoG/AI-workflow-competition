/**
 * FacadeEngine — the parent-side executor of the child's `__host.*` boundary calls.
 *
 * The deterministic core: every journalled operation is
 * identified by `(runId, siteId, ordinal)` plus an `inputHash` of its inputs. On
 * resume the journal hit short-circuits — the recorded result is returned with zero
 * provider calls and zero process spawns — and an inputHash mismatch fails loudly
 * instead of silently misbinding. Replay is not a special mode; it is the normal
 * path hitting the cache.
 *
 * Journalled kinds: ask, worldRead, worldRun, artifact. Presentation calls (phase,
 * log, report) are recorded as events only. Every journalled node also appends an
 * entry to the evidence ledger (`dwf_evidence`) at its saveNode point — the kind
 * mapping and redaction discipline are documented on {@link FacadeEngine.recordEvidence}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSupervised } from '../process-supervision.js';
import { HostCallFrame, WorldRunResult } from './protocol.js';
import { redactText, redactValue } from './redact.js';
import { domainError, toDomainError, toSerializableError } from '../domain/errors.js';
import { EvidenceEntryInput } from '../domain/evidence.js';
import { zodFromJsonSchema } from './json-schema-zod.js';
import { globFiles, globToRegExp } from './glob.js';
import { agent } from '../agent/rpc.js';
import { RetryOrchestrator } from './retry-orchestrator.js';
import { backoffSleep } from './attempt-classifier.js';
import { providerRegistry } from '../agent/provider.js';
import { aimdGovernor, retryAfterFromError } from './governor.js';
import { classifyFailure } from './attempt-classifier.js';
import { listSavedWorkflows } from './saved.js';
import { StateStore, DwfJournalStore, DwfNode, LLMMessage, TokenUsage, WorkflowEventType } from '../types.js';

/**
 * Default ask concurrency: min(16, max(2, cores - 2)); derived from available parallelism.
 */
const ASK_CONCURRENCY_DEFAULT = Math.min(16, Math.max(2, availableParallelism() - 2));
const FILE_READ_CAP = 1024 * 1024; // 1 MiB — files.read rejects over this
const ARTIFACT_FILE_CAP = 20 * 1024 * 1024; // 20 MiB
const ARTIFACT_MD_CAP = 256 * 1024; // 256 KiB
const GREP_MATCH_CAP = 2000;
const GREP_BYTES_CAP = 256 * 1024; // 256 KiB
const WORLD_OUTPUT_CAP = 16 * 1024 * 1024; // 16 MiB per stream (rejects, never truncates)
const GIT_DIFF_CAP = 512 * 1024; // 512 KiB — git.diff rejects over this
const WORLD_DEFAULT_TIMEOUT_MS = 300_000;
/**
 * Boundary payload cap for ask prompts and log messages ("ask/log 入口同款上限"):
 * mirrors the runner's 16MB single-frame budget
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
  /** Approval set: literal world.run command names from the compiled script. */
  approvedCommands: string[];
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
  maxConcurrency?: number;
  /**
   * Per-ask stall clock. 0 disables it. The runner resolves the default
   * from AI_WORKFLOW_STALL_MS or 90000ms.
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
  /** workflow() composition: nesting depth (children cannot compose further). */
  workflowDepth?: number;
}

interface JournalledNode {
  inputHash: string;
  status: 'completed' | 'failed';
  resultJson?: string;
  errorText?: string;
}

export class FacadeEngine {
  private readonly ordinals = new Map<string, number>();
  /** Persistent actor sessions: one conversation per agent(name), kept across asks. */
  private readonly actors = new Map<string, { name: string; provider?: string; history: LLMMessage[]; chain: Promise<unknown> }>();
  private artifactVersions = new Map<string, number>();
  /** Audit gap #4: artifact versions are run-level facts — restored from the journal on first use. */
  private versionsRestored = false;
  private readonly artifactKinds = new Map<string, string>();
  private inFlightAsks = 0;
  private askQueue: Array<() => void> = [];
  /** In-flight ask abort controllers keyed by the child's call id (sessions.cancel). */
  private readonly inFlight = new Map<number, AbortController>();
  /** Retry/failover policy brain above the classifier (see retry-orchestrator.ts). */
  private readonly retryOrchestrator = new RetryOrchestrator();
  /**
   * Import-closure gate: true after the first world.run execution —
   * the prior-run world the imported cache described no longer exists, so
   * world-derived nodes stop consulting it. One-way; re-fires on worldRun replays.
   */
  private importClosed = false;
  /**
   * Settle pools (audit gap #5): per-site journal rows available for replay,
   * consumed 1:1 by inputHash content matching — NOT by arrival order. This is
   * what makes fan-out resume deterministic: parallel thunks sharing one call
   * site complete in wall-clock order on the live run, but on resume each call
   * takes the unconsumed journal row whose input hash matches ITS input.
   */
  private readonly journalPools = new Map<string, Map<string, DwfNode>>();
  private readonly importedPools = new Map<string, Map<string, DwfNode>>();
  private readonly consumedPools = new Set<string>();
  /** Output tokens spent by completed asks (budget accounting, independent engineering calibration). */
  private outputTokensSpent = 0;
  /** Executed (live) ask count — the 1000-call cap and the size warning key off this. */
  private executedAsks = 0;
  private sizeWarningEmitted = false;
  private budgetTotal: number | null = null;

  private static readonly AGENT_CALL_CAP = 1000;
  private static readonly SIZE_WARNING_ASKS = 25;

  constructor(private readonly options: FacadeEngineOptions) {
  // Audit gap #4: a resumed run continues its token accounting, not a fresh zero.
  if (options.restoreOutputTokensSpent !== undefined) {
    this.outputTokensSpent = options.restoreOutputTokensSpent;
  }
    // Audit gap #4: a resumed run continues its token accounting, not a fresh zero.
    if (options.restoreOutputTokensSpent !== undefined) {
      this.outputTokensSpent = options.restoreOutputTokensSpent;
    }
  }

  /** Abort the provider request behind a pending ask (sessions.cancel from the realm). */
  onCancelCall(cancelId: number): void {
    this.inFlight.get(cancelId)?.abort();
  }

  private reportCount = 0;
  private reportBytes = 0;
  private readonly reportHashes = new Set<string>();
  private readonly reportItems: unknown[] = [];
  private readonly reportOrdinals = new Map<string, number>();
  /** Terminal snapshot: the last 256 report items (deduplicated). */
  getReportItems(): unknown[] {
    return [...this.reportItems];
  }

  /**
   * workflow(name) — compose a saved workflow as a CHILD run (independent
   * engineering calibration): own runId (lineage → this run), own
   * compile-checked approvals, own sandbox. Nesting is limited to one level — a
   * child script cannot call workflow() again.
   */
  private async composeWorkflow(siteId: string, name: string): Promise<unknown> {
    if ((this.options.workflowDepth ?? 0) >= 1) {
      throw new Error('workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.');
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
      args: { ...this.options.args, workflowParent: this.options.runId },
      parentRunId: this.options.runId,
      workflowDepth: (this.options.workflowDepth ?? 0) + 1,
      stallMs: this.options.stallMs,
      dbPath: path.join(this.options.workspace, '.workflow', 'dwf.sqlite'),
      onEvent: (e) => this.emit(e.type as WorkflowEventType, { ...e.data, childWorkflow: name }),
    });
    this.emit('dwf_child_workflow', { siteId, name, childRunId: child.runId, status: child.status });
    if (child.status !== 'completed') {
      throw new Error(`child workflow "${name}" (${child.runId}) ended ${child.status}${child.error ? `: ${child.error}` : ''}`);
    }
    return child.value;
  }

  /** The script set budget.total (child notify → parent enforcer). */
  /** Output tokens spent so far — persisted at settle for cross-resume continuity. */
  getOutputTokensSpent(): number {
    return this.outputTokensSpent;
  }

  setBudgetTotal(total: number | null): void {
    this.budgetTotal = total !== null && total > 0 ? total : null;
    this.emit('dwf_budget_spent', { spent: this.outputTokensSpent, total: this.budgetTotal });
  }

  /** Dispatch one boundary call from the child; resolves with the reply value. */
  async handleCall(frame: HostCallFrame): Promise<unknown> {
    const p = frame.payload as unknown[];
    switch (frame.op) {
      case 'createActor':
        return this.createActor(String(frame.siteId), String(p[0] ?? ''), p[1] === null || p[1] === undefined ? undefined : String(p[1]));
      case 'escalate':
        return this.escalate(String(frame.siteId), String(p[0] ?? ''));
      case 'ask':
        return this.ask(String(frame.siteId), p[0], String(p[1] ?? ''), (p[2] as string | null) ?? null, frame.id);
      case 'enterPhase':
        return this.enterPhase(String(p[0] ?? ''), p[1] === undefined ? undefined : Number(p[1]));
      case 'log':
        return this.log(p[0]);
      case 'report':
        return this.report(String(frame.siteId), p[0]);
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
  onActorCreated(siteId: string, name?: string, provider?: string): void {
    const display = name && name !== siteId ? name : `agent-${siteId}`;
    if (provider !== undefined && !providerRegistry.list().includes(provider)) {
      throw domainError('AgentError', `unknown provider "${provider}" for actor "${display}" — registered providers: ${providerRegistry.list().join(', ')}`, {
        details: { provider, actor: display, registeredProviders: providerRegistry.list() },
      });
    }
    this.actors.set(siteId, { name: display, provider, history: [], chain: Promise.resolve() });
    this.emit('dwf_actor_created', { siteId, name: display, provider: provider ?? '(default)' });
  }

  private createActor(siteId: string, name: string, provider?: string): unknown {
    this.onActorCreated(siteId, name, provider);
    return { __actor: siteId };
  }

  private async ask(siteId: string, actorValue: unknown, prompt: string, schemaJson: string | null, callId?: number): Promise<unknown> {
    // Boundary payload cap: an oversize prompt is rejected
    // by name BEFORE any seat/FIFO/budget machinery — no journalled node, no
    // in-flight registration, no provider call.
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
    // official facade contract. The chain stays alive across failures. The abort
    // controller registers synchronously (at frame-processing time), so a
    // sessions.cancel arriving immediately after the call still finds it.
    const controller = new AbortController();
    if (callId !== undefined) this.inFlight.set(callId, controller);
    const turn: Promise<unknown> = actor.chain.then(() => {
      return this.withAskSeat(async () => {
        // Failover chain: the actor's routed provider first, then the run's
        // configured failover providers — governed by the retry orchestrator
        // (per-provider + total attempt budgets, circuit breaker, Retry-After
        // aware backoff). AIMD buckets are charged per attempted provider;
        // with no failover configured the chain is length 1 and behavior is
        // byte-identical to the pre-failover engine.
        const failoverChain = this.buildFailoverChain(actor.provider);
        // Per-ask usage box: filled by the onUsage callback below (summed
        // across schema-repair retries AND failover attempts), read by
        // journalled() when it records the node's evidence entry. Passed as a
        // mutable holder because the usage arrives DURING execute, after
        // journalled() was entered.
        const usageMeta: { tokenUsage?: TokenUsage } = {};
        return await this.journalled('ask', siteId, prompt, async () => {
            // Budget + call-cap enforcement happens at live agent()-call granularity
            // (independent engineering calibration of WorkflowBudgetExceededError /
            // WorkflowAgentCapError): replayed asks cost nothing and never trip them.
            if (this.budgetTotal !== null && this.outputTokensSpent >= this.budgetTotal) {
              // Legacy `name` rides along as details.errorName so the runner keeps
              // rebuilding WorkflowBudgetExceededError in the realm (dwf-budget test).
              throw domainError(
                'AgentError',
                `Workflow token budget exceeded (${this.outputTokensSpent.toLocaleString()} / ${this.budgetTotal.toLocaleString()} output tokens). ` +
                `Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
                { details: { errorName: 'WorkflowBudgetExceededError', spent: this.outputTokensSpent, total: this.budgetTotal } },
              );
            }
            if (this.executedAsks >= FacadeEngine.AGENT_CALL_CAP) {
              throw domainError(
                'AgentError',
                `Workflow agent() call cap reached (${FacadeEngine.AGENT_CALL_CAP}). This usually means a loop using budget.remaining() never terminates because ` +
                `no token budget was set — remaining() returns Infinity when budget.total is null. ` +
                `Add a hard iteration cap to the loop, or pass a token budget.`,
                { details: { errorName: 'WorkflowAgentCapError', cap: FacadeEngine.AGENT_CALL_CAP, executedAsks: this.executedAsks } },
              );
            }
            if (!this.sizeWarningEmitted && this.executedAsks >= FacadeEngine.SIZE_WARNING_ASKS) {
              this.sizeWarningEmitted = true;
              this.emit('dwf_size_warning', { executedAsks: this.executedAsks, hint: 'large workflow — consider scoping down or setting budget.total explicitly' });
            }
            this.emit('dwf_ask_start', { siteId, actor: actor.name, prompt: prompt.slice(0, 400) });
            let schema: ReturnType<typeof zodFromJsonSchema> | undefined;
            let promptWithSchema = prompt;
            let attempt = 0;
            if (schemaJson) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(schemaJson);
              } catch {
                throw domainError('SchemaValidationError', `invalid synthesized schema at ${siteId} (compiler bug)`, {
                  details: { siteId },
                });
              }
              schema = zodFromJsonSchema(parsed as Parameters<typeof zodFromJsonSchema>[0]);
              // The subagent must see the contract it is validated against.
              promptWithSchema = `${prompt}\n\nRespond with a single JSON object matching exactly this schema:\n${schemaJson}`;
            }
            let lastErr: unknown;
            let chainIdx = 0;
            let providerRetries = 0;
            while (chainIdx < failoverChain.length) {
              const routedProvider = failoverChain[chainIdx]!;
              const admission = this.retryOrchestrator.canAttempt(routedProvider);
              if (!admission.allowed) {
                if (failoverChain.length > 1) {
                  this.emit('dwf_failover', { siteId, provider: routedProvider, action: 'skip', reason: admission.reason });
                }
                chainIdx += 1;
                providerRetries = 0;
                continue;
              }
              await aimdGovernor.acquire(routedProvider);
              try {
                const reply = await agent(actor.name).ask<unknown>(promptWithSchema, schema as never, {
                  priorMessages: actor.history,
                  providerId: routedProvider,
                  stallMs: this.options.stallMs,
                  signal: controller.signal,
                  onUsage: (usage) => {
                    this.outputTokensSpent += usage.completionTokens;
                    // Summed across schema-repair retries AND failover attempts so
                    // the evidence entry carries the ask's TOTAL consumption.
                    const prev = usageMeta.tokenUsage;
                    usageMeta.tokenUsage = {
                      promptTokens: (prev?.promptTokens ?? 0) + usage.promptTokens,
                      completionTokens: (prev?.completionTokens ?? 0) + usage.completionTokens,
                      totalTokens: (prev?.totalTokens ?? 0) + usage.totalTokens,
                    };
                  },
                });
                this.retryOrchestrator.recordSuccess(routedProvider);
                aimdGovernor.release(routedProvider, 'success');
                this.executedAsks++;
                this.emit('dwf_budget_spent', { spent: this.outputTokensSpent, total: this.budgetTotal });
                this.emit('dwf_ask_complete', { siteId, actor: actor.name });
                return reply;
              } catch (err) {
                // a cancelled ask never charged the bucket for a completed round-trip
                if ((err as Error).name === 'AbortError') {
                  aimdGovernor.release(routedProvider, 'success');
                  throw err;
                }
                aimdGovernor.release(routedProvider, 'failure', retryAfterFromError(err));
                const decision = this.retryOrchestrator.decide(routedProvider, providerRetries, err);
                providerRetries += 1;
                if (failoverChain.length > 1) {
                  this.emit('dwf_failover', {
                    siteId,
                    provider: routedProvider,
                    attempt: providerRetries,
                    action: decision.action,
                    category: decision.classification.category,
                    waitMs: decision.waitMs,
                    reason: decision.reason,
                  });
                }
                lastErr = err;
                // G7 (model-error policy): quota/auth/invalid_request are POLICY
                // STOPS — the run settles as stopped(provider) so the user can act
                // (top up, wait for reset) and resume; they must never retry-storm.
                if (!decision.classification.retryable && ['quota', 'auth', 'invalid_request'].includes(decision.classification.category)) {
                  const stop = new Error(`${(err as Error).name}: ${(err as Error).message}`);
                  stop.name = 'WorkflowPolicyStopError';
                  (stop as Error & { cause?: string }).cause = decision.classification.category;
                  throw stop;
                }
                // Auth/fatal/cancelled fails the ask outright.
                if (!decision.classification.retryable) throw err;
                // The circuit just opened for this provider — move down the chain.
                if (decision.action === 'give-up') {
                  chainIdx += 1;
                  providerRetries = 0;
                }
                if (decision.waitMs > 0) await backoffSleep(decision.waitMs, controller.signal);
                // Per-provider engine-level budget: after N attempts on one
                // provider, continue with the next chain entry.
                if (providerRetries >= this.retryOrchestrator.limits.maxAttemptsPerProvider) {
                  chainIdx += 1;
                  providerRetries = 0;
                }
              }
            }
            throw lastErr ?? domainError('AgentError', `failover chain exhausted for ask at ${siteId}`, { details: { siteId } });
          }, usageMeta);
      }).finally(() => {
        if (callId !== undefined) this.inFlight.delete(callId);
      });
    });
    actor.chain = turn.catch(() => undefined);

    // History is appended AFTER journalled() resolves — on both the live path and
    // the replay path — so a resumed run reconstructs the identical conversation.
    const reply = await turn;
    actor.history.push(
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify(reply ?? null) },
    );
    return reply;
  }

  /** Routed provider first, then configured failover providers (deduped, registered only). */
  private buildFailoverChain(actorProvider: string | undefined): string[] {
    const primary = actorProvider ?? providerRegistry.get().id;
    const chain = [primary];
    for (const p of this.options.failoverProviders ?? []) {
      if (p !== primary && !chain.includes(p) && providerRegistry.list().includes(p)) chain.push(p);
    }
    return chain;
  }

  private async withAskSeat<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.options.maxConcurrency ?? ASK_CONCURRENCY_DEFAULT;
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

  private enterPhase(name: string, index?: number): null {
    this.emit('dwf_phase', { phase: name, index, kind: 'phase' });
    return null;
  }

  private log(message: unknown): null {
    const text = typeof message === 'string' ? message : safeJson(message);
    // Boundary payload cap (ask/log 入口同款上限): named
    // rejection before the message reaches the journal — mirrors the runner's
    // frame budget; see BOUNDARY_PAYLOAD_CAP_CHARS.
    if (text.length > BOUNDARY_PAYLOAD_CAP_CHARS) {
      throw domainError('AgentError', `log message is ${text.length} chars, over the ${BOUNDARY_PAYLOAD_CAP_CHARS}-char boundary payload cap`, {
        details: { errorName: 'ChildFrameLimitExceeded' },
      });
    }
    this.emit('dwf_log', { message: text });
    return null;
  }

  /**
   * P3: report() journals each item as its own node — hash-deduplicated (a resumed
   * run never re-shows one), capped at 65,536 items / 1 MiB per item / 1 GiB per run
   * with NAMED failures, and surfaced in the terminal snapshot (first 256).
   */
  private report(siteId: string, item: unknown): null {
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
      this.emit('dwf_report', { item, deduplicated: true });
      return null;
    }
    this.reportHashes.add(itemHash);
    this.reportCount++;
    this.reportBytes += itemJson.length;
    this.reportItems.push(item);
    if (this.reportItems.length > 256) this.reportItems.shift();
    this.emit('dwf_report', { item });
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

  private async artifact(siteId: string, kind: string, args: unknown[]): Promise<unknown> {
    // P3 caps (authoring.md parity): 32 ids per run, 16 versions per id, one kind per
    // id, title ≤ 120 / description ≤ 500 chars — all NAMED failures.
    await this.ensureVersionsRestored();
    const id = String(args[0] ?? `artifact-${siteId}`);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw domainError('SchemaValidationError', `artifact id "${id}" must match [A-Za-z0-9_.-]{1,64}`, {
        details: { kind: 'artifact', artifactId: id, siteId },
      });
    }
    const opts = (args[2] ?? {}) as { title?: string; description?: string };
    if (opts.title !== undefined && opts.title.length > 120) {
      const e = new Error(`artifact "${id}" title exceeds 120 characters`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    if (opts.description !== undefined && opts.description.length > 500) {
      const e = new Error(`artifact "${id}" description exceeds 500 characters`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    const knownKind = this.artifactKinds.get(id);
    if (knownKind && knownKind !== kind) {
      const e = new Error(`artifact id "${id}" was published as "${knownKind}" and cannot be reused as "${kind}"`);
      e.name = 'ArtifactKindMismatch';
      throw e;
    }
    this.artifactKinds.set(id, kind);
    if (!this.artifactVersions.has(id) && this.artifactKinds.size > 32) {
      const e = new Error(`artifact id count reached the 32 per-run cap`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    if ((this.artifactVersions.get(id) ?? 0) >= 16) {
      const e = new Error(`artifact "${id}" reached the 16-version per-id cap`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    const input = kind === 'file' ? String(args[1] ?? '') : String(args[1] ?? '');

    return this.journalled('artifact', siteId, kind === 'file' ? `file:${input}` : `md:${input}`, async () => {
      let content: string;
      let artifactType: string;
      if (kind === 'file') {
        const abs = this.resolveInsideWorkspace(input, `artifact.file path`);
        const stat = fs.statSync(abs);
        if (stat.size > ARTIFACT_FILE_CAP) {
          throw domainError('SchemaValidationError', `artifact.file "${input}" is ${stat.size} bytes, over the ${ARTIFACT_FILE_CAP} cap`, {
            details: { kind: 'artifact.file', path: input, bytes: stat.size, cap: ARTIFACT_FILE_CAP, siteId },
          });
        }
        content = fs.readFileSync(abs, 'utf8');
        artifactType = path.extname(abs) === '.html' ? 'text/html' : 'text/plain';
      } else {
        if (input.length > ARTIFACT_MD_CAP) {
          throw domainError('SchemaValidationError', `artifact.markdown "${id}" is ${input.length} chars, over the ${ARTIFACT_MD_CAP} cap`, {
            details: { kind: 'artifact.markdown', artifactId: id, chars: input.length, cap: ARTIFACT_MD_CAP, siteId },
          });
        }
        content = input;
        artifactType = 'text/markdown';
      }
      const version = (this.artifactVersions.get(id) ?? 0) + 1;
      this.artifactVersions.set(id, version);
      await this.options.store.saveArtifact?.({
        artifactId: `${this.options.runId}:${id}`,
        runId: this.options.runId,
        stepId: id,
        name: typeof opts.title === 'string' && opts.title ? opts.title : id,
        artifactType,
        content,
        createdAt: new Date().toISOString(),
      });
      this.emit('dwf_artifact', { id, kind, version, bytes: content.length });
      return { id, version };
    });
  }

  /**
   * Audit gap #4: artifact versions are run-level facts ("the third version is
   * the third version, not counted from one again"). Restored lazily from the
   * journal on the first artifact call of this engine instance.
   */
  private async ensureVersionsRestored(): Promise<void> {
    if (this.versionsRestored) return;
    this.versionsRestored = true;
    if (this.options.replayEnabled === false) return;
    // Walk the run's lineage (self + amend ancestors) — an amend's artifact
    // versions continue from every ancestor that published the same id.
    const seen = new Set<string>();
    let cursor: string | undefined = this.options.runId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const nodes = await this.options.store.getDwfNodes(cursor);
      for (const n of nodes) {
        if (n.kind !== 'artifact' || n.status !== 'completed' || n.resultJson === undefined) continue;
        try {
          const v = JSON.parse(n.resultJson) as { id?: string; version?: number };
          if (v.id && typeof v.version === 'number' && v.version > (this.artifactVersions.get(v.id) ?? 0)) {
            this.artifactVersions.set(v.id, v.version);
          }
        } catch {
          /* malformed row — skip */
        }
      }
      const row = await this.options.store.getDwfRun(cursor);
      cursor = row?.parentRunId;
    }
  }

  // ----------------------------------------------------------- world reads

  private async worldRead(siteId: string, readOp: string, args: unknown[]): Promise<unknown> {
    const inputKey = safeJson(args);
    return this.journalled('worldRead', siteId, inputKey, async () => {
      switch (readOp) {
        case 'files.glob': {
          const pattern = String(args[0] ?? '**/*');
          const files = globFiles(this.options.workspace, pattern, { maxFiles: 2000 });
          if (files.length > 2000) {
            throw domainError('SchemaValidationError', `files.glob matched more than 2000 files — narrow the pattern`, {
              details: { op: 'files.glob', pattern, matched: files.length, cap: 2000, siteId },
            });
          }
          return files;
        }
        case 'files.read': {
          const rel = String(args[0] ?? '');
          const abs = this.resolveInsideWorkspace(rel, 'files.read path');
          const stat = fs.statSync(abs);
          if (stat.size > FILE_READ_CAP) {
            throw domainError('SchemaValidationError', `files.read "${rel}" is ${stat.size} bytes, over the ${FILE_READ_CAP} cap`, {
              details: { op: 'files.read', path: rel, bytes: stat.size, cap: FILE_READ_CAP, siteId },
            });
          }
          return fs.readFileSync(abs, 'utf8');
        }
        case 'files.grep': {
          return this.grepWorkspace(String(args[0] ?? ''), args[1] === undefined || args[1] === null ? undefined : String(args[1]), siteId);
        }
        case 'git.changedFiles': {
          const base = args[0] === undefined || args[0] === null ? undefined : String(args[0]);
          if (!base) {
            const res = await this.spawnCaptured('git', ['status', '--porcelain']);
            if (res.exitCode !== 0) {
              throw domainError('ProberError', `git.status failed: ${res.stderr.slice(0, 500)}`, {
                details: { command: 'git status --porcelain', exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
              });
            }
            return parsePorcelainPaths(res.stdout);
          }
          const res = await this.spawnCaptured('git', ['diff', '--name-only', base]);
          if (res.exitCode !== 0) {
            throw domainError('ProberError', `git.diff --name-only failed: ${res.stderr.slice(0, 500)}`, {
              details: { command: `git diff --name-only ${base}`, exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
            });
          }
          return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        }
        case 'git.diff': {
          // G5: explicit base semantics — diff against HEAD unless a base is given
          // (bare `git diff` compares worktree-vs-index, which is NOT the documented
          // 'diff against base, default HEAD' contract) + a rejecting 512KB cap.
          const gitArgs = ['diff', String(args[0] ?? 'HEAD')];
          if (args[1] !== undefined && args[1] !== null) gitArgs.push('--', String(args[1]));
          const res = await this.spawnCaptured('git', gitArgs);
          if (res.exitCode !== 0) {
            throw domainError('ProberError', `git.diff failed: ${res.stderr.slice(0, 500)}`, {
              details: { command: gitArgs.join(' '), exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
            });
          }
          if (res.stdout.length > GIT_DIFF_CAP) {
            throw domainError('SchemaValidationError', `git.diff output is ${res.stdout.length} bytes, over the ${GIT_DIFF_CAP} cap — narrow with a base and path`, {
              details: { op: 'git.diff', bytes: res.stdout.length, cap: GIT_DIFF_CAP, siteId },
            });
          }
          return res.stdout;
        }
        case 'git.status': {
          const [branchRes, porcelain] = await Promise.all([
            this.spawnCaptured('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
            this.spawnCaptured('git', ['status', '--porcelain']),
          ]);
          const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : undefined;
          const staged: string[] = [];
          const unstaged: string[] = [];
          const untracked: string[] = [];
          for (const line of porcelain.stdout.split('\n')) {
            if (!line.trim()) continue;
            const x = line[0];
            const y = line[1];
            const p = line.slice(3);
            if (x === '?') untracked.push(p);
            else if (x !== ' ') staged.push(p);
            if (y && y !== ' ' && x !== '?') unstaged.push(p);
          }
          return { branch, clean: porcelain.stdout.trim() === '', staged, unstaged, untracked };
        }
        case 'git.log': {
          // D8④: over-cap requests are structurally rejected — never silently clamped
          // (official world-read caps contract: reject, don't truncate).
          const requested = Number(args[0] ?? 20) || 20;
          if (requested > 100) {
            throw domainError('SchemaValidationError', `git.log count ${requested} exceeds the 100-entry cap — request fewer commits`, {
              details: { op: 'git.log', requested, cap: 100, siteId },
            });
          }
          const count = Math.max(requested, 1);
          const res = await this.spawnCaptured('git', ['log', `-n`, String(count), '--pretty=format:%H%x1f%s%x1f%an%x1f%aI']);
          if (res.exitCode !== 0) {
            throw domainError('ProberError', `git.log failed: ${res.stderr.slice(0, 500)}`, {
              details: { command: `git log -n ${count}`, exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
            });
          }
          return res.stdout.split('\n').filter(Boolean).map((line) => {
            const [hash, subject, author, date] = line.split('\x1f');
            return { hash, subject, author, date };
          });
        }
        default:
          throw domainError('AgentError', `unknown world read: ${readOp}`, {
            details: { readOp, siteId },
          });
      }
    });
  }

  private grepWorkspace(pattern: string, glob: string | undefined, siteId: string): Array<{ path: string; line: number; text: string }> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      throw domainError('SchemaValidationError', `files.grep pattern is not a valid regex: ${(e as Error).message}`, {
        details: { op: 'files.grep', pattern },
        cause: (e as Error).message,
      });
    }
    const include = glob ? globToRegExp(glob) : null;
    const scannedPattern = include ? glob!.replace(/^\*\*\//, '**/') : '**/*';
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let bytes = 0;
    const files = globFiles(this.options.workspace, scannedPattern, { maxFiles: 5000 });
    // D8④: an over-cap corpus is a named rejection, not a silent narrowing of the
    // search set (mirror of the files.glob cap check above).
    if (files.length > 5000) {
      throw domainError('SchemaValidationError', `files.grep scanned more than 5000 files — narrow the glob`, {
        details: { op: 'files.grep', pattern: scannedPattern, scanned: files.length, cap: 5000, siteId },
      });
    }
    for (const rel of files) {
      if (include && !include.test(rel)) continue;
      let text: string;
      try {
        const stat = fs.statSync(path.join(this.options.workspace, rel));
        if (stat.size > FILE_READ_CAP) continue;
        text = fs.readFileSync(path.join(this.options.workspace, rel), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) });
          bytes += lines[i].length;
          if (matches.length >= GREP_MATCH_CAP || bytes > GREP_BYTES_CAP) {
            throw domainError('SchemaValidationError', `files.grep results over cap (${GREP_MATCH_CAP} matches / ${GREP_BYTES_CAP} bytes) — narrow the pattern or glob`, {
              details: { op: 'files.grep', matches: matches.length, matchCap: GREP_MATCH_CAP, bytesCap: GREP_BYTES_CAP },
            });
          }
        }
      }
    }
    return matches;
  }

  // ------------------------------------------------------------- world run

  /**
   * A hole parks its BRANCH until filled: the engine reports `dwf_hole_open` and
   * returns a promise that never settles, while sibling branches keep running. When
   * the child realm has nothing left but parked holes it signals idle, and the
   * runner finishes the run as `parked`. `fill` splices the body into the source
   * and forks an amend, whose journal replay skips everything already completed
   * (zero cost) and executes the body live.
   */
  private async hole(siteId: string, name: string, prompt: string): Promise<unknown> {
    // Hash WITHOUT the ordinal (audit: multi-instance fanout parking) — the
    // settle pool matches this park to a fill/answer row by (kind, hash)
    // content, consumed 1:1, so parallel holes at one call site cannot misbind.
    const inputHash = createHash('sha256').update(`hole\u0000${siteId}\u0000${name}`).digest('hex');

    if (this.options.replayEnabled !== false) {
      const pool = await this.journalPool(siteId);
      const cached = this.takeFromPool(pool, 'hole', inputHash);
      if (cached && cached.status === 'completed' && cached.resultJson !== undefined) {
        this.emit('dwf_replay_hit', { siteId, ordinal: cached.ordinal, kind: 'hole' });
        return JSON.parse(cached.resultJson);
      }
      const importedPool = this.importedPool(siteId);
      const imported = this.takeFromPool(importedPool, 'hole', inputHash);
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
   * The id lives on the open event; the answer lives in
   * the journal so a resumed run never re-asks.
   */
  private async escalate(siteId: string, question: string): Promise<unknown> {
    // Hash WITHOUT the ordinal (audit: multi-instance fanout parking) — pool
    // matching by (kind, hash) content, consumed 1:1. The open event carries the
    // inputHash so `answer` can write the reply row the pool will match.
    const inputHash = createHash('sha256').update(`escalation\u0000${siteId}\u0000${question}`).digest('hex');

    if (this.options.replayEnabled !== false) {
      const pool = await this.journalPool(siteId);
      const cached = this.takeFromPool(pool, 'escalation', inputHash);
      if (cached && cached.status === 'completed' && cached.resultJson !== undefined) {
        this.emit('dwf_replay_hit', { siteId, ordinal: cached.ordinal, kind: 'escalation' });
        return JSON.parse(cached.resultJson);
      }
      const importedPool = this.importedPool(siteId);
      const imported = this.takeFromPool(importedPool, 'escalation', inputHash);
      if (imported && imported.status === 'completed' && imported.resultJson !== undefined) {
        this.emit('dwf_amend_hit', { siteId, ordinal: imported.ordinal, kind: 'escalation' });
        return JSON.parse(imported.resultJson);
      }
    }

    const questionId = `dwfq-${randomBytes(4).toString('hex')}`;
    this.emit('dwf_escalation_open', { siteId, questionId, question, inputHash });
    return new Promise<never>(() => {}); // parks until the runner finishes as 'parked'
  }

  private async worldRun(siteId: string, cmd: string, args: string[], opts: { timeoutMs?: number } | undefined): Promise<WorldRunResult> {
    if (!this.options.approvedCommands.includes(cmd)) {
      throw domainError('SchemaValidationError', `world.run command "${cmd}" is not in the approved command set [${this.options.approvedCommands.join(', ')}] — the command name must be a literal known at compile time`, {
        details: { cmd, approvedCommands: this.options.approvedCommands, siteId },
      });
    }
    return this.journalled('worldRun', siteId, safeJson([cmd, args]), async () => {
      // The event is recorded verbatim (runner emit → store.recordEvent →
      // SQLite): redact the args at this boundary too. The spawn below keeps
      // the original args — masking is observability-only.
      this.emit('dwf_world_run', { cmd, args: args.map((a) => redactText(String(a))) });
      return this.spawnCaptured(cmd, args, opts?.timeoutMs);
    });
  }

  private spawnCaptured(cmd: string, args: string[], timeoutMs?: number): Promise<WorldRunResult> {
    const timeout = timeoutMs ?? WORLD_DEFAULT_TIMEOUT_MS;
    // Supervised spawn (process safety): the child runs in its own
    // process group (POSIX) with a sanitized environment, and a timeout kills
    // the WHOLE tree — a command that spawned grandchildren cannot outlive
    // its cap. The facade contract is preserved: timeout and spawn failure
    // reject; nonzero exits resolve.
    const supervised = spawnSupervised(cmd, args, {
      cwd: this.options.workspace,
      timeoutMs: timeout,
      envAllowlist: ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'NODE_ENV'],
    });
    return new Promise<WorldRunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      supervised.child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < WORLD_OUTPUT_CAP) stdout += chunk.toString('utf8');
      });
      supervised.child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < WORLD_OUTPUT_CAP) stderr += chunk.toString('utf8');
      });
      void supervised.result.then((res) => {
        if (res.timedOut) {
          reject(domainError('SandboxTimeout', `world.run "${cmd}" timed out after ${timeout}ms (process tree killed)`, {
            details: { cmd, timeoutMs: timeout },
          }));
          return;
        }
        if (res.exitCode === -1 && supervised.child.exitCode === null && res.stderr.startsWith('spawn ')) {
          reject(domainError('SandboxSpawnError', res.stderr, { details: { cmd, stderr: res.stderr } }));
          return;
        }
        // Irreversible redaction at the source: the value the
        // script sees IS the journalled value — git-remote URLs with embedded
        // credentials and token-shaped output never reach result_json, the
        // live view, or anything the script logs downstream.
        resolve({ exitCode: res.exitCode, stdout: redactText(stdout), stderr: redactText(stderr) });
      });
    });
  }

  // -------------------------------------------------------------- journal

  private async journalPool(siteId: string): Promise<Map<string, DwfNode>> {
    let pool = this.journalPools.get(siteId);
    if (!pool) {
      pool = new Map();
      if (this.options.replayEnabled !== false) {
        for (const n of await this.options.store.getDwfNodes(this.options.runId)) {
          if (n.siteId === siteId) pool.set(`${n.siteId}#${n.ordinal}`, n);
        }
      }
      this.journalPools.set(siteId, pool);
    }
    return pool;
  }

  private importedPool(siteId: string): Map<string, DwfNode> {
    let pool = this.importedPools.get(siteId);
    if (!pool) {
      pool = new Map();
      if (this.options.importedCache) {
        for (const n of this.options.importedCache.values()) {
          if (n.siteId === siteId) pool.set(`${n.siteId}#${n.ordinal}`, n);
        }
      }
      this.importedPools.set(siteId, pool);
    }
    return pool;
  }

  /** Take the first unconsumed pool row of this kind whose input hash matches. */
  private takeFromPool(pool: Map<string, DwfNode>, kind: string, inputHash: string): DwfNode | undefined {
    for (const [key, n] of pool) {
      if (this.consumedPools.has(key)) continue;
      if (n.kind !== kind) continue;
      if (n.inputHash === inputHash) {
        this.consumedPools.add(key);
        return n;
      }
    }
    return undefined;
  }

  /**
   * Journal short-circuit: `(siteId, ordinal, inputHash)` — a completed hit returns the
   * recorded result without executing; a hash mismatch fails loudly; a miss executes
   * once and records. With an importedCache (amend), a matching prior-run node replays
   * at zero cost and a mismatch marks the node diverged and executes live. Replay is
   * not a special mode; it is the normal path hitting the cache.
   *
   * Import-closure gate (engine.ts `importClosed`): the first LIVE
   * world.run execution closes the import cache for world-derived nodes — after it,
   * worldRead/worldRun nodes stop consulting the imported (prior-run) table, because
   * the world those entries described has just been mutated. Pure nodes (asks, which
   * carry no world tools in this engine) keep consulting. Closure also re-fires on a
   * journal/amend hit for a worldRun, so a crash-resumed run re-closes it.
   */
  private async journalled<T>(
    kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact',
    siteId: string,
    input: string,
    execute: () => Promise<T>,
    /**
     * Per-node evidence metadata the execute callback may fill while running
     * (an ask records the provider's token usage into `tokenUsage`). Read
     * after `execute()` resolves, so a mutable holder is safe.
     */
    meta?: { tokenUsage?: TokenUsage },
  ): Promise<T> {
    // Hash over (kind, siteId, input) — WITHOUT the ordinal: the settle pool
    // (audit gap #5) matches this call to an unconsumed journal row of the same
    // site by CONTENT, and hands back the row's original ordinal. Arrival-order
    // drift in fan-outs can therefore no longer misbind rows. NUL separators
    // keep the (kind, siteId, input) tuple unambiguous under concatenation.
    const inputHash = createHash('sha256').update(`${kind}\u0000${siteId}\u0000${input}`).digest('hex');

    if (this.options.replayEnabled !== false) {
      const pool = await this.journalPool(siteId);
      const cached = this.takeFromPool(pool, kind, inputHash);
      if (cached) {
        const ordinal = cached.ordinal;
        if (kind === 'worldRun') this.importClosed = true; // the recorded world mutation happened
        if (cached.status === 'completed' && cached.resultJson !== undefined) {
          this.emit('dwf_replay_hit', { siteId, ordinal, kind });
          return JSON.parse(cached.resultJson) as T;
        }
        if (cached.status === 'failed' && cached.errorText !== undefined) {
          // Replay the SAME rejection instead of re-executing: deterministic
          // resume. Retrying means amend/new run.
          if (kind === 'worldRun') this.importClosed = true; // world state uncertain
          this.emit('dwf_node_failed', { siteId, ordinal, kind, error: cached.errorText, replayed: true });
          throw new Error(`${cached.errorText} (journalled failure at ${siteId}#${ordinal} — it replays on resume; edit the script or start a fresh run to retry)`);
        }
      }

      // Amend path: warm cache from the prior-run lineage — same pool matching.
      // After the import gate closes, world-derived nodes (worldRead/worldRun)
      // bypass this table: the prior-run world they described no longer exists.
      if (!this.importClosed || kind === 'ask') {
        const importedPool = this.importedPool(siteId);
        const imported = this.takeFromPool(importedPool, kind, inputHash);
        if (imported) {
          if (imported.status === 'completed' && imported.resultJson !== undefined) {
            if (kind === 'worldRun') this.importClosed = true;
            this.emit('dwf_amend_hit', { siteId, ordinal: imported.ordinal, kind });
            return JSON.parse(imported.resultJson) as T;
          }
          if (imported.status === 'failed' && imported.errorText !== undefined) {
            // The warm cache knows this exact input fails — replay instead of a
            // doomed live call.
            this.emit('dwf_node_failed', { siteId, ordinal: imported.ordinal, kind, error: imported.errorText, replayed: true });
            throw new Error(`${imported.errorText} (journalled failure from the amended run at ${siteId}#${imported.ordinal})`);
          }
        }
        if (importedPool.size > 0) this.emit('dwf_amend_diverged', { siteId, kind });
      }
    }
    if (kind === 'worldRun') this.importClosed = true; // a live world.run is about to mutate the world
    // A LIVE node allocates its ordinal by arrival (fresh runs and genuinely new
    // calls); replayed nodes keep their original journal ordinal via the pool.
    const ordinal = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, ordinal);
    const cacheKey = `${siteId}#${ordinal}`;

    const startedAtMs = Date.now();
    let value: T;
    try {
      value = await execute();
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      // Persisted as an event AND as a failed journal node — redact before either
      // crosses the boundary. error_text now stores the Tagged Error Algebra
      // (serialized JSON, read back with tryParseStoredError); plain-text legacy
      // rows stay readable. The row carries the SAME inputHash, and under the
      // settle pool a failed row replays its rejection on resume instead of
      // re-executing (deterministic, no repeated side effects); the tagged
      // detail just survives the round trip.
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
      await this.recordEvidence({
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
    // The journalled value is the redaction boundary (redact.ts:5-8: strings
    // bound for SQLite, the live view or the run result must pass here):
    // masking once makes the journal the authority AND lets every downstream
    // channel (script view, log/report/return, the CLI result line) inherit
    // the mask — replay then deterministically inherits the masked value.
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
    });
    await this.recordEvidence({
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
   * Record one evidence-ledger entry for a journalled node at its saveNode
   * point. Kind mapping over the `domain/evidence.ts`
   * vocabulary:
   * - `worldRead` / `worldRun` / `artifact` → `'observation'` — deterministic
   *   facts measured in the workspace or captured from a subprocess;
   * - `ask` → `'inference'` — the recorded answer is an agent-produced
   *   inference; provider-reported token usage rides
   *   along when present;
   * - a failed node → `'unknown'` — explicitly not established, never faked.
   *
   * The entry's user-derived text (label/limitations carry prompt and error
   * excerpts) passes {@link redactText} BEFORE persistence (不可逆脱敏: what
   * reaches SQLite is already masked, and journal replays inherit the masked
   * form). Field-wise on purpose: {@link redactValue} on the whole entry would
   * DESTROY `inputHash` — its anchored whole-value rule masks any string that
   * is nothing but hex (see redact.ts trade-off note), and a masked hash would
   * break the ledger↔`dwf_nodes` agreement. `inputHash`/`provenance`/
   * `durationMs`/`tokenUsage` are engine-generated structure with no user
   * content and pass through verbatim. `inputHash` is the SAME hash the
   * `dwf_nodes` row is keyed by, so a ledger entry and its node row always
   * agree.
   *
   * Best-effort by design: the node's primary journal row is already persisted
   * when this runs, and audit bookkeeping must never fail a node whose
   * primary persistence succeeded (mirrors the failed-save convention in
   * {@link journalled}). Stores without the evidence surface simply skip it.
   */
  private async recordEvidence(args: {
    kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact';
    siteId: string;
    ordinal: number;
    inputHash: string;
    input: string;
    status: 'completed' | 'failed';
    durationMs: number;
    tokenUsage?: TokenUsage;
    errorMessage?: string;
  }): Promise<void> {
    if (this.options.store.saveDwfEvidence === undefined) return;
    const rawEntry = buildEvidenceEntry(args);
    const entry: EvidenceEntryInput = {
      ...rawEntry,
      // The prose carries user content (prompt excerpts, error messages) —
      // masked irreversibly before the serialization boundary. The structural
      // fields are engine-generated (see TSDoc) and survive verbatim.
      label: redactText(rawEntry.label),
      coverage: redactText(rawEntry.coverage),
      limitations: redactText(rawEntry.limitations),
    };
    try {
      await this.options.store.saveDwfEvidence({
        runId: this.options.runId,
        siteId: args.siteId,
        nodeOrdinal: args.ordinal,
        entry,
      });
    } catch {
      /* best-effort evidence bookkeeping — never fail a journalled node over it */
    }
  }

  private resolveInsideWorkspace(rel: string, what: string): string {
    const workspace = path.resolve(this.options.workspace);
    const abs = path.resolve(workspace, rel.replace(/\\/g, '/'));
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
      throw domainError('SchemaValidationError', `${what} "${rel}" escapes the workspace`, {
        details: { what, path: rel },
      });
    }
    return abs;
  }

  private emit(type: WorkflowEventType, data: Record<string, unknown>): void {
    this.options.onEvent?.({ type, data });
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Input excerpt bound into an evidence label — kept short; redacted before persistence. */
const EVIDENCE_EXCERPT_CHARS = 200;

/** Args for {@link buildEvidenceEntry} — one journalled node's saveNode outcome. */
interface EvidenceEntryArgs {
  kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact';
  siteId: string;
  ordinal: number;
  inputHash: string;
  input: string;
  status: 'completed' | 'failed';
  durationMs: number;
  tokenUsage?: TokenUsage;
  errorMessage?: string;
}

/**
 * Map one journalled node's outcome to its evidence entry (the raw,
 * still-unredacted form — see {@link FacadeEngine.recordEvidence} for the kind
 * mapping and redaction discipline). The label carries a short excerpt of the
 * node's input so the ledger is readable on its own; the excerpt is the part
 * {@link redactValue} masks before persistence.
 */
function buildEvidenceEntry(args: EvidenceEntryArgs): EvidenceEntryInput {
  // Ordinal separator is `@` on purpose: compiler site ids already contain
  // `#` (e.g. `worldread#2`), so `worldread#2@1` stays unambiguous.
  const at = `${args.siteId}@${args.ordinal}`;
  const provenance = `dwf:${args.kind}:${at}`;
  const excerpt =
    args.input.length > EVIDENCE_EXCERPT_CHARS ? `${args.input.slice(0, EVIDENCE_EXCERPT_CHARS)}...` : args.input;
  const recordedAt = new Date().toISOString();
  const tokenUsage = args.tokenUsage;

  if (args.status === 'failed') {
    return {
      kind: 'unknown',
      label: `${args.kind} at ${at} failed (input: ${excerpt})`,
      inputHash: args.inputHash,
      provenance,
      coverage: 'nothing — the operation failed before producing a journalled result',
      limitations: `no result was established: ${args.errorMessage ?? 'unknown error'}`,
      durationMs: args.durationMs,
      recordedAt,
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    };
  }
  switch (args.kind) {
    case 'ask':
      return {
        kind: 'inference',
        label: `ask("${excerpt}") completed at ${at}`,
        inputHash: args.inputHash,
        provenance,
        coverage: 'the model answer recorded in dwf_nodes.result_json answers the recorded prompt at this site',
        limitations: 'a model-produced inference, not a verified world fact — bounded by the recorded prompt and the provider',
        durationMs: args.durationMs,
        recordedAt,
        ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      };
    case 'worldRead':
    case 'worldRun':
    case 'artifact':
      return {
        kind: 'observation',
        label: `${args.kind}(${excerpt}) completed at ${at}`,
        inputHash: args.inputHash,
        provenance,
        coverage: `the deterministic ${args.kind} output recorded in dwf_nodes.result_json for this site`,
        limitations: 'reflects the workspace only at execution time — no guarantee it still holds',
        durationMs: args.durationMs,
        recordedAt,
      };
  }
}

function parsePorcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    out.push(line.slice(3).trim());
  }
  return out;
}
