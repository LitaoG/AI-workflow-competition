/**
 * Standard test workflows, schemas, and telemetry fixtures for opaque-box E2E testing.
 */

export const SAMPLE_LINEAR_WORKFLOW = `
export default {
  name: "simple-linear-workflow",
  version: "1.0.0",
  description: "A simple linear 2-step workflow for testing",
  phases: ["Phase 1: Inspection", "Phase 2: Execution"],
  steps: [
    {
      id: "step-1-inspect",
      name: "Inspect Environment",
      phase: "Phase 1: Inspection",
      role: "inspector",
      execute: async (ctx) => {
        ctx.log("Inspecting environment");
        return { inspected: true, commit: ctx.probe.git.commitHash };
      }
    },
    {
      id: "step-2-execute",
      name: "Execute Operation",
      phase: "Phase 2: Execution",
      role: "worker",
      dependencies: ["step-1-inspect"],
      execute: async (ctx) => {
        ctx.log("Executing operation");
        return { success: true, count: 42 };
      }
    }
  ]
};
`;

export const SAMPLE_MULTI_AGENT_WORKFLOW = `
export default {
  name: "multi-agent-workflow",
  version: "1.0.0",
  description: "Workflow with inspector, parallel workers, and reviewer",
  phases: ["Triage", "Remediation", "Review", "Gate"],
  steps: [
    {
      id: "step-triage",
      name: "Triage Alert",
      phase: "Triage",
      role: "inspector",
      execute: async (ctx) => {
        const triage = await ctx.agent("inspector").ask(
          "Analyze incoming alert telemetry",
          {
            schema: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["P1", "P2", "P3"] },
                suspect: { type: "string" },
                rootCause: { type: "string" }
              },
              required: ["severity", "suspect", "rootCause"]
            },
            mockResponse: {
              severity: "P1",
              suspect: "db_connection_pool",
              rootCause: "Database max connection pool exhausted"
            }
          }
        );
        return triage;
      }
    },
    {
      id: "step-remediation",
      name: "Synthesize Remediation",
      phase: "Remediation",
      role: "worker",
      dependencies: ["step-triage"],
      execute: async (ctx) => {
        const plan = await ctx.agent("worker").ask(
          "Generate minimal risk remediation plan",
          {
            schema: {
              type: "object",
              properties: {
                commands: { type: "array", items: { type: "string" } },
                riskLevel: { type: "string" }
              },
              required: ["commands", "riskLevel"]
            },
            mockResponse: {
              commands: ["pool_size --expand 50", "restart_workers --graceful"],
              riskLevel: "low"
            }
          }
        );
        return plan;
      }
    },
    {
      id: "step-review",
      name: "Safety Review",
      phase: "Review",
      role: "reviewer",
      dependencies: ["step-remediation"],
      execute: async (ctx) => {
        const review = await ctx.agent("reviewer").ask(
          "Verify remediation safety and blast radius",
          {
            schema: {
              type: "object",
              properties: {
                approved: { type: "boolean" },
                auditNotes: { type: "string" }
              },
              required: ["approved", "auditNotes"]
            },
            mockResponse: {
              approved: true,
              auditNotes: "All commands meet least-privilege safety steering guidelines"
            }
          }
        );
        return review;
      }
    },
    {
      id: "step-gate",
      name: "Verify Healthz Gate",
      phase: "Gate",
      role: "gate",
      dependencies: ["step-review"],
      execute: async (ctx) => {
        const result = await ctx.gate("node -e \\"console.log('healthz-ok')\\"");
        return { gatePassed: result.passed, stdout: result.stdout };
      }
    }
  ]
};
`;

export const SAMPLE_FAILING_WORKFLOW = `
export default {
  name: "failing-workflow",
  version: "1.0.0",
  description: "Workflow with an intentional failure step for testing resume",
  phases: ["Phase 1: Setup", "Phase 2: Error", "Phase 3: Finalize"],
  steps: [
    {
      id: "step-1-setup",
      name: "Setup Step",
      phase: "Phase 1: Setup",
      role: "worker",
      execute: async (ctx) => {
        return { setup: "complete" };
      }
    },
    {
      id: "step-2-fail",
      name: "Failing Step",
      phase: "Phase 2: Error",
      role: "worker",
      dependencies: ["step-1-setup"],
      execute: async (ctx) => {
        if (!process.env.REPAIR_STEP_2) {
          throw new Error("Simulated failure in step-2-fail");
        }
        return { fixed: true };
      }
    },
    {
      id: "step-3-finish",
      name: "Final Step",
      phase: "Phase 3: Finalize",
      role: "worker",
      dependencies: ["step-2-fail"],
      execute: async (ctx) => {
        return { finished: true };
      }
    }
  ]
};
`;

export const SAMPLE_DEMO1_INCIDENT_WORKFLOW = `
export default {
  name: "incident-triage-remediation",
  version: "1.0.0",
  description: "Autonomous DevOps Incident Triage and Automated Remediation",
  phases: ["Detection", "Triage", "Plan & Review", "Execution Gate", "Post-Mortem"],
  steps: [
    {
      id: "phase-1-detection",
      name: "Telemetry Probing & Anomaly Detection",
      phase: "Detection",
      role: "inspector",
      execute: async (ctx) => {
        return {
          telemetry: {
            httpErrorRate: "14.2%",
            cpuUsage: "89%",
            service: "checkout-api",
            recentCommits: ["a1b2c3d: update connection pool size to 10"]
          }
        };
      }
    },
    {
      id: "phase-2-triage",
      name: "Root Cause Classification",
      phase: "Triage",
      role: "inspector",
      dependencies: ["phase-1-detection"],
      execute: async (ctx) => {
        return {
          severity: "P1",
          domain: "database_resource_exhaustion",
          suspectedCommit: "a1b2c3d",
          rootCause: "Under-provisioned connection pool under high checkout concurrency"
        };
      }
    },
    {
      id: "phase-3-plan-review",
      name: "Remediation Plan & Safety Audit Pair",
      phase: "Plan & Review",
      role: "reviewer",
      dependencies: ["phase-2-triage"],
      execute: async (ctx) => {
        return {
          plan: {
            remediationCommand: "scale_db_pool --min 30 --max 150",
            rollbackCommand: "scale_db_pool --reset"
          },
          safetyAudit: {
            approved: true,
            destructiveRisk: "none",
            policyCompliance: "PASS"
          }
        };
      }
    },
    {
      id: "phase-4-exec-gate",
      name: "Deterministic Recovery Verification Gate",
      phase: "Execution Gate",
      role: "gate",
      dependencies: ["phase-3-plan-review"],
      execute: async (ctx) => {
        const gate = await ctx.gate("node -e \\"console.log('HTTP/1.1 200 OK - Healthz Pass')\\"");
        return { verified: gate.passed, output: gate.stdout.trim() };
      }
    },
    {
      id: "phase-5-post-mortem",
      name: "Post-Mortem Synthesis & Live Dashboard Export",
      phase: "Post-Mortem",
      role: "coordinator",
      dependencies: ["phase-4-exec-gate"],
      execute: async (ctx) => {
        return {
          postMortemReport: "# Incident Post-Mortem\\n\\nSeverity: P1\\nResolution: Pool re-scaled.\\nRecovery: 100% verified.",
          kanbanState: "RESOLVED"
        };
      }
    }
  ]
};
`;

export const SAMPLE_DEMO2_MIGRATION_WORKFLOW = `
export default {
  name: "repo-migration-engine",
  version: "1.0.0",
  description: "Multi-Agent AWS SDK v2 to v3 Codebase Migration Engine",
  phases: ["AST Scan", "Parallel Transform", "Review Pair", "Build Gate", "Commit Summary"],
  steps: [
    {
      id: "phase-1-ast-scan",
      name: "AST & Dependency Probe",
      phase: "AST Scan",
      role: "inspector",
      execute: async (ctx) => {
        return {
          targetFiles: ["src/storage/s3.ts", "src/db/dynamo.ts"],
          deprecatedAPIs: ["AWS.S3", "AWS.DynamoDB.DocumentClient"]
        };
      }
    },
    {
      id: "phase-2-transform",
      name: "Parallel Worker Fan-Out Transformation",
      phase: "Parallel Transform",
      role: "worker",
      dependencies: ["phase-1-ast-scan"],
      execute: async (ctx) => {
        // Fan-out simulation across multiple files
        return {
          transformedFiles: [
            { file: "src/storage/s3.ts", client: "@aws-sdk/client-s3" },
            { file: "src/db/dynamo.ts", client: "@aws-sdk/client-dynamodb" }
          ]
        };
      }
    },
    {
      id: "phase-3-review",
      name: "Paired AST & Style Review",
      phase: "Review Pair",
      role: "reviewer",
      dependencies: ["phase-2-transform"],
      execute: async (ctx) => {
        return {
          astValidation: "PASS",
          lintCheck: "PASS",
          approved: true
        };
      }
    },
    {
      id: "phase-4-build-gate",
      name: "Deterministic Verification Test Gate",
      phase: "Build Gate",
      role: "gate",
      dependencies: ["phase-3-review"],
      execute: async (ctx) => {
        const gate = await ctx.gate("node -e \\"console.log('Build & Typecheck Passed')\\"");
        return { buildPassed: gate.passed };
      }
    },
    {
      id: "phase-5-summary",
      name: "Migration Summary & PR Package",
      phase: "Commit Summary",
      role: "coordinator",
      dependencies: ["phase-4-build-gate"],
      execute: async (ctx) => {
        return {
          totalFilesMigrated: 2,
          breakingChangesResolved: 2,
          status: "READY_FOR_MERGE"
        };
      }
    }
  ]
};
`;
