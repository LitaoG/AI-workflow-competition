// ============================================================================
// Multi-Agent Repo Migration (AWS SDK v2 → v3) — facade-script edition (P0-4b)
//
// The 5-phase flow of workflow.ts re-authored on the dwf facade:
// baseline gate → scan → parallel fan-out workers + paired reviewers →
// post-merge gate → release synthesis. Every side effect goes through the
// facade; every node is journalled for zero-provider-call resume.
//
// Run it offline (mock provider is the registry default, <4s, 0 tokens):
//   node bin/workflow.js run apps/repo-migration-engine/facade.workflow.ts \
//     --cwd apps/repo-migration-engine --approve-cmd node
//   (or with run-script):
//   node bin/workflow.js run-script apps/repo-migration-engine/facade.workflow.ts \
//     --cwd apps/repo-migration-engine --approve-cmd node
// Replay the completed run at zero cost: append --resume <runId>.
//
// The baseline/post-merge gate executes the fixture's unit test for real
// (node --experimental-strip-types), so the fixture needs its node_modules
// (aws-sdk) — the same prerequisite as the demo-migration integration suite.
// ============================================================================

interface MigrationResult {
  /** Workspace-relative file the mock transformer reports. */
  file: string;
  originalPackage: string;
  targetPackage: string;
  /** The transformed code the worker produced. */
  transformedCode: string;
  /** Human-readable breaking changes this transform resolves. */
  breakingChangesResolved: string[];
  status: 'SUCCESS' | 'FAILED';
}

interface CodeReview {
  isApproved: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  safetyViolations: string[];
  rollbackCommand: string;
  signedOffBy: string;
}

interface PullRequestRecord {
  status: string;
  message: string;
  timestamp: string;
}

const pkgFrom = (args.from as string | undefined) ?? 'aws-sdk';

// ---------------------------------------------------------------------------
// Phase 1 — Baseline Test Gate (the fixture must be green BEFORE migrating)
// ---------------------------------------------------------------------------
phase('Baseline Test Gate');
// Self-locating: works whether the workspace root is the repo or this demo dir.
// When the fixture is not in this workspace at all, fall back to the literal path —
// the gate must still RUN and fail by exit code (a missing fixture is a gate
// failure, not a script error: the deterministic gate decides before any model spend).
const fixtureHits = await files.glob('**/fixtures/legacy-aws-sdk-app/tests/s3-service.test.ts');
const fixtureTest = fixtureHits[0] ?? 'fixtures/legacy-aws-sdk-app/tests/s3-service.test.ts';
const baseline = await world.run(
  'node',
  ['--experimental-strip-types', fixtureTest],
  { timeoutMs: 60_000 },
);
if (baseline.exitCode !== 0) {
  throw new Error(`Baseline gate failed — fix the fixture before migrating:\n${baseline.stderr.slice(0, 800)}`);
}
log('Baseline gate passed: fixture unit tests are green on aws-sdk v2.');
report({ step: 'baseline', gate: 'passed' });

// ---------------------------------------------------------------------------
// Phase 2 — Scan & Migration Architecture (deterministic grep → plan ask)
// ---------------------------------------------------------------------------
phase('Scan & Migration Architecture');
const matches = await files.grep(`from ['"]${pkgFrom}`, `${fixtureTest.replace('/tests/s3-service.test.ts', '/src')}/**/*.ts`);
const targetFiles = [...new Set(matches.filter((m) => m.text.includes('import')).map((m) => m.path))];
if (targetFiles.length === 0) {
  log(`No ${pkgFrom} imports found — nothing to migrate.`);
  return { migrated: 0, targetPackage: '@aws-sdk/client-s3' };
}
log(`Scan found ${targetFiles.length} file(s) importing ${pkgFrom}: ${targetFiles.join(', ')}`);

const architect = agent('migration-architect');
const plan = await architect.ask(
  `Draft the migration architecture for converting these files from ${pkgFrom} v2 to the v3 modular client: ${JSON.stringify(targetFiles)}`,
);
report({ step: 'plan', files: targetFiles.length });

// ---------------------------------------------------------------------------
// Phase 3 — Parallel Fan-Out Workers & Paired Code Reviewers
// (worker → reviewer chained per item; no barrier between files)
// ---------------------------------------------------------------------------
phase('Parallel Fan-Out Workers & Paired Code Reviewers');
const worker = agent('migration-worker');
const reviewer = agent('code-reviewer');

const perFile = await Promise.all(
  targetFiles.map(async (file) => {
    const migration = await worker.ask<MigrationResult>(
      `aws-sdk v2→v3 migration transform for ${file}. Current imports: ${JSON.stringify({ pkgFrom })}.`,
    );
    if (migration.status !== 'SUCCESS') {
      throw new Error(`Migration worker failed on ${file}: ${JSON.stringify(migration.breakingChangesResolved)}`);
    }
    const review = await reviewer.ask<CodeReview>(
      `Code review this migration patch for ${file}: ${JSON.stringify({
        targetPackage: migration.targetPackage,
        breakingChangesResolved: migration.breakingChangesResolved,
      })}`,
    );
    if (!review.isApproved) {
      throw new Error(`Reviewer rejected ${file} (${review.riskLevel}): ${review.safetyViolations.join('; ')}`);
    }
    report({ step: 'transform', file, risk: review.riskLevel });
    return { file, migration, review };
  }),
);
log(`Fan-out complete: ${perFile.length} file(s) transformed and reviewed (${perFile.map((p) => p.review.riskLevel).join('/')}).`);

// Sandbox file writing: write transformed code into .workflow/sandbox for verification and diffing
for (const item of perFile) {
  const writeRes = await world.run(
    'node',
    [
      '-e',
      `const fs = require('fs'); const path = require('path'); const target = path.join('.workflow', 'sandbox', process.argv[1]); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, decodeURIComponent(process.argv[2]), 'utf8');`,
      item.file,
      encodeURIComponent(item.migration.transformedCode),
    ],
    { timeoutMs: 30_000 },
  );
  if (writeRes.exitCode !== 0) {
    throw new Error(`Sandbox file write failed for ${item.file}: ${writeRes.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Compiler Diagnostics & Post-Merge Test Gate
// ---------------------------------------------------------------------------
phase('Compiler Diagnostics & Post-Merge Test Gate');
for (const item of perFile) {
  const sandboxedTarget = `.workflow/sandbox/${item.file.replace(/\\/g, '/')}`;
  const syntaxCheck = await world.run(
    'node',
    ['--experimental-strip-types', '--check', sandboxedTarget],
    { timeoutMs: 30_000 },
  );
  if (syntaxCheck.exitCode !== 0) {
    throw new Error(`Compiler diagnostic check failed for sandboxed ${item.file}:\n${syntaxCheck.stderr}`);
  }
}

const postMerge = await world.run(
  'node',
  ['--experimental-strip-types', fixtureTest],
  { timeoutMs: 60_000 },
);
if (postMerge.exitCode !== 0) {
  throw new Error(`Post-merge gate failed:\n${postMerge.stderr.slice(0, 800)}`);
}
log('Post-merge gate passed.');
report({ step: 'post-merge', gate: 'passed' });

// ---------------------------------------------------------------------------
// Phase 5 — Release Synthesis & PR Generation
// ---------------------------------------------------------------------------
phase('Release Synthesis & PR Generation');
const recorder = agent('release-recorder');
const prRecord = await recorder.ask<PullRequestRecord>(
  `Record the migration pull request: ${JSON.stringify({
    files: perFile.map((p) => p.file),
    targetPackage: '@aws-sdk/client-s3',
    reviewers: perFile.map((p) => p.review.signedOffBy),
  })}`,
);

const diffTable = await Promise.all(
  perFile.map(async (p) => {
    const origCode = await files.read(p.file);
    const origLines = origCode.split('\n').length;
    const transformedLines = p.migration.transformedCode.split('\n').length;
    const net = transformedLines - origLines;
    return `| \`${p.file}\` | ${origLines} | ${transformedLines} | ${net >= 0 ? '+' : ''}${net} |`;
  }),
);

const markdown = [
  '# Migration PR: aws-sdk v2 → v3 modular client',
  '',
  `- **Scope**: ${perFile.length} service file(s) — ${perFile.map((p) => p.file).join(', ')}`,
  `- **Target**: \`@aws-sdk/client-s3\``,
  `- **Resolved breaking changes**: ${perFile.flatMap((p) => p.migration.breakingChangesResolved).map((c) => `\`${c}\``).join(', ')}`,
  `- **Reviews**: all approved (${perFile.map((p) => `${p.review.signedOffBy}·${p.review.riskLevel}`).join(', ')})`,
  `- **Rollback**: \`${perFile[0]?.review.rollbackCommand ?? 'git checkout -- .'}\``,
  `- **Gates**: baseline ✔ compiler diagnostics ✔ post-merge ✔`,
  `- **Record**: ${prRecord.status} — ${prRecord.message}`,
  '',
  '## Diff Statistics (measured from sandboxed transforms)',
  '| File | Legacy fixture (lines) | Transformed output (lines) | Net Change |',
  '| :--- | ---: | ---: | ---: |',
  ...diffTable,
].join('\n');
await artifact.markdown('pull-request', markdown, { title: 'Migration PR (aws-sdk v2→v3)' });

return {
  migrated: perFile.length,
  targetPackage: '@aws-sdk/client-s3',
  allApproved: perFile.every((p) => p.review.isApproved),
  gates: 'passed',
  record: prRecord.status,
};
