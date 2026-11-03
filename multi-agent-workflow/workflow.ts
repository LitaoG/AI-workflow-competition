import { defineWorkflow, z } from 'ai-workflow';

// Schemas
const IssueTriageSchema = z.object({
  issueId: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  affectedComponent: z.string(),
  suggestedAction: z.string(),
});

const PatchSchema = z.object({
  patchId: z.string(),
  diff: z.string(),
  explanation: z.string(),
});

const ReviewSchema = z.object({
  approved: z.boolean(),
  comments: z.array(z.string()),
  securityPassed: z.boolean(),
});

export default defineWorkflow({
  name: 'Multi-Agent Night Shift Triage & Sweep Workflow',
  description: 'Advanced dynamic workflow featuring parallel fan-out, paired agents, and deterministic shell gates',
  version: '1.0.0',
  phases: [
    'Phase 1: Baseline Gate',
    'Phase 2: Parallel Triage',
    'Phase 3: Fixer & Reviewer Pair',
    'Phase 4: Post-Fix Test Gate',
    'Phase 5: Merge Coordination',
  ],
  steps: [
    // 1. Deterministic baseline gate
    {
      id: 'baseline-test-gate',
      name: 'Verify Test Baseline',
      phase: 'Phase 1: Baseline Gate',
      role: 'gate',
      async execute(ctx) {
        const gateResult = await ctx.gate('node -e "process.exit(0)"');
        if (!gateResult.passed) {
          throw new Error(`Baseline tests failed with code ${gateResult.exitCode}`);
        }
        return { baselineClean: true };
      },
    },
    // 2. Parallel fan-out triage workers
    {
      id: 'parallel-triage',
      name: 'Fan-out Triage Agents (Worker 1..3)',
      phase: 'Phase 2: Parallel Triage',
      role: 'worker',
      dependencies: ['baseline-test-gate'],
      async execute(ctx) {
        const items = ['ISSUE-101: Memory Leak', 'ISSUE-102: API Deprecation', 'ISSUE-103: Config Typo'];

        // Execute parallel agent RPCs via native Promise.all
        const triageResults = await Promise.all(
          items.map(async (item, idx) => {
            const workerId = `triage-worker-${idx + 1}`;
            return ctx.agent(workerId).ask(
              `Triage the following incident item: ${item}`,
              IssueTriageSchema,
              {
                mockResponse: {
                  issueId: `ISSUE-10${idx + 1}`,
                  severity: idx === 0 ? 'HIGH' : 'MEDIUM',
                  affectedComponent: idx === 0 ? 'cache' : 'api',
                  suggestedAction: 'Apply code patch and rerun tests',
                },
              }
            );
          })
        );

        ctx.log(`Triaged ${triageResults.length} issues in parallel.`);
        return triageResults;
      },
    },
    // 3. Paired Fixer + Reviewer with critique loop
    {
      id: 'fixer-reviewer-pair',
      name: 'Paired Code Fixer & Security Reviewer',
      phase: 'Phase 3: Fixer & Reviewer Pair',
      role: 'reviewer',
      dependencies: ['parallel-triage'],
      async execute(ctx) {
        let attempts = 0;
        let approved = false;
        let lastComments: string[] = [];
        let finalPatch: z.infer<typeof PatchSchema> | null = null;

        while (!approved && attempts < 3) {
          attempts++;
          ctx.log(`Fix & Review iteration #${attempts}`);

          // Fixer Agent generates patch
          finalPatch = await ctx.agent('fixer').ask(
            `Generate patch for triaged issues. Feedback from previous round: ${lastComments.join('; ')}`,
            PatchSchema,
            {
              mockResponse: {
                patchId: `patch-attempt-${attempts}`,
                diff: 'Index: src/cache.ts\n+ fixed resource leak',
                explanation: 'Patched cache eviction and updated listener cleanup.',
              },
            }
          );

          // Reviewer Agent audits patch
          const review = await ctx.agent('reviewer').ask(
            `Review patch ${finalPatch.patchId}: ${finalPatch.diff}`,
            ReviewSchema,
            {
              mockResponse: {
                approved: true,
                comments: ['Patch addresses the issue securely', 'Zero regressions noted'],
                securityPassed: true,
              },
            }
          );

          approved = review.approved && review.securityPassed;
          lastComments = review.comments;
        }

        if (!approved) {
          throw new Error('Fixer/Reviewer pair failed to reach approved patch within 3 attempts.');
        }

        return { patch: finalPatch, attempts };
      },
    },
    // 4. Deterministic post-fix shell gate
    {
      id: 'post-fix-test-gate',
      name: 'Post-Fix Deterministic Shell Test Gate',
      phase: 'Phase 4: Post-Fix Test Gate',
      role: 'gate',
      dependencies: ['fixer-reviewer-pair'],
      async execute(ctx) {
        const gateResult = await ctx.gate('node -e "process.exit(0)"');
        if (!gateResult.passed) {
          throw new Error(`Post-fix verification gate failed with exit code ${gateResult.exitCode}`);
        }
        return { gatePassed: true, durationMs: gateResult.durationMs };
      },
    },
    // 5. Merge coordinator agent
    {
      id: 'merge-coordinator',
      name: 'Merge Coordinator Agent',
      phase: 'Phase 5: Merge Coordination',
      role: 'coordinator',
      dependencies: ['post-fix-test-gate'],
      async execute(ctx) {
        const result = await ctx.agent('merge-coordinator').ask(
          'All gates passed. Summarize patch sweep and prepare pull request.',
          z.object({
            merged: z.boolean(),
            prTitle: z.string(),
            changelog: z.string(),
          }),
          {
            mockResponse: {
              merged: true,
              prTitle: 'fix(engine): automated sweep of triaged incidents',
              changelog: '- Resolved cache leak\n- Passed all deterministic test gates',
            },
          }
        );
        ctx.log(`Sweep completed: ${result.prTitle}`);
        return result;
      },
    },
  ],
});
