/**
 * Context compaction pipeline (Issue #102). It keeps every model
 * request inside a token budget with three tiers:
 *
 *   1. micro: read-time projection of one oversized tool output
 *      (micro-compactor.ts), applied when the result is recorded;
 *   2. snip: fold old turns into one-line records (history-snipper.ts) once
 *      the context passes `snipRatio` of the budget;
 *   3. summarize: replace the older history with a model-written snapshot
 *      (summarizer.ts) once the context passes `summarizeRatio` of the budget
 *      (default 70%, ) or `budgetTokens - summarizeReserveTokens`,
 *      and only when that history holds at least `summarizeMinNewTokens` of
 *      material that is not already a snapshot. Without that floor a context
 *      whose recent turns alone sit above the trigger would call the summary
 *      model on every turn, each time re-summarizing the last snapshot.
 *
 * When every tier still leaves the context over budget, ensureBudget() reports
 * `withinBudget: false` and the loop stops with `context_overflow` instead of
 * sending the request.
 *
 * Token counts are estimates, with no tokenizer dependency: ASCII text at about
 * four characters per token, every other character as one token, plus a fixed
 * overhead per message. The estimate only ever scales up when a provider
 * reports more prompt tokens than estimated.
 */
import type { ProviderContract } from '../../agent/provider-contract.js';
import type { LLMMessage, TokenUsage } from '../../domain/workflow-types.js';
import { EngineConfigError } from '../agent-loop.js';
import { isTurnMessage, snipHistory } from './history-snipper.js';
import { projectToolOutput } from './micro-compactor.js';
import { ConversationSummarizer, SNAPSHOT_SYSTEM_PROMPT, type SummarizerOptions } from './summarizer.js';

export type ContextMessageKind =
  | 'system'
  | 'goal'
  | 'assistant'
  | 'tool_result'
  | 'feedback'
  | 'snipped'
  | 'snapshot';

/** One message of the working context: an LLM message plus where it came from. */
export interface ContextMessage extends LLMMessage {
  kind: ContextMessageKind;
  /** Loop turn that produced the message (0 for the system prompt and the goal). */
  turn: number;
}

export type CompactionTier = 'micro' | 'snip' | 'summarize';

export interface CompactionEvent {
  tier: CompactionTier;
  /** False when the tier ran but could not shrink the context (the summarizer failed, or was skipped). */
  applied: boolean;
  beforeTokens: number;
  afterTokens: number;
  detail: string;
  /** Summary-model calls made by this event (summarize tier: 1 when attempted, 0 when skipped). */
  calls?: number;
  /** Tokens of the summary call, as reported or estimated (see usageEstimated); absent when the call failed. */
  usage?: TokenUsage;
  /** True when `usage` is an estimate because the summary model reported none. */
  usageEstimated?: boolean;
}

export interface CompactionConfig {
  /** Estimated-token budget that every model request must fit. */
  budgetTokens: number;
  /** Tool outputs above this are projected (default budgetTokens / 8, at least 64). */
  microThresholdTokens?: number;
  /** Upper bound on the characters kept from the start of a projected output (default 1200). */
  microHeadChars?: number;
  /** Upper bound on the characters kept from the end of a projected output (default 800). */
  microTailChars?: number;
  /** Directory for spilled full outputs; omit to keep excerpts only. */
  spillDir?: string;
  /** Snip once the context passes this share of the budget (default 0.5). */
  snipRatio?: number;
  /** Summarize once the context passes this share of the budget (default 0.7). */
  summarizeRatio?: number;
  /** Alternative trigger: summarize at budgetTokens minus this reserve (overrides summarizeRatio). */
  summarizeReserveTokens?: number;
  /** Least new (non-snapshot) history worth a summary call, in tokens (default 15% of the budget, at least 64). */
  summarizeMinNewTokens?: number;
  /** Turns kept verbatim by snipping and summarizing (default 4, at least 1). */
  keepRecentTurns?: number;
  /** Characters kept from each folded message (default 120). */
  snipExcerptChars?: number;
}

export interface EnsureBudgetResult {
  messages: ContextMessage[];
  events: CompactionEvent[];
  /** Calibrated estimate of `messages`. */
  estimatedTokens: number;
  withinBudget: boolean;
}

export interface ProjectedToolResult {
  content: string;
  compacted: boolean;
  spilledPath?: string;
  events: CompactionEvent[];
}

/** Fixed per-message overhead (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Estimated tokens of one text: ASCII at ~4 chars per token, any other character as 1. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii += 1;
    else if (code < 0xdc00 || code > 0xdfff) other += 1; // a low surrogate belongs to a pair already counted
  }
  return Math.ceil(ascii / 4) + other;
}

/** Estimated tokens of a message list, overhead included. */
export function estimateMessages(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  return total;
}

export class CompactionPipeline {
  readonly budgetTokens: number;
  readonly snipAtTokens: number;
  readonly summarizeAtTokens: number;
  readonly summarizeMinNewTokens: number;
  readonly keepRecentTurns: number;
  private readonly microThresholdTokens: number;
  private readonly microHeadChars: number;
  private readonly microTailChars: number;
  private readonly spillDir: string | undefined;
  private readonly snipExcerptChars: number;
  private readonly summarizer: ConversationSummarizer | undefined;
  private calibration = 1;

  constructor(config: CompactionConfig, summaryProvider?: ProviderContract, summarizerOptions?: SummarizerOptions) {
    const budget = config.budgetTokens;
    if (!Number.isFinite(budget) || budget < 1) {
      throw new EngineConfigError(`compaction budgetTokens must be a positive number, got ${String(budget)}`, {
        field: 'budgetTokens',
        value: budget,
      });
    }
    this.budgetTokens = Math.floor(budget);
    this.microThresholdTokens = Math.max(64, Math.floor(config.microThresholdTokens ?? this.budgetTokens / 8));
    this.microHeadChars = Math.max(0, Math.floor(config.microHeadChars ?? 1200));
    this.microTailChars = Math.max(0, Math.floor(config.microTailChars ?? 800));
    this.spillDir = config.spillDir;
    this.snipAtTokens = Math.floor(this.budgetTokens * ratio(config.snipRatio, 0.5));
    this.summarizeAtTokens =
      config.summarizeReserveTokens !== undefined
        ? Math.max(0, this.budgetTokens - Math.floor(config.summarizeReserveTokens))
        : Math.floor(this.budgetTokens * ratio(config.summarizeRatio, 0.7));
    this.summarizeMinNewTokens = Math.max(1, Math.floor(config.summarizeMinNewTokens ?? Math.max(64, this.budgetTokens * 0.15)));
    this.keepRecentTurns = Math.max(1, Math.floor(config.keepRecentTurns ?? 4));
    this.snipExcerptChars = Math.max(16, Math.floor(config.snipExcerptChars ?? 120));
    this.summarizer = summaryProvider ? new ConversationSummarizer(summaryProvider, summarizerOptions) : undefined;
  }

  /** Calibration factor applied to raw estimates (>= 1). */
  get calibrationFactor(): number {
    return this.calibration;
  }

  /** True when a summarizer is configured and its circuit is open. */
  get summarizerTripped(): boolean {
    return this.summarizer?.tripped ?? false;
  }

  /** Calibrated estimate of a message list. */
  estimate(messages: readonly { content: string }[]): number {
    return Math.ceil(estimateMessages(messages) * this.calibration);
  }

  /** Calibrated estimate of one text, without message overhead. */
  estimateText(text: string): number {
    return Math.ceil(estimateTokens(text) * this.calibration);
  }

  /** Feed back the prompt size a provider reported for a request; estimates only ever scale up (at most 4x). */
  observeUsage(request: readonly { content: string }[], promptTokens: number): void {
    const raw = estimateMessages(request);
    if (raw <= 0 || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
    const factor = promptTokens / raw;
    if (factor > this.calibration) this.calibration = Math.min(4, factor);
  }

  /** Tier 1: project one tool output before it enters the context. */
  projectToolResult(output: string, fileStem: string): ProjectedToolResult {
    const result = projectToolOutput(output, {
      thresholdTokens: this.microThresholdTokens,
      headChars: this.microHeadChars,
      tailChars: this.microTailChars,
      spillDir: this.spillDir,
      fileStem,
      estimate: estimateTokens,
    });
    const events: CompactionEvent[] = result.compacted
      ? [
          {
            tier: 'micro',
            applied: true,
            beforeTokens: result.originalTokens,
            afterTokens: estimateTokens(result.content),
            detail: result.spilledPath !== undefined ? `spilled to ${result.spilledPath}` : 'excerpt only',
          },
        ]
      : [];
    return {
      content: result.content,
      compacted: result.compacted,
      ...(result.spilledPath !== undefined ? { spilledPath: result.spilledPath } : {}),
      events,
    };
  }

  /** Tiers 2 and 3 plus the last-resort hard snip; run before every model request. */
  async ensureBudget(messages: readonly ContextMessage[], signal?: AbortSignal): Promise<EnsureBudgetResult> {
    const events: CompactionEvent[] = [];
    let current: ContextMessage[] = [...messages];
    let tokens = this.estimate(current);

    if (tokens > this.snipAtTokens) {
      const snipped = snipHistory(current, { keepRecentTurns: this.keepRecentTurns, excerptChars: this.snipExcerptChars });
      if (snipped.foldedTurns.length > 0) {
        const after = this.estimate(snipped.messages);
        events.push({ tier: 'snip', applied: true, beforeTokens: tokens, afterTokens: after, detail: `folded ${describeTurns(snipped.foldedTurns)}` });
        current = snipped.messages;
        tokens = after;
      }
    }

    if (tokens > this.summarizeAtTokens && this.summarizer !== undefined && !this.summarizer.tripped) {
      const { pinned, history, recent } = this.partition(current);
      // Only new material is worth a summary call: re-summarizing an earlier
      // snapshot alone, or a sliver of new history, costs a call and makes the
      // snapshot lossier without freeing real space.
      const fresh = history.filter((message) => message.kind !== 'snapshot');
      const freshTokens = this.estimate(fresh);
      if (fresh.length > 0 && freshTokens >= this.summarizeMinNewTokens) {
        const result = await this.summarizer.summarize(history, signal);
        if (result !== undefined) {
          const lastTurn = history.reduce((max, message) => Math.max(max, message.turn), 0);
          const rebuilt: ContextMessage[] = [
            ...pinned,
            { role: 'user', kind: 'snapshot', turn: lastTurn, content: `[snapshot of the work up to turn ${lastTurn}]\n${result.snapshot}` },
            ...recent,
          ];
          const after = this.estimate(rebuilt);
          events.push({
            tier: 'summarize',
            applied: true,
            beforeTokens: tokens,
            afterTokens: after,
            detail: `replaced ${history.length} messages up to turn ${lastTurn}`,
            calls: 1,
            usage: result.usage ?? this.estimateSummaryUsage(history, result.snapshot),
            ...(result.usage === undefined ? { usageEstimated: true } : {}),
          });
          current = rebuilt;
          tokens = after;
        } else {
          events.push({
            tier: 'summarize',
            applied: false,
            beforeTokens: tokens,
            afterTokens: tokens,
            detail: `summarizer failed (${this.summarizer.failures} in a row${this.summarizer.tripped ? ', circuit open' : ''}): ${this.summarizer.lastError ?? 'unknown reason'}`,
            calls: 1,
          });
        }
      } else if (history.length > 0) {
        events.push({
          tier: 'summarize',
          applied: false,
          beforeTokens: tokens,
          afterTokens: tokens,
          detail: `skipped: ${freshTokens} tokens of new history, below summarizeMinNewTokens (${this.summarizeMinNewTokens})`,
          calls: 0,
        });
      }
    }

    if (tokens > this.budgetTokens) {
      const hard = snipHistory(current, { keepRecentTurns: 1, excerptChars: this.snipExcerptChars });
      if (hard.foldedTurns.length > 0) {
        const after = this.estimate(hard.messages);
        events.push({ tier: 'snip', applied: true, beforeTokens: tokens, afterTokens: after, detail: `hard snip: folded ${describeTurns(hard.foldedTurns)}` });
        current = hard.messages;
        tokens = after;
      }
    }

    return { messages: current, events, estimatedTokens: tokens, withinBudget: tokens <= this.budgetTokens };
  }

  /** pinned = system prompt and goal; recent = the newest turns kept verbatim; history = the rest. */
  private partition(messages: readonly ContextMessage[]): {
    pinned: ContextMessage[];
    history: ContextMessage[];
    recent: ContextMessage[];
  } {
    const turns = [...new Set(messages.filter(isTurnMessage).map((m) => m.turn))].sort((a, b) => a - b);
    const recentTurns = new Set(turns.slice(Math.max(0, turns.length - this.keepRecentTurns)));
    const pinned: ContextMessage[] = [];
    const history: ContextMessage[] = [];
    const recent: ContextMessage[] = [];
    for (const message of messages) {
      if (message.kind === 'system' || message.kind === 'goal') pinned.push(message);
      else if (isTurnMessage(message) && recentTurns.has(message.turn)) recent.push(message);
      else history.push(message);
    }
    return { pinned, history, recent };
  }

  /** Estimated tokens of a summary call the summary model reported no usage for. */
  private estimateSummaryUsage(history: readonly ContextMessage[], snapshot: string): TokenUsage {
    const promptTokens = this.estimate(history) + this.estimateText(SNAPSHOT_SYSTEM_PROMPT) + 2 * MESSAGE_OVERHEAD_TOKENS;
    const completionTokens = this.estimateText(snapshot);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }
}

/** A ratio option in (0, 1]; undefined or out-of-range values fall back or clamp. */
function ratio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0.05, value));
}

function describeTurns(turns: readonly number[]): string {
  if (turns.length === 0) return 'no turns';
  if (turns.length === 1) return `turn ${turns[0]}`;
  return `${turns.length} turns (${turns[0]}-${turns[turns.length - 1]})`;
}
