import { SQLiteStateStore } from './sqlite-store.js';
import { EventLogWriter } from './event-log.js';
import { RunNotFoundError } from '../core/error.js';

export interface ReplayPlan {
  runId: string;
  resumable: boolean;
  firstFailedStepId?: string;
  stepsToSkip: string[];    // Completed steps with cached outputs
  stepsToExecute: string[]; // Failed step and downstream dependents
  cachedOutputs: Record<string, unknown>;
  tokensSavedEstimate: number;
}

export class ReplayEngine {
  private store: SQLiteStateStore;
  private logWriter?: EventLogWriter;

  constructor(store: SQLiteStateStore, logWriter?: EventLogWriter) {
    this.store = store;
    this.logWriter = logWriter;
  }

  public async analyzeRun(
    runId: string,
    orderedStepIds: string[],
    options?: { forceRecompute?: boolean; startStepId?: string }
  ): Promise<ReplayPlan> {
    const checkpoints = await this.store.getAllCheckpoints(runId);
    if (Object.keys(checkpoints).length === 0) {
      throw new RunNotFoundError(runId);
    }

    const stepsToSkip: string[] = [];
    const stepsToExecute: string[] = [];
    const cachedOutputs: Record<string, unknown> = {};
    let firstFailedStepId: string | undefined;
    let failureEncountered = false;
    let tokensSaved = 0;

    for (const stepId of orderedStepIds) {
      const cp = checkpoints[stepId];

      if (options?.forceRecompute) {
        stepsToExecute.push(stepId);
        continue;
      }

      if (options?.startStepId) {
        if (!failureEncountered && stepId !== options.startStepId) {
          if (cp && cp.status === 'completed') {
            stepsToSkip.push(stepId);
            cachedOutputs[stepId] = cp.output;
            tokensSaved += (cp.tokens?.prompt || 0) + (cp.tokens?.completion || 0);
          } else {
            stepsToExecute.push(stepId);
          }
        } else {
          failureEncountered = true;
          stepsToExecute.push(stepId);
        }
        continue;
      }

      if (!failureEncountered && cp && cp.status === 'completed') {
        stepsToSkip.push(stepId);
        cachedOutputs[stepId] = cp.output;
        tokensSaved += (cp.tokens?.prompt || 0) + (cp.tokens?.completion || 0);
      } else {
        if (!failureEncountered && cp && cp.status === 'failed') {
          firstFailedStepId = stepId;
          failureEncountered = true;
        }
        stepsToExecute.push(stepId);
      }
    }

    return {
      runId,
      resumable: failureEncountered || stepsToExecute.length > 0,
      firstFailedStepId,
      stepsToSkip,
      stepsToExecute,
      cachedOutputs,
      tokensSavedEstimate: tokensSaved,
    };
  }

  public recordResumptionStart(runId: string, plan: ReplayPlan): void {
    if (!this.logWriter) return;

    this.logWriter.record({
      workflowId: 'dynamic_workflow',
      runId,
      type: 'workflow_start',
      data: {
        resumed: true,
        resumeFromStep: plan.firstFailedStepId,
        skippedStepsCount: plan.stepsToSkip.length,
        tokensSaved: plan.tokensSavedEstimate,
      },
    });

    // Mark skipped steps in the event log as REPLAYED
    for (const stepId of plan.stepsToSkip) {
      this.logWriter.record({
        workflowId: 'dynamic_workflow',
        runId,
        stepId,
        type: 'step_complete',
        data: {
          replayed: true,
          output: plan.cachedOutputs[stepId],
          status: 'completed',
        },
      });
    }
  }
}
