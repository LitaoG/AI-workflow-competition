# Specification: AI-Workflow Dynamic Slash-Command Engine

**Status**: Standard | **Category**: Skeleton Crew | **Version**: 1.0.0

## 1. Operational Semantics
AI-Workflow executes dynamic workflows expressed as TypeScript code rather than conversational loops ("Code, not conversation"). The engine coordinates multi-agent DAGs, deterministic environment probing, durable dual-layer persistence, and real-time visual progress rendering.

## 2. State Machine Transitions
A workflow execution transitions through six discrete states:
1. `INITIALIZING`: Validates workflow definition, resolves dependencies using Kahn's algorithm, initializes execution context.
2. `PROBING`: Executes deterministic environment probing (system, git, toolchains, sanitized env) and computes a SHA-256 fingerprint.
3. `SCHEDULED`: Computes topological execution waves and schedules parallel or serial step execution.
4. `EXECUTING_STEP`: Dispatches typed agent RPCs, action steps, or fan-out pools.
5. `VALIDATING_GATE`: Executes deterministic shell script gates; halts or branches on failure.
6. `COMPLETED` / `FAILED` / `REPLAYING`: Finalizes run status, flushes `events.jsonl`, saves terminal SQLite snapshot.

## 3. Typed Agent RPC Protocol
Agents are invoked via:
```typescript
agent(name: string).ask<T>(prompt: string, schema: z.ZodType<T>, options?: AgentCallOptions): Promise<T>
```
- Runtime validation: Responses are parsed against the Zod schema.
- Automated repair loop: On JSON malformation or validation failure, errors are formatted into actionable LLM repair prompts up to `maxRetries` (default: 3).
- Non-negotiable contract: Zero unvalidated string passing between agent nodes.

## 4. Durable Replay & Persistence
Dual-layer persistence guarantees crash resilience:
- **Event Journal** (`events.jsonl`): Append-only immutable log with strictly increasing sequence numbers.
- **State Store** (`runs.db`): SQLite database storing indexed step checkpoints, duration, token usage, and status.
- **Prefix Replay**: Re-running an existing run reuses cached outputs for completed steps with zero LLM token re-expenditure.
