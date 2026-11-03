---
inclusion: always
name: workflow-engineering-guidelines
description: Core architectural principles for AI-Workflow dynamic execution
---

# Engineering Guidelines: Code, Not Conversation

1. **Code, Not Conversation**: Never replace deterministic workflow logic with multi-turn chat loops. Workflows must be expressed as executable TypeScript DAGs with standard control flow.
2. **Typed Agent RPCs**: Every agent interaction must use typed RPC (`agent(name).ask<T>(prompt, schema)`). Plain unvalidated string passing is strictly forbidden.
3. **Deterministic Probing**: Probing of git status, toolchain versions, system metrics, and sanitized environment variables must precede any LLM generation.
4. **Durable Persistence**: All workflow steps must emit checkpoints and append-only event logs to support fault-tolerant replay without token re-expenditure.
5. **Deterministic Gate Verification**: Steps requiring verification must use deterministic shell gates executing real test suites and health checks.
