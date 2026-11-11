/**
 * Conversational summarizer: tier 3 of the context compaction pipeline
 * (F.md §5.2, Issue #102). When the context nears its budget, a light model
 * turns the older history into a factual snapshot, and the pipeline rebuilds
 * the context as system prompt + goal + snapshot + recent turns.
 *
 * It is best effort, behind a circuit breaker: a failed or empty answer counts
 * as one failure, and after `maxConsecutiveFailures` in a row the summarizer
 * stops calling the model. The pipeline then falls back to harder snipping.
 */
import type { ProviderContract } from '../../agent/provider-contract.js';
import type { TokenUsage } from '../../domain/workflow-types.js';
import type { ContextMessage } from './pipeline.js';

export interface SummarizerOptions {
  /** Consecutive failures that open the circuit (default 3). */
  maxConsecutiveFailures?: number;
  /** Output token budget for one snapshot (default 600). */
  maxTokens?: number;
  /** Model override for the snapshot call. */
  model?: string;
  /** Upper bound on the transcript sent to the model, in characters (default 60,000; the newest part is kept). */
  maxInputChars?: number;
}

/** One snapshot, with the tokens the summary model reported for it (when it reported any). */
export interface SummaryResult {
  snapshot: string;
  usage?: TokenUsage;
}

/** Instruction for the snapshot call. */
export const SNAPSHOT_SYSTEM_PROMPT = [
  'You compress the working history of an autonomous engineering agent into a factual snapshot.',
  'Keep the goal, the decisions taken, the facts observed (file paths, commands, results, errors) and the work still open.',
  'Drop chatter and repeated tool output. Never invent facts. Reply with the snapshot only, as short bullet points.',
].join(' ');

export class ConversationSummarizer {
  private consecutiveFailures = 0;
  private lastFailure: string | undefined;
  private readonly maxFailures: number;
  private readonly maxSnapshotChars: number;

  constructor(
    private readonly provider: ProviderContract,
    private readonly options: SummarizerOptions = {},
  ) {
    this.maxFailures = Math.max(1, Math.floor(options.maxConsecutiveFailures ?? 3));
    // A model that ignores maxTokens must not blow the budget it was asked to save.
    this.maxSnapshotChars = Math.max(200, (options.maxTokens ?? 600) * 8);
  }

  /** True once the circuit is open: no further model calls are made. */
  get tripped(): boolean {
    return this.consecutiveFailures >= this.maxFailures;
  }

  /** Failures in a row so far. */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Reason of the most recent failure, if the last call failed. */
  get lastError(): string | undefined {
    return this.lastFailure;
  }

  /**
   * Snapshot of `history`, or undefined when the call failed or the circuit is
   * open (no call is made then). Each call made counts toward the run's spend.
   */
  async summarize(history: readonly ContextMessage[], signal?: AbortSignal): Promise<SummaryResult | undefined> {
    if (this.tripped || history.length === 0) return undefined;
    const transcript = boundTranscript(
      history.map((message) => `[${message.kind} turn ${message.turn}] ${message.content}`).join('\n'),
      Math.max(1000, Math.floor(this.options.maxInputChars ?? 60_000)),
    );
    try {
      const result = await this.provider.chat(
        [
          { role: 'system', content: SNAPSHOT_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        { temperature: 0, maxTokens: this.options.maxTokens ?? 600, model: this.options.model, signal },
      );
      const text = result.content.trim();
      if (text.length === 0) return this.fail('the model returned an empty snapshot');
      this.consecutiveFailures = 0;
      this.lastFailure = undefined;
      const snapshot = text.length > this.maxSnapshotChars ? text.slice(0, this.maxSnapshotChars) : text;
      return result.usage !== undefined ? { snapshot, usage: result.usage } : { snapshot };
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(reason: string): undefined {
    this.consecutiveFailures += 1;
    this.lastFailure = reason;
    return undefined;
  }
}

function boundTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} older chars dropped ...]\n${text.slice(text.length - maxChars)}`;
}
