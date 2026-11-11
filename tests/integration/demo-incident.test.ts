import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteStateStore, EventLogReader } from 'ai-workflow';

// Anchor the suite at the repo root via this file's compiled location
// (dist/tests/integration/) — same convention as demo-facade-incident.test.ts —
// so the spawned CLI, demo and artifact paths never depend on the caller's cwd
// (the gate may invoke node --test with absolute test paths from any directory).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runCLI(args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): CLIResult {
  const rootDir = REPO_ROOT;
  const binCli = path.join(rootDir, 'bin', 'workflow.js');
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
    cwd: options.cwd || rootDir,
    env: mergedEnv,
    timeout: options.timeoutMs || 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMs = Date.now() - startTime;
  const stdout = proc.stdout ? proc.stdout.trim() : '';
  const stderr = proc.stderr ? proc.stderr.trim() : '';
  const rawExitCode = proc.status ?? (proc.error ? 1 : 0);
  const exitCode = rawExitCode > 0 ? 1 : 0;

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
  };
}

function createTempDir(prefix = 'demo1-integ-'): string {
  const tmpBase = os.tmpdir();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const dirPath = path.join(tmpBase, `${prefix}${Date.now()}-${randomSuffix}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

// Issue #233 diagnostic: when artifacts go missing under load, the listing
// makes the next red self-identifying (what actually got written).
function dirListing(dirPath: string): string {
  try {
    return fs.readdirSync(dirPath).join(', ') || '(empty dir)';
  } catch (err: any) {
    return `(readdir failed: ${err?.code ?? err?.message})`;
  }
}

test('Integration Suite: Demo 1 — Incident Triage & Automated Remediation', async (t) => {
  const tempDir = createTempDir('demo1-integ-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  const demoWorkflowPath = path.resolve(REPO_ROOT, 'demos', 'incident-triage-remediation', 'workflow.ts');

  await t.test('TEST 1: Default P1 DB Connection Pool Exhaustion executes end-to-end in <15s with exit code 0', () => {
    const outputDir = path.join(tempDir, 'run-01-db-pool');
    const startTime = Date.now();

    const res = runCLI(['run', demoWorkflowPath, '--mock', '--output-dir', outputDir], {
      // cwd is sandboxed to the suite temp dir: the demo exports artifacts to
      // process.cwd()/artifacts, and run.ts mirrors to <cwd>/.workflow/runs.db —
      // both must stay off the shared repository state (gate round 1 races).
      cwd: tempDir,
      env: { SCENARIO: 'p1_db_pool_exhaustion' },
    });

    const elapsed = Date.now() - startTime;
    assert.equal(res.exitCode, 0, `Workflow failed with stderr: ${res.stderr}\nStdout: ${res.stdout}`);
    // Speed semantics kept deliberately (mock mode must not get slow) — same
    // rationale as the Demo 2 suite: this offline mock run was measured at
    // 4.1-6.8s under full-suite parallel load while the run itself was healthy
    // (spawn contention, not a regression), so the 4,000ms bound flaked. 15,000ms
    // tolerates the suite's parallel load; a genuinely broken mock run fails
    // much louder (the 30s spawnSync timeout).
    assert.ok(elapsed < 15000, `Execution time (${elapsed}ms) exceeded 15,000ms threshold`);

    // Verify stdout contains phase progression
    assert.ok(res.stdout.includes('phase-1') || res.stdout.includes('Detection'), 'Stdout should show Phase 1');
    assert.ok(res.stdout.includes('phase-2') || res.stdout.includes('Triage'), 'Stdout should show Phase 2');
    assert.ok(res.stdout.includes('phase-3') || res.stdout.includes('Remediation'), 'Stdout should show Phase 3');
    assert.ok(res.stdout.includes('phase-4') || res.stdout.includes('Gate'), 'Stdout should show Phase 4');
    assert.ok(res.stdout.includes('phase-5') || res.stdout.includes('Post-Mortem'), 'Stdout should show Phase 5');
  });

  await t.test('TEST 2: Checkpoint persistence records all 5 phases as completed in SQLite', async () => {
    const outputDir = path.join(tempDir, 'run-01-db-pool');
    const dbPath = path.join(outputDir, 'checkpoints.db');
    assert.ok(fs.existsSync(dbPath), `Checkpoints database does not exist at ${dbPath} (dir listing: ${dirListing(outputDir)})`);

    const store = new SQLiteStateStore(dbPath);
    const runs = store.listRuns();
    assert.ok(runs.length > 0, `Runs should be recorded in checkpoints.db (dir listing: ${dirListing(outputDir)})`);
    const checkpoints = await store.getAllCheckpoints(runs[0].runId);
    store.close();

    assert.ok(Object.keys(checkpoints).length >= 5, 'Should record checkpoints for at least 5 steps');
    const stepIds = Object.keys(checkpoints);
    assert.ok(stepIds.some(id => id.includes('gate')), 'Gate step checkpoint must exist');

    // Verify event journal exists
    const eventLogPath = path.join(outputDir, 'events.jsonl');
    assert.ok(fs.existsSync(eventLogPath), 'events.jsonl should be generated');
    const events = await EventLogReader.readAll(eventLogPath);
    assert.ok(events.length >= 5, 'Should have logged at least 5 workflow events');
  });

  await t.test('TEST 3: Scenario 2 (p1_bad_deploy_regression) triggers GIT_ROLLBACK and identifies breaking commit', () => {
    const outputDir = path.join(tempDir, 'run-02-bad-deploy');
    const res = runCLI(['run', demoWorkflowPath, '--mock', '--output-dir', outputDir], {
      cwd: tempDir,
      env: { SCENARIO: 'p1_bad_deploy_regression' },
    });

    assert.equal(res.exitCode, 0, `Workflow failed with stderr: ${res.stderr}\nStdout: ${res.stdout}`);
    // Only this run's own exports (cwd sandboxed above) — the tracked
    // demos/<app>/artifacts fallbacks raced with parallel suites and served
    // stale other-scenario content (gate round 1).
    const postMortemCandidates = [
      path.join(outputDir, 'PostMortem.md'),
      path.join(tempDir, 'artifacts', 'PostMortem.md'),
    ];

    const postMortemPath = postMortemCandidates.find(p => fs.existsSync(p));
    assert.ok(postMortemPath, 'PostMortem.md should be generated');
    const postMortemContent = fs.readFileSync(postMortemPath, 'utf-8');
    assert.ok(
      postMortemContent.includes('CODE_REGRESSION') || postMortemContent.includes('GIT_ROLLBACK') || postMortemContent.includes('7f8a9b2'),
      'PostMortem should record code regression diagnosis'
    );
  });

  await t.test('TEST 4: Scenario 3 (p2_high_latency_leak) triggers RESTART_PODS strategy', () => {
    const outputDir = path.join(tempDir, 'run-03-mem-leak');
    const res = runCLI(['run', demoWorkflowPath, '--mock', '--output-dir', outputDir], {
      cwd: tempDir,
      env: { SCENARIO: 'p2_high_latency_leak' },
    });

    assert.equal(res.exitCode, 0, `Workflow failed with stderr: ${res.stderr}\nStdout: ${res.stdout}`);
    // Only this run's own exports (cwd sandboxed above) — see TEST 3.
    const postMortemCandidates = [
      path.join(outputDir, 'PostMortem.md'),
      path.join(tempDir, 'artifacts', 'PostMortem.md'),
    ];

    const postMortemPath = postMortemCandidates.find(p => fs.existsSync(p));
    assert.ok(postMortemPath, 'PostMortem.md should be generated');
    const postMortemContent = fs.readFileSync(postMortemPath, 'utf-8');
    assert.ok(
      postMortemContent.includes('RESTART_PODS') || postMortemContent.includes('MEMORY_LEAK_OOM') || postMortemContent.includes('4a3b2c1'),
      'PostMortem should record memory leak diagnosis'
    );
  });

  await t.test('TEST 5: UI Parity Artifacts (dag.html & kanban.json) are valid and well-formed', () => {
    const outputDir = path.join(tempDir, 'run-01-db-pool');

    // 1. Verify DAG HTML visualizer
    const dagPath = path.join(outputDir, 'dag.html');
    assert.ok(fs.existsSync(dagPath), `dag.html must be exported (dir listing: ${dirListing(outputDir)})`);
    const dagHtml = fs.readFileSync(dagPath, 'utf-8');
    assert.ok(dagHtml.includes('<svg'), 'dag.html must contain SVG canvas');
    assert.ok(dagHtml.includes('bezier-edge') || dagHtml.includes('path'), 'dag.html must contain SVG path edges');
    assert.ok(dagHtml.includes('phase') || dagHtml.includes('Phase'), 'dag.html must show phases');

    // 2. Verify Kanban board JSON — only this suite's own exports
    const kanbanCandidates = [
      path.join(outputDir, 'kanban.json'),
      path.join(tempDir, 'artifacts', 'kanban.json'),
    ];
    const kanbanPath = kanbanCandidates.find(p => fs.existsSync(p));
    assert.ok(kanbanPath, 'kanban.json should exist');
    const kanbanJson = JSON.parse(fs.readFileSync(kanbanPath, 'utf-8'));
    assert.ok(Array.isArray(kanbanJson.columns), 'kanban.json must have columns array');
    assert.ok(kanbanJson.columns.length >= 4, 'kanban.json must contain at least 4 artifact columns');
  });

  await t.test('TEST 6: Bilingual localized execution (--lang zh) runs successfully and outputs Chinese metrics', () => {
    const outputDir = path.join(tempDir, 'run-04-zh');
    const res = runCLI(['run', demoWorkflowPath, '--mock', '--lang', 'zh', '--output-dir', outputDir], {
      cwd: tempDir,
    });

    assert.equal(res.exitCode, 0, `Workflow failed with stderr: ${res.stderr}\nStdout: ${res.stdout}`);
    // Check for Chinese output tokens
    assert.ok(
      res.stdout.includes('阶段') || res.stdout.includes('完成') || res.stdout.includes('智能体') || res.stdout.includes('步骤'),
      'Stdout should output Chinese localized messages'
    );
  });
});
