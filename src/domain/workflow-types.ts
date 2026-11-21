/**
 * Workflow contract & metadata types — the pure data contracts shared by every
 * layer of the engine (core builder, dwf facade stack, agent RPC, storage, DAG,
 * MCP). Type-only definitions: no behavior, no side effects, no external
 * dependencies (Clean Inward Architecture) — this module may only be imported
 * *into*, never outward. Runtime event vocabulary lives in `./events.js`.
 */
import type { WorkflowEvent } from './events.js';
import type { DwfEvidenceRow, EvidenceEntry } from './evidence.js';

// ============================================================================
// 1. Workflow & Phase Types
// ============================================================================

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'paused';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'replayed';

export type StepType = 'agent' | 'probe' | 'gate' | 'fanout' | 'action';

export interface WorkflowOptions {
  name: string;
  description?: string;
  version?: string;
  runId?: string;
  mockMode?: boolean;
  timeoutMs?: number;
  maxConcurrency?: number;
  lang?: 'en' | 'zh';
  stateStore?: StateStore;
  /**
   * MCP servers that `ctx.mcp.callTool` may reach in this run. When given,
   * they are the only MCP config source.
   */
  mcpServers?: Record<string, MCPServerConfig>;
  /**
   * Path to a trusted `.mcp.json` (Claude Code format), used when `mcpServers`
   * is omitted. Default: the `AI_WORKFLOW_MCP_CONFIG` environment variable. A
   * `.mcp.json` in the working directory is never read implicitly, because it
   * may belong to an untrusted checkout (Issue #106).
   */
  mcpConfigPath?: string;
  /**
   * Handshake timeout per MCP server in ms. Default: the
   * `AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS` environment variable, else 20000.
   * Raise it for servers with a slow first start (e.g. an `npx -y` download).
   */
  mcpConnectTimeoutMs?: number;
}

export interface PhaseDefinition {
  id: string;
  name: string;
  description?: string;
  order: number;
  steps: StepDefinition[];
}

export interface StepDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  phaseId: string;
  type: StepType;
  role?: 'inspector' | 'worker' | 'reviewer' | 'gate' | 'coordinator' | string;
  dependsOn?: string[]; // IDs of prerequisite steps
  runner: StepRunner<TInput, TOutput>;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
}

export type StepRunner<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ExecutionContext
) => Promise<TOutput>;

// ============================================================================
// 2. Execution Context Contracts
// ============================================================================

export interface ContextSnapshot {
  workflowId: string;
  runId: string;
  startedAt: string;
  variables: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  probeSnapshot?: ProberResult;
}

export interface ExecutionContext {
  readonly workflowId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly isMock: boolean;
  readonly lang: 'en' | 'zh';
  readonly stateStore?: StateStore;

  get<T = unknown>(key: string, defaultValue?: T): T;
  set<T = unknown>(key: string, value: T): void;
  has(key: string): boolean;

  getOutput<T = unknown>(stepId: string): T | undefined;
  setOutput<T = unknown>(stepId: string, output: T): void;
  getAllOutputs(): Record<string, unknown>;

  getProbeSnapshot(): ProberResult | undefined;
  setProbeSnapshot(probe: ProberResult): void;

  recordArtifact(name: string, content: string, type?: string, stepId?: string): Promise<void>;

  agent(roleOrName: string): AgentRPCClient;
  gate(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<GateResult>;
  probe: ((options?: ProberOptions) => Promise<ProberResult>) & Partial<ProberResult>;
  mcp?: {
    callTool: (server: string, tool: string, args?: Record<string, unknown>, options?: McpCallOptions) => Promise<unknown>;
  };

  /**
   * Cancellation for the running step: aborted when a sibling step in the same
   * parallel batch fails. Long-running step code can check it and stop early;
   * `agent()`, `gate()` and `mcp.callTool` already refuse new work once it fires.
   */
  readonly signal?: AbortSignal;

  snapshot(): ContextSnapshot;
  restore(snapshot: ContextSnapshot): void;
  createChildContext(stepId: string, signal?: AbortSignal): ExecutionContext;
}

export interface GateResult {
  passed: boolean;
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// ============================================================================
// 3. Retry Policy & Errors
// ============================================================================

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  /**
   * Decides alone which errors retry. Without it, an error whose `isRecoverable`
   * is `false` is not retried; errors without that flag are.
   */
  retryableErrorFilter?: (error: Error) => boolean;
}

// ============================================================================
// 4. Typed Agent RPC Types
// ============================================================================

export type AgentRole = 'inspector' | 'worker' | 'reviewer' | 'fixer' | 'planner' | 'coordinator' | string;

/**
 * Minimal structural contract for the runtime validator passed to
 * `AgentRPCClient.ask`. Conforms to any zod schema (`z.ZodType<T>` satisfies it
 * structurally), while keeping this pure domain module dependency-free.
 */
export interface PromptSchema<TOutput = unknown> {
  /** Strictly parse `data`, throwing on invalid input (zod-compatible). */
  parse(data: unknown): TOutput;
  /** Non-throwing validation: success with data, or failure with issue details. */
  safeParse(
    data: unknown
  ): { success: true; data: TOutput } | { success: false; error: { issues: readonly unknown[] } };
}

export interface AgentCallOptions {
  role?: AgentRole;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number; // Schema auto-repair retries (default: 3)
  timeoutMs?: number;
  mockResponse?: unknown; // Explicit override for testing
  /** Prior conversation turns for persistent actor sessions (inserted between system and the new user turn). */
  priorMessages?: LLMMessage[];
  /** Route this ask to a specific registered provider instead of the registry default. */
  providerId?: string;
  /** Abort signal — a cancelled session turn must stop its provider call. */
  signal?: AbortSignal;
  /**
   * Stall clock (aligned with common agent-host defaults): if the provider call
   * makes no progress within this window, reject with a transient stall error —
   * the classifier turns it into a retry. Default: no stall clock.
   */
  stallMs?: number;
  /**
   * Observe the provider usage of each generate call (budget accounting).
   * Issue #125: attempts that lose the stall race are also accounted —
   * `droppedAttempt` marks a request whose result was discarded (its result
   * arrived after the stall abort), and `estimated` marks the conservative
   * maxTokens entry recorded when the orphan died on our abort with no real
   * usage to read. The budget may only over-count, never silently
   * under-count.
   */
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    droppedAttempt?: boolean;
    estimated?: boolean;
  }) => void;
  /**
   * Retry-orchestrator policy (ODW-inspired): which failure categories may retry and
   * how hard. Absent = the classifier's defaults (rate_limit/transient retry).
   */
  retryPolicy?: {
    maxRetries?: number;
    /** Failure categories eligible for another attempt. */
    retryOn?: Array<'rate_limit' | 'transient' | 'auth' | 'quota' | 'invalid_request' | 'cancelled' | 'fatal'>;
    /** Backoff multiplier base in ms (default 500, exponential per attempt). */
    backoffMs?: number;
  };
}

export interface AgentRPCClient {
  readonly name: string;
  ask<T>(prompt: string, schema: PromptSchema<T>, options?: AgentCallOptions): Promise<T>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  model?: string;
  /** Abort signal for cancellable asks (sessions.cancel) — providers must honour it. */
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: TokenUsage;
  latencyMs: number;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Readiness probe for /workflow doctor — no model call, config/env level. */
  checkHealth?(): Promise<ProviderHealth> | ProviderHealth;
}

// ============================================================================
// 5. Deterministic Prober Types
// ============================================================================

export interface SystemProbe {
  platform: 'win32' | 'linux' | 'darwin' | string;
  arch: string;
  cpus: number;
  cpuModel: string;
  totalMemMb: number;
  totalMemoryMB?: number;
  freeMemMb: number;
  freeMemoryMB?: number;
  uptimeSeconds: number;
  hostname: string;
  nodeVersion: string;
}

export interface GitProbe {
  isGitRepo: boolean;
  branch: string;
  commit: string;
  commitHash?: string;
  commitShort: string;
  isDirty: boolean;
  dirtyFilesCount: number;
  trackingRemote?: string;
  remoteUrl?: string;
}

export interface ToolchainProbe {
  node: string;
  nodeVersion?: string;
  /** Measured npm version; undefined = not installed (never a fabricated value, Issue #88). */
  npm?: string;
  /** Measured git version; undefined = not installed (never a fabricated value, Issue #88). */
  git?: string;
  python?: string;
  tsc?: string;
  docker?: string;
  tools?: Record<string, unknown>;
}

export interface ProberResult {
  snapshotId?: string;
  timestamp: string;
  system: SystemProbe;
  git: GitProbe;
  toolchain: ToolchainProbe;
  env: Record<string, string>; // Strictly sanitized/redacted — the single env snapshot (Issue #36)
}

export interface ProberOptions {
  cwd?: string;
  sanitizeEnv?: boolean;
  envWhitelist?: string[];
  probeTimeoutMs?: number;
}

// ============================================================================
// 6. Durable State & Event Types
// ============================================================================

export interface StepCheckpoint {
  stepId: string;
  phaseId: string;
  role?: string;
  status: StepStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  tokens?: { prompt: number; completion: number };
  completedAt?: string;
  /**
   * sha256 over the canonical (step definition, input) pair that produced this
   * checkpoint (see `computeStepCheckpointHash` in core/workflow.ts) — the
   * replay short-circuit re-executes on a mismatch instead of serving a stale
   * result. `undefined` on rows written before the binding existed (legacy
   * checkpoints); the replay path treats those as a fail-safe miss, never as
   * a hit.
   */
  inputHash?: string;
}

export interface WorkflowArtifact {
  artifactId: string;
  runId: string;
  stepId: string;
  name: string;
  artifactType: string;
  content: string;
  createdAt: string;
}

export interface StateStore {
  recordEvent(event: WorkflowEvent): Promise<void>;
  saveCheckpoint(runId: string, checkpoint: StepCheckpoint): Promise<void>;
  getCheckpoint(runId: string, stepId: string): Promise<StepCheckpoint | null>;
  getAllCheckpoints(runId: string): Promise<Record<string, StepCheckpoint>>;
  getRunStatus(runId: string): Promise<{
    status: WorkflowStatus;
    completedSteps: string[];
    failedSteps?: string[];
    activeSubagents?: number;
  }>;
  /**
   * Durable checkpoint invalidation — the honest basis for replay
   * `--step` / `--force-recompute`. A deleted checkpoint makes the engine
   * genuinely re-execute the step, so every store holding a copy of the run's
   * checkpoints must honor the deletion (a surviving mirror copy would be
   * served by a fallback read and silently cancel the invalidation).
   */
  deleteCheckpoints?(runId: string, stepId?: string): Promise<void>;
  saveArtifact?(artifact: WorkflowArtifact): Promise<void>;
  getArtifacts?(runId: string): Promise<WorkflowArtifact[]>;
  close?(): Promise<void> | void;
}

// ============================================================================
// 6b. Facade-script (dwf) journal contracts
// ============================================================================

/** One journalled facade node: the replay key is (runId, siteId, ordinal). */
export interface DwfNode {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: 'ask' | 'worldRead' | 'worldRun' | 'artifact' | 'hole' | 'escalation' | 'report';
  inputHash: string;
  status: 'completed' | 'failed';
  resultJson?: string;
  errorText?: string;
  durationMs?: number;
  completedAt?: string;
  /**
   * Issue #39 per-actor named-cache identity (ask rows only): the actor's
   * effective name, this ask's per-actor sequence, a SITE-INDEPENDENT content
   * hash of the prompt, and the canonical persona the actor ran under. The
   * amend cache matches on (name + persona) and consumes content hashes 1:1,
   * so a renumbered amend script still hits. Old rows without these fields
   * replay through the site-keyed pool exactly as before.
   */
  actorName?: string;
  actorSeq?: number;
  contentHash?: string;
  personaJson?: string;
}

/** A facade-script run row: script identity, args and lineage. */
export interface DwfRunRow {
  runId: string;
  scriptHash: string;
  scriptPath?: string;
  argsJson?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'parked';
  parentRunId?: string;
  /**
   * OS pid of the runner process that owns/owned this run — orphan detection
   * and stale-`running` takeover (GOAL.md §1.5). Written when the row enters
   * `status: 'running'`; the resume path probes it to distinguish a live host
   * (another host is executing: refuse, the error names the pid) from a
   * crashed one (emit `dwf_resume_takeover` and take over). `undefined` on
   * rows written before the column existed (legacy pre-pid journal rows —
   * also treated as crash takeover) and on rows that never started running.
   */
  runnerPid?: number;
  /** Output tokens spent at the last settlement — restored on resume (audit gap #4). */
  outputTokensSpent?: number;
  createdAt?: string;
  updatedAt?: string;  /**
   * The run's output-token ceiling (Issue #118): persisted at launch and
   * restored by every continuation door, so an answer/resume/amend continues
   * under the original cap instead of running unbounded. `undefined` = no
   * ceiling was set.
   */
  budgetTotal?: number;
  /**
   * Executed (live) ask count at the last settlement (Issue #63): persisted
   * alongside outputTokensSpent and restored by the same continuation doors,
   * so the agent() call cap and the size warning keep counting across a
   * resume instead of restarting from zero while the token spend continues.
   */
  executedAsks?: number;
}

/** Optional facade-journal surface a StateStore may implement. */
export interface DwfJournalStore {
  saveDwfNode(node: DwfNode): Promise<void>;
  getDwfNode(runId: string, siteId: string, ordinal: number): Promise<DwfNode | null>;
  getDwfNodes(runId: string): Promise<DwfNode[]>;
  saveDwfRun(row: DwfRunRow): Promise<void>;
  getDwfRun(runId: string): Promise<DwfRunRow | null>;
  /**
   * List facade run rows, newest first — the dwf counterpart of the builder
   * `listRuns` (telemetry hookup, gap-matrix D2). Optional: only journal
   * stores backing a `list` face need it.
   */
  listDwfRuns?(options?: { limit?: number; status?: string }): Promise<DwfRunRow[]>;
  /** Append one evidence entry (idempotent per `(runId, siteId, nodeOrdinal)`). */
  saveDwfEvidence?(row: DwfEvidenceRow): Promise<void>;
  /** All evidence entries of a run, in append (ordinal) order. */
  getDwfEvidence?(runId: string): Promise<EvidenceEntry[]>;
}

// ============================================================================
// 7. DAG Graph Contracts
// ============================================================================

export interface DAGNode {
  id: string;
  name: string;
  phaseId: string;
  phaseName: string;
  role: 'inspector' | 'worker' | 'reviewer' | 'gate' | 'coordinator' | string;
  type: StepType;
  status: StepStatus;
  dependsOn: string[];
  inputs?: Record<string, string>;
  outputs?: unknown;
  durationMs?: number;
  errorMessage?: string;
}

export interface DAGEdge {
  fromNodeId: string;
  toNodeId: string;
  label?: string;
}

export interface DAGGraph {
  workflowName: string;
  runId: string;
  status: WorkflowStatus;
  phases: Array<{ id: string; name: string; order: number }>;
  nodes: DAGNode[];
  edges: DAGEdge[];
  activeSubagents: number;
  totalPhases: number;
  currentPhaseIndex: number;
  startedAt: string;
  completedAt?: string;
}

export interface LayoutDimensions {
  phaseWidth: number;
  phaseGap: number;
  nodeWidth: number;
  nodeHeight: number;
  nodeGap: number;
  headerHeight: number;
  padding: number;
}

export interface PositionedNode extends DAGNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedEdge extends DAGEdge {
  x1: number;
  y1: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x2: number;
  y2: number;
  status: string;
}

export interface DAGVisualizer {
  renderHTML(graph: DAGGraph, lang?: 'en' | 'zh'): string;
  renderMermaid(graph: DAGGraph, direction?: 'LR' | 'TD'): string;
  renderASCII(graph: DAGGraph): string;
}

// ============================================================================
// 8. MCP Integration Types
// ============================================================================

export interface MCPServerConfig {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Working directory for a stdio server (default: inherit the engine's). */
  cwd?: string;
}

/** Per-call options for `ctx.mcp.callTool` and `MCPManager.callTool`. */
export interface McpCallOptions {
  /**
   * Return a tool result whose `isError` is true instead of throwing
   * `McpToolError` (code `MCP_TOOL_FAILED`). Default: false.
   */
  allowToolError?: boolean;
}

export interface MCPManager {
  connectServer(serverName: string, config: MCPServerConfig): Promise<void>;
  listTools(serverName: string): Promise<Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>>;
  callTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<unknown>;
  disconnectAll(): Promise<void>;
}
