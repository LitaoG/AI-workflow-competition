import { z } from 'zod';

// ============================================================================
// 1. Telemetry & Environment Probing Schemas
// ============================================================================

export const CommitInfoSchema = z.object({
  hash: z.string().describe('Git commit SHA-1 hash'),
  author: z.string().describe('Author name and email'),
  message: z.string().describe('Commit subject message'),
  timestamp: z.string().describe('ISO 8601 commit timestamp'),
  filesChanged: z.array(z.string()).describe('List of changed file paths'),
  diff: z.string().optional().describe('Unified diff snippet'),
});

export const TelemetryProbeResultSchema = z.object({
  serviceName: z.string().describe('Target service identifier'),
  healthCheckStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
  http5xxRatePercent: z.number().min(0).max(100).describe('Percentage of 5xx HTTP responses'),
  p99LatencyMs: z.number().nonnegative().describe('P99 response latency in milliseconds'),
  activeDbConnections: z.number().int().nonnegative().describe('Current active DB pool connections'),
  maxDbConnections: z.number().int().positive().describe('Configured maximum connection pool ceiling'),
  cpuUsagePercent: z.number().min(0).max(100).optional().describe('Average CPU utilization percentage'),
  memoryUsagePercent: z.number().min(0).max(100).optional().describe('Average RAM utilization percentage'),
  cpuUtilizationPercent: z.number().min(0).max(100).optional().describe('Alternative alias for CPU %'),
  memoryUtilizationPercent: z.number().min(0).max(100).optional().describe('Alternative alias for RAM %'),
  recentCommits: z.array(CommitInfoSchema).describe('Recent commit log since last stable release'),
  recentLogErrors: z.array(z.string()).describe('Top recent error log lines extracted from service telemetry'),
  timestamp: z.string().optional().describe('Probe execution timestamp'),
});
export type TelemetryProbeResult = z.infer<typeof TelemetryProbeResultSchema>;

// ============================================================================
// 2. Triage & Root Cause Analysis Schemas
// ============================================================================

export const FailureDomainEnum = z.enum([
  'DATABASE_EXHAUSTION',
  'CODE_REGRESSION',
  'MEMORY_LEAK_OOM',
  'CONFIG_DRIFT',
  'NETWORK_PARTITION',
  // Backwards compatibility aliases with test fixtures and mock responses
  'DATABASE',
  'database_resource_exhaustion',
]);

export const TriageAssessmentSchema = z.object({
  incidentId: z.string().describe('Unique incident identifier (e.g. INC-20261031-01)'),
  severity: z.enum(['P1', 'P2', 'P3']).describe('Assessed incident severity level'),
  failureDomain: FailureDomainEnum.describe('Primary architectural subsystem responsible for failure'),
  suspectedCommitHash: z.string().optional().describe('Suspected regression commit hash, if identified'),
  rootCauseAnalysis: z.string().min(10).describe('Detailed explanation of triggering condition and mechanism'),
  confidenceScore: z.number().min(0).max(1).describe('Model confidence score between 0.0 and 1.0'),
  affectedEndpoints: z.array(z.string()).describe('List of degraded or failing API routes'),
  recommendedStrategy: z.enum([
    'GIT_ROLLBACK',
    'SCALE_SERVICE_REPLICAS',
    'EXPAND_CONNECTION_POOL',
    'ENABLE_CIRCUIT_BREAKER',
    'RESTART_PODS',
  ]).optional().describe('Preliminary recommended remediation strategy'),
});
export type TriageAssessment = z.infer<typeof TriageAssessmentSchema>;

// ============================================================================
// 3. Remediation Synthesis & Action Schemas
// ============================================================================

export const RemediationStrategyEnum = z.enum([
  'GIT_ROLLBACK',
  'SCALE_SERVICE_REPLICAS',
  'EXPAND_CONNECTION_POOL',
  'ENABLE_CIRCUIT_BREAKER',
  'RESTART_PODS',
]);

export const RemediationActionSchema = z.object({
  order: z.number().int().positive().describe('Execution sequence order (1-indexed)'),
  command: z.string().min(1).describe('Exact CLI or API command string to execute'),
  description: z.string().describe('Human-readable description of the action'),
  isDestructive: z.boolean().describe('Flag indicating whether the action mutates persistent data'),
  rollbackCommand: z.string().min(1).describe('Exact command string to revert this action upon failure'),
});

export const RemediationPlanSchema = z.object({
  strategy: RemediationStrategyEnum.describe('High-level remediation pattern'),
  rationale: z.string().min(10).describe('Technical justification for why this strategy was chosen'),
  actions: z.array(RemediationActionSchema).min(1).describe('Ordered sequence of remediation actions'),
  estimatedRecoveryTimeSeconds: z.number().nonnegative().describe('Estimated MTTR in seconds'),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).describe('Assessed execution risk level'),
});
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;

// ============================================================================
// 4. Paired Safety Review Schemas
// ============================================================================

export const SafetyReviewSchema = z.object({
  approved: z.boolean().describe('Whether the plan is approved for automated execution'),
  safetyScore: z.number().min(0).max(1).describe('Safety confidence rating between 0.0 and 1.0'),
  prohibitedCommandsDetected: z.array(z.string()).describe('List of disallowed command tokens detected'),
  policyCompliance: z.enum(['PASS', 'FAIL', 'CONDITIONAL']).optional().default('PASS').describe('Compliance against deterministic steering policies'),
  riskMitigationNotes: z.string().describe('Safety auditor analysis and blast radius containment commentary'),
  signedOffBy: z.string().optional().describe('Auditor agent identity stamp'),
});
export type SafetyReview = z.infer<typeof SafetyReviewSchema>;

// ============================================================================
// 5. Remediation Execution & Gate Verification Schemas
// ============================================================================

export const RemediationExecutionResultSchema = z.object({
  strategyExecuted: z.string().describe('Remediation strategy that was executed'),
  commandsRun: z.array(z.string()).describe('List of commands successfully executed'),
  executionSuccess: z.boolean().describe('Whether all remediation commands succeeded'),
  postRemediationHealthStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']).describe('Post-remediation /healthz state'),
  resolvedErrorRatePercent: z.number().min(0).max(100).describe('Residual HTTP 5xx error percentage'),
  timeToRemediateSeconds: z.number().nonnegative().describe('Total wall-clock duration from detection to recovery'),
  gatePassed: z.boolean().optional().describe('Whether deterministic recovery gate verification succeeded'),
  gateOutput: z.string().optional().describe('Raw standard output from recovery gate script'),
});
export type RemediationExecutionResult = z.infer<typeof RemediationExecutionResultSchema>;

// ============================================================================
// 6. Post-Mortem Report Schemas
// ============================================================================

export const ActionItemSchema = z.object({
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).describe('Action item priority'),
  description: z.string().min(5).describe('Specific engineering task description'),
  ownerRole: z.string().describe('Assigned engineering role or team'),
});

export const PostMortemReportSchema = z.object({
  title: z.string().describe('Executive incident post-mortem title'),
  incidentDurationMinutes: z.number().nonnegative().describe('Total incident duration in minutes'),
  impactSummary: z.string().min(10).describe('User and business impact statement'),
  rootCause: z.string().min(10).describe('Technical root cause analysis'),
  triggerEvent: z.string().describe('Initial event that triggered the outage'),
  remediationSummary: z.string().describe('Summary of automated recovery actions'),
  actionItems: z.array(ActionItemSchema).min(1).describe('Preventive follow-up action items'),
  markdownReport: z.string().optional().describe('Full rendered markdown document'),
});
export type PostMortemReport = z.infer<typeof PostMortemReportSchema>;
