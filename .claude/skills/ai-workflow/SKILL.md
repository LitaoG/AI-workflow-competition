---
name: ai-workflow
description: >-
  Author and run deterministic dynamic-workflow scripts with the AI-Workflow
  engine: compile-checked facade scripts (agent().ask<T>, phases, fan-outs,
  shell gates, artifacts) executed in a sandbox with a journal that replays
  completed work at zero provider calls. Use for multi-step tasks that need
  real orchestration — coverage loops, parallel reviews with verification,
  migration pipelines, anything where "the plan" must live in code, not in
  one agent's context window. Not for single delegated lookups.
---

# AI-Workflow skill loader

The canonical, maintained instructions for this skill live in this repository at:

`skills/ai-workflow/SKILL.md`

Read that file before authoring or running a facade workflow. It is the single
source of truth for the authoring loop (`check` → `run` → `resume`), the facade
API surface, and the examples. This wrapper exists so Claude Code can discover
the skill from `.claude/skills/ai-workflow/` without duplicating the body.