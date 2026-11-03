/* workflow
name: goal-case-a-review
description: Case A - static smell scan over the src tree plus a parallel security and arch expert review fan-out
*/

// ============================================================================
// TEST-GOAL Phase 2 / Case A: concurrent code review over the dwf facade.
//
// Phase 1 (StaticScan): deterministic world reads only - files.glob('src/**/*.ts')
//   + files.grep over a fixed set of code-smell signals. Zero model spend.
// Phase 2 (ParallelReview): fanout.parallel dispatches two INDEPENDENT expert
//   actors concurrently (child-main.ts __fanout.parallel = Promise.allSettled
//   over thunks; slot concurrency gated by the parent's seat limit). A failed
//   slot arrives as null and the script fails loudly instead of half-reporting.
// Phase 3 (Synthesis): script-side markdown summary published as a run artifact.
//
// Offline run (mock provider is the registry default, 0 tokens):
//   node bin/workflow.js check examples/goal-e2e/case-a-review.ts
//   node bin/workflow.js run-script examples/goal-e2e/case-a-review.ts \
//     --db .workflow/goal-case-a.db
// Mock honesty note: with the built-in mock provider, expert verdicts are
// deterministic canned payloads selected by mock-provider.ts keyword routing
// (the "review" keyword routes to its review-shaped payload) - NOT real model
// calls. The scan phase is fully real regardless of provider.
// ============================================================================

interface SmellFinding {
  /** Human-readable smell label. */
  smell: string;
  /** Regex passed to files.grep. */
  pattern: string;
  /** Number of matching lines under the src tree (glob src over double-star slash star dot ts). */
  matches: number;
  /** Up to three path:line samples. */
  samples: string[];
}

/** Review verdict contract. Field names match the deterministic mock's review payload. */
interface ExpertReview {
  /** Does the expert sign off on the scanned signals as a whole? */
  isApproved: boolean;
  /** Highest severity the expert assigns: LOW | MEDIUM | HIGH. */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Findings this expert would block on (empty = nothing blocking). */
  safetyViolations: string[];
  /** Rollback / undo recommendation attached to the verdict. */
  rollbackCommand: string;
  /** Which expert signed the verdict. */
  signedOffBy: string;
}

const SMELL_PATTERNS: ReadonlyArray<{ smell: string; pattern: string }> = [
  { smell: 'marker comments (TODO/FIXME/HACK/XXX)', pattern: 'TODO|FIXME|HACK|XXX' },
  { smell: 'suppressed diagnostics (@ts-ignore/@ts-expect-error)', pattern: '@ts-ignore|@ts-expect-error' },
  { smell: 'loose any (as any / : any)', pattern: '\\bas any\\b|:\\s*any\\b' },
  { smell: 'stray console output in src', pattern: 'console\\.(log|warn|error)' },
  { smell: 'empty catch blocks', pattern: 'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' },
];

// ---------------------------------------------------------------------------
// Phase 1 - StaticScan: deterministic smell sweep (world reads only)
// ---------------------------------------------------------------------------
phase('StaticScan');
const tsFiles = await files.glob('src/**/*.ts');
if (tsFiles.length === 0) {
  throw new Error('files.glob("src/**/*.ts") matched nothing - run from the repo/worktree root');
}
log(`StaticScan: ${tsFiles.length} TypeScript file(s) under src/`);

const findings: SmellFinding[] = [];
for (const { smell, pattern } of SMELL_PATTERNS) {
  const hits = await files.grep(pattern, 'src/**/*.ts');
  findings.push({
    smell,
    pattern,
    matches: hits.length,
    samples: hits.slice(0, 3).map((m) => `${m.path}:${m.line}`),
  });
}
report({ step: 'static-scan', files: tsFiles.length, findings });

// ---------------------------------------------------------------------------
// Phase 2 - ParallelReview: two independent experts review the scan in parallel
// ---------------------------------------------------------------------------
phase('ParallelReview');
// Compact digest only (labels + counts + samples) - never whole files
// (anti-pattern: Context Flood; pass pointers, not payloads).
const digest = findings
  .map((f) => `- ${f.smell}: ${f.matches} hit(s)${f.samples.length ? ` (e.g. ${f.samples.join(', ')})` : ''}`)
  .join('\n');

const [securityRaw, archRaw] = await fanout.parallel([
  () => agent('security-expert').ask<ExpertReview>(
    `Security review the following static scan signals collected from src/**/*.ts and return a verdict:\n${digest}`,
  ),
  () => agent('arch-expert').ask<ExpertReview>(
    `Architecture review the following static scan signals collected from src/**/*.ts and return a verdict:\n${digest}`,
  ),
]);
if (!securityRaw || !archRaw) {
  throw new Error(
    `parallel review incomplete - security=${securityRaw ? 'ok' : 'null'}, arch=${archRaw ? 'ok' : 'null'}`,
  );
}
const security = securityRaw as ExpertReview;
const arch = archRaw as ExpertReview;
log(`ParallelReview: security ${security.signedOffBy}/${security.riskLevel}, arch ${arch.signedOffBy}/${arch.riskLevel}`);
report({ step: 'parallel-review', security: security.riskLevel, arch: arch.riskLevel });

// ---------------------------------------------------------------------------
// Phase 3 - Synthesis: markdown summary artifact
// ---------------------------------------------------------------------------
phase('Synthesis');
const findingRows = findings
  .map((f) => `| ${f.smell} | \`${f.pattern}\` | ${f.matches} | ${f.samples.length ? f.samples.map((s) => `\`${s}\``).join(', ') : '-'} |`)
  .join('\n');
const md = [
  `# Case A - Parallel Code Review Summary`,
  '',
  `- **Script**: examples/goal-e2e/case-a-review.ts`,
  `- **Provider**: offline deterministic mock (registry default) - expert verdicts are canned mock payloads, NOT real model calls; the StaticScan phase is fully real`,
  `- **Scan scope**: \`src/**/*.ts\` - ${tsFiles.length} file(s)`,
  `- **Concurrency primitive**: \`fanout.parallel\` over two independent actors (security-expert, arch-expert)`,
  '',
  '## Static smell signals',
  '',
  '| Signal | Pattern | Matches | Samples |',
  '| --- | --- | --- | --- |',
  findingRows,
  '',
  '## Expert verdicts (parallel fan-out)',
  '',
  `| Expert | Approved | Risk | Blocking findings | Rollback |`,
  `| --- | --- | --- | --- | --- |`,
  `| security-expert | ${security.isApproved} | ${security.riskLevel} | ${security.safetyViolations.length ? security.safetyViolations.join('; ') : '-'} | \`${security.rollbackCommand}\` |`,
  `| arch-expert | ${arch.isApproved} | ${arch.riskLevel} | ${arch.safetyViolations.length ? arch.safetyViolations.join('; ') : '-'} | \`${arch.rollbackCommand}\` |`,
  '',
  `- **Budget**: ${budget.spent()} output token(s) spent by completed asks (total: ${budget.total ?? 'unlimited'})`,
  '',
  '## Reproduce',
  '',
  '```bash',
  'node bin/workflow.js check examples/goal-e2e/case-a-review.ts',
  'node bin/workflow.js run-script examples/goal-e2e/case-a-review.ts --db .workflow/goal-case-a.db',
  '```',
].join('\n');
await artifact.markdown('case-a-review-summary', md, { title: 'Case A - Parallel Code Review Summary' });

return {
  scannedFiles: tsFiles.length,
  totalSignals: findings.reduce((sum, f) => sum + f.matches, 0),
  findings: findings.map((f) => ({ smell: f.smell, matches: f.matches })),
  security,
  arch,
  artifact: 'case-a-review-summary',
  budgetSpent: budget.spent(),
};
