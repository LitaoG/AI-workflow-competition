import { z } from 'zod';

// ============================================================================
// 1. AST Codebase Scanning Schemas
// ============================================================================

export const AffectedFileSchema = z.object({
  filePath: z.string().describe('Relative file path from repository root (e.g. src/s3-service.ts)'),
  serviceName: z.enum(['s3', 'dynamodb', 'sqs', 'general']).or(z.string()).optional().describe('AWS service client identified'),
  deprecatedImports: z.array(z.string()).describe('List of deprecated AWS SDK v2 import statements'),
  detectedCallSites: z.array(z.string()).describe('List of deprecated method invocations (e.g. upload, getObject, putItem)'),
  linesOfCode: z.number().int().nonnegative().describe('Total lines of code in file'),
});
export type AffectedFile = z.infer<typeof AffectedFileSchema>;

export const CodebaseScanResultSchema = z.object({
  targetRepoPath: z.string().describe('Path to the target codebase fixture being scanned'),
  detectedSourceVersion: z.string().describe('Source library version detected (e.g. aws-sdk@2.1500.0)'),
  desiredTargetVersion: z.string().describe('Target library version (e.g. @aws-sdk/client-*@3.x)'),
  affectedFiles: z.array(AffectedFileSchema).describe('List of files containing deprecated SDK v2 usage'),
  totalOccurrences: z.number().int().nonnegative().describe('Total count of deprecated API usages across codebase'),
  scanTimestamp: z.string().optional().describe('ISO timestamp of when the scan occurred'),
});
export type CodebaseScanResult = z.infer<typeof CodebaseScanResultSchema>;

// ============================================================================
// 2. Migration Architecture & Planning Schemas
// ============================================================================

export const MigrationRuleSchema = z.object({
  sourcePattern: z.string().describe('Deprecated v2 pattern (e.g. new AWS.S3())'),
  targetPattern: z.string().describe('Modular v3 replacement (e.g. new S3Client({}))'),
  targetPackage: z.string().describe('Target modular npm package (e.g. @aws-sdk/client-s3)'),
  breakingChangeNotes: z.string().describe('Explanation of method signature changes and promise handling'),
});
export type MigrationRule = z.infer<typeof MigrationRuleSchema>;

export const MigrationPlanSchema = z.object({
  planId: z.string().describe('Unique identifier for this migration execution plan (e.g. PLAN-AWS-SDK-V3-001)'),
  topologicalOrder: z.array(z.string()).describe('Ordered file paths to migrate, respecting dependency topology'),
  transformationRulesApplied: z.array(z.string()).describe('High-level list of transformation rule summaries'),
  estimatedComplexity: z.enum(['LOW', 'MEDIUM', 'HIGH']).describe('Assessed migration complexity based on call sites'),
  backupBranchName: z.string().describe('Git branch or snapshot tag name created before migration'),
  parallelBatches: z.array(z.array(z.string())).optional().describe('Batches of files that can be safely transformed concurrently'),
  mcpRulesConsulted: z.array(z.string()).optional().describe('Rule identifiers fetched from MCP docs server'),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

// ============================================================================
// 3. Code Transformation & Paired Review Schemas
// ============================================================================

export const CodeTransformResultSchema = z.object({
  filePath: z.string().describe('Relative path to the transformed file'),
  serviceName: z.string().optional().describe('AWS service associated with this file (e.g. s3, dynamodb, sqs)'),
  transformedCode: z.string().describe('Full source code of the file after applying AWS SDK v3 modular migration'),
  diffPatch: z.string().describe('Unified diff patch representing the modifications made to the original file'),
  modifiedImports: z.array(z.string()).describe('New modular v3 import declarations introduced'),
  breakingChangesHandled: z.array(z.string()).optional().describe('List of specific breaking changes resolved (e.g. .promise() removal, SendCommand pattern)'),
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']).default('SUCCESS').describe('Transformation status'),
  notes: z.string().describe('Engineer or agent notes explaining architectural changes made'),
});
export type CodeTransformResult = z.infer<typeof CodeTransformResultSchema>;

export const CodeReviewResultSchema = z.object({
  filePath: z.string().describe('File path reviewed'),
  approved: z.boolean().describe('Whether the paired reviewer approves the transformed code for merging'),
  reviewScore: z.number().min(0).max(1).optional().default(0.98).describe('Quality and safety rating from 0.0 to 1.0'),
  identifiedRisks: z.array(z.string()).describe('Potential semantic regressions, missing error handling, or performance concerns'),
  astValidation: z.enum(['PASS', 'FAIL']).optional().default('PASS').describe('Whether all original exported signatures and interfaces are preserved'),
  lintCheck: z.enum(['PASS', 'FAIL']).optional().default('PASS').describe('Whether the code complies with TypeScript strict formatting and lint rules'),
  suggestedAdjustments: z.string().optional().describe('Recommended minor tweaks if approved with comments'),
  signedOffBy: z.string().optional().describe('Identity stamp of the paired CodeReviewerAgent'),
});
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;

// ============================================================================
// 4. Compiler Diagnostic Auto-Repair Schemas
// ============================================================================

export const CompilerFixResultSchema = z.object({
  filePath: z.string().describe('File path that encountered a compiler diagnostic error'),
  compilerErrorFixed: z.string().describe('Verbatim compiler error message that was repaired (e.g. TS2339: Property promise does not exist)'),
  errorCode: z.string().optional().describe('TypeScript diagnostic error code (e.g. TS2339, TS2304)'),
  correctedCode: z.string().describe('Updated source code with type annotation or method call corrected'),
  fixExplanation: z.string().describe('Technical explanation of the type mismatch and how it was resolved'),
  resolved: z.boolean().default(true).describe('Whether the fix resolved the diagnostic error'),
});
export type CompilerFixResult = z.infer<typeof CompilerFixResultSchema>;

// ============================================================================
// 5. Verification Gate Output Schemas
// ============================================================================

export const BaselineGateResultSchema = z.object({
  passed: z.boolean().describe('Whether baseline test gate succeeded'),
  testCount: z.number().int().nonnegative().optional().describe('Number of unit tests run'),
  exitCode: z.number().int().describe('Shell exit code'),
  output: z.string().describe('Standard output from test runner'),
});
export type BaselineGateResult = z.infer<typeof BaselineGateResultSchema>;

export const PostMergeGateResultSchema = z.object({
  passed: z.boolean().describe('Whether post-merge verification gate succeeded'),
  compilerPassed: z.boolean().describe('Whether tsc typechecking succeeded'),
  testsPassed: z.boolean().describe('Whether test suite succeeded'),
  exitCode: z.number().int().describe('Shell exit code'),
  output: z.string().describe('Standard output from build & test gate'),
  autoFixesApplied: z.number().int().nonnegative().optional().default(0).describe('Number of compiler diagnostic fixes applied'),
});
export type PostMergeGateResult = z.infer<typeof PostMergeGateResultSchema>;

// ============================================================================
// 6. Release Synthesis & Pull Request Report Schemas
// ============================================================================

export const MigrationSummaryReportSchema = z.object({
  summaryTitle: z.string().describe('Executive title of the migration summary report'),
  filesMigratedCount: z.number().int().nonnegative().describe('Total number of source files successfully upgraded'),
  totalLinesModified: z.number().int().nonnegative().describe('Aggregate lines of code added or altered'),
  compilerPassStatus: z.boolean().describe('Whether tsc --noEmit passed cleanly without type errors'),
  testsPassStatus: z.boolean().describe('Whether npm test passed cleanly after migration'),
  breakingChangesResolved: z.array(z.string()).describe('Complete catalog of SDK v2 to v3 breaking changes addressed'),
  pullRequestMarkdown: z.string().describe('Ready-to-publish GitHub/GitLab Pull Request description in markdown'),
  kanbanState: z.string().optional().describe('Final status string on the ZCode live Kanban board'),
  durationSeconds: z.number().nonnegative().optional().describe('Total execution time in seconds'),
});
export type MigrationSummaryReport = z.infer<typeof MigrationSummaryReportSchema>;
