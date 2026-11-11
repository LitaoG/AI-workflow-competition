import {
  ExecutionContext,
  ContextSnapshot,
  ProberResult,
  StateStore,
  GateResult,
  AgentRPCClient,
  ProberOptions,
  McpCallOptions,
} from '../types.js';
import { agent as createAgentClient } from '../agent/rpc.js';
import { probe as runProber } from '../prober/index.js';
import { MCPClientManager, type MCPClientManagerOptions } from '../mcp/client.js';
import { McpClientClosedError, WorkflowAbortedError } from './error.js';
import { parseGateCommand, runGateCommandWithTransientRetry } from './step.js';
import { redactText } from '../dwf/redact.js';

export class WorkflowExecutionContext implements ExecutionContext {
  readonly workflowId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly isMock: boolean;
  readonly lang: 'en' | 'zh';
  readonly stateStore?: StateStore;

  private variables: Map<string, unknown> = new Map();
  private stepOutputs: Map<string, unknown> = new Map();
  private probeSnapshot?: ProberResult;
  private currentStepId?: string;
  /**
   * Run-scoped MCP pool. Created eagerly (no I/O) so child contexts, built with
   * `Object.create(this)`, share it through the prototype instead of shadowing it.
   */
  private readonly mcpManager: MCPClientManager;
  /** Set by {@link disposeMcp}; later `ctx.mcp` calls throw instead of reconnecting. */
  private mcpDisposed = false;
  /**
   * Cancellation for the step this context runs. `Workflow.run()` aborts it when
   * a sibling step in the same parallel batch fails; the step then starts no new
   * model, MCP or gate call (Issue #120). Undefined on the run's root context.
   */
  readonly signal?: AbortSignal;

  constructor(options: {
    workflowId: string;
    runId?: string;
    isMock?: boolean;
    lang?: 'en' | 'zh';
    stateStore?: StateStore;
    initialVariables?: Record<string, unknown>;
    /** Explicit MCP servers; when given, they are the only MCP config source. */
    mcpServers?: MCPClientManagerOptions['servers'];
    /** Trusted `.mcp.json` path (default: `AI_WORKFLOW_MCP_CONFIG`); the working directory is never searched. */
    mcpConfigPath?: string;
    /** MCP handshake timeout in ms (default: `AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS`, else 20000). */
    mcpConnectTimeoutMs?: number;
  }) {
    this.workflowId = options.workflowId;
    this.runId = options.runId ?? `run-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.startedAt = new Date().toISOString();
    this.isMock = options.isMock ?? false;
    this.lang = options.lang ?? 'en';
    this.stateStore = options.stateStore;
    this.mcpManager = new MCPClientManager(this.isMock, {
      servers: options.mcpServers,
      configPath: options.mcpConfigPath,
      connectTimeoutMs: options.mcpConnectTimeoutMs,
    });

    if (options.initialVariables) {
      for (const [k, v] of Object.entries(options.initialVariables)) {
        this.variables.set(k, v);
      }
    }
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    if (this.variables.has(key)) {
      return this.variables.get(key) as T;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Variable "${key}" not found in ExecutionContext`);
  }

  set<T = unknown>(key: string, value: T): void {
    this.variables.set(key, value);
  }

  has(key: string): boolean {
    return this.variables.has(key);
  }

  getOutput<T = unknown>(stepId: string): T | undefined {
    return this.stepOutputs.get(stepId) as T | undefined;
  }

  setOutput<T = unknown>(stepId: string, output: T): void {
    this.stepOutputs.set(stepId, output);
  }

  getAllOutputs(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.stepOutputs.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  getProbeSnapshot(): ProberResult | undefined {
    return this.probeSnapshot;
  }

  setProbeSnapshot(probe: ProberResult): void {
    this.probeSnapshot = probe;
  }

  async recordArtifact(name: string, content: string, type = 'deliverable', stepId?: string): Promise<void> {
    if (this.stateStore && typeof this.stateStore.saveArtifact === 'function') {
      await this.stateStore.saveArtifact({
        artifactId: `art-${this.runId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        runId: this.runId,
        stepId: stepId ?? this.currentStepId ?? 'general',
        name,
        artifactType: type,
        content,
        createdAt: new Date().toISOString(),
      });
    }
  }

  agent(roleOrName: string): AgentRPCClient {
    return createAgentClient(roleOrName, { signal: this.signal });
  }

  async gate(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<GateResult> {
    // A cancelled step starts no new command; one already running finishes.
    if (this.signal?.aborted) throw this.cancelledError();
    const startTime = Date.now();
    const timeout = options?.timeoutMs ?? 30000;
    const done = (passed: boolean, exitCode: number, stdout: string, stderr: string): GateResult => ({
      passed,
      success: passed,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - startTime,
    });
    // Supervised, shell-less spawn (Issue #151) — the world.run security
    // boundary: allowlist-only env, whole-tree timeout kill, irreversible
    // output redaction. A gate failure is a RESULT here (the step-level
    // gateStep maps it to GateFailureError); this method only reports.
    let argv: string[];
    try {
      argv = parseGateCommand(command);
    } catch (err: any) {
      return done(false, 1, '', redactText(String(err?.message ?? err)));
    }
    let result: Awaited<ReturnType<typeof runGateCommandWithTransientRetry>>;
    try {
      // Issue #233: transient spawn failures (never-started command, no side
      // effects) get a bounded retry inside the wrapper — infrastructure noise
      // must not surface as a false gate outcome under parallel load.
      result = await runGateCommandWithTransientRetry(argv, options?.cwd ?? process.cwd(), timeout);
    } catch (err: any) {
      return done(false, 1, '', redactText(String(err?.message ?? err)));
    }
    if (result.timedOut) {
      return done(false, 1, redactText(result.stdout), redactText(`gate "${command}" timed out after ${timeout}ms (process tree killed)`));
    }
    if (result.exitCode === -1 && result.stderr.startsWith('spawn ')) {
      return done(false, 1, '', redactText(result.stderr));
    }
    if (result.exitCode !== 0) {
      return done(false, result.exitCode, redactText(result.stdout), redactText(result.stderr));
    }
    return done(true, 0, redactText(result.stdout), redactText(result.stderr));
  }

  get probe(): any {
    const fn: any = async (options?: ProberOptions) => {
      const res = await runProber(options);
      this.setProbeSnapshot(res);
      return res;
    };
    const defaultGit = {
      isGitRepo: false,
      branch: 'main',
      commit: '0000000000000000000000000000000000000000',
      commitHash: '0000000000000000000000000000000000000000',
      commitShort: '0000000',
      isDirty: false,
      dirtyFilesCount: 0,
    };
    const defaultSnapshot = {
      timestamp: new Date().toISOString(),
      system: { platform: process.platform, arch: process.arch, cpus: 1, cpuModel: 'generic', totalMemMb: 1024, freeMemMb: 512, uptimeSeconds: 100, hostname: 'localhost', nodeVersion: process.version },
      git: defaultGit,
      toolchain: { node: process.version, npm: '10.0.0', git: '2.40.0' },
      env: {},
    };
    const snapshot = this.probeSnapshot ?? defaultSnapshot;
    Object.assign(fn, snapshot);
    if (snapshot.git && !(snapshot.git as any).commitHash) {
      (snapshot.git as any).commitHash = snapshot.git.commit;
    }
    return fn;
  }

  get mcp(): any {
    return {
      callTool: async (server: string, tool: string, args?: Record<string, unknown>, options?: McpCallOptions) => {
        if (this.mcpDisposed) throw new McpClientClosedError(server);
        // A cancelled step starts no new tool call. One already in flight is not
        // interrupted: a write tool cut off half-way leaves half its side effects.
        if (this.signal?.aborted) throw this.cancelledError();
        return this.mcpManager.callTool(server, tool, args ?? {}, options);
      },
    };
  }

  /**
   * Close every MCP connection this run opened, so each stdio server exits.
   * `Workflow.run()` calls it once on the root context when the run ends; a
   * later `ctx.mcp` call throws `McpClientClosedError` instead of spawning a
   * server nobody would close.
   */
  async disposeMcp(): Promise<void> {
    this.mcpDisposed = true;
    await this.mcpManager.disconnectAll();
  }

  log(message: string): void {
    if (process.env.DEBUG || process.env.VERBOSE) {
      console.log(`[ExecutionContext ${this.runId}] ${message}`);
    }
  }

  snapshot(): ContextSnapshot {
    return {
      workflowId: this.workflowId,
      runId: this.runId,
      startedAt: this.startedAt,
      variables: Object.fromEntries(this.variables.entries()),
      stepOutputs: Object.fromEntries(this.stepOutputs.entries()),
      probeSnapshot: this.probeSnapshot,
    };
  }

  restore(snapshot: ContextSnapshot): void {
    this.variables.clear();
    for (const [k, v] of Object.entries(snapshot.variables)) {
      this.variables.set(k, v);
    }
    this.stepOutputs.clear();
    for (const [k, v] of Object.entries(snapshot.stepOutputs)) {
      this.stepOutputs.set(k, v);
    }
    this.probeSnapshot = snapshot.probeSnapshot;
  }

  createChildContext(stepId: string, signal?: AbortSignal): ExecutionContext {
    const child = Object.create(this);
    child.currentStepId = stepId;
    if (signal) child.signal = signal;
    return child;
  }

  /** The error a cancelled step throws instead of starting new work. */
  private cancelledError(): WorkflowAbortedError {
    const reason = this.signal?.reason;
    // The abort reason may now be the sibling-failure WorkflowAbortedError
    // itself (Issue #131) — carry its message instead of dropping it.
    const detail =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : undefined;
    return new WorkflowAbortedError(
      detail ?? `step "${this.currentStepId ?? 'unknown'}" was cancelled`
    );
  }
}
