import type {
  TriageAssessment,
  RemediationPlan,
  SafetyReview,
  PostMortemReport,
} from '../schemas.ts';

export interface ScenarioMockBundle {
  scenarioId: string;
  name: string;
  triage: TriageAssessment;
  remediationPlan: RemediationPlan;
  safetyReview: SafetyReview;
  postMortem: PostMortemReport;
}

// ============================================================================
// SCENARIO 1: P1 Database Connection Pool Exhaustion
// ============================================================================
export const mockDbPoolExhaustionBundle: ScenarioMockBundle = {
  scenarioId: 'p1_db_pool_exhaustion',
  name: 'P1: Database Connection Pool Exhaustion under Burst Traffic',
  triage: {
    incidentId: 'INC-20261031-DB100',
    severity: 'P1',
    failureDomain: 'DATABASE_EXHAUSTION',
    suspectedCommitHash: 'c4d9e1a',
    rootCauseAnalysis:
      'Database connection pool reached hard 100/100 ceiling following flash promotion traffic surge. Premature 5s idle connection timeout in commit c4d9e1a prevented connection reuse, causing queuing timeouts and HTTP 500 error cascades across /checkout.',
    confidenceScore: 0.98,
    affectedEndpoints: [
      '/api/v1/checkout',
      '/api/v1/orders/pay',
      '/api/v1/cart/commit',
    ],
    recommendedStrategy: 'EXPAND_CONNECTION_POOL',
  },
  remediationPlan: {
    strategy: 'EXPAND_CONNECTION_POOL',
    rationale:
      'Immediately expanding the connection pool max size from 100 to 250 connections and configuring aggressive 10s idle reaper restores service availability while preventing backend database OOM.',
    actions: [
      {
        order: 1,
        command: 'node -e "console.log(\'POOL_EXPAND: max_connections scaled to 250\')"',
        description: 'Dynamically expand DB connection pool upper boundary to 250 and set idle connection reaper to 10s.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'POOL_RESET: max_connections reset to 100\')"',
      },
      {
        order: 2,
        command: 'node -e "console.log(\'REPLICAS_SCALE: replicas scaled to 8\')"',
        description: 'Scale out checkout API pods to distribute incoming query concurrency.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'REPLICAS_RESET: replicas scaled to 4\')"',
      },
      {
        order: 3,
        command: 'node -e "console.log(\'ROLLOUT_RESTART: completed rolling restart\')"',
        description: 'Send rolling restart signal to worker pods to recycle orphaned connections.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'NOOP\')"',
      },
    ],
    estimatedRecoveryTimeSeconds: 20,
    riskLevel: 'LOW',
  },
  safetyReview: {
    approved: true,
    safetyScore: 0.98,
    prohibitedCommandsDetected: [],
    policyCompliance: 'PASS',
    riskMitigationNotes:
      'Remediation contains zero destructive commands (no DROP, TRUNCATE, or rm -rf). Database server has 64GB RAM with ample capacity for 250 client connections. Rollback command is verified safe and non-disruptive.',
    signedOffBy: 'SafetyReviewerAgent',
  },
  postMortem: {
    title: 'Incident Post-Mortem: Database Connection Pool Exhaustion on Checkout Service',
    incidentDurationMinutes: 12,
    impactSummary:
      'During flash sale peak traffic, checkout requests experienced a 38.5% HTTP 500 error rate. 640 customer transactions were delayed or failed over a 12-minute window.',
    rootCause:
      'Commit c4d9e1a introduced an aggressive connection idle timeout that held active client leases beyond query completion, exhausting the 100-connection limit within 90 seconds.',
    triggerEvent: 'Marketing promotional campaign triggered 3x normal concurrent checkout request rate at 14:15 UTC.',
    remediationSummary:
      'Autonomous workflow diagnosed database pool exhaustion within 4 seconds, expanded connection pool limit to 250, and recycled idle connection leases. Post-remediation health gate verified error rate dropped to 0.02%.',
    actionItems: [
      {
        priority: 'HIGH',
        description: 'Audit all database transaction paths to guarantee try/finally release semantics.',
        ownerRole: 'Backend Lead',
      },
      {
        priority: 'HIGH',
        description: 'Deploy connection pool utilization alert threshold at 80% with automated PagerDuty warning.',
        ownerRole: 'DevOps / SRE',
      },
      {
        priority: 'MEDIUM',
        description: 'Implement circuit breaker on /checkout to reject excess load gracefully with HTTP 429 instead of 500.',
        ownerRole: 'Platform Architect',
      },
    ],
  },
};

// ============================================================================
// SCENARIO 2: P1 Bad Deploy Regression
// ============================================================================
export const mockBadDeployRegressionBundle: ScenarioMockBundle = {
  scenarioId: 'p1_bad_deploy_regression',
  name: 'P1: Bad Deploy Code Regression (Null Pointer Exception in Checkout)',
  triage: {
    incidentId: 'INC-20261031-PAY500',
    severity: 'P1',
    failureDomain: 'CODE_REGRESSION',
    suspectedCommitHash: '7f8a9b2',
    rootCauseAnalysis:
      'Release v2.4.12 contained commit 7f8a9b2, which introduced an unchecked null access in billingAddress for users with empty customer profiles, triggering unhandled TypeErrors.',
    confidenceScore: 0.99,
    affectedEndpoints: [
      '/api/v1/checkout',
      '/api/v1/payments/charge',
    ],
    recommendedStrategy: 'GIT_ROLLBACK',
  },
  remediationPlan: {
    strategy: 'GIT_ROLLBACK',
    rationale:
      'Reverting commit 7f8a9b2 back to stable release tag v2.4.11 eliminates the null pointer bug instantly without requiring schema changes or database rollbacks.',
    actions: [
      {
        order: 1,
        command: 'node -e "console.log(\'ROLLOUT_UNDO: rolled back deployment to revision 2\')"',
        description: 'Rollback Kubernetes deployment to prior stable release (v2.4.11).',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'ROLLOUT_REAPPLY: reapplied revision 3\')"',
      },
      {
        order: 2,
        command: 'node -e "console.log(\'GIT_REVERT: reverted commit 7f8a9b2\')"',
        description: 'Create automated revert commit for commit 7f8a9b2.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'GIT_CHERRYPICK: cherrypicked 7f8a9b2\')"',
      },
    ],
    estimatedRecoveryTimeSeconds: 45,
    riskLevel: 'LOW',
  },
  safetyReview: {
    approved: true,
    safetyScore: 0.99,
    prohibitedCommandsDetected: [],
    policyCompliance: 'PASS',
    riskMitigationNotes:
      'Git revert is safe and reversible; no schema modifications or data loss detected. Validated rollback command is provided.',
    signedOffBy: 'SafetyReviewerAgent',
  },
  postMortem: {
    title: 'Incident Post-Mortem: Unhandled TypeError in Checkout Following Release v2.4.12',
    incidentDurationMinutes: 8,
    impactSummary:
      '100% of checkout requests for users without saved profiles failed with HTTP 500 for 8 minutes following deployment of release v2.4.12.',
    rootCause:
      'Commit 7f8a9b2 assumed billingAddress was always present, missing optional chaining check in TypeScript.',
    triggerEvent: 'Automated CI/CD deployment of release tag v2.4.12 at 15:02 UTC.',
    remediationSummary:
      'Automated triage agent identified commit 7f8a9b2 as the trigger within 2 seconds. Revert commit executed and deployed; post-remediation health check confirmed 100% success rate on /checkout.',
    actionItems: [
      {
        priority: 'HIGH',
        description: 'Add mandatory CI unit test checking null, undefined, and empty guest checkout payloads.',
        ownerRole: 'QA Engineer',
      },
      {
        priority: 'MEDIUM',
        description: 'Enable canary deployment with 5% traffic slice for 10 minutes before full promotion.',
        ownerRole: 'Release Engineer',
      },
    ],
  },
};

// ============================================================================
// SCENARIO 3: P2 High Latency Memory Leak
// ============================================================================
export const mockHighLatencyLeakBundle: ScenarioMockBundle = {
  scenarioId: 'p2_high_latency_leak',
  name: 'P2: High Latency & Memory Leak (GC Stop-The-World Stalls)',
  triage: {
    incidentId: 'INC-20261031-MEMLEAK',
    severity: 'P2',
    failureDomain: 'MEMORY_LEAK_OOM',
    suspectedCommitHash: '4a3b2c1',
    rootCauseAnalysis:
      'Commit 4a3b2c1 removed maxKeys limit on in-memory session cache. Heap usage expanded to 3.9GB, causing Node.js V8 garbage collector to perform frequent 3200ms full Mark-Sweep pauses.',
    confidenceScore: 0.94,
    affectedEndpoints: [
      '/api/v1/search',
      '/api/v1/autocomplete',
    ],
    recommendedStrategy: 'RESTART_PODS',
  },
  remediationPlan: {
    strategy: 'RESTART_PODS',
    rationale:
      'Performing a rolling restart of worker pods clears bloated V8 heaps and resets memory to 220MB, restoring P99 latencies below 100ms while permanent cache eviction patch is authored.',
    actions: [
      {
        order: 1,
        command: 'node -e "console.log(\'REPLICAS_SCALE: scaled to 12\')"',
        description: 'Scale replicas to 12 to halve per-pod query load.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'REPLICAS_RESET: scaled to 6\')"',
      },
      {
        order: 2,
        command: 'node -e "console.log(\'ROLLOUT_RESTART: rolling restart executed\')"',
        description: 'Trigger sequential zero-downtime rolling restart across search application pods.',
        isDestructive: false,
        rollbackCommand: 'node -e "console.log(\'NOOP\')"',
      },
    ],
    estimatedRecoveryTimeSeconds: 30,
    riskLevel: 'LOW',
  },
  safetyReview: {
    approved: true,
    safetyScore: 0.96,
    prohibitedCommandsDetected: [],
    policyCompliance: 'PASS',
    riskMitigationNotes:
      'Rolling restart maintains 75% replica capacity throughout execution; zero downtime or dropped connections.',
    signedOffBy: 'SafetyReviewerAgent',
  },
  postMortem: {
    title: 'Incident Post-Mortem: Heap Bloat and P99 Latency Degradation on Search Indexer',
    incidentDurationMinutes: 24,
    impactSummary:
      'P99 response latencies increased from 85ms to 4200ms for 24 minutes. Users experienced noticeable UI lag, but zero hard transaction drops occurred.',
    rootCause:
      'Unbounded in-memory LRU query cache in commit 4a3b2c1 accumulated 1.2M search records without eviction.',
    triggerEvent: 'Sustained user traffic over 4 hours pushed V8 Old Space to 3.9GB threshold.',
    remediationSummary:
      'Rolling restart executed autonomously; heap dropped to nominal and P99 latency recovered to 95ms within 30 seconds.',
    actionItems: [
      {
        priority: 'HIGH',
        description: 'Enforce strict 50,000 key limit and 15-minute TTL on in-memory LRU caches.',
        ownerRole: 'Backend Engineer',
      },
      {
        priority: 'MEDIUM',
        description: 'Add memory consumption alert at 75% heap limit in CloudWatch.',
        ownerRole: 'DevOps / SRE',
      },
    ],
  },
};

// ============================================================================
// Dispatcher & Lookup Functions
// ============================================================================
export const SCENARIO_BUNDLES: Record<string, ScenarioMockBundle> = {
  p1_db_pool_exhaustion: mockDbPoolExhaustionBundle,
  p1_bad_deploy_regression: mockBadDeployRegressionBundle,
  p2_high_latency_leak: mockHighLatencyLeakBundle,
};

/**
 * Returns the mock bundle for the requested scenario ID (defaults to DB pool exhaustion).
 */
export function getMockBundle(scenarioId?: string): ScenarioMockBundle {
  const id = scenarioId || process.env.SCENARIO || 'p1_db_pool_exhaustion';
  return SCENARIO_BUNDLES[id] || mockDbPoolExhaustionBundle;
}

/**
 * Returns typed mock response for a given agent role and scenario.
 */
export function getMockResponseForRole(
  role: 'inspector' | 'planner' | 'reviewer' | 'post-mortem' | 'coordinator' | string,
  scenarioId?: string
): unknown {
  const bundle = getMockBundle(scenarioId);

  switch (role) {
    case 'inspector':
    case 'triage':
      return bundle.triage;
    case 'planner':
    case 'remediation-planner':
      return bundle.remediationPlan;
    case 'reviewer':
    case 'safety-reviewer':
      return bundle.safetyReview;
    case 'post-mortem':
    case 'synthesizer':
    case 'coordinator':
    case 'post-mortem-synthesizer':
      return bundle.postMortem;
    default:
      return bundle.triage;
  }
}
