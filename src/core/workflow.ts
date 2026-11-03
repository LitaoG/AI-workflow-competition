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
import { CircularDependencyError, MissingDependencyError, StepExecutionError, withRetry } from './error.js';

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
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!this.stepsMap.has(depId)) {
            throw new MissingDependencyError(stepId, depId);
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
        await this.executePhaseSteps(phase, context, completedSteps, failedSteps);

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

      const finalStatus: WorkflowStatus = failedSteps.size > 0 ? 'failed' : 'completed';

      await this.emitEvent(store, {
        id: `evt-${Date.now()}-end`,
        workflowId: this.name,
        runId: context.runId,
        type: finalStatus === 'completed' ? 'workflow_complete' : 'workflow_failed',
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
    }
  }

  private async executePhaseSteps(
    phase: PhaseDefinition,
    context: ExecutionContext,
    completedSteps: Set<string>,
    failedSteps: Set<string>
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

      // Execute ready steps in parallel via Promise.all
      await Promise.all(
        readySteps.map(async (step) => {
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
            const stepCtx = context.createChildContext(step.id);
            const output = await withRetry(() => step.runner(input, stepCtx), step.retryPolicy);
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
            failedSteps.add(step.id);
            const durationMs = Date.now() - startTime;
            if (context.stateStore) {
              await context.stateStore.saveCheckpoint(context.runId, {
                stepId: step.id,
                phaseId: phase.id,
                role: step.role,
                status: 'failed',
                input: undefined,
                error: err.message,
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
              data: { error: err.message, durationMs },
            });

            throw new StepExecutionError(step.id, phase.id, err);
          }
        })
      );
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

// ---------------------------------------------------------------------------
// Checkpoint replay binding — a checkpoint is only served when the producing
// (step definition, input) pair hashes to the recorded inputHash (audit fix:
// the short-circuit used to key on stepId alone and served stale results)
// ---------------------------------------------------------------------------

/** The serializable identity fields of a {@link StepDefinition} bound into the replay hash. */
interface StepHashDescriptor {
  id: string;
  name: string;
  phaseId: string;
  type: string;
  role?: string;
  /** Sorted copy — dependency ORDER carries no semantics, only the set does. */
  dependsOn: string[];
  retryPolicy?: { maxRetries: number; initialDelayMs?: number; backoffFactor?: number };
  timeoutMs?: number;
}

/**
 * Pick the step's serializable identity fields in canonical form. The
 * non-serializable closures (`runner`, `retryPolicy.retryableErrorFilter`) are
 * deliberately NOT part of the binding: function source text is not stable
 * across minifiers/bundlers, so binding it would produce spurious mismatches
 * (the fail-safe direction, but noisy). Editing only a step's function body is
 * therefore not detected at this layer — whole-script identity binding is the
 * dwf facade runner's job (`scriptHash`).
 */
function stepHashDescriptor(step: StepDefinition): StepHashDescriptor {
  return {
    id: step.id,
    name: step.name,
    phaseId: step.phaseId,
    type: step.type,
    ...(step.role !== undefined ? { role: step.role } : {}),
    dependsOn: [...(step.dependsOn ?? [])].sort(),
    ...(step.retryPolicy !== undefined
      ? {
          retryPolicy: {
            maxRetries: step.retryPolicy.maxRetries,
            ...(step.retryPolicy.initialDelayMs !== undefined
              ? { initialDelayMs: step.retryPolicy.initialDelayMs }
              : {}),
            ...(step.retryPolicy.backoffFactor !== undefined
              ? { backoffFactor: step.retryPolicy.backoffFactor }
              : {}),
          },
        }
      : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  };
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so two
 * structurally equal values always produce the same text regardless of key
 * insertion order; arrays keep their order (it is semantically meaningful).
 * `undefined` serializes as `null` (JSON semantics); non-JSON values (BigInt,
 * functions, symbols) degrade to their `String()` form; cyclic references
 * degrade to the `"[Circular]"` marker instead of throwing. Total — never
 * throws, so hashing hostile step inputs is always safe.
 *
 * @param value - Any runtime value (expected to be JSON-safe in practice).
 */
export function stableStringify(value: unknown): string {
  return stringifyStable(value, new Set());
}

function stringifyStable(value: unknown, seen: Set<object>): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return JSON.stringify(String(value));
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => stringifyStable(item, seen)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const pairs = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stringifyStable(record[key], seen)}`);
    out = `{${pairs.join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * sha256 over the canonical (step definition, input) pair — the hash a core
 * checkpoint is bound by. The two parts are serialized independently
 * ({@link stableStringify}) and joined with a NUL separator so no pair of
 * (definition, input) values can collide across the boundary. Pure: the same
 * pair always yields the same hex digest.
 *
 * @param step - The step definition as currently wired into the workflow.
 * @param input - The runtime input the step is about to receive (or received).
 */
export function computeStepCheckpointHash(step: StepDefinition, input: unknown): string {
  return createHash('sha256')
    .update(stableStringify(stepHashDescriptor(step)))
    .update('\u0000')
    .update(stableStringify(input))
    .digest('hex');
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
