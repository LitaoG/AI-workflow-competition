import { z } from 'zod';

// Core Workflow
export { Workflow, defineWorkflow } from './core/workflow.js';
export { WorkflowExecutionContext } from './core/context.js';
export {
  agentStep,
  gateStep,
  probeStep,
  fanOutStep,
  actionStep,
} from './core/step.js';
export {
  WorkflowError,
  StepExecutionError,
  GateFailureError,
  SchemaValidationError,
  ProviderError,
  CircularDependencyError,
  MissingDependencyError,
  WorkflowAbortedError,
  RunNotFoundError,
  McpServerNotConfiguredError,
  McpConfigError,
  McpConnectError,
  McpClientClosedError,
  McpToolError,
  withRetry,
} from './core/error.js';

// Agent RPC
export { agent } from './agent/rpc.js';
export { extractJson, repairJsonString, formatZodErrors } from './agent/schema.js';
export { providerRegistry } from './agent/provider.js';
export { MockProvider } from './agent/mock-provider.js';
export { BedrockProvider, configureBedrockFromEnv } from './agent/bedrock-provider.js';
export { configureHttpProvidersFromEnv, createDefaultProviders } from './agent/http-providers.js';
export { AgentProviderError, asContract, asLlmProvider, normalizeStreamChunk, redactServerText } from './agent/provider-contract.js';
export type {
  ChatOptions,
  ChatResult,
  ProviderContract,
  ProviderErrorDetails,
  StreamChunk,
  StructuredOutputSpec,
} from './agent/provider-contract.js';
export { AnthropicProvider, configureAnthropicFromEnv } from './agent/anthropic-provider.js';
export { OpenAiProvider, configureOpenAiFromEnv } from './agent/openai-provider.js';

// Prober
export {
  probe,
  probeSystem,
  probeGit,
  probeToolchain,
  sanitizeEnv,
  computeFingerprint,
} from './prober/index.js';

// State Persistence & Replay
export { SQLiteStateStore } from './state/sqlite-store.js';
export { EventLogWriter, EventLogReader } from './state/event-log.js';
export { ReplayEngine } from './state/replay.js';

// DAG Visualizer & Kanban
export { DAGVisualizerCoordinator } from './dag/visualizer.js';
export { HTMLRenderer } from './dag/html-renderer.js';
export { MermaidRenderer } from './dag/mermaid-renderer.js';
export { ASCIIRenderer } from './dag/ascii-renderer.js';

// MCP
export { MCPClientManager } from './mcp/client.js';
export { BuiltinWorkflowMCPServer } from './mcp/server.js';

// Re-export Zod for workflow authoring convenience
export { z };

// Types
export * from './types.js';
