/**
 * Typed agent RPC — the seam that turns an LLM backend into a strongly-typed
 * microservice endpoint: `agent(name).ask<T>(prompt, schema)` resolves to a
 * validated `T` or throws a domain error, so unvalidated model prose can never
 * enter workflow logic wearing a type it did not earn.
 *
 * 【Design intent — three pillars (E-doc §5.1-6 blueprint, verified against code)】
 *
 * 1. Contract-driven output. The caller owns the contract as a `PromptSchema<T>`
 *    (structural validator in src/domain/workflow-types.ts; any zod schema
 *    satisfies it, keeping this module validator-agnostic). The system prompt
 *    mandates the *transport format* only ("a single valid JSON object, nothing
 *    else") and deliberately does NOT inline the schema's shape. Rationale: a
 *    prompt-side description can drift from the real schema, while `safeParse`
 *    cannot; the validator is the single source of truth, and field-level
 *    guidance reaches the model reactively through the repair loop instead of
 *    being promised up front.
 *
 * 2. Self-healing reflection loop. A failed turn is repaired over evidence, not
 *    resent blindly: the model's own raw output is replayed as an `assistant`
 *    message, followed by a validator complaint as a `user` message. Two tiers —
 *    JSON syntax failures get a syntax-repair prompt; schema-validation failures
 *    get `formatZodErrors` output (field path + message + received value). The
 *    loop is bounded by `maxRetries` (default 3); exhausting it surfaces a
 *    `SchemaValidationError` domain tag carrying stepId / attemptCount /
 *    issueCount, so failure accounting can tell "model could not satisfy the
 *    contract" apart from infrastructure faults.
 *
 * 3. Dual-track provider sourcing, mock-by-default. `providerRegistry` defaults
 *    to the deterministic, offline, zero-token MockProvider; exporting
 *    `AI_WORKFLOW_PROVIDER=codex|gemini|opencode` opts the process into real
 *    CLI agent providers (registered + defaulted by
 *    `configureCliProvidersFromEnv`, cli-providers.ts); a per-call `providerId`
 *    routes a single ask elsewhere. This is explicit selection, NOT automatic
 *    runtime failover — silently degrading to the mock in production would fake
 *    success instead of failing loudly, so the tracks never switch on error.
 *
 * Transient-failure discipline: provider throws go through the attempt
 * classifier + retry-policy table (`attempt-classifier.ts`) — rate limits back
 * off exponentially, stalls reject via the Promise.race stall clock, retries
 * rewrite (never accumulate) the Claude-parity "(Retry N …)" marker on the last
 * user turn, and the retried conversation is left UNTOUCHED so repair turns are
 * never poisoned by infrastructure noise.
 */

import { z } from 'zod';
import { AgentRPCClient, AgentCallOptions, LLMMessage, LLMResponse } from '../types.js';
import { providerRegistry } from './provider.js';
import { extractJson, repairJsonString, formatZodErrors } from './schema.js';
import { isJsonSchemaShape, zodFromJsonSchema } from './json-schema-zod.js';
import { SchemaValidationError } from './schema-validation-error.js';
import { classifyFailure, backoffSleep } from './attempt-classifier.js';

/**
 * Build the typed RPC client for one logical agent endpoint.
 *
 * `name` does triple duty: (a) it seeds the default system prompt ("You are
 * specialized agent \"<name>\""), which is also the MockProvider's actor-routing
 * key — system-message identity outranks keyword matches on user prompts whose
 * embedded typed-result JSON would poison them (see mock-provider.ts); (b) it
 * becomes `stepId` in the terminal SchemaValidationError; (c) it is how
 * `context.agent(roleOrName)` (src/core/context.ts) binds a workflow role to
 * this client.
 *
 * `defaults.signal` is merged with each call's own `options.signal`: either one
 * aborting cancels the ask. `ExecutionContext.agent()` passes the step's
 * cancellation signal here, so a step cancelled by a failing sibling makes no
 * further model calls (Issue #120).
 */
export function agent(name: string, defaults?: { signal?: AbortSignal }): AgentRPCClient {
  return {
    name,
    async ask<T>(prompt: string, schemaOrOptions?: any, maybeOptions?: AgentCallOptions): Promise<T> {
      let schema: any = schemaOrOptions;
      let options: AgentCallOptions | undefined = maybeOptions;

      // Two-arg compatibility shim: ask(prompt, { schema, mockResponse, ... }).
      // Detection is a capability probe (no safeParse method + schema/mock
      // fields present), not instanceof — the domain layer deliberately knows
      // nothing about zod, so a schema is recognised by what it can do.
      if (
        schemaOrOptions &&
        typeof schemaOrOptions.safeParse !== 'function' &&
        (schemaOrOptions.mockResponse !== undefined || schemaOrOptions.schema !== undefined)
      ) {
        options = schemaOrOptions;
        schema = schemaOrOptions.schema;
      }

      // Fast path: an explicit mockResponse bypasses provider resolution
      // entirely — deterministic tests never touch a real backend. The schema
      // still parses the canned value, so the test exercises the same output
      // contract as production rather than an unchecked stub.
      if (options?.mockResponse !== undefined) {
        if (schema && typeof schema.parse === 'function') {
          return schema.parse(options.mockResponse);
        }
        // Issue #53: a plain JSON-Schema shape (no parse method) used to fall
        // through UNVALIDATED — a structurally-violating canned response
        // (missing required field, enum violation, wrong type) masqueraded as a
        // completed step with exit 0. The mock path now enforces the same
        // output contract as production through the same JSON-Schema→zod
        // converter the dwf compile path uses; violations throw
        // SchemaValidationError like a failed live turn would.
        if (schema && isJsonSchemaShape(schema)) {
          const parsed = zodFromJsonSchema(schema).safeParse(options.mockResponse);
          if (!parsed.success) {
            throw new SchemaValidationError(
              name,
              JSON.stringify(options.mockResponse).slice(0, 2000),
              parsed.error.issues,
              0,
            );
          }
          return parsed.data as T;
        }
        return options.mockResponse as T;
      }

      // Provider sourcing (pillar 3): the registry default is 'mock';
      // AI_WORKFLOW_PROVIDER (configureCliProvidersFromEnv) flips the process
      // default to a real CLI agent, and providerId pins this single ask to
      // one backend without touching the global default.
      const provider = providerRegistry.get(options?.providerId);
      const maxRetries = options?.maxRetries ?? 3;
      const policy = options?.retryPolicy;
      const signal = mergeSignals(options?.signal, defaults?.signal);

      // Transport-format mandate only (pillar 1): the schema's shape is NOT
      // echoed into the prompt — safeParse stays the sole authority and concrete
      // field guidance arrives reactively via the repair loop. Untyped asks get
      // the prose default instead of a JSON demand (G3 facade contract).
      const systemPrompt = [
        options?.systemPrompt ?? `You are specialized agent "${name}".`,
        ...(schema
          ? [
              'You MUST respond with a single valid JSON object strictly conforming to the requested schema.',
              'Do NOT include explanations, markdown greetings, or text outside the JSON object.',
            ]
          : ['Answer in plain prose unless the task explicitly asks for structured output.']),
      ].join(' ');

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(options?.priorMessages ?? []),
        { role: 'user', content: prompt },
      ];
      const RETRY_SUFFIX_RE = /\n\n\(Retry \d+ after no progress for \d+ms — continue the task\.\)$/;

      let lastRawOutput = '';
      let lastIssues: z.ZodIssue[] = [];
      // The last INFRASTRUCTURE error (rate limit/timeout/network) that took a
      // retry `continue`: when the loop then exits by its own bound, this is
      // rethrown instead of a mislabeled SchemaValidationError (round 2 — the
      // old path reported empty-rawText contract failures for provider faults).
      let lastInfraError: unknown = undefined;

      // One attempt = one provider turn + one validation pass. Repair turns
      // appended below make `messages` grow, so attempt N sees attempt N-1's
      // raw output plus the validator's complaint — reflection over evidence,
      // not a blind resend of the same prompt. The bound honors a larger
      // retryPolicy.maxRetries (a step's policy may exceed the ask default —
      // the old fixed bound silently truncated the policy's promise).
      const retries = Math.max(maxRetries, policy?.maxRetries ?? 0);
      for (let attempt = 1; attempt <= retries; attempt++) {
        // Pre-flight re-check: a cancel landing during the backoff sleep is
        // already rejected there; this one catches a cancel between attempts.
        if (signal?.aborted) {
          throw abortError();
        }
        let response;
        // Issue #125: each attempt owns an AbortController merged with the
        // caller's signal. A stalled attempt is ABORTED — the orphaned
        // in-flight request used to keep running (and billing) with its result
        // discarded, occupying concurrency/rate-limit slots.
        const attemptController = new AbortController();
        const attemptSignal = signal ? AbortSignal.any([signal, attemptController.signal]) : attemptController.signal;
        try {
          // Defaults bias determinism: temperature 0.0, maxTokens 2048. The
          // same `messages` array is reused across attempts — repair turns get
          // appended to it, transient retries resend it untouched (the
          // classifier branch below), so the transcript only ever grows for
          // output-quality reasons, never for infrastructure noise.
          const generatePromise = provider.generate({
            messages,
            temperature: options?.temperature ?? 0.0,
            maxTokens: options?.maxTokens ?? 2048,
            signal: attemptSignal,
          });
          // An attempt that loses the stall race still belongs to the budget.
          // The accounting lives in the tracked promise's own handlers, gated
          // by stallFired: the tracked handlers run on the orphan's eventual
          // settlement (the race already rejected via the timer, so nobody
          // consumed the response). A losing attempt that RESOLVES records its
          // real usage (droppedAttempt), or the same conservative estimate
          // when the provider reports none (#192); one that dies on our abort
          // with no usage to read records the conservative maxTokens estimate; a
          // sessions.race loser (outer reason 'race-loser') is estimated the
          // same way. Caller/settle aborts (bare abort -> DOMException
          // 'AbortError') stay unaccounted (#107: nothing bills past the
          // settle point). The cap (#73) may only over-count.
          let stallFired = false;
          const estimateOrphanUsage = () => {
            options?.onUsage?.({
              promptTokens: 0,
              completionTokens: options?.maxTokens ?? 2048,
              totalTokens: options?.maxTokens ?? 2048,
              droppedAttempt: true,
              estimated: true,
            });
          };
          const tracked = generatePromise.then(
            (r) => {
              if (stallFired && r.usage) {
                // The race already rejected with the stall — this response is
                // an orphan's, and its real usage still reaches the budget.
                options?.onUsage?.({
                  promptTokens: r.usage.promptTokens ?? 0,
                  completionTokens: r.usage.completionTokens ?? 0,
                  totalTokens: r.usage.totalTokens ?? 0,
                  droppedAttempt: true,
                });
              } else if (stallFired) {
                // Issue #192 (P3): the orphan resolved but the provider
                // reported no usage — the request was still billed, so the
                // budget takes the same conservative estimate as the reject
                // path below instead of losing the attempt's cost.
                estimateOrphanUsage();
              }
              return r;
            },
            (e) => {
              if (stallFired) {
                estimateOrphanUsage();
              } else if (signal?.aborted && (signal as AbortSignal).reason === 'race-loser') {
                estimateOrphanUsage();
              }
              throw e;
            }
          );
          // Stall clock (Claude-parity): no progress within stallMs -> transient stall.
          // The timer is always cleared (and unref'd) so a completed call does not
          // keep the process alive for the rest of the stall window.
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          response = options?.stallMs
            ? await Promise.race([
                tracked,
                new Promise<never>((_, reject) => {
                  stallTimer = setTimeout(() => {
                    const e = new Error(`stalled — no progress for ${options.stallMs}ms`);
                    e.name = 'StallError';
                    stallFired = true;
                    attemptController.abort(e); // kill the orphaned request (Issue #125)
                    reject(e);
                  }, options.stallMs);
                  stallTimer.unref?.();
                }),
              ]).finally(() => {
                if (stallTimer !== undefined) {
                  clearTimeout(stallTimer);
                  stallTimer = undefined;
                }
              })
            : await tracked;
        } catch (err) {
          // Attempt classification + policy table (ODW): rate limits back off,
          // transient faults retry fast, auth/cancellations are fatal unless the
          // policy says otherwise. Retryable failures do NOT poison the repair
          // conversation — the same messages go back out untouched.
          const c = classifyFailure(err, attempt - 1);
          const cap = policy?.maxRetries ?? maxRetries;
          const allowed = policy?.retryOn ? policy.retryOn.includes(c.category) : c.retryable;
          if (allowed && attempt < cap) {
            lastInfraError = err;
            // The retried prompt is rewritten with a "(retry N)"
            // marker. Do the same on the last user turn, replacing any previous
            // marker instead of accumulating it. The journal key still hashes
            // the original prompt, so replay identity is unchanged.
            if (err instanceof Error && err.name === 'StallError' && options?.stallMs) {
              const last = messages[messages.length - 1];
              if (last?.role === 'user') {
                const base = last.content.replace(RETRY_SUFFIX_RE, '');
                messages[messages.length - 1] = {
                  role: 'user',
                  content: `${base}\n\n(Retry ${attempt} after no progress for ${options.stallMs}ms — continue the task.)`,
                };
              }
            }
            await backoffSleep(policy?.backoffMs ? policy.backoffMs * 2 ** (attempt - 1) : c.backoffMs, signal);
            continue;
          }
          throw err;
        }

        // A successful provider turn clears the infra-error memory: a later
        // validation-budget exhaustion must report the contract failure, not
        // a stale earlier outage.
        lastInfraError = undefined;
        // Budget accounting hook: normalises the provider's optional usage
        // fields so callers can track spend per ask without knowing each
        // backend's reporting quirks.
        if (response.usage) {
          options?.onUsage?.({
            promptTokens: response.usage.promptTokens ?? 0,
            completionTokens: response.usage.completionTokens ?? 0,
            totalTokens: response.usage.totalTokens ?? 0,
          });
        }
        lastRawOutput = response.content;
        // G3 fix (facade contract): an UNTYPED ask returns the subagent's final reply
        // text as-is — no JSON demand, no repair loop. Only typed asks (schema present)
        // go through extraction/repair. The system prompt no longer forces JSON either.
        if (!schema || typeof schema.safeParse !== 'function') {
          return response.content as T;
        }
        const cleaned = extractJson(response.content);
        let parsedJson: any;

        try {
          parsedJson = JSON.parse(cleaned);
        } catch {
          try {
            parsedJson = JSON.parse(repairJsonString(cleaned));
          } catch {
            // Tier-1 repair (syntax): extraction already peeled markdown fences
            // / outermost braces (extractJson), and repairJsonString gave the
            // common single-flaw cases (trailing commas, single quotes, bare
            // keys) one more parse shot. Reaching here means BOTH failed —
            // replay the raw output and demand a syntax fix, distinct from the
            // schema-failure prompt below so each tier tells the model exactly
            // what kind of mistake it made.
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content: 'Your response was not valid JSON. Please fix syntax errors (e.g. quotes, brackets) and return ONLY the valid JSON object.',
            });
            continue;
          }
        }

        if (!schema || typeof schema.safeParse !== 'function') {
          return parsedJson as T;
        }

        // Structured gate (pillar 1): safeParse — deliberately not the throwing
        // parse — so a contract mismatch becomes a repairable signal that
        // consumes a retry, never an exception that skips the retry budget.
        const validation = schema.safeParse(parsedJson);
        if (validation.success) {
          return validation.data;
        }

        lastIssues = validation.error.issues;

        // Tier-2 repair (schema): replay the raw output as an assistant turn,
        // then feed formatZodErrors — per-field path, message and received
        // value — back as a user turn. That specificity is the reflection
        // payload: the model must see WHAT failed and WHY, not just "invalid",
        // to converge within the retry budget.
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            'Your JSON response failed runtime schema validation with the following errors:',
            formatZodErrors(lastIssues),
            'Please correct these specific fields and return the updated JSON object.',
          ].join('\n'),
        });
      }

      // Retry budget exhausted on an INFRASTRUCTURE fault (the loop exited via
      // a retryable `continue`): rethrow the real provider error — a
      // SchemaValidationError with empty rawText here misreported a provider
      // outage as a model-contract failure and swallowed the cause
      // (2026-11-14 round 2). Only genuine budget-exhausted VALIDATION
      // failures fall through to the contract-error below.
      if (lastInfraError !== undefined) {
        throw lastInfraError;
      }
      // Retry budget exhausted: throw the real SchemaValidationError class
      // (Issue #110) — an Error instance with stack, carrying the domain tag +
      // persistence-safe details (stepId / attemptCount / issueCount) for the
      // engine's failure accounting, plus the process-only rawText (the last
      // raw model output) and zodErrors (field paths) the caller paid for.
      throw new SchemaValidationError(name, lastRawOutput, lastIssues, maxRetries, provider.id);
    },
  };
}

function abortError(): Error {
  const e = new Error('ask cancelled');
  e.name = 'AbortError';
  return e;
}

/** One signal that aborts when either input does; `undefined` when neither is given. */
function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}
