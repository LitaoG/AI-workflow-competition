# AI-Workflow Developer Guide

> **A Practical Handbook for Authoring Typed, Deterministic, and Durable Dynamic Workflows**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew Category)*

---

## 1. Introduction

Welcome to the **AI-Workflow Developer Guide**. This handbook provides step-by-step instructions for authoring custom dynamic workflows using AI-Workflow's extensible TypeScript engine.

By following this guide, you will learn how to:
- Define multi-phase workflows with declarative dependencies.
- Invoke typed agent RPCs with Zod runtime schemas and auto-repair loops.
- Gather deterministic environment telemetry using the prober.
- Intercept and protect workflows using cross-platform shell script gates.
- Scaffold new projects and test workflows deterministically in offline mock mode.

---

## 2. Quick Scaffolding: Creating Your First Project

The fastest way to start is with the `workflow init` command:

```bash
# Scaffold a basic workflow template
node bin/workflow.js init basic my-first-workflow

# Or scaffold a production-grade multi-agent template with paired reviewers & gates
node bin/workflow.js init multi-agent my-agent-pipeline

cd my-agent-pipeline
npm install
npm test
```

### Directory Structure of a Scaffolded Project
```
my-agent-pipeline/
├── package.json
├── tsconfig.json
├── README.md
├── workflow.ts             # Primary workflow definition
└── gates/
    ├── test-gate.cmd       # Windows deterministic shell gate
    └── test-gate.sh        # POSIX deterministic shell gate
```

---

## 3. Authoring a Dynamic Workflow

Workflows can be authored using either the declarative `defineWorkflow` helper or the fluent `new Workflow()` class API.

### 3.1 Declarative Workflow Definition (`defineWorkflow`)
Below is a complete, production-ready example illustrating environment probing, typed agent RPCs, and deterministic shell gates:

```typescript
import { z } from 'zod';
import { defineWorkflow } from 'ai-workflow';

// 1. Define Zod Schemas for Runtime Validation
const CodeAuditSchema = z.object({
  issuesFound: z.number(),
  vulnerabilities: z.array(z.string()),
  recommendedAction: z.enum(['APPROVE', 'REFACTOR', 'BLOCK']),
  patchContent: z.string().optional(),
});
type CodeAudit = z.infer<typeof CodeAuditSchema>;

// 2. Define the Workflow
export default defineWorkflow({
  name: 'security-audit-and-patch',
  description: 'Probes repo, performs typed security audit, and verifies patch through shell gate',
  phases: [
    { id: 'discovery', name: 'Environment Probing & Discovery' },
    { id: 'audit', name: 'Multi-Agent Security Audit' },
    { id: 'verification', name: 'Compiler & Test Verification Gate' },
  ],
  steps: [
    // Step 1: Deterministic Probing
    {
      id: 'step-1-probe',
      name: 'Probe Repository & Git State',
      phaseId: 'discovery',
      role: 'inspector',
      execute: async (ctx) => {
        const probeResult = await ctx.probe();
        ctx.set('gitCommit', probeResult.git.commitShort);
        return { isDirty: probeResult.git.isDirty, branch: probeResult.git.branch };
      },
    },

    // Step 2: Typed Agent RPC
    {
      id: 'step-2-auditor',
      name: 'Security Auditor Agent',
      phaseId: 'audit',
      role: 'worker',
      dependsOn: ['step-1-probe'],
      execute: async (ctx) => {
        const branch = ctx.get('branch', 'main');
        
        // Typed Agent RPC with auto-repair loop
        const audit = await ctx.agent('SecurityAuditor').ask<CodeAudit>(
          `Audit current repository on branch "${branch}". Identify potential CVEs or SQL injection risks.`,
          CodeAuditSchema,
          {
            temperature: 0.1,
            maxRetries: 3,
            mockResponse: {
              issuesFound: 1,
              vulnerabilities: ['CWE-89: SQL Injection in auth router'],
              recommendedAction: 'REFACTOR',
              patchContent: 'const query = db.prepare("SELECT * FROM users WHERE id = ?");',
            },
          }
        );

        ctx.set('auditResult', audit);
        return audit;
      },
    },

    // Step 3: Deterministic Shell Script Gate
    {
      id: 'step-3-gate',
      name: 'Verification Test Gate',
      phaseId: 'verification',
      role: 'gate',
      dependsOn: ['step-2-auditor'],
      execute: async (ctx) => {
        const audit = ctx.get<CodeAudit>('auditResult');
        if (audit.recommendedAction === 'BLOCK') {
          throw new Error('Audit indicated critical blocking vulnerabilities.');
        }

        // Execute local shell gate
        const gateResult = await ctx.gate('npm test');
        if (!gateResult.passed) {
          throw new Error(`Gate failed with exit code ${gateResult.exitCode}: ${gateResult.stderr}`);
        }

        await ctx.recordArtifact(
          'AUDIT_REPORT.md',
          `# Security Audit Report\nAction: ${audit.recommendedAction}\nIssues: ${audit.issuesFound}`
        );

        return { verified: true, durationMs: gateResult.durationMs };
      },
    },
  ],
});
```

---

## 4. Typed Agent RPCs: Best Practices

### 4.1 Strict Schema Design
Always design Zod schemas with explicit field constraints:
```typescript
const TriageSchema = z.object({
  severity: z.enum(['P1', 'P2', 'P3', 'P4']),
  rootCause: z.string().min(5),
  confidenceScore: z.number().min(0).max(1),
  affectedServices: z.array(z.string()).nonempty(),
  recommendedAction: z.string(),
});
```

### 4.2 Handling Auto-Repair Loops
When the model returns malformed JSON or omits required fields, the engine automatically injects the Zod errors back into the conversation for up to `maxRetries` iterations. To ensure deterministic testing and continuous integration:
```typescript
const result = await ctx.agent('TriageAgent').ask(prompt, TriageSchema, {
  mockResponse: ctx.isMock ? defaultMockTriage : undefined,
  maxRetries: 3,
});
```

---

## 5. Authoring Deterministic Shell Gates

Gates act as deterministic physical laws interspersed among probabilistic AI reasoning steps.

### 5.1 Exit Code Semantics
- **Exit Code `0`**: Gate Passed. Downstream dependent steps are allowed to execute.
- **Non-zero Exit Code**: Gate Failed. The step halts with `GateFailureError`, triggering rollbacks if defined.

### 5.2 Writing Cross-Platform Gate Scripts
Place platform-specific scripts in a `gates/` folder:
- Windows: `gates/verify-build.cmd`
- POSIX: `gates/verify-build.sh`

```batch
@echo off
REM gates/verify-build.cmd
echo [GATE] Running compilation and test baseline...
call npx tsc --noEmit
if %errorlevel% neq 0 (
  echo [GATE-ERROR] TypeScript compilation failed!
  exit /b 1
)
call npm test
if %errorlevel% neq 0 (
  echo [GATE-ERROR] Unit tests failed!
  exit /b 1
)
echo [GATE-SUCCESS] All compiler gates passed.
exit /b 0
```

---

## 6. Durable State & Zero-Token Replay

Every step's input and output are automatically persisted into `checkpoints.db` (SQLite) and `events.jsonl`.

### 6.1 Resuming from Failed Steps
If step 4 of 6 fails due to a network hiccup or temporary service degradation, fix the root cause and resume with:
```bash
node bin/workflow.js run workflow.ts --resume-from-failed <runId>
```
The engine skips steps 1-3 in **0 milliseconds** without re-invoking the LLM, preserving previous inputs and outputs.

---

## 7. Testing Your Dynamic Workflows

Unit and integration tests can be written using Node.js 22's built-in test runner:

```typescript
// tests/my-workflow.test.ts
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import myWorkflow from '../workflow.js';

test('Workflow executes end-to-end in offline mock mode', async () => {
  const result = await myWorkflow.run({
    mockMode: true,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.failedSteps.length, 0);
  assert.ok(result.durationMs < 2000, 'Execution should complete in under 2 seconds');
});
```

Execute tests via:
```bash
node --experimental-strip-types --test tests/my-workflow.test.ts
```
---

## 8. Repository Development Gates

These gates govern changes to THIS repository (the engine itself), not to
scaffolded projects.

**Build before test.** `npm test` executes the compiled artifacts under
`dist/` — running it without a fresh `npm run build` tests stale code.
`bin/workflow.js` also loads `dist/` first, so the CLI and the sources can
drift apart unless you rebuild. When in doubt: `npm run build` first.

| Script | What it runs | Notes |
| --- | --- | --- |
| `npm run build` | `tsc` (strict) | emits `dist/`; also runs `postinstall` hooks on a fresh install (self-link + fixture SDK stubs) |
| `npm test` | unit + integration suites via `node --test` on `dist/tests/` | must be preceded by a build |
| `npm run test:unit` / `test:integration` | the individual layers | |
| `npm run test:e2e` | the tiered E2E runner (`tests/e2e/runner.ts`) | runs TypeScript directly via type stripping |
| `npm run test:adversarial` | the Tier-5 adversarial stress suites (`tests/adversarial/`) | includes the demo stress scripts |
| `npm run test:pbt` | fast-check property tests (`.kiro/pbt/`) | |
| `npm run gate` | build → test → e2e → adversarial → pbt | the one-command merge gate: exit code 0 = everything green |
| `npm run coverage` | `c8` over `npm test` | HTML report in `coverage/` (git-ignored); key modules — `src/dwf/compile|engine|runner`, `src/domain/**`, `src/process-supervision` — carry a per-file 84% line floor (the measured baseline; engine.ts is the current gap at ~84% — ratchet it upward as coverage improves, never lower it) |

**Runtime data.** `.workflow/` holds live run journals (`dwf.sqlite`,
`runs/<runId>/events.jsonl`, per-run checkpoints). It is git-ignored runtime
state: never commit it, never delete a run you may still want to resume —
`workflow run-script --resume <runId>` needs the journal intact. Test
by-products that DO land in tracked fixtures (`tests/unit/fixtures/`) must be
restored after a test run: `git restore tests/unit/fixtures/`.
