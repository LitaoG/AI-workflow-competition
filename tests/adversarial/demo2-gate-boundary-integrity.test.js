/**
 * Tier 5 Adversarial Stress Challenge Suite: Demo App 2 (Repo Migration Engine)
 * Adversarial hardening suite
 *
 * Verifies:
 * 1. Adversarial Gate Failure Handling:
 *    - Injected synthetic compilation failure into post-merge gate (SIMULATE_GATE_FAILURE=true & broken TS syntax)
 *    - Workflow halts with exit code 1, captures compiler error accurately, and blocks Phase 5 PR release
 *    - Universal gate-runner exit code contract (0 = Pass, 1 = Verification Failure, 2 = Config Error)
 * 2. AST Probe Boundary Conditions:
 *    - Empty files (0 bytes), non-TypeScript files (.txt, .json, .bin), and invalid syntax files
 *    - Deeply nested structures, corrupted package.json, and non-existent directories
 *    - Fast-Check property-based fuzzing ensuring zero unhandled exceptions
 * 3. Live Mode vs Mock Mode Integrity:
 *    - Running without --mock does NOT return canned mock data, but triggers authentic agent RPC mechanism
 *    - Strict Zod schema compliance across all 5 role mock bundles
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import fc from 'fast-check';

// Wall-clock SLA (Issue #137): same baseline × load-factor scheme as
// demo1-dag-stress.js — the idle-host 4,000 ms figure turned host load into
// false product regressions (observed 4,154 ms with a healthy mock run, only
// 3.9% over the line). 2,500 ms design baseline × 3 still fails loudly on a
// genuine 3× slowdown; AIWF_ADVERSARIAL_SLA_MS overrides for stricter runs.
const MOCK_RUN_SLA_MS = Number(process.env.AIWF_ADVERSARIAL_SLA_MS) || 7500;

// Direct TypeScript schema & probe imports via Node 22 --experimental-strip-types
import {
  CodebaseScanResultSchema,
  MigrationPlanSchema,
  CodeTransformResultSchema,
  CodeReviewResultSchema,
  CompilerFixResultSchema,
  MigrationSummaryReportSchema,
  BaselineGateResultSchema,
  PostMergeGateResultSchema,
} from '../../demos/repo-migration-engine/schemas.ts';

import { scanCodebase } from '../../demos/repo-migration-engine/probes/ast-probe.ts';
import { getMockResponseForRole } from '../../demos/repo-migration-engine/mocks/mock-agent-responses.ts';
import { SQLiteStateStore, EventLogReader } from 'ai-workflow';

const ROOT_DIR = path.resolve(process.cwd());
const DEMO2_DIR = path.join(ROOT_DIR, 'demos', 'repo-migration-engine');
const GATES_DIR = path.join(DEMO2_DIR, 'gates');
const GATE_RUNNER = path.join(GATES_DIR, 'gate-runner.js');
// Gate-failure injection via fixture-local marker (Issue #174): workflow-level
// gates run under the allowlist-only supervised env (Issue #151), so
// CLI-process env like SIMULATE_GATE_FAILURE never reaches the gate child.
// DIRECT gate spawns keep the env channel — it still works there.
const GATE_FAILURE_MARKER = path.join(GATES_DIR, '.simulate-gate-failure-boundary');
function setGateFailure(on) {
  if (on) fs.writeFileSync(GATE_FAILURE_MARKER, 'on');
  else try { fs.rmSync(GATE_FAILURE_MARKER, { force: true }); } catch { /* already gone */ }
}
const POST_MERGE_CMD = path.join(GATES_DIR, 'post-merge-test-gate.cmd');
const DEMO_WORKFLOW_PATH = path.join(DEMO2_DIR, 'workflow.ts');

function createTempDir(prefix = 'demo2-adv-') {
  const tmpBase = os.tmpdir();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const dirPath = path.join(tmpBase, `${prefix}${Date.now()}-${randomSuffix}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function cleanupTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

function runWorkflowCLI(args, options = {}) {
  const binCli = path.join(ROOT_DIR, 'bin', 'workflow.js');
  const startTime = Date.now();

  const spawnArgs = [
    '--experimental-strip-types',
    binCli,
    ...args,
  ];

  const mergedEnv = {
    ...process.env,
    ...(options.env || {}),
  };

  const proc = spawnSync(process.execPath, spawnArgs, {
    cwd: options.cwd || ROOT_DIR,
    env: mergedEnv,
    timeout: options.timeoutMs || 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMs = Date.now() - startTime;
  const stdout = proc.stdout ? proc.stdout.trim() : '';
  const stderr = proc.stderr ? proc.stderr.trim() : '';
  const exitCode = proc.status !== null ? proc.status : (proc.error ? 1 : 0);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
  };
}

// ============================================================================
// SUITE 1: GATE FAILURE HANDLING & COMPILER ERROR LOGGING
// ============================================================================

test('Adversarial Challenge 1: Gate Failure Handling & Compiler Diagnostics', async (suite) => {
  const tempDir = createTempDir('demo2-gate-test-');

  suite.after(() => {
    cleanupTempDir(tempDir);
  });

  await suite.test('1.1: gate-runner.js post-merge in mock mode exits 0', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-merge', '--mock'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0, 'post-merge gate in mock mode must exit 0');
    assert.ok(res.stdout.includes('Post-Merge Compilation & Test Gate PASSED'));
  });

  await suite.test('1.2: gate-runner.js post-merge with SIMULATE_GATE_FAILURE=true exits 1 and logs TS2339 error', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-merge', '--mock'], {
      cwd: ROOT_DIR,
      env: { ...process.env, SIMULATE_GATE_FAILURE: 'true' },
      encoding: 'utf-8',
    });
    assert.equal(res.status, 1, 'Simulated gate failure must exit 1');
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(combined.includes('Simulated Gate Failure Triggered'), 'Output must announce simulated failure');
    assert.ok(combined.includes('TS2339'), 'Output must log TS2339 compiler error');
    assert.ok(combined.includes("Property 'promise' does not exist"), 'Output must log property promise missing error');
    assert.ok(combined.includes('Compiler diagnostics failed in src/s3-service.ts'), 'Output must log failing file location');
  });

  await suite.test('1.3: gate-runner.js post-merge on real broken syntax code exits 1 and logs compiler diagnostic', () => {
    const brokenDir = path.join(tempDir, 'broken-repo');
    const testsDir = path.join(brokenDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });

    // Inject invalid TypeScript syntax in test runner
    fs.writeFileSync(
      path.join(testsDir, 's3-service.test.ts'),
      'const brokenType: number = "string"; function ( { { { invalid syntax !!',
      'utf-8'
    );

    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-merge', `--cwd=${brokenDir}`], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });

    assert.equal(res.status, 1, 'Broken syntax must cause exit 1');
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(combined.includes('Gate execution failed in mode "post-merge"'));
    assert.ok(combined.includes('SyntaxError') || combined.includes('ERR_INVALID_TYPESCRIPT_SYNTAX'));
  });

  await suite.test('1.4: gate-runner.js exit code contract: unknown mode exits 2, unknown flag exits 2', () => {
    const resMode = spawnSync(process.execPath, [GATE_RUNNER, 'unknown-gate-mode'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });
    assert.equal(resMode.status, 2, 'Unknown mode must exit with code 2');

    const resFlag = spawnSync(process.execPath, [GATE_RUNNER, 'post-merge', '--invalid-flag-xyz'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });
    assert.equal(resFlag.status, 2, 'Unknown flag must exit with code 2');
  });

  await suite.test('1.5: Native Windows .cmd post-merge gate exits 0 in mock mode and 1 on simulated failure', () => {
    if (process.platform === 'win32') {
      const resPass = spawnSync('cmd.exe', ['/c', POST_MERGE_CMD, '--mock'], {
        cwd: DEMO2_DIR,
        encoding: 'utf-8',
      });
      assert.equal(resPass.status, 0, 'post-merge-test-gate.cmd --mock must exit 0');

      const resFail = spawnSync('cmd.exe', ['/c', POST_MERGE_CMD, '--mock'], {
        cwd: DEMO2_DIR,
        env: { ...process.env, SIMULATE_GATE_FAILURE: 'true' },
        encoding: 'utf-8',
      });
      assert.equal(resFail.status, 1, 'post-merge-test-gate.cmd with SIMULATE_GATE_FAILURE must exit 1');
      assert.ok(`${resFail.stdout}\n${resFail.stderr}`.includes('TS2339'));
    }
  });

  await suite.test('1.6: End-to-end workflow execution halts at Phase 4 on gate failure, logs TS2339, and blocks Phase 5', async () => {
    const runDir = path.join(tempDir, 'run-e2e-gate-fail');
    const runId = `run-postmerge-fail-${Date.now()}`;

    // Step A: Pre-populate checkpoints up to Phase 3 using INTERRUPT_AT=2
    const stepARes = runWorkflowCLI([
      'run',
      DEMO_WORKFLOW_PATH,
      '--mock',
      '--output-dir', runDir,
      '--resume-from-failed', runId,
    ], {
      env: { INTERRUPT_AT: '2' },
    });
    assert.equal(stepARes.exitCode, 1, 'Step A must halt at interrupt point');

    // Step B: Resume execution with the gate-failure marker on (Issue #174)
    setGateFailure(true);
    const stepBRes = runWorkflowCLI([
      'run',
      DEMO_WORKFLOW_PATH,
      '--mock',
      '--output-dir', runDir,
      '--resume-from-failed', runId,
    ], {
      env: { INTERRUPT_AT: '' },
    });
    setGateFailure(false);

    // 1. Assert CLI halts with exit code 1
    assert.equal(stepBRes.exitCode, 1, 'Workflow must exit 1 on post-merge gate failure');

    const combinedOutput = `${stepBRes.stdout}\n${stepBRes.stderr}`;

    // 2. Assert step-4-post-merge-gate is recorded as failed
    assert.ok(
      combinedOutput.includes('step-4-post-merge-gate') && combinedOutput.includes('failed with exit code 1'),
      'Output must indicate step-4-post-merge-gate failed with exit code 1'
    );

    // 3. Assert compiler diagnostic error is verbatim logged
    assert.ok(
      combinedOutput.includes('TS2339: Property \'promise\' does not exist'),
      'Compiler error TS2339 must be logged in failure report'
    );
    assert.ok(
      combinedOutput.includes('Compiler diagnostics failed in src/s3-service.ts'),
      'Failing source file must be logged in compiler diagnostics'
    );

    // 4. Assert Phase 5 is completely blocked (never reached or completed)
    assert.ok(
      !combinedOutput.includes('Phase 5: Release Synthesis & PR Generation') ||
      !combinedOutput.includes('Step completed: step-5-summary'),
      'Phase 5 PR generation must NOT complete when gate fails'
    );

    // 5. Assert deliverable PULL_REQUEST.md was NOT created in artifact directory
    const prPath = path.join(runDir, 'PULL_REQUEST.md');
    assert.equal(fs.existsSync(prPath), false, 'PULL_REQUEST.md must NOT exist on failed gate run');

    // 6. Verify SQLite checkpoints state
    const dbPath = path.join(runDir, 'checkpoints.db');
    assert.ok(fs.existsSync(dbPath), 'checkpoints.db must exist');
    const store = new SQLiteStateStore(dbPath);
    const checkpoints = await store.getAllCheckpoints(runId);
    store.close();

    assert.ok(checkpoints['step-4-post-merge-gate'], 'Checkpoint for step-4-post-merge-gate must exist');
    assert.equal(checkpoints['step-4-post-merge-gate'].status, 'failed', 'step-4-post-merge-gate must be status: failed');
    assert.equal(checkpoints['step-5-summary'], undefined, 'step-5-summary checkpoint must NOT exist');
  });
});

// ============================================================================
// SUITE 2: AST PROBE BOUNDARY CONDITIONS & RESILIENCE
// ============================================================================

test('Adversarial Challenge 2: AST Probe Boundary Conditions & Edge Cases', async (suite) => {
  const tempDir = createTempDir('demo2-ast-boundary-');

  suite.after(() => {
    cleanupTempDir(tempDir);
  });

  await suite.test('2.1: Empty files (0 bytes) are scanned gracefully without exceptions', async () => {
    const repoDir = path.join(tempDir, 'empty-repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'empty.ts'), '');
    fs.writeFileSync(path.join(srcDir, 'whitespace.ts'), '   \n\n\t\t\n   ');

    const result = await scanCodebase(repoDir);
    assert.equal(result.affectedFiles.length, 0, 'Empty files must produce 0 affected files');
    assert.equal(result.totalOccurrences, 0, 'Total occurrences must be 0');
    assert.ok(result.scanTimestamp, 'Timestamp must be populated');
  });

  await suite.test('2.2: Non-TypeScript files are handled safely by extension filter or text parser', async () => {
    const repoDir = path.join(tempDir, 'non-ts-repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Files with non-TS extensions
    fs.writeFileSync(path.join(srcDir, 'README.md'), '# Documentation\nMentions `new AWS.S3()` in docs.');
    fs.writeFileSync(path.join(srcDir, 'config.json'), '{"service": "new AWS.S3()"}');
    fs.writeFileSync(path.join(srcDir, 'styles.css'), '.s3-class { color: red; }');
    fs.writeFileSync(path.join(srcDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x41, 0x57, 0x53]));

    // Default scan ignores non-matching extensions
    const defaultScan = await scanCodebase(repoDir);
    assert.equal(defaultScan.affectedFiles.length, 0, 'Default scan should ignore .md, .json, .css, .dat');

    // Explicit scan with extended file extensions does not crash on non-TS files
    const explicitScan = await scanCodebase({
      repoPath: repoDir,
      fileExtensions: ['.md', '.json', '.css', '.txt'],
    });
    assert.ok(Array.isArray(explicitScan.affectedFiles), 'Explicit scan must return valid array');
  });

  await suite.test('2.3: Files with invalid TypeScript syntax and malformed code do not crash AST scanner', async () => {
    const repoDir = path.join(tempDir, 'syntax-err-repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // File 1: Syntax errors without AWS SDK
    fs.writeFileSync(
      path.join(srcDir, 'bad-syntax.ts'),
      'export const ??? = ;;; function ( { { { class 1234 { invalid syntax (((('
    );

    // File 2: Syntax errors WITH AWS SDK usage
    fs.writeFileSync(
      path.join(srcDir, 'bad-syntax-with-aws.ts'),
      `import AWS from 'aws-sdk';
const s3 = new AWS.S3();
let unclosed = {{{ ;;;
s3.upload({ Bucket: "test", Key: "k" }).promise();
broken ??? invalid tokens`
    );

    const result = await scanCodebase(repoDir);

    // Scanner should successfully process both files without throwing
    assert.ok(result.affectedFiles.length >= 1, 'Scanner should detect AWS call sites even with syntax errors');
    const detectedFile = result.affectedFiles.find((f) => f.filePath.includes('bad-syntax-with-aws.ts'));
    assert.ok(detectedFile, 'Must identify bad-syntax-with-aws.ts as affected');
    assert.ok(detectedFile.deprecatedImports.length > 0, 'Must extract import');
    assert.ok(detectedFile.detectedCallSites.length > 0, 'Must extract call site');
  });

  await suite.test('2.4: Corrupted or missing package.json falls back safely to default version', async () => {
    const repoDir = path.join(tempDir, 'corrupt-pkg-repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Write malformed JSON into package.json
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{ invalid json package.json content !!!!');

    const result = await scanCodebase(repoDir);
    assert.equal(result.detectedSourceVersion, 'aws-sdk@2.x', 'Must fall back to default aws-sdk@2.x');

    // Missing package.json
    fs.rmSync(path.join(repoDir, 'package.json'));
    const resultMissing = await scanCodebase(repoDir);
    assert.equal(resultMissing.detectedSourceVersion, 'aws-sdk@2.x', 'Missing package.json must fall back safely');
  });

  await suite.test('2.5: Non-existent repository path returns safe zero-result object', async () => {
    const nonExistentPath = path.join(tempDir, 'path-does-not-exist-' + Date.now());
    const result = await scanCodebase(nonExistentPath);

    assert.equal(result.affectedFiles.length, 0);
    assert.equal(result.totalOccurrences, 0);
  });

  await suite.test('2.6: Deeply nested directory structure is traversed completely', async () => {
    const repoDir = path.join(tempDir, 'nested-repo');
    const deepDir = path.join(repoDir, 'src', 'level1', 'level2', 'level3', 'level4');
    fs.mkdirSync(deepDir, { recursive: true });

    fs.writeFileSync(
      path.join(deepDir, 'nested-s3.ts'),
      `import AWS from 'aws-sdk';
const s3 = new AWS.S3();
s3.getObject({ Bucket: 'b', Key: 'k' }).promise();`
    );

    const result = await scanCodebase(repoDir);
    assert.equal(result.affectedFiles.length, 1);
    assert.ok(result.affectedFiles[0].filePath.includes('level4'));
  });

  await suite.test('2.7: Fast-Check property fuzzing with 100 random source strings does not crash AST scanner', async () => {
    const repoDir = path.join(tempDir, 'fuzz-repo');
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fuzzFile = path.join(srcDir, 'fuzz-target.ts');

    await fc.assert(
      fc.asyncProperty(fc.fullUnicodeString({ maxLength: 1000 }), async (randomCode) => {
        fs.writeFileSync(fuzzFile, randomCode, 'utf-8');
        try {
          const res = await scanCodebase(repoDir);
          assert.ok(Array.isArray(res.affectedFiles));
          return true;
        } catch (err) {
          assert.fail(`AST scanner crashed on random input: ${err.message}`);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// SUITE 3: LIVE MODE VS MOCK MODE INTEGRITY
// ============================================================================

test('Adversarial Challenge 3: Live Mode vs Mock Mode Integrity', async (suite) => {
  await suite.test('3.1: Running without --mock engages authentic agent RPC and does NOT return canned mock data', () => {
    // In live mode without --mock, mockResponse is undefined.
    // The engine invokes the actual agent ask() pipeline with Schema validation and auto-repair.
    // Because no live LLM API key / backend is supplied in test environment, the provider's unaligned
    // default output fails runtime Zod validation for MigrationPlanSchema after 3 repair attempts.
    const res = runWorkflowCLI(['run', DEMO_WORKFLOW_PATH]);

    // 1. Must exit with code 1
    assert.equal(res.exitCode, 1, 'Live mode without valid provider must fail with exit code 1');

    const combinedOutput = `${res.stdout}\n${res.stderr}`;

    // 2. Must NOT claim mock provider mode
    assert.equal(
      combinedOutput.includes('Execution mode: Deterministic Mock Provider'),
      false,
      'Live execution must NOT display Deterministic Mock Provider header'
    );

    // 3. Must execute Phase 1 and Phase 2a live, then fail inside agent RPC on step-2b-architect
    assert.ok(
      combinedOutput.includes('step-1-baseline-gate'),
      'Step 1 baseline gate should execute'
    );
    assert.ok(
      combinedOutput.includes('step-2a-ast-scan'),
      'Step 2a AST scan should execute'
    );
    assert.ok(
      combinedOutput.includes('step-2b-architect') && combinedOutput.includes('Schema validation failed for step "migration-architect" after 3 repair attempts'),
      'Step 2b must fail on genuine schema validation and repair loops rather than bypassing with canned mock data'
    );
  });

  await suite.test('3.2: Running with --mock executes deterministic mock pipeline adhering to <4s SLA', () => {
    const tempDir = createTempDir('demo2-mock-sla-');
    try {
      const res = runWorkflowCLI(['run', DEMO_WORKFLOW_PATH, '--mock', '--output-dir', tempDir]);

      assert.equal(res.exitCode, 0, `Mock run failed: ${res.stderr}\n${res.stdout}`);
      assert.ok(res.durationMs < MOCK_RUN_SLA_MS, `Execution took ${res.durationMs}ms, exceeding ${MOCK_RUN_SLA_MS}ms SLA (Issue #137 tolerance scheme)`);
      assert.ok(res.stdout.includes('Workflow completed successfully'));

      // Verify generated deliverables
      assert.ok(fs.existsSync(path.join(tempDir, 'PULL_REQUEST.md')), 'PULL_REQUEST.md must exist');
      assert.ok(fs.existsSync(path.join(tempDir, 'kanban.json')), 'kanban.json must exist');
      assert.ok(fs.existsSync(path.join(tempDir, 'dag.html')), 'dag.html must exist');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  await suite.test('3.3: Mock response isolation: all 5 roles have isolated, schema-valid bundles', () => {
    // Role 1: Migration Architect
    const architectMock = getMockResponseForRole('migration-architect');
    const parseArchitect = MigrationPlanSchema.safeParse(architectMock);
    assert.equal(parseArchitect.success, true, 'MigrationPlan mock must strictly satisfy MigrationPlanSchema');

    // Role 2: Code Transformer (S3, DynamoDB, SQS)
    for (const service of ['s3', 'dynamo', 'sqs']) {
      const workerMock = getMockResponseForRole('code-transformer', service);
      const parseWorker = CodeTransformResultSchema.safeParse(workerMock);
      assert.equal(parseWorker.success, true, `Transformer (${service}) mock must satisfy CodeTransformResultSchema`);
    }

    // Role 3: Code Reviewer (S3, DynamoDB, SQS)
    for (const service of ['s3', 'dynamo', 'sqs']) {
      const reviewerMock = getMockResponseForRole('code-reviewer', service);
      const parseReviewer = CodeReviewResultSchema.safeParse(reviewerMock);
      assert.equal(parseReviewer.success, true, `Reviewer (${service}) mock must satisfy CodeReviewResultSchema`);
      assert.equal(parseReviewer.data.approved, true);
      assert.ok(parseReviewer.data.reviewScore >= 0.9);
    }

    // Role 4: Type Fixer
    const fixerMock = getMockResponseForRole('type-fixer');
    const parseFixer = CompilerFixResultSchema.safeParse(fixerMock);
    assert.equal(parseFixer.success, true, 'CompilerFix mock must satisfy CompilerFixResultSchema');
    assert.equal(parseFixer.data.resolved, true);

    // Role 5: Migration Summary
    const summaryMock = getMockResponseForRole('migration-summary');
    const parseSummary = MigrationSummaryReportSchema.safeParse(summaryMock);
    assert.equal(parseSummary.success, true, 'Summary mock must satisfy MigrationSummaryReportSchema');
    assert.equal(parseSummary.data.compilerPassStatus, true);
    assert.equal(parseSummary.data.testsPassStatus, true);
  });
});
