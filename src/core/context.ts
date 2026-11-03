import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ExecutionContext,
  ContextSnapshot,
  ProberResult,
  StateStore,
  GateResult,
  AgentRPCClient,
  ProberOptions,
} from '../types.js';
import { agent as createAgentClient } from '../agent/rpc.js';
import { probe as runProber } from '../prober/index.js';
import { MCPClientManager } from '../mcp/client.js';

const execAsync = promisify(exec);

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

  constructor(options: {
    workflowId: string;
    runId?: string;
    isMock?: boolean;
    lang?: 'en' | 'zh';
    stateStore?: StateStore;
    initialVariables?: Record<string, unknown>;
  }) {
    this.workflowId = options.workflowId;
    this.runId = options.runId ?? `run-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.startedAt = new Date().toISOString();
    this.isMock = options.isMock ?? false;
    this.lang = options.lang ?? 'en';
    this.stateStore = options.stateStore;

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
    return createAgentClient(roleOrName);
  }

  async gate(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<GateResult> {
    const startTime = Date.now();
    const timeout = options?.timeoutMs ?? 30000;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options?.cwd ?? process.cwd(),
        timeout,
        windowsHide: true,
      });
      const durationMs = Date.now() - startTime;
      return {
        passed: true,
        success: true,
        exitCode: 0,
        stdout,
        stderr,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? err.message ?? '';
      return {
        passed: false,
        success: false,
        exitCode,
        stdout,
        stderr,
        durationMs,
      };
    }
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
      callTool: async (server: string, tool: string, args?: Record<string, unknown>) => {
        const client = new MCPClientManager(this.isMock);
        return client.callTool(server, tool, args ?? {});
      },
    };
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

  createChildContext(stepId: string): ExecutionContext {
    const child = Object.create(this);
    child.currentStepId = stepId;
    return child;
  }
}
