import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  WorkflowOptions,
  PhaseDefinition,
  StepDefinition,
  WorkflowStatus,
  ExecutionContext,
  WorkflowEvent,
  DAGGraph,
  DAGNode,
  DAGEdge,
  StateStore,
} from '../types.js';
import { WorkflowExecutionContext } from './context.js';
import { CircularDependencyError, MissingDependencyError, StepExecutionError, WorkflowAbortedError, withRetry } from './error.js';
import { redactValue } from '../dwf/redact.js';
import { computeStepCheckpointHash, stableStringify } from './checkpoint-hash.js';

// Historical export surface: the checkpoint-hash vocabulary resolves from the
// workflow module (tests, replay tooling).
export { computeStepCheckpointHash, stableStringify } from './checkpoint-hash.js';

/**
 * Enforce StepDefinition.timeoutMs: race the step promise against the deadline.
 * The deadline also aborts the step's signal (composite, see executePhaseSteps)
 * so cooperative runners, MCP calls and gate children stop; the race is what
 * fails an UNcooperative runner instead of hanging the whole run.
 */
async function withStepTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, stepId: string): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`step "${stepId}" exceeded its configured timeoutMs (${timeoutMs}ms)`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DefineWorkflowOptions {
  name: string;
  description?: string;
  version?: string;
  phases: Array<string | { id: string; name: string; description?: string }>;
  steps: Array<{
    id: string;
    name: string;
    phase?: string;
    phaseId?: string;
    role?: string;
    dependencies?: string[];
    dependsOn?: string[];
    execute: (ctx: ExecutionContext, input?: unknown) => Promise<unknown>;
    retryPolicy?: StepDefinition['retryPolicy'];
    timeoutMs?: number;
  }>;
}

export class Workflow extends EventEmitter {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly phases: PhaseDefinition[] = [];
  private stepsMap: Map<string, StepDefinition> = new Map();
  private abortController: AbortController = new AbortController();
  /** The currently executing errgroup batch, aborted directly by abort() so in-flight steps stop too. */
  private activeBatch: AbortController | undefined;

  constructor(options: { name: string; description?: string; version?: string }) {
    super();
    this.name = options.name;
    this.description = options.description;
    this.version = options.version;
  }

  addPhase(phase: { id: string; name: string; description?: string }): this {
    if (this.phases.some((p) => p.id === phase.id)) {
      throw new Error(`Phase with id "${phase.id}" already exists`);
    }
    this.phases.push({
      ...phase,
      order: this.phases.length,
      steps: [],
    });
    return this;
  }

  addStep(step: StepDefinition): this {
    const phase = this.phases.find((p) => p.id === step.phaseId);
    if (!phase) {
      throw new Error(`Cannot add step "${step.id}": Phase "${step.phaseId}" does not exist`);
    }
    if (this.stepsMap.has(step.id)) {
      throw new Error(`Step with id "${step.id}" already exists`);
    }
    phase.steps.push(step);
    this.stepsMap.set(step.id, step);
    return this;
  }

  getStep(stepId: string): StepDefinition | undefined {
    return this.stepsMap.get(stepId);
  }

  getAllSteps(): StepDefinition[] {
    return Array.from(this.stepsMap.values());
  }

  abort(reason?: string): void {
    this.abortController.abort(reason);
    // Steps only ever receive the per-batch signal (createChildContext passes
    // batch.signal verbatim), so without aborting the active batch an in-flight
    // step kept running to completion after abort().
    this.activeBatch?.abort(new WorkflowAbortedError(reason ?? `workflow "${this.name}" aborted`));
  }

  /**
   * Validate dependency graph for missing dependencies and circular loops using Kahn's algorithm.
   */
  validate(): void {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const stepId of this.stepsMap.keys()) {
      inDegree.set(stepId, 0);
      adjList.set(stepId, []);
    }

    for (const [stepId, step] of this.stepsMap.entries()) {
      const stepPhase = this.phases.find((p) => p.id === step.phaseId);
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!this.stepsMap.has(depId)) {
            throw new MissingDependencyError(stepId, depId);
          }
          // A FORWARD cross-phase dependency passes Kahn's algorithm (the DAG
          // here is global, phase boundaries are not modeled) but deadlocks at
          // runtime — executePhaseSteps only treats same-/earlier-phase deps
          // as satisfied. Fail fast at validation, not mid-run (round 2).
          const dep = this.stepsMap.get(depId)!;
          const depPhase = this.phases.find((p) => p.id === dep.phaseId);
          if (stepPhase && depPhase && depPhase.order > stepPhase.order) {
            throw new Error(
              `Step "${stepId}" (phase "${step.phaseId}") depends on "${depId}" from a LATER phase ("${dep.phaseId}") — ` +
                'dependencies must point to the same or an earlier phase',
            );
          }
          adjList.get(depId)!.push(stepId);
          inDegree.set(stepId, inDegree.get(stepId)! + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [stepId, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(stepId);
    }

    let visitedCount = 0;
    while (queue.length > 0) {
      const u = queue.shift()!;
      visitedCount++;
      for (const v of adjList.get(u)!) {
        inDegree.set(v, inDegree.get(v)! - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    if (visitedCount !== this.stepsMap.size) {
      // Find cyclic nodes
      const cyclicNodes = Array.from(inDegree.entries())
        .filter(([_, deg]) => deg > 0)
        .map(([id]) => id);
      throw new CircularDependencyError(cyclicNodes);
    }
  }

  /**
   * Execute the dynamic workflow.
   */
  async run(options?: Partial<WorkflowOptions>): Promise<{ status: WorkflowStatus; context: ExecutionContext }> {
    this.validate();

    const context = new WorkflowExecutionContext({
      workflowId: this.name,
      runId: options?.runId,
      isMock: options?.mockMode ?? false,
      lang: options?.lang ?? 'en',
      stateStore: options?.stateStore,
      mcpServers: options?.mcpServers,
      mcpConfigPath: options?.mcpConfigPath,
      mcpConnectTimeoutMs: options?.mcpConnectTimeoutMs,
    });

    const store = options?.stateStore;
    const completedSteps = new Set<string>();
    const failedSteps = new Set<string>();

    await this.emitEvent(store, {
      id: `evt-${Date.now()}-start`,
      workflowId: this.name,
      runId: context.runId,
      type: 'workflow_start',
      timestamp: new Date().toISOString(),
      data: { workflowName: this.name, phasesCount: this.phases.length },
    });

    try {
      for (const phase of this.phases) {
        if (this.abortController.signal.aborted) break;

        await this.emitEvent(store, {
          id: `evt-${Date.now()}-phase-${phase.id}`,
          workflowId: this.name,
          runId: context.runId,
          phaseId: phase.id,
          type: 'phase_start',
          timestamp: new Date().toISOString(),
          data: { phaseId: phase.id, phaseName: phase.name },
        });

        // Filter phase steps and execute with DAG concurrency
        await this.executePhaseSteps(phase, context, completedSteps, failedSteps, options?.maxConcurrency);

        await this.emitEvent(store, {
          id: `evt-${Date.now()}-phase-end-${phase.id}`,
          workflowId: this.name,
          runId: context.runId,
          phaseId: phase.id,
          type: 'phase_complete',
          timestamp: new Date().toISOString(),
          data: { phaseId: phase.id },
        });
      }

      // An aborted run must never read as 'completed': the phase/batch loops
      // above break on abort and silently drop pending steps, so the old
      // failedSteps-only check reported success (and run.ts printed it). A
      // caller-requested abort dominates — steps cancelled BECAUSE of the
      // abort are consequences, recorded in the events, not a separate
      // failure cause.
      const aborted = this.abortController.signal.aborted;
      const finalStatus: WorkflowStatus = aborted ? 'aborted' : failedSteps.size > 0 ? 'failed' : 'completed';

      await this.emitEvent(store, {
        id: `evt-${Date.now()}-end`,
        workflowId: this.name,
        runId: context.runId,
        type: aborted
          ? 'workflow_aborted'
          : finalStatus === 'completed'
            ? 'workflow_complete'
            : 'workflow_failed',
        timestamp: new Date().toISOString(),
        data: { status: finalStatus, completedSteps: Array.from(completedSteps) },
      });

      return { status: finalStatus, context };
    } catch (err: any) {
      await this.emitEvent(store, {
        id: `evt-${Date.now()}-err`,
        workflowId: this.name,
        runId: context.runId,
        type: 'workflow_failed',
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
      throw err;
    } finally {
      // Whatever the outcome, release this run's MCP connections so no stdio
      // MCP server outlives the run (Issue #106).
      await context.disposeMcp();
    }
  }

  private async executePhaseSteps(
    phase: PhaseDefinition,
    context: ExecutionContext,
    completedSteps: Set<string>,
    failedSteps: Set<string>,
    maxConcurrency?: number
  ): Promise<void> {
    const pendingSteps = new Set(phase.steps.map((s) => s.id));

    while (pendingSteps.size > 0) {
      if (this.abortController.signal.aborted) break;

      // Find ready steps in this phase
      const readySteps = phase.steps.filter((s) => {
        if (!pendingSteps.has(s.id)) return false;
        if (!s.dependsOn || s.dependsOn.length === 0) return true;
        return s.dependsOn.every((dep) => completedSteps.has(dep));
      });

      if (readySteps.length === 0) {
        const remaining = Array.from(pendingSteps).join(', ');
        throw new Error(`Deadlock or unfulfilled dependencies for steps: ${remaining}`);
      }

      // Execute ready steps in parallel as one group (errgroup-style, Issue #120):
      // the first failure aborts the batch signal, so siblings start no new
      // model, MCP or gate call, and the batch waits for every step to settle
      // before it reports that first failure. Nothing outlives the batch, so the
      // run's `finally` never closes MCP connections under a running step.
      const batch = new AbortController();
      this.activeBatch = batch;
      let firstFailedStepId: string | undefined;
      const cancelSiblings = (stepId: string): void => {
        if (batch.signal.aborted) return;
        firstFailedStepId = stepId;
        // Abort with the domain error, not a bare string (Issue #131): an
        // in-flight ask's fetch rejects with `signal.reason` verbatim (WHATWG
        // fetch semantics, undici), so a string reason flowed through the
        // providers — which rethrow it as-is when the signal is aborted — into
        // isCancellation, which only recognizes WorkflowAbortedError /
        // AbortError. The cancelled sibling was then recorded as a SECOND root
        // failure with an empty error message instead of `cancelledBy`. With
        // the error instance the cancellation survives the whole chain.
        batch.abort(new WorkflowAbortedError(`sibling step "${stepId}" failed`));
      };
      // WorkflowOptions.maxConcurrency was previously accepted but never
      // enforced — every ready step launched at once. Bound the batch with a
      // worker pool when a cap is configured (1 = sequential; unset = the old
      // all-at-once behavior). Junk caps (NaN/0/negative) fall back to uncapped
      // rather than poisoning Math.min into a zero-worker livelock.
      const rawCap = maxConcurrency ?? readySteps.length;
      const safeCap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : readySteps.length;
      const limit = Math.max(1, Math.min(safeCap, readySteps.length));
      const rejectionReasons = new Map<string, unknown>();
      const launchStep = (index: number): Promise<void> =>
        Promise.resolve(readySteps[index]!).then(async (step) => {
          pendingSteps.delete(step.id);
          const startTime = Date.now();

          // Gather input from immediate dependency output if single dep. This
          // happens BEFORE the checkpoint check: the gathered input is part of
          // the replay-binding hash below.
          let input: unknown = undefined;
          if (step.dependsOn && step.dependsOn.length === 1) {
            input = context.getOutput(step.dependsOn[0]);
          }
          const stepInputHash = computeStepCheckpointHash(step, input);

          // Check durable replay checkpoint — bound to the exact (step
          // definition, input) pair, not to `stepId` alone. A checkpoint whose
          // recorded inputHash differs (edited step definition or changed
          // input) is stale and is re-executed; a legacy row without a hash is
          // unverifiable and is re-executed too (fail-safe, backward
          // compatible — every re-execution is announced on the console).
          if (context.stateStore) {
            const cached = await context.stateStore.getCheckpoint(context.runId, step.id);
            if (cached && cached.status === 'completed') {
              if (cached.inputHash === undefined) {
                console.warn(
                  `[workflow] checkpoint for step "${step.id}" in run "${context.runId}" has no inputHash (legacy row) — re-executing (fail-safe)`
                );
              } else if (cached.inputHash === stepInputHash) {
                context.setOutput(step.id, cached.output);
                completedSteps.add(step.id);
                await this.emitEvent(context.stateStore, {
                  id: `evt-${Date.now()}-cached-${step.id}`,
                  workflowId: this.name,
                  runId: context.runId,
                  stepId: step.id,
                  phaseId: phase.id,
                  type: 'step_skipped',
                  timestamp: new Date().toISOString(),
                  data: { reason: 'replayed_from_checkpoint', output: cached.output },
                });
                return;
              } else {
                console.warn(
                  `[workflow] checkpoint for step "${step.id}" in run "${context.runId}" does not match the current step definition + input (inputHash mismatch) — re-executing`
                );
              }
            }
          }

          await this.emitEvent(context.stateStore, {
            id: `evt-${Date.now()}-step-start-${step.id}`,
            workflowId: this.name,
            runId: context.runId,
            stepId: step.id,
            phaseId: phase.id,
            type: 'step_start',
            timestamp: new Date().toISOString(),
            data: { stepName: step.name, type: step.type },
          });

            try {
            // timeoutMs was previously accepted but silently ignored — a
            // hanging step hung the whole run forever. Enforce it: the step's
            // signal is a composite of the batch signal and the deadline (so
            // MCP calls and gate children stop at the deadline), and the
            // promise is raced against it (so even an uncooperative runner
            // fails the step instead of hanging the run).
            const stepSignal =
              step.timeoutMs !== undefined && Number.isFinite(step.timeoutMs) && step.timeoutMs > 0
                ? AbortSignal.any([batch.signal, AbortSignal.timeout(step.timeoutMs)])
                : batch.signal;
            const stepCtx = context.createChildContext(step.id, stepSignal);
            const output = await withStepTimeout(
              withRetry(() => step.runner(input, stepCtx), step.retryPolicy, batch.signal),
              step.timeoutMs,
              step.id,
            );
            context.setOutput(step.id, output);
            completedSteps.add(step.id);

            const durationMs = Date.now() - startTime;
            if (context.stateStore) {
              await context.stateStore.saveCheckpoint(context.runId, {
                stepId: step.id,
                phaseId: phase.id,
                role: step.role,
                status: 'completed',
                input,
                output,
                durationMs,
                completedAt: new Date().toISOString(),
                inputHash: stepInputHash,
              });
            }

            await this.emitEvent(context.stateStore, {
              id: `evt-${Date.now()}-step-done-${step.id}`,
              workflowId: this.name,
              runId: context.runId,
              stepId: step.id,
              phaseId: phase.id,
              type: 'step_complete',
              timestamp: new Date().toISOString(),
              data: { output, durationMs },
            });
          } catch (err: any) {
            // Cancel the siblings first, before the bookkeeping below awaits.
            cancelSiblings(step.id);
            // A sibling cancelled by that first failure is recorded as cancelled,
            // so one failure does not read as N in events, Studio or `inspect`.
            const cancelledBy = step.id !== firstFailedStepId && isCancellation(err) ? firstFailedStepId : undefined;
            const errorText = cancelledBy
              ? `cancelled because sibling step "${cancelledBy}" failed (${err.message})`
              : err.message;
            failedSteps.add(step.id);
            const durationMs = Date.now() - startTime;
            if (context.stateStore) {
              await context.stateStore.saveCheckpoint(context.runId, {
                stepId: step.id,
                phaseId: phase.id,
                role: step.role,
                status: 'failed',
                input: undefined,
                error: errorText,
                durationMs,
                inputHash: stepInputHash,
              });
            }

            await this.emitEvent(context.stateStore, {
              id: `evt-${Date.now()}-step-fail-${step.id}`,
              workflowId: this.name,
              runId: context.runId,
              stepId: step.id,
              phaseId: phase.id,
              type: 'step_failed',
              timestamp: new Date().toISOString(),
              data: cancelledBy ? { error: errorText, durationMs, cancelled: true, cancelledBy } : { error: errorText, durationMs },
            });

            throw new StepExecutionError(step.id, phase.id, err);
          }
        }).catch((err: unknown) => {
          rejectionReasons.set(readySteps[index]!.id, err);
          // A failure outside the step's own try (checkpoint lookup, event
          // emit) cancels the siblings too.
          cancelSiblings(readySteps[index]!.id);
          throw err;
        });
      let nextIdx = 0;
      const settled = await Promise.allSettled(
        limit >= readySteps.length
          ? readySteps.map((_, i) => launchStep(i))
          : Array.from({ length: limit }, async () => {
              // errgroup: once a sibling failed, start nothing new.
              while (nextIdx < readySteps.length && firstFailedStepId === undefined && !batch.signal.aborted) {
                const i = nextIdx++;
                await launchStep(i);
              }
            }),
      );
      this.activeBatch = undefined;

      if (firstFailedStepId !== undefined) {
        const reason = rejectionReasons.get(firstFailedStepId);
        if (reason !== undefined) throw reason;
        const first = settled.find((r) => r.status === 'rejected');
        if (first) throw first.reason;
      }
    }
  }

  private async emitEvent(store: StateStore | undefined, event: WorkflowEvent): Promise<void> {
    this.emit(event.type, event);
    this.emit('event', event);
    if (store) {
      await store.recordEvent(event);
    }
  }

  /**
   * Export static DAG Graph structure for visualizers.
   */
  exportGraph(runId = 'dry-run'): DAGGraph {
    const nodes: DAGNode[] = [];
    const edges: DAGEdge[] = [];

    for (const phase of this.phases) {
      for (const step of phase.steps) {
        nodes.push({
          id: step.id,
          name: step.name,
          phaseId: phase.id,
          phaseName: phase.name,
          role: step.role ?? 'worker',
          type: step.type,
          status: 'pending',
          dependsOn: step.dependsOn ?? [],
        });

        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            edges.push({ fromNodeId: dep, toNodeId: step.id });
          }
        }
      }
    }

    return {
      workflowName: this.name,
      runId,
      status: 'pending',
      phases: this.phases.map((p) => ({ id: p.id, name: p.name, order: p.order })),
      nodes,
      edges,
      activeSubagents: 0,
      totalPhases: this.phases.length,
      currentPhaseIndex: 0,
      startedAt: new Date().toISOString(),
    };
  }
}

/**
 * Convenience helper to define a workflow using an object manifest.
 */
export function defineWorkflow(options: DefineWorkflowOptions): Workflow {
  const wf = new Workflow({
    name: options.name,
    description: options.description,
    version: options.version,
  });

  const phaseIdMap = new Map<string, string>();
  const phases: Array<string | { id: string; name: string; description?: string }> =
    options.phases && options.phases.length > 0
      ? options.phases
      : options.steps && options.steps.some((s: any) => s.phase)
      ? Array.from(new Set(options.steps.map((s: any) => s.phase).filter(Boolean)))
      : ['Phase 1'];

  if (phases.length === 0) {
    phases.push('Phase 1');
  }

  // Add phases
  phases.forEach((p, idx) => {
    if (typeof p === 'string') {
      const id = `phase-${idx + 1}`;
      phaseIdMap.set(p, id);
      wf.addPhase({ id, name: p });
    } else {
      phaseIdMap.set(p.name, p.id);
      phaseIdMap.set(p.id, p.id);
      wf.addPhase(p);
    }
  });

  // Add steps
  for (const s of (options.steps ?? [])) {
    const targetPhase = s.phaseId ?? s.phase ?? phases[0];
    const targetPhaseNameOrId = typeof targetPhase === 'string' ? targetPhase : (targetPhase ? targetPhase.id : 'phase-1');
    const resolvedPhaseId = phaseIdMap.get(targetPhaseNameOrId) ?? targetPhaseNameOrId ?? 'phase-1';

    const dependsOn = s.dependsOn ?? s.dependencies ?? [];

    wf.addStep({
      id: s.id,
      name: s.name,
      phaseId: resolvedPhaseId,
      type: s.role === 'gate' ? 'gate' : s.role === 'inspector' ? 'probe' : 'action',
      role: s.role ?? 'worker',
      dependsOn,
      runner: async (input, ctx) => s.execute(ctx, input),
      retryPolicy: s.retryPolicy,
      timeoutMs: s.timeoutMs,
    });
  }

  return wf;
}

/**
 * True for the error a step throws because its batch was cancelled: a refused
 * `ctx.mcp` / `ctx.gate` call (`WorkflowAbortedError`) or an aborted ask.
 */
function isCancellation(err: unknown): boolean {
  return err instanceof WorkflowAbortedError || (err instanceof Error && err.name === 'AbortError');
}
