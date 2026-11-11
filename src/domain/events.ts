/**
 * Canonical workflow event vocabulary with constant names.
 *
 * Single source of truth for every event type the engine emits to `events.jsonl`,
 * the SQLite checkpoint and the DAG visualizer. The `WorkflowEventType` union is
 * *derived* from the {@link WORKFLOW_EVENT} constant map, so the wire strings and
 * the compile-time union can never drift apart.
 *
 * This module is dependency-free by design (Clean Inward Architecture): it imports
 * nothing and may only be imported *into*.
 */

/** Named constants for every canonical event type (wire values, stable order). */
export const WORKFLOW_EVENT = {
  /** Run lifecycle started. */
  WORKFLOW_START: 'workflow_start',
  /** A phase entered execution. */
  PHASE_START: 'phase_start',
  /** A step entered execution. */
  STEP_START: 'step_start',
  /** A step finished successfully. */
  STEP_COMPLETE: 'step_complete',
  /** A step finished with an error. */
  STEP_FAILED: 'step_failed',
  /** A step was skipped (dependency failed or replayed away). */
  STEP_SKIPPED: 'step_skipped',
  /** A deterministic shell gate was evaluated. */
  GATE_EVAL: 'gate_eval',
  /** A phase finished execution. */
  PHASE_COMPLETE: 'phase_complete',
  /** Run lifecycle completed successfully. */
  WORKFLOW_COMPLETE: 'workflow_complete',
  /** Run lifecycle completed with failures. */
  WORKFLOW_FAILED: 'workflow_failed',
  /** Run lifecycle was aborted by the user or a supervisor. */
  WORKFLOW_ABORTED: 'workflow_aborted',
  /** A typed agent RPC request was dispatched. */
  AGENT_RPC_REQUEST: 'agent_rpc_request',
  /** A typed agent RPC response was received. */
  AGENT_RPC_RESPONSE: 'agent_rpc_response',
  /** An MCP tool call was dispatched to a server. */
  MCP_TOOL_CALL: 'mcp_tool_call',
  /** An MCP tool result was received from a server. */
  MCP_TOOL_RESULT: 'mcp_tool_result',
  /** An artifact was recorded for a run. */
  ARTIFACT_EMITTED: 'artifact_emitted',
  // —— facade-script (dwf) engine events ——
  /** Facade script entered a named phase. */
  DWF_PHASE: 'dwf_phase',
  /** Facade script emitted a log line. */
  DWF_LOG: 'dwf_log',
  /** Facade script emitted a report payload. */
  DWF_REPORT: 'dwf_report',
  /** A persistent actor session was created for an agent. */
  DWF_ACTOR_CREATED: 'dwf_actor_created',
  /** A facade `agent(name).ask(...)` started. */
  DWF_ASK_START: 'dwf_ask_start',
  /** A facade `agent(name).ask(...)` completed. */
  DWF_ASK_COMPLETE: 'dwf_ask_complete',
  /** A journalled node was served from the replay cache. */
  DWF_REPLAY_HIT: 'dwf_replay_hit',
  /** An amend run replayed a warm node at zero cost. */
  DWF_AMEND_HIT: 'dwf_amend_hit',
  /** An amend run found a warm node whose inputs diverged; it forked live. */
  DWF_AMEND_DIVERGED: 'dwf_amend_diverged',
  /** A facade hole (model-authored sub-workflow) was opened. */
  DWF_HOLE_OPEN: 'dwf_hole_open',
  /** A facade escalate(question) asked the run owner a blocking question. */
  DWF_ESCALATION_OPEN: 'dwf_escalation_open',
  /** Budget accounting heartbeat: output tokens spent by completed asks. */
  DWF_BUDGET_SPENT: 'dwf_budget_spent',
  /** The run crossed the large-workflow ask threshold. */
  DWF_SIZE_WARNING: 'dwf_size_warning',
  /** The amend's imported cache closed (a live world.run may have changed the workspace). */
  DWF_IMPORT_CACHE_CLOSED: 'dwf_import_cache_closed',
  /** A workflow() composition child run settled. */
  DWF_CHILD_WORKFLOW: 'dwf_child_workflow',
  /** The run settled: registered in-flight ask controllers were aborted (Issue #107). */
  DWF_INFLIGHT_ABORT: 'dwf_inflight_abort',
  /** A failing ask moved to (or skipped) another provider in the failover chain. */
  DWF_FAILOVER: 'dwf_failover',
  /** A facade `world.run` command executed. */
  DWF_WORLD_RUN: 'dwf_world_run',
  /** A facade `world.run` command's authorization provenance (Issue #127 direction 1: explicit | allowlist | tty). */
  DWF_WORLD_RUN_AUTH: 'dwf_world_run_auth',
  /** A host call from the child failed. */
  DWF_CALL_ERROR: 'dwf_call_error',
  /** A journalled facade node failed. */
  DWF_NODE_FAILED: 'dwf_node_failed',
  /** A facade artifact was recorded. */
  DWF_ARTIFACT: 'dwf_artifact',
  /** Facade script run completed successfully. */
  DWF_COMPLETED: 'dwf_completed',
  /** Facade script run completed with failures. */
  DWF_FAILED: 'dwf_failed',
  /** Facade script run parked on an open hole/escalation (resumable — not a failure; Issue #35). */
  DWF_PARKED: 'dwf_parked',
  /** A resume took over a stale `running` row whose host pid is dead (host crash) or never recorded (legacy row). */
  DWF_RESUME_TAKEOVER: 'dwf_resume_takeover',
  /** An `events.jsonl` append failed — the mirror is degraded; SQLite stays authoritative (StorageError-tagged payload). */
  DWF_EVENT_LOG_WRITE_FAILED: 'dwf_event_log_write_failed',
  /** Unparseable child stdout frames were counted (diagnostic; tearing/garbage never silently dropped). */
  DWF_FRAME_MALFORMED: 'dwf_frame_malformed',
  /** Win32 Job Object supervision mode for the sandbox child (diagnostic; job-object | fallback-taskkill). */
  DWF_JOB_GUARD: 'dwf_job_guard',
} as const;

/** Every canonical event type, as a union of the wire-string literals above. */
export type WorkflowEventType = (typeof WORKFLOW_EVENT)[keyof typeof WORKFLOW_EVENT];

/** All valid event type wire values, in the stable declaration order. */
export const WORKFLOW_EVENT_TYPES: readonly WorkflowEventType[] = Object.values(WORKFLOW_EVENT);

/**
 * Type guard: `true` when `value` is one of the canonical event type strings.
 * Used when re-parsing `events.jsonl` frames from disk.
 *
 * @param value - Any parsed value.
 */
export function isWorkflowEventType(value: unknown): value is WorkflowEventType {
  return WORKFLOW_EVENT_TYPES.includes(value as WorkflowEventType);
}

/** One journalled workflow event: the append-only unit of the event stream. */
export interface WorkflowEvent {
  /** Unique event id within the run. */
  id: string;
  /** Id of the workflow definition that emitted the event. */
  workflowId: string;
  /** Id of the run the event belongs to. */
  runId: string;
  /** Id of the step that emitted the event, when step-scoped. */
  stepId?: string;
  /** Id of the phase that emitted the event, when phase-scoped. */
  phaseId?: string;
  /** Canonical event type (see {@link WORKFLOW_EVENT}). */
  type: WorkflowEventType;
  /** ISO-8601 wall-clock timestamp of emission. */
  timestamp: string;
  /** Monotonic sequence number within the run, when assigned by the writer. */
  sequence?: number;
  /** Free-form, JSON-safe payload carried by the event. */
  data: unknown;
}
