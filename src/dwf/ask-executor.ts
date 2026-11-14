/**
 * Ask executor — one live ask's provider execution: schema preparation, the
 * failover chain walk, AIMD admission, structured quota-reset waits, and the
 * retry-orchestrator policy stops. Journal policy (replay/settle/record)
 * stays in engine.ts `journalled()`; this module is invoked as the execute
 * callback and must emit the exact event sequence and error shapes the runner
 * and tests observe.
 */
import { agent } from '../agent/rpc.js';
import { resolveRoutedProvider } from '../agent/model-router.js';
import { backoffSleep, classifyFailure } from '../agent/attempt-classifier.js';
import { providerRegistry } from '../agent/provider.js';
import { RetryOrchestrator } from './retry-orchestrator.js';
import { aimdGovernor, retryAfterFromError } from './governor.js';
import { zodFromJsonSchema } from './json-schema-zod.js';
import { lintJsonSchema } from './schema-lint.js';
import { domainError } from '../domain/errors.js';
import type { BudgetLedger } from './budget-ledger.js';
import type { LLMMessage, TokenUsage, WorkflowEventType } from '../types.js';

/** Official usage-limit horizon: never wait more than 24h for a reset. */
const MAX_QUOTA_WAIT_MS = 24 * 60 * 60_000;

/**
 * Structured quota reset from a provider error. Accepts both the canonical
 * `details.quotaLimits = { status: 'rejected', resetsAt }` (epoch seconds) and
 * the adapter-friendly `details.resetAtMs` (epoch ms). Absent/invalid metadata
 * falls through to the existing policy-stop path — never a blind sleep.
 */
function resetAtFromError(err: unknown): number | undefined {
  const details = (err as { details?: Record<string, unknown> } | null | undefined)?.details;
  if (!details) return undefined;
  const quota = details['quotaLimits'] as { status?: unknown; resetsAt?: unknown } | undefined;
  if (quota && quota.status === 'rejected' && typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt)) {
    return quota.resetsAt * 1000;
  }
  const resetAtMs = details['resetAtMs'];
  return typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) ? resetAtMs : undefined;
}

/** Routed provider first, then configured failover providers (deduped, registered only). */
function buildFailoverChain(primary: string, failoverProviders: string[] | undefined): string[] {
  const chain = [primary];
  for (const p of failoverProviders ?? []) {
    if (p !== primary && !chain.includes(p) && providerRegistry.list().includes(p)) chain.push(p);
  }
  return chain;
}

export interface AskExecutionContext {
  siteId: string;
  actor: { name: string; provider?: string; tier?: 'fast' | 'deep'; model?: string; modelProvider?: string; history: LLMMessage[] };
  prompt: string;
  schemaJson: string | null;
  /** swarm() task: no conversation read/write; prompts stay position-independent. */
  swarm: boolean;
  controller: AbortController;
  /**
   * Per-ask metadata box: tokenUsage is filled by the onUsage callback (summed
   * across schema-repair retries AND failover attempts) and read by journalled()
   * when it records the node's evidence entry; actorSiteId keys the per-actor
   * amend divergence flag. Mutable because usage arrives DURING execute, after
   * journalled() was entered.
   */
  meta: { tokenUsage?: TokenUsage; actorSiteId?: string };
  ledger: BudgetLedger;
  retryOrchestrator: RetryOrchestrator;
  stallMs?: number;
  deadlineMs?: number;
  failoverProviders?: string[];
  /** Issue #37 layer 3: the calling run's identity and concurrency bound —
   *  keys the AIMD growthLimit derivation (registerRunBound on first use). */
  aimdRun?: { runId: string; bound?: number };
  emit: (type: WorkflowEventType, data: Record<string, unknown>) => void;
}

/**
 * Execute one ask against the failover chain. Runs only on the live path
 * (replay short-circuits before this). Throws the original error when the
 * chain is exhausted.
 */
export async function executeAsk(ctx: AskExecutionContext): Promise<unknown> {
  const { siteId, actor, prompt, schemaJson, swarm, controller, meta, ledger, retryOrchestrator, emit } = ctx;
  ledger.assertAskAllowed(emit);
  emit('dwf_ask_start', { siteId, actor: actor.name, prompt: prompt.slice(0, 400) });

  let schema: ReturnType<typeof zodFromJsonSchema> | undefined;
  let promptWithSchema = prompt;
  if (schemaJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaJson);
    } catch {
      throw domainError('SchemaValidationError', `invalid synthesized schema at ${siteId} (compiler bug)`, {
        details: { siteId },
      });
    }
    // Official parity (tengu_workflow_schema_lint_enforce): an unusable schema
    // is refused BEFORE any provider request, so it costs zero tokens. The
    // compiler synthesizes this schema, so a hit here is a compiler bug or a
    // future raw-schema surface — never a routine path.
    const lintIssues = lintJsonSchema(parsed);
    const lintIssue =
      lintIssues.find((i) => i.kind === 'invalid') ?? lintIssues.find((i) => i.kind === 'unsatisfiable');
    if (lintIssue) {
      throw domainError(
        'SchemaValidationError',
        `agent({schema}) received an ${lintIssue.kind === 'invalid' ? 'invalid' : 'unusable'} JSON Schema at ${siteId}` +
          `${lintIssue.path ? ` (${lintIssue.path})` : ''}: ${lintIssue.message}. ` +
          'The subagent was not started — fix the schema and call agent() again.',
        { details: { siteId, schemaIssue: lintIssue.kind, path: lintIssue.path } },
      );
    }
    schema = zodFromJsonSchema(parsed as Parameters<typeof zodFromJsonSchema>[0]);
    // The subagent must see the contract it is validated against.
    promptWithSchema = `${prompt}\n\nRespond with a single JSON object matching exactly this schema:\n${schemaJson}`;
  }

  // Failover chain: the routed provider first, then the run's configured
  // failover providers — governed by the retry orchestrator (per-provider +
  // total attempt budgets, circuit breaker, Retry-After aware backoff). AIMD
  // buckets are charged per attempted provider; with no failover configured
  // the chain is length 1. The head resolves through the task-attribute
  // router: an explicit actor provider wins, else the actor's tier, else
  // schema presence / prompt size — each only when the tier's provider is
  // actually configured, else the registry default.
  const routed = resolveRoutedProvider({
    actorModelProvider: actor.modelProvider,
    actorProvider: actor.provider,
    tier: actor.tier,
    hasSchema: schemaJson !== null && schemaJson !== undefined,
    promptLength: prompt.length,
  });
  const failoverChain = buildFailoverChain(routed, ctx.failoverProviders);

  let lastErr: unknown;
  let chainIdx = 0;
  let providerRetries = 0;
  // Official `class Bo` parity (bounded): wait out a structured quota reset at
  // most twice per ask, and never past the run deadline.
  let quotaWaits = 0;
  // Per-ask total attempt budget (2026-11-14 round 2): the orchestrator is
  // shared by every concurrent ask of the run, so its run-lifetime counter
  // cannot gate a single ask — the budget lives HERE, in ask scope, and
  // counts every provider round trip this ask spends across the chain.
  let askAttempts = 0;
  while (chainIdx < failoverChain.length) {
    if (askAttempts >= retryOrchestrator.limits.maxTotalAttempts) break;
    const routedProvider = failoverChain[chainIdx]!;
    const admission = retryOrchestrator.canAttempt(routedProvider);
    if (!admission.allowed) {
      if (failoverChain.length > 1) {
        emit('dwf_failover', { siteId, provider: routedProvider, action: 'skip', reason: admission.reason });
      }
      chainIdx += 1;
      providerRetries = 0;
      continue;
    }
    // Issue #37 layer 1: model-granular bucket key; layer 3: the run's bound
    // joins the growthLimit derivation on first use of this key.
    const aimdModel = actor.model;
    await aimdGovernor.acquire(routedProvider, { modelId: aimdModel, runId: ctx.aimdRun?.runId, runBound: ctx.aimdRun?.bound });
    askAttempts += 1;
    try {
      const reply = await agent(actor.name).ask<unknown>(promptWithSchema, schema as never, {
        // swarm tasks carry no conversation: an empty priorMessages keeps
        // every task's prompt identical regardless of its position.
        priorMessages: swarm ? [] : actor.history,
        providerId: routedProvider,
        stallMs: ctx.stallMs,
        signal: controller.signal,
        onUsage: (usage) => {
          ledger.charge(usage);
          const prev = meta.tokenUsage;
          meta.tokenUsage = {
            promptTokens: (prev?.promptTokens ?? 0) + usage.promptTokens,
            completionTokens: (prev?.completionTokens ?? 0) + usage.completionTokens,
            totalTokens: (prev?.totalTokens ?? 0) + usage.totalTokens,
          };
        },
      });
      retryOrchestrator.recordSuccess(routedProvider);
      aimdGovernor.release(routedProvider, 'success', { modelId: aimdModel });
      const spent = ledger.noteAskCompleted();
      emit('dwf_budget_spent', { spent, total: ledger.total });
      emit('dwf_ask_complete', { siteId, actor: actor.name });
      return reply;
    } catch (err) {
      // Issue #37 layer 4 (canonical `ended` semantics): a cancelled ask is
      // NEVER a success — it neither grows the streak nor judges the cap.
      if ((err as Error).name === 'AbortError') {
        aimdGovernor.release(routedProvider, 'ended', { modelId: aimdModel });
        throw err;
      }
      // Outcome classes (layer 4): only rate limits judge the cap
      // (throttled); transient faults clear the streak without shrinking;
      // permanent failures just leave (ended). Each loop iteration re-
      // acquires, so no AIMD slot is held across retries.
      const aimdClass = classifyFailure(err, providerRetries).category;
      const aimdOutcome = aimdClass === 'rate_limit' ? 'throttled' : aimdClass === 'transient' ? 'transient' : 'ended';
      aimdGovernor.release(routedProvider, aimdOutcome, { modelId: aimdModel, retryAfterMs: retryAfterFromError(err) });
      // Structured quota reset (canonical quota-reset contract): wait and retry the SAME provider
      // instead of a policy stop — but only when the reset is within the
      // whole-run deadline and the per-ask wait budget.
      const resetAtMs = resetAtFromError(err);
      if (resetAtMs !== undefined) {
        const waitMs = Math.max(0, resetAtMs - Date.now()) + 1000;
        const remainingMs = ctx.deadlineMs === undefined ? Infinity : ctx.deadlineMs - Date.now();
        if (quotaWaits < 2 && waitMs <= remainingMs && waitMs <= MAX_QUOTA_WAIT_MS) {
          quotaWaits += 1;
          emit('dwf_failover', {
            siteId,
            provider: routedProvider,
            action: 'wait',
            waitMs,
            reason: `usage-limit reset at ${new Date(resetAtMs).toISOString()}`,
          });
          await backoffSleep(waitMs, controller.signal);
          continue;
        }
      }
      const decision = retryOrchestrator.decide(routedProvider, providerRetries, err);
      providerRetries += 1;
      if (failoverChain.length > 1) {
        emit('dwf_failover', {
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
      // G7 (ZCode model-error policy): quota/auth/invalid_request are POLICY
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
      // Per-provider engine-level budget: after N attempts on one provider,
      // continue with the next chain entry.
      if (providerRetries >= retryOrchestrator.limits.maxAttemptsPerProvider) {
        chainIdx += 1;
        providerRetries = 0;
      }
    }
  }
  throw lastErr ?? domainError('AgentError', `failover chain exhausted for ask at ${siteId}`, { details: { siteId } });
}
