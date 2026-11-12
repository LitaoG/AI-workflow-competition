/**
 * Core agent loop (Issue #102). `queryLoop()` is an async generator
 * that drives one ReAct session turn by turn:
 *
 *   1. budget check and compaction (CompactionPipeline.ensureBudget);
 *   2. model request, streamed when the provider offers `stream`;
 *   3. a reply without tool calls is the final answer;
 *   4. the permission gate checks every tool call;
 *   5. tools run, and each result passes the micro compaction tier;
 *   6. the snapshot hook persists the session.
 *
 * Control flow is code, not prompt. The loop ends with a typed LoopResult on
 * the turn limit, on repeated model or protocol errors, on a run of turns in
 * which every tool call failed or was denied, on the context or spend limit,
 * or on abort. A failed model call goes through the shared attempt classifier
 * (src/agent/attempt-classifier.ts): auth, quota and other non-retryable
 * failures stop the loop at once; retryable ones wait for the provider's reset
 * time or the classifier's backoff before the next try.
 *
 * Providers only expose plain chat, so tool calls use a text protocol: a reply
 * that is a JSON object with a non-empty `tool_calls` array calls tools, and
 * any other reply is the final answer.
 *
 * Every result reports the tokens spent by the main model and the summary
 * model. When a provider reports no usage (streaming, or a provider without
 * usage), the loop counts the pipeline's estimate instead and says so in
 * `estimatedCalls`; failed calls are counted but add no tokens.
 */
import type { ChatOptions, ProviderContract } from '../agent/provider-contract.js';
import { backoffSleep, classifyFailure, type FailureCategory } from '../agent/attempt-classifier.js';
import { extractJson, repairJsonString } from '../agent/schema.js';
import type { DomainError } from '../domain/errors.js';
import { domainError } from '../domain/errors.js';
import type { TokenUsage } from '../domain/workflow-types.js';
import type { CompactionEvent, CompactionPipeline, ContextMessage } from './compaction/pipeline.js';

/**
 * Misconfiguration of the core engine (a bad budget, a duplicate tool name).
 * A real Error that also carries the domain algebra's AgentError tag.
 */
export class EngineConfigError extends Error {
  readonly tag = 'AgentError' as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EngineConfigError';
    this.details = details;
  }
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolContext {
  turn: number;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the input object, shown to the model. */
  inputSchema?: Record<string, unknown>;
  /** True when the tool never changes state (the Plan mode relies on it). */
  readOnly?: boolean;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<string> | string;
}

export type PermissionDecision =
  | { ok: true }
  | { ok: false; reason: string; /** build-mode confirmation marker (#151). */ pending?: PendingConfirmation };

/** A build-mode denial a host can resolve by confirming the call (#151). */
export interface PendingConfirmation {
  kind: 'confirmation-required';
  tool: string;
  callId: string;
}

export interface PermissionGate {
  check(call: ToolCall, tool: ToolDefinition | undefined): PermissionDecision | Promise<PermissionDecision>;
}

/** (#151): the three concrete modes behind the gate — plan/build/yolo. */
export type { PermissionMode } from './permissions/modes.js';

/** Default: every call is allowed — the same semantics as the 'yolo' mode (permissions/permission-manager.ts). */
export const allowAllPermissions: PermissionGate = {
  check: (): PermissionDecision => ({ ok: true }),
};

export interface SessionContext {
  /** The user goal this session works on. */
  goal: string;
  /** Working context: replaced by compaction, appended by the loop. */
  messages: ContextMessage[];
  /** Turns started so far. */
  turn: number;
}

/** What queryLoop needs from its engine (QueryEngine implements it). */
export interface LoopEngine {
  readonly provider: ProviderContract;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly permissions: PermissionGate;
  readonly compaction: CompactionPipeline;
  /** Called after every turn with tool calls and once at the end (step 6). */
  persistSnapshot?(session: SessionContext): Promise<void> | void;
}

export interface LoopOptions {
  /** Hard cap on turns (default 50). */
  maxTurns?: number;
  /** Failed model calls or protocol errors in a row that end the loop (default 3). */
  maxConsecutiveErrors?: number;
  /** Turns in a row in which every tool call failed or was denied that end the loop as 'stalled' (default 3). */
  maxFailedToolTurns?: number;
  /** Spend cap in tokens (main + summary model): the loop stops before a request that would pass it. */
  maxTotalTokens?: number;
  /** Longest wait before retrying a failed model call (default 60000 ms); a later provider reset stops the loop. */
  maxRetryWaitMs?: number;
  /** Wait used before a retry (default: the abort-aware backoffSleep); tests inject a fake one. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  model?: string;
  /** Sampling temperature (default 0). */
  temperature?: number;
  /** Output token budget per model call. */
  maxOutputTokens?: number;
}

/** Tokens and calls spent by one run. */
export interface LoopUsage {
  /** Main-model tokens (as reported, or estimated when the provider reported none). */
  model: TokenUsage;
  /** Summary-model tokens, same rule. */
  summary: TokenUsage;
  /** model + summary. */
  total: TokenUsage;
  /** Main-model calls made, failed ones included. */
  modelCalls: number;
  /** Summary-model calls made, failed ones included. */
  summaryCalls: number;
  /** Successful calls whose tokens are estimates because the provider reported no usage. */
  estimatedCalls: number;
  /** Failed calls: counted here, but they add no tokens (providers do not bill a rejected call). */
  failedCalls: number;
}

export type EngineEvent =
  | { type: 'TURN_START'; turn: number }
  | ({ type: 'COMPACTION'; turn: number } & CompactionEvent)
  | { type: 'MODEL_REQUEST_START'; turn: number; estimatedTokens: number; budgetTokens: number; messageCount: number }
  | { type: 'STREAM_CHUNK'; turn: number; chunk: string }
  | { type: 'MODEL_RESPONSE'; turn: number; content: string; usage?: TokenUsage }
  | {
      type: 'MODEL_ERROR';
      turn: number;
      message: string;
      consecutive: number;
      category: FailureCategory;
      /** Whether the loop will try again. */
      retryable: boolean;
      /** Wait before the next try (0 when the loop stops). */
      waitMs: number;
    }
  | { type: 'PROTOCOL_ERROR'; turn: number; message: string; consecutive: number }
  | { type: 'TOOL_CALL'; turn: number; call: ToolCall }
  | { type: 'PERMISSION_DENIED'; turn: number; call: ToolCall; reason: string; pending?: PendingConfirmation }
  | { type: 'TOOL_RESULT'; turn: number; call: ToolCall; ok: boolean; content: string; compacted: boolean }
  | { type: 'TEXT_COMPLETED'; turn: number; content: string };

/**
 * `context_overflow`: the context does not fit the context budget even after
 * compaction. `spend_limit`: the next request would pass `maxTotalTokens`.
 * `stalled`: every tool call failed or was denied for `maxFailedToolTurns` turns.
 */
export type LoopStatus = 'completed' | 'max_turns' | 'aborted' | 'failed' | 'stalled' | 'context_overflow' | 'spend_limit';

export interface LoopResult {
  status: LoopStatus;
  /** Turns started. */
  turns: number;
  /** The final answer (status 'completed'). */
  text?: string;
  /** Why the loop stopped (every status except 'completed'); always an AgentError. */
  error?: DomainError;
  usage: LoopUsage;
}

export type ParsedReply =
  | { kind: 'final' }
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'invalid'; message: string };

/**
 * Read the tool protocol out of one assistant reply. A JSON object with a
 * non-empty `tool_calls` array is a call. A reply that is itself a JSON object
 * (or a json / untagged code fence holding one) but breaks the protocol is
 * invalid. Anything else is the final answer, including code in another
 * language that merely mentions tool_calls.
 */
export function parseToolCalls(content: string, turn: number): ParsedReply {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { kind: 'invalid', message: 'the reply is empty' };
  if (!trimmed.includes('tool_calls')) return { kind: 'final' };

  const looksLikeCall = trimmed.startsWith('{') || isJsonFence(trimmed);
  const value = parseJsonLoosely(extractJson(trimmed));
  const rawCalls: unknown = isRecord(value) ? value['tool_calls'] : undefined;
  if (!Array.isArray(rawCalls)) {
    return looksLikeCall
      ? { kind: 'invalid', message: 'expected one JSON object with a "tool_calls" array' }
      : { kind: 'final' };
  }
  if (rawCalls.length === 0) return { kind: 'invalid', message: '"tool_calls" is empty' };

  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawCalls.length; i++) {
    const item = rawCalls[i];
    if (!isRecord(item)) return { kind: 'invalid', message: `tool_calls[${i}] is not an object` };
    const rawName = item['name'];
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length === 0) return { kind: 'invalid', message: `tool_calls[${i}] has no "name"` };
    const rawInput = item['input'] === undefined ? {} : item['input'];
    if (!isRecord(rawInput)) return { kind: 'invalid', message: `tool_calls[${i}].input must be an object` };
    const rawId = item['id'];
    let id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : `call_${turn}_${i}`;
    if (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    calls.push({ id, name, input: rawInput });
  }
  return { kind: 'tools', calls };
}

/** Drive one session to completion, yielding every engine event on the way. */
export async function* queryLoop(
  engine: LoopEngine,
  session: SessionContext,
  options: LoopOptions = {},
): AsyncGenerator<EngineEvent, LoopResult, void> {
  const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 50));
  const maxErrors = Math.max(1, Math.floor(options.maxConsecutiveErrors ?? 3));
  const maxFailedToolTurns = Math.max(1, Math.floor(options.maxFailedToolTurns ?? 3));
  const maxRetryWaitMs = Math.max(0, options.maxRetryWaitMs ?? 60_000);
  const maxTotalTokens = options.maxTotalTokens;
  const sleep = options.sleep ?? backoffSleep;
  const signal = options.signal;
  const chatOptions: ChatOptions = {
    model: options.model,
    temperature: options.temperature ?? 0,
    maxTokens: options.maxOutputTokens,
    signal,
  };
  const usage = emptyUsage();
  let consecutiveErrors = 0;
  let failedToolTurns = 0;

  const stop = (
    status: Exclude<LoopStatus, 'completed'>,
    turns: number,
    message: string,
    details: Record<string, unknown> = {},
  ): LoopResult => ({
    status,
    turns,
    error: domainError('AgentError', message, { details: { status, ...details } }),
    usage: copyUsage(usage),
  });

  while (true) {
    if (signal?.aborted) return stop('aborted', session.turn, 'the loop was aborted');
    if (session.turn >= maxTurns) {
      return stop('max_turns', session.turn, `the loop reached maxTurns (${maxTurns}) without a final answer`, { maxTurns });
    }

    session.turn += 1;
    const turn = session.turn;
    yield { type: 'TURN_START', turn };

    // 1. Budget check and compaction.
    const budget = await engine.compaction.ensureBudget(session.messages, signal);
    session.messages = budget.messages;
    for (const event of budget.events) {
      if (event.tier === 'summarize') chargeSummary(usage, event);
      yield { type: 'COMPACTION', turn, ...event };
    }
    if (!budget.withinBudget) {
      return stop(
        'context_overflow',
        turn,
        `the context needs about ${budget.estimatedTokens} tokens after compaction, over the ${engine.compaction.budgetTokens}-token context budget`,
        { estimatedTokens: budget.estimatedTokens, budgetTokens: engine.compaction.budgetTokens },
      );
    }
    if (maxTotalTokens !== undefined && usage.total.totalTokens + budget.estimatedTokens > maxTotalTokens) {
      return stop(
        'spend_limit',
        turn,
        `the next request (about ${budget.estimatedTokens} tokens) would take the run past maxTotalTokens (${maxTotalTokens}); ${usage.total.totalTokens} tokens spent so far`,
        { maxTotalTokens, spentTokens: usage.total.totalTokens, nextRequestTokens: budget.estimatedTokens },
      );
    }

    // 2. Model request.
    const request = session.messages.map(({ role, content: text }) => ({ role, content: text }));
    yield {
      type: 'MODEL_REQUEST_START',
      turn,
      estimatedTokens: budget.estimatedTokens,
      budgetTokens: engine.compaction.budgetTokens,
      messageCount: request.length,
    };
    let content = '';
    let reported: TokenUsage | undefined;
    try {
      if (engine.provider.stream) {
        for await (const chunk of engine.provider.stream(request, chatOptions)) {
          content += chunk;
          yield { type: 'STREAM_CHUNK', turn, chunk };
        }
      } else {
        const result = await engine.provider.chat(request, chatOptions);
        content = result.content;
        reported = result.usage;
      }
    } catch (err) {
      if (signal?.aborted) return stop('aborted', turn, 'the loop was aborted during the model call');
      usage.modelCalls += 1;
      usage.failedCalls += 1;
      consecutiveErrors += 1;
      const message = errorText(err);
      const retry = retryDecision(err, consecutiveErrors, maxRetryWaitMs);
      const willRetry = retry.retry && consecutiveErrors < maxErrors;
      yield {
        type: 'MODEL_ERROR',
        turn,
        message,
        consecutive: consecutiveErrors,
        category: retry.category,
        retryable: willRetry,
        waitMs: willRetry ? retry.waitMs : 0,
      };
      if (!retry.retry) {
        return stop('failed', turn, `the model call failed and will not be retried (${retry.reason}): ${message}`, {
          category: retry.category,
          consecutiveErrors,
        });
      }
      if (!willRetry) {
        return stop('failed', turn, `the model call failed ${consecutiveErrors} times in a row: ${message}`, {
          category: retry.category,
          consecutiveErrors,
        });
      }
      if (retry.waitMs > 0) {
        try {
          await sleep(retry.waitMs, signal);
        } catch (sleepErr) {
          if (signal?.aborted) return stop('aborted', turn, 'the loop was aborted while waiting to retry the model call');
          throw sleepErr;
        }
      }
      continue;
    }
    chargeModel(usage, reported, budget.estimatedTokens, engine.compaction.estimateText(content));
    if (reported !== undefined) engine.compaction.observeUsage(request, reported.promptTokens);
    yield { type: 'MODEL_RESPONSE', turn, content, usage: reported };
    session.messages.push({ role: 'assistant', kind: 'assistant', turn, content });

    // 3. A reply without tool calls is the final answer.
    const parsed = parseToolCalls(content, turn);
    if (parsed.kind === 'final') {
      yield { type: 'TEXT_COMPLETED', turn, content };
      await engine.persistSnapshot?.(session);
      return { status: 'completed', turns: turn, text: content, usage: copyUsage(usage) };
    }
    if (parsed.kind === 'invalid') {
      consecutiveErrors += 1;
      yield { type: 'PROTOCOL_ERROR', turn, message: parsed.message, consecutive: consecutiveErrors };
      session.messages.push({
        role: 'user',
        kind: 'feedback',
        turn,
        content: `[PROTOCOL_ERROR] ${parsed.message}. To call tools, reply with ONLY {"tool_calls":[{"id":"call_1","name":"<tool>","input":{}}]}; otherwise reply with your final answer.`,
      });
      if (consecutiveErrors >= maxErrors) {
        return stop('failed', turn, `the model broke the tool protocol ${consecutiveErrors} times in a row: ${parsed.message}`, {
          consecutiveErrors,
        });
      }
      continue;
    }
    consecutiveErrors = 0;

    // 4 + 5. Permission gate, then execution.
    let anyToolOk = false;
    for (const call of parsed.calls) {
      if (signal?.aborted) return stop('aborted', turn, 'the loop was aborted between tool calls');
      yield { type: 'TOOL_CALL', turn, call };
      const tool = engine.tools.get(call.name);
      const permit = await engine.permissions.check(call, tool);
      if (!permit.ok) {
        yield { type: 'PERMISSION_DENIED', turn, call, reason: permit.reason, pending: permit.pending };
        session.messages.push({
          role: 'user',
          kind: 'feedback',
          turn,
          content: `[PERMISSION_DENIED] ${call.name} (${call.id}): ${permit.reason}`,
        });
        continue;
      }
      let ok = true;
      let output: string;
      if (tool === undefined) {
        ok = false;
        const available = [...engine.tools.keys()].join(', ');
        output = `unknown tool "${call.name}"; available tools: ${available.length > 0 ? available : '(none)'}`;
      } else {
        try {
          output = String(await tool.execute(call.input, { turn, signal }));
        } catch (err) {
          ok = false;
          output = `tool error: ${errorText(err)}`;
        }
      }
      if (ok) anyToolOk = true;
      const projected = engine.compaction.projectToolResult(output, `turn-${turn}-${call.id}`);
      for (const event of projected.events) yield { type: 'COMPACTION', turn, ...event };
      session.messages.push({
        role: 'user',
        kind: 'tool_result',
        turn,
        content: `[tool_result id=${call.id} name=${call.name} ok=${ok}]\n${projected.content}`,
      });
      yield { type: 'TOOL_RESULT', turn, call, ok, content: projected.content, compacted: projected.compacted };
    }

    // 6. Snapshot hook.
    await engine.persistSnapshot?.(session);

    // A model stuck on calls that keep failing (a wrong path, a denied write)
    // must not burn a full-context request per turn until maxTurns.
    failedToolTurns = anyToolOk ? 0 : failedToolTurns + 1;
    if (failedToolTurns >= maxFailedToolTurns) {
      return stop('stalled', turn, `every tool call failed or was denied in ${failedToolTurns} turns in a row`, { failedToolTurns });
    }
  }
}

/** Margin added to a provider reset time, as the dwf engine does for usage-limit waits (src/dwf/engine.ts). */
const RESET_MARGIN_MS = 1000;

interface RetryDecision {
  retry: boolean;
  waitMs: number;
  category: FailureCategory;
  reason: string;
}

/**
 * A provider reset time (`details.resetAtMs`, set from Retry-After) wins when
 * it is within `maxWaitMs`; otherwise the shared classifier decides, and its
 * backoff is capped at `maxWaitMs`.
 */
function retryDecision(err: unknown, consecutive: number, maxWaitMs: number): RetryDecision {
  const verdict = classifyFailure(err, consecutive - 1);
  const resetAtMs = resetAtFromError(err);
  if (resetAtMs !== undefined) {
    const waitMs = Math.max(0, resetAtMs - Date.now()) + RESET_MARGIN_MS;
    if (waitMs <= maxWaitMs) return { retry: true, waitMs, category: verdict.category, reason: 'provider reset time' };
    return {
      retry: false,
      waitMs: 0,
      category: verdict.category,
      reason: `the provider resets at ${new Date(resetAtMs).toISOString()}, later than maxRetryWaitMs (${maxWaitMs} ms)`,
    };
  }
  if (!verdict.retryable) return { retry: false, waitMs: 0, category: verdict.category, reason: `${verdict.category} failures are not retried` };
  return { retry: true, waitMs: Math.min(verdict.backoffMs, maxWaitMs), category: verdict.category, reason: 'backoff' };
}

function resetAtFromError(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const details = (err as { details?: unknown }).details;
  if (!isRecord(details)) return undefined;
  const resetAtMs = details['resetAtMs'];
  return typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) ? resetAtMs : undefined;
}

function emptyTokens(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyUsage(): LoopUsage {
  return { model: emptyTokens(), summary: emptyTokens(), total: emptyTokens(), modelCalls: 0, summaryCalls: 0, estimatedCalls: 0, failedCalls: 0 };
}

function copyUsage(usage: LoopUsage): LoopUsage {
  return { ...usage, model: { ...usage.model }, summary: { ...usage.summary }, total: { ...usage.total } };
}

function addTokens(target: TokenUsage, delta: TokenUsage): void {
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
}

function chargeModel(usage: LoopUsage, reported: TokenUsage | undefined, promptEstimate: number, completionEstimate: number): void {
  usage.modelCalls += 1;
  let delta = reported;
  if (delta === undefined) {
    usage.estimatedCalls += 1;
    delta = { promptTokens: promptEstimate, completionTokens: completionEstimate, totalTokens: promptEstimate + completionEstimate };
  }
  addTokens(usage.model, delta);
  addTokens(usage.total, delta);
}

function chargeSummary(usage: LoopUsage, event: CompactionEvent): void {
  const calls = event.calls ?? 0;
  if (calls === 0) return;
  usage.summaryCalls += calls;
  if (event.usage === undefined) {
    usage.failedCalls += calls;
    return;
  }
  if (event.usageEstimated === true) usage.estimatedCalls += calls;
  addTokens(usage.summary, event.usage);
  addTokens(usage.total, event.usage);
}

/** A ```json or untagged fence whose content starts like a JSON object. */
function isJsonFence(text: string): boolean {
  const open = /^```([A-Za-z0-9_+-]*)[ \t]*\r?\n?/.exec(text);
  if (open === null) return false;
  const tag = (open[1] ?? '').toLowerCase();
  if (tag !== '' && tag !== 'json') return false;
  return text.slice(open[0].length).trimStart().startsWith('{');
}

function parseJsonLoosely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJsonString(text));
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
