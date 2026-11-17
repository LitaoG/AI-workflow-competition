/**
 * Budget ledger — run-level output-token accounting and live-call caps
 * (the WorkflowBudgetExceededError /
 * WorkflowAgentCapError). Replayed asks cost nothing and never trip these;
 * enforcement happens at live agent()-call granularity. The AIMD provider
 * buckets themselves live in `governor.ts` — this module is the run's ledger,
 * not the flow governor.
 */
import { SWARM_AGENT_CAP } from '../execution/swarm-dispatcher.js';
import { domainError } from '../domain/errors.js';
import type { TokenUsage, WorkflowEventType } from '../types.js';

/** Executed (live) ask count — the call cap and the size warning key off this. */
const AGENT_CALL_CAP = SWARM_AGENT_CAP;
const SIZE_WARNING_ASKS = 25;

export class BudgetLedger {
  private outputTokensSpent = 0;
  private executedAsks = 0;
  private sizeWarningEmitted = false;
  private readonly budgetTotal: number | null;

  constructor(opts: { restoreOutputTokensSpent?: number; restoreExecutedAsks?: number; budgetTotal?: number }) {
    // A resumed run continues its token accounting, not a fresh zero.
    if (opts.restoreOutputTokensSpent !== undefined) {
      this.outputTokensSpent = opts.restoreOutputTokensSpent;
    }
    // Issue #63: the ask cap continues across a resume too — the prior run's
    // executed asks come back from the dwf_runs row, or a resumed run would
    // burn another full AGENT_CALL_CAP on top of the lineage's asks while its
    // token budget stays continuous. A lineage that already crossed the size
    // warning threshold counts as warned: without this, the one-shot warning
    // (dwf_size_warning) would re-emit on every continuation past 25 asks.
    if (opts.restoreExecutedAsks !== undefined) {
      this.executedAsks = opts.restoreExecutedAsks;
      this.sizeWarningEmitted = this.executedAsks >= SIZE_WARNING_ASKS;
    }
    // Official parity: the run config, not the script, owns the cap.
    this.budgetTotal = opts.budgetTotal !== undefined && opts.budgetTotal > 0 ? opts.budgetTotal : null;
  }

  get spent(): number {
    return this.outputTokensSpent;
  }

  get total(): number | null {
    return this.budgetTotal;
  }

  /** Executed (live) ask count so far — the dwf_budget_spent payload carries it for settlement persistence. */
  get askCount(): number {
    return this.executedAsks;
  }

  charge(usage: TokenUsage): void {
    this.outputTokensSpent += usage.completionTokens;
  }

  /** workflow() composition: the child bills against the parent's remaining budget. */
  childBudgetRemainder(): number | undefined {
    return this.budgetTotal === null ? undefined : Math.max(1, this.budgetTotal - this.outputTokensSpent);
  }

  /**
   * Pre-execution gates for a live ask: hard budget cap, whole-run agent() call
   * cap, one-shot size warning. Throws with the exact realm-visible error names
   * (the runner rebuilds them in the child).
   */
  assertAskAllowed(emit: (type: WorkflowEventType, data: Record<string, unknown>) => void): void {
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
    if (this.executedAsks >= AGENT_CALL_CAP) {
      throw domainError(
        'AgentError',
        `Workflow agent() call cap reached (${AGENT_CALL_CAP}). This usually means a loop using budget.remaining() never terminates because ` +
        `no token budget was set — remaining() returns Infinity when budget.total is null. ` +
        `Add a hard iteration cap to the loop, or pass a token budget.`,
        { details: { errorName: 'WorkflowAgentCapError', cap: AGENT_CALL_CAP, executedAsks: this.executedAsks } },
      );
    }
    if (!this.sizeWarningEmitted && this.executedAsks >= SIZE_WARNING_ASKS) {
      this.sizeWarningEmitted = true;
      emit('dwf_size_warning', { executedAsks: this.executedAsks, hint: 'large workflow — consider scoping down or passing --budget-total explicitly' });
    }
  }

  /** Count one completed live ask; returns the running spend for telemetry. */
  noteAskCompleted(): number {
    this.executedAsks++;
    return this.outputTokensSpent;
  }

  /** Absorb a composed child run's spend; returns the new parent-level total. */
  absorbChildSpend(tokens: number): number {
    this.outputTokensSpent += tokens;
    return this.outputTokensSpent;
  }
}
