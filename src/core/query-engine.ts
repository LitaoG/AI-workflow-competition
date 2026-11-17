/**
 * QueryEngine (Issue #102): the single entry point that owns one
 * engine's dependencies (main model, tools, permission gate, compaction
 * pipeline, snapshot hook) and drives queryLoop() for a goal.
 *
 * Capability-absorption disclosure (Issue #123): like the rest of the ReAct
 * subsystem (see src/core/agent-loop.ts), this engine is a demo asset —
 * production asks do NOT pass through it (they run via src/agent/rpc.ts and
 * src/dwf/ask-executor.ts). Consumed only by tests/unit/core/*.
 *
 * Model routing (Thinking vs Flash) and the Plan / Build / YOLO permission
 * modes are (Issue #151): the gate resolves through
 * permissions/permission-manager.ts (`permissionMode`, default 'yolo' — the
 * pre-Phase-6 allow-all posture), and provider routing layers the model
 * router (src/agent/model-router.ts) over the caller's explicit choices.
 */
import type { ProviderContract } from '../agent/provider-contract.js';
import {
  EngineConfigError,
  queryLoop,
  type EngineEvent,
  type LoopEngine,
  type LoopOptions,
  type LoopResult,
  type PermissionGate,
  type SessionContext,
  type ToolDefinition,
} from './agent-loop.js';
import { CompactionPipeline, type CompactionConfig } from './compaction/pipeline.js';
import type { SummarizerOptions } from './compaction/summarizer.js';
import { createPermissionGate } from './permissions/permission-manager.js';
import type { PermissionMode } from './permissions/modes.js';

export interface QueryEngineOptions {
  /** Main model. */
  provider: ProviderContract;
  /** Light model for the summarize tier; omit it to turn that tier off. */
  summaryProvider?: ProviderContract;
  summarizerOptions?: SummarizerOptions;
  tools?: readonly ToolDefinition[];
  /** Permission gate (default: the 'yolo' mode gate — allow every call). */
  permissions?: PermissionGate;
  /** Permission posture; ignored when an explicit `permissions` gate is given. */
  permissionMode?: PermissionMode;
  compaction: CompactionConfig;
  /** Base instruction placed before the tool protocol in the system prompt. */
  systemPrompt?: string;
  /** Persistence hook, called after every turn with tool calls and once at the end. */
  persistSnapshot?: (session: SessionContext) => Promise<void> | void;
}

export interface RunOptions extends LoopOptions {
  /** Receives every engine event as it happens. */
  onEvent?: (event: EngineEvent) => void;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are an autonomous engineering agent. Work toward the goal step by step, and use the tools when they help.';

/** System prompt = base instruction + the text tool protocol + the tool list. */
export function buildSystemPrompt(base: string | undefined, tools: readonly ToolDefinition[]): string {
  const lines = [
    base ?? DEFAULT_SYSTEM_PROMPT,
    '',
    'Tool protocol: to call tools, reply with ONLY one JSON object, for example {"tool_calls":[{"id":"call_1","name":"<tool name>","input":{}}]}.',
    'Each result comes back in a message that starts with [tool_result id=... name=... ok=...]. Any reply without that object is your final answer.',
  ];
  if (tools.length === 0) {
    lines.push('', 'No tools are available: answer directly.');
  } else {
    lines.push('', 'Tools:');
    for (const tool of tools) {
      const schema = tool.inputSchema !== undefined ? ` Input schema: ${JSON.stringify(tool.inputSchema)}` : '';
      lines.push(`- ${tool.name}: ${tool.description}${schema}`);
    }
  }
  return lines.join('\n');
}

export class QueryEngine implements LoopEngine {
  readonly provider: ProviderContract;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly permissions: PermissionGate;
  readonly compaction: CompactionPipeline;
  readonly systemPrompt: string;
  private readonly snapshotHook: ((session: SessionContext) => Promise<void> | void) | undefined;

  constructor(options: QueryEngineOptions) {
    const tools = new Map<string, ToolDefinition>();
    for (const tool of options.tools ?? []) {
      if (tools.has(tool.name)) {
        throw new EngineConfigError(`duplicate tool name "${tool.name}"`, { field: 'tools', name: tool.name });
      }
      tools.set(tool.name, tool);
    }
    this.provider = options.provider;
    this.tools = tools;
    this.permissions = options.permissions ?? createPermissionGate(options.permissionMode ?? 'yolo');
    this.compaction = new CompactionPipeline(options.compaction, options.summaryProvider, options.summarizerOptions);
    this.systemPrompt = buildSystemPrompt(options.systemPrompt, [...tools.values()]);
    this.snapshotHook = options.persistSnapshot;
  }

  /** A fresh session: the system prompt and the goal, at turn 0. */
  createSession(goal: string): SessionContext {
    return {
      goal,
      turn: 0,
      messages: [
        { role: 'system', kind: 'system', turn: 0, content: this.systemPrompt },
        { role: 'user', kind: 'goal', turn: 0, content: goal },
      ],
    };
  }

  persistSnapshot(session: SessionContext): Promise<void> | void {
    return this.snapshotHook?.(session);
  }

  /** The event stream of one goal; the generator's return value is the LoopResult. */
  query(goal: string, options: LoopOptions = {}): AsyncGenerator<EngineEvent, LoopResult, void> {
    return queryLoop(this, this.createSession(goal), options);
  }

  /** Run one goal to the end and return its result; events go to `onEvent`. */
  async run(goal: string, options: RunOptions = {}): Promise<LoopResult> {
    const { onEvent, ...loopOptions } = options;
    const events = this.query(goal, loopOptions);
    while (true) {
      const next = await events.next();
      if (next.done) return next.value;
      onEvent?.(next.value);
    }
  }
}
