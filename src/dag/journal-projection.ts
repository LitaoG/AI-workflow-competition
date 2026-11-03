/**
 * Journal projection — fold a `dwf_*` event stream into a {@link DAGGraph}
 * (the engine's "one projection for live runs and cold replays" contract).
 *
 * ONE pure function serves both halves of the "活跑与冷回放同一投影" contract:
 *
 * - the LIVE watch (`run-script --watch-graph`) re-folds the accumulated event
 *   prefix after every emit and rewrites `graph.html` inside the run dir;
 * - the COLD replay (`workflow graph <run-dir|events.jsonl>`) folds the whole
 *   journal — `events.jsonl` preferred, the SQLite event table as fallback —
 *   through this exact same function.
 *
 * The fold is deterministic by construction: every field (statuses, durations,
 * phase columns, node order, graph timestamps) is derived from the events
 * themselves — no wall clock, no randomness, no I/O — so folding a prefix and
 * folding the full stream of the same run produce deeply-equal graphs and
 * byte-identical renders. That is precisely why the live watcher can afford the
 * simplest possible "incremental" strategy: re-fold the prefix on every emit
 * (runs are bounded by the engine's agent-call cap, so the quadratic total cost
 * is negligible) and the watched run can never diverge from its replay.
 *
 * Event → node/edge/status mapping (the full `dwf_*` vocabulary):
 *
 * | Event                                              | Effect                                                       |
 * | -------------------------------------------------- | ------------------------------------------------------------ |
 * | `dwf_phase`                                        | phase column, first-appearance order, deduped by name         |
 * | `dwf_ask_start`                                    | ask node (keyed by siteId) → running; prompt stored (redacted)|
 * | `dwf_ask_complete`                                 | ask node → completed; durationMs from the two timestamps      |
 * | `dwf_replay_hit` / `dwf_amend_hit`                 | node → replayed (zero-cost journal/warm-cache reuse)          |
 * | `dwf_amend_diverged`                               | node → running (the node forks and executes live)             |
 * | `dwf_node_failed` / `dwf_call_error`               | node → failed; errorMessage stored (redacted)                 |
 * | `dwf_world_run`                                    | gate node `gate:<cmd>` → running (carries no siteId on the wire) |
 * | `dwf_artifact`                                     | artifact node `artifact:<id>` → completed (carries no siteId) |
 * | `dwf_hole_open` / `dwf_escalation_open`            | gate node (siteId) → running (the run parks waiting on it)    |
 * | `dwf_completed`                                    | graph → completed; still-running nodes settle to completed    |
 * | `dwf_failed` (status `failed`)                     | graph → failed; still-running nodes settle to failed          |
 * | `dwf_failed` (status `parked`)                     | graph → paused; running nodes left untouched (the run resumes)|
 * | `dwf_actor_created`                                | no node — an actor is a session, not a workflow step          |
 * | `dwf_log` / `dwf_report` / `dwf_budget_spent` / `dwf_size_warning` | telemetry — no node                            |
 * | `dwf_resume_takeover`                              | no node — a takeover is journal meta, never a pseudo step     |
 * | `dwf_event_log_write_failed`                       | no node — mirror-degradation meta                             |
 * | core-builder vocabulary (`workflow_start`, `step_*`, …) | ignored — this projection is dwf-specific                |
 *
 * Nodes are SITE-level: the node id is the siteId, and multiple ordinals of the
 * same site (a loop body) collapse into one node whose status is the LAST fact
 * the stream states. The two site-less events are keyed by what they do carry
 * (`gate:<cmd>`, `artifact:<id>`); a diverged amend gate therefore briefly
 * shows its siteId node (from `dwf_amend_diverged`) plus its `gate:<cmd>` node.
 *
 * Edges are the per-phase creation-order chain: within a phase each node
 * depends on the previously created one — the causal order the event stream
 * actually proves (a facade script is a linear program, so site start order
 * inside a phase is its dependency order; under parallel asks the chain follows
 * start order). A failed node keeps its edges — failure highlights the node,
 * it never amputates the graph.
 *
 * Free text that reaches the rendered artifact (prompts, gate command lines,
 * error messages) passes through {@link redactText} here — the projection is
 * the last boundary before the HTML/ASCII/mermaid render.
 */

import { DAGEdge, DAGGraph, DAGNode, StepStatus, StepType, WorkflowEvent } from '../types.js';
import { redactText } from '../dwf/redact.js';

/** Cap applied to free text embedded into the graph (the engine caps prompts at the same 400). */
const TEXT_CAP = 400;

/** Graph name for every projected run — the `workflowId` the dwf runner stamps on its events. */
const FACADE_WORKFLOW_NAME = 'facade-script';

/** Fallback phase for nodes created before the first `dwf_phase` (mirrors the live view's "(start)"). */
const START_PHASE_NAME = '(start)';

/** Visual shape of a journal node by journalled-node kind. */
const KIND_SHAPE: Record<string, { role: string; type: StepType }> = {
  ask: { role: 'worker', type: 'agent' },
  worldRead: { role: 'inspector', type: 'probe' },
  worldRun: { role: 'gate', type: 'gate' },
  artifact: { role: 'coordinator', type: 'action' },
  hole: { role: 'gate', type: 'gate' },
  escalation: { role: 'gate', type: 'gate' },
};

/** Host-call op → journalled-node kind (for `dwf_call_error`, which carries the op, not a kind). */
const OP_KIND: Record<string, string> = {
  ask: 'ask',
  worldRead: 'worldRead',
  worldRun: 'worldRun',
  artifact: 'artifact',
  hole: 'hole',
  escalate: 'escalation',
};

interface PhaseColumn {
  id: string;
  name: string;
  order: number;
}

interface SiteEntry {
  node: DAGNode;
  /** Wall-clock ms of the `dwf_ask_start` event — the base for durationMs on completion. */
  startedAtMs?: number;
}

interface ProjectionState {
  runId: string;
  startedAt: string;
  completedAt: string | undefined;
  status: DAGGraph['status'];
  /** Phase columns keyed by phase NAME — re-entering a phase reuses its column. */
  phases: Map<string, PhaseColumn>;
  currentPhase: PhaseColumn | undefined;
  /** Nodes keyed by siteId — or `gate:<cmd>` / `artifact:<id>` for the two site-less events. */
  sites: Map<string, SiteEntry>;
  /** Node keys in first-creation order: the node array order and the edge chain. */
  order: string[];
  /** Per-phase last created node key — the creation-order dependency chain. */
  lastNodeByPhase: Map<string, string>;
  edges: DAGEdge[];
}

/** Narrow an event payload to a record (events written by older hosts may carry anything). */
function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

/** Stringify one payload field; `undefined`/`null` collapse to `''`. */
function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value);
}

/** Redact free text and cap it before it can reach a rendered artifact. */
function cappedRedacted(text: string): string {
  return redactText(text).slice(0, TEXT_CAP);
}

/** Parse an ISO timestamp to wall-clock ms; `NaN` when unparseable. */
function msOf(timestamp: string): number {
  return Date.parse(timestamp);
}

/** Find or create the phase column for a phase name (deterministic `phase-<n>` ids). */
function ensurePhase(state: ProjectionState, name: string): PhaseColumn {
  const key = name || START_PHASE_NAME;
  const existing = state.phases.get(key);
  if (existing) return existing;
  const column: PhaseColumn = { id: `phase-${state.phases.size}`, name: key, order: state.phases.size };
  state.phases.set(key, column);
  return column;
}

/** Create a node, append it to the creation order and wire the per-phase chain edge. */
function createNode(state: ProjectionState, key: string, init: Omit<DAGNode, 'dependsOn'>): DAGNode {
  const last = state.lastNodeByPhase.get(init.phaseId);
  const dependsOn = last !== undefined && last !== key ? [last] : [];
  const node: DAGNode = { ...init, dependsOn };
  state.sites.set(key, { node });
  state.order.push(key);
  if (last !== undefined && last !== key) {
    state.edges.push({ fromNodeId: last, toNodeId: key });
  }
  state.lastNodeByPhase.set(init.phaseId, key);
  return node;
}

/** Find a site node or lazily create it in the current phase with the kind's visual shape. */
function ensureSiteNode(state: ProjectionState, siteId: string, kind: string, name: string): SiteEntry {
  const existing = state.sites.get(siteId);
  if (existing) return existing;
  const shape = KIND_SHAPE[kind] ?? KIND_SHAPE['ask']!;
  const phase = state.currentPhase ?? ensurePhase(state, START_PHASE_NAME);
  createNode(state, siteId, {
    id: siteId,
    name: name || siteId,
    phaseId: phase.id,
    phaseName: phase.name,
    role: shape.role,
    type: shape.type,
    status: 'pending',
  });
  return state.sites.get(siteId)!;
}

/** Settle every still-running node to a terminal status (a settled run has no in-flight work). */
function settleRunning(state: ProjectionState, to: StepStatus): void {
  for (const key of state.order) {
    const entry = state.sites.get(key);
    if (entry && entry.node.status === 'running') entry.node.status = to;
  }
}

/** Apply one event to the fold state. Unknown/ignored types fall through harmlessly. */
function applyEvent(state: ProjectionState, event: WorkflowEvent): void {
  if (state.runId === '' && event.runId) state.runId = event.runId;
  if (state.startedAt === '') state.startedAt = event.timestamp;
  const data = asRecord(event.data);

  switch (event.type) {
    case 'dwf_phase': {
      state.currentPhase = ensurePhase(state, field(data, 'phase'));
      break;
    }
    case 'dwf_ask_start': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, 'ask', field(data, 'actor'));
      entry.node.status = 'running';
      entry.startedAtMs = msOf(event.timestamp);
      const prompt = field(data, 'prompt');
      if (prompt) entry.node.inputs = { prompt: cappedRedacted(prompt) };
      break;
    }
    case 'dwf_ask_complete': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, 'ask', field(data, 'actor') || siteId);
      if (entry.node.status === 'running') entry.node.status = 'completed';
      const end = msOf(event.timestamp);
      if (entry.startedAtMs !== undefined && Number.isFinite(end) && end >= entry.startedAtMs) {
        entry.node.durationMs = end - entry.startedAtMs;
      }
      break;
    }
    case 'dwf_replay_hit':
    case 'dwf_amend_hit': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, field(data, 'kind') || 'ask', siteId);
      entry.node.status = 'replayed';
      break;
    }
    case 'dwf_amend_diverged': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, field(data, 'kind') || 'ask', siteId);
      entry.node.status = 'running';
      break;
    }
    case 'dwf_node_failed':
    case 'dwf_call_error': {
      const siteId = field(data, 'siteId');
      // A call_error without a siteId has no node to attach to — it stays journal meta.
      if (!siteId) break;
      const kind = event.type === 'dwf_node_failed'
        ? field(data, 'kind') || 'ask'
        : OP_KIND[field(data, 'op')] ?? 'ask';
      const entry = ensureSiteNode(state, siteId, kind, siteId);
      entry.node.status = 'failed';
      const error = field(data, 'error');
      if (error) entry.node.errorMessage = cappedRedacted(error);
      break;
    }
    case 'dwf_world_run': {
      const cmd = field(data, 'cmd');
      if (!cmd) break;
      // The wire event carries no siteId — gates are keyed by the command they run.
      const key = `gate:${cmd}`;
      if (!state.sites.has(key)) {
        const phase = state.currentPhase ?? ensurePhase(state, START_PHASE_NAME);
        createNode(state, key, {
          id: key,
          name: `world.run ${cmd}`,
          phaseId: phase.id,
          phaseName: phase.name,
          role: 'gate',
          type: 'gate',
          status: 'running',
        });
      }
      const args = Array.isArray(data.args) ? (data.args as unknown[]).map(String) : [];
      state.sites.get(key)!.node.inputs = { cmd: cappedRedacted([cmd, ...args].join(' ')) };
      break;
    }
    case 'dwf_artifact': {
      const id = field(data, 'id');
      if (!id) break;
      // The wire event carries no siteId — artifacts are keyed by their id.
      const key = `artifact:${id}`;
      if (!state.sites.has(key)) {
        const phase = state.currentPhase ?? ensurePhase(state, START_PHASE_NAME);
        createNode(state, key, {
          id: key,
          name: `artifact ${id}`,
          phaseId: phase.id,
          phaseName: phase.name,
          role: 'coordinator',
          type: 'action',
          // An emitted artifact did land — the only event kind that is a completion fact itself.
          status: 'completed',
        });
      }
      break;
    }
    case 'dwf_hole_open': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, 'hole', field(data, 'name') || siteId);
      entry.node.status = 'running'; // parked, waiting for a human fill
      const prompt = field(data, 'prompt');
      if (prompt) entry.node.inputs = { prompt: cappedRedacted(prompt) };
      break;
    }
    case 'dwf_escalation_open': {
      const siteId = field(data, 'siteId');
      if (!siteId) break;
      const entry = ensureSiteNode(state, siteId, 'escalation', field(data, 'questionId') || siteId);
      entry.node.status = 'running'; // parked, waiting for a human answer
      const question = field(data, 'question');
      if (question) entry.node.inputs = { question: cappedRedacted(question) };
      break;
    }
    case 'dwf_completed': {
      state.status = 'completed';
      state.completedAt = event.timestamp;
      settleRunning(state, 'completed');
      break;
    }
    case 'dwf_failed': {
      // The runner emits dwf_failed for BOTH failure and park; a parked run
      // resumes, so its in-flight sites stay running instead of being failed.
      const parked = field(data, 'status') === 'parked';
      state.status = parked ? 'paused' : 'failed';
      state.completedAt = event.timestamp;
      if (!parked) settleRunning(state, 'failed');
      break;
    }
    default:
      // dwf_actor_created (a session, not a step), dwf_log / dwf_report /
      // dwf_budget_spent / dwf_size_warning (telemetry), dwf_resume_takeover
      // and dwf_event_log_write_failed (journal meta) never become nodes, and
      // the core-builder vocabulary belongs to a different runtime.
      break;
  }
}

/**
 * Project a `dwf_*` event stream into a DAG graph for the visualizers.
 *
 * Pure and total: an empty stream yields an empty graph (never throws), unknown
 * event types are ignored, and the same event sequence always yields a
 * deeply-equal graph — which is what makes the live watch and the cold replay
 * two views of one truth. See the module TSDoc for the full mapping table.
 *
 * @param events - The journalled events in stream order (any prefix of a run's
 *   stream projects to the state at that point of the run).
 */
export function projectEventsToGraph(events: readonly WorkflowEvent[]): DAGGraph {
  const state: ProjectionState = {
    runId: '',
    startedAt: '',
    completedAt: undefined,
    status: events.length > 0 ? 'running' : 'pending',
    phases: new Map(),
    currentPhase: undefined,
    sites: new Map(),
    order: [],
    lastNodeByPhase: new Map(),
    edges: [],
  };
  for (const event of events) applyEvent(state, event);

  let activeSubagents = 0;
  for (const key of state.order) {
    const entry = state.sites.get(key);
    if (entry && entry.node.type === 'agent' && entry.node.status === 'running') activeSubagents++;
  }
  const phases = [...state.phases.values()]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ id: p.id, name: p.name, order: p.order }));

  return {
    workflowName: FACADE_WORKFLOW_NAME,
    runId: state.runId,
    status: state.status,
    phases,
    nodes: state.order.map((key) => ({ ...state.sites.get(key)!.node })),
    edges: state.edges.map((edge) => ({ ...edge })),
    activeSubagents,
    totalPhases: phases.length,
    currentPhaseIndex: state.currentPhase ? state.currentPhase.order : 0,
    startedAt: state.startedAt,
    ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
  };
}
