---
inclusion: always
name: workflow-conventions
description: Architectural standards and coding conventions for dynamic workflows
---

# ZCode Dynamic Workflow Conventions

1. **Workflow Structure**: Workflows are defined in modular TypeScript files exporting a `Workflow` instance or using `defineWorkflow(...)`.
2. **Step Semantics**: Steps define `id`, `name`, `phaseId`, `role`, and optional `dependsOn` arrays.
3. **Execution Context**: Steps receive `ctx: ExecutionContext` and access upstream outputs via `ctx.getOutput(stepId)`.
4. **Multi-Agent Topologies**:
   - Single agent: Dedicated individual node
   - Parallel fan-out: Concurrent array processing via `Promise.all`
   - Paired agents: Paired fixer and reviewer loop with bounded retries
5. **Replay Invariant**: All steps must be idempotent or side-effect isolated to guarantee repeatable replay.
