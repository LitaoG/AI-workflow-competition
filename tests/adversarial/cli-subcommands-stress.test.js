import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSlashArgs } from '../../dist/src/cli/slash-parser.js';
import { executeProbe } from '../../dist/src/cli/commands/probe.js';
import { executeReplay } from '../../dist/src/cli/commands/replay.js';
import { executeRun } from '../../dist/src/cli/commands/run.js';
import { executeInit } from '../../dist/src/cli/commands/init.js';
import { SQLiteStateStore } from '../../dist/src/state/sqlite-store.js';

const TEST_DIR = path.join(process.cwd(), 'tests', 'adversarial', 'fixtures', 'cli-stress');

function setupCleanDir(subDir) {
  const dir = path.join(TEST_DIR, subDir);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('CLI Stress 1: /workflow slash parser edge cases', () => {
  // Case A: Standard /workflow prefix
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/workflow', 'run', 'test.ts']),
    ['node', 'bin/workflow.js', 'run', 'test.ts']
  );

  // Case B: Colon-delimited /workflow:run
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/workflow:run', 'test.ts', '--mock']),
    ['node', 'bin/workflow.js', 'run', 'test.ts', '--mock']
  );

  // Case C: Direct slash subcommands: /run, /replay, /probe, /init
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/run', 'workflow.ts']),
    ['node', 'bin/workflow.js', 'run', 'workflow.ts']
  );
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/replay', 'run-123', '--step', 'step-1']),
    ['node', 'bin/workflow.js', 'replay', 'run-123', '--step', 'step-1']
  );
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/probe', '--json']),
    ['node', 'bin/workflow.js', 'probe', '--json']
  );
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/init', 'basic', './my-app']),
    ['node', 'bin/workflow.js', 'init', 'basic', './my-app']
  );

  // Case D: Chained slash commands (/workflow /run)
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/workflow', '/run', 'workflow.ts']),
    ['node', 'bin/workflow.js', 'run', 'workflow.ts']
  );

  // Case E: Windows flags or non-command slashes preserved
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '/?']),
    ['node', 'bin/workflow.js', '/?']
  );
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', '//']),
    ['node', 'bin/workflow.js', '//']
  );

  // Case F: Standard un-slashed invocations unchanged
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js', 'run', 'workflow.ts', '--mock']),
    ['node', 'bin/workflow.js', 'run', 'workflow.ts', '--mock']
  );
  assert.deepEqual(
    normalizeSlashArgs(['node', 'bin/workflow.js']),
    ['node', 'bin/workflow.js']
  );
});

test('CLI Stress 2: probe --json output validity, schema, and secret sanitization', async () => {
  // Capture console.log
  const originalLog = console.log;
  let capturedOutput = '';
  console.log = (msg) => {
    capturedOutput += msg + '\n';
  };

  try {
    const exitCode = await executeProbe(process.cwd(), { json: true });
    assert.equal(exitCode, 0, 'probe --json must exit with code 0');

    // Parse output as valid JSON
    const parsed = JSON.parse(capturedOutput.trim());

    // Verify schema contracts
    assert.ok(parsed.snapshotId, 'Must contain snapshotId');
    assert.ok(parsed.timestamp, 'Must contain timestamp');
    assert.ok(parsed.system, 'Must contain system info');
    assert.ok(parsed.git, 'Must contain git info');
    assert.ok(parsed.toolchain, 'Must contain toolchain info');
    assert.ok(parsed.env, 'Must contain env');
    assert.ok(!('sanitizedEnv' in parsed), 'Must not contain the redundant sanitizedEnv duplicate (Issue #36)');

    // Verify git and toolchain fields
    assert.equal(typeof parsed.git.isGitRepo, 'boolean');
    assert.ok(parsed.toolchain.node, 'Must report node version');

    // Verify secret sanitization in JSON output
    for (const [k, v] of Object.entries(parsed.env)) {
      if (/(secret|key|token|password)/i.test(k)) {
        assert.equal(v, '***REDACTED***', `Key ${k} must be redacted in JSON output`);
      }
    }
  } finally {
    console.log = originalLog;
  }
});

test('CLI Stress 3: replay <runId> --step <stepId> edge cases and failure modes', async (t) => {
  const wsDir = setupCleanDir('replay-cli');
  // The workspace is disposable runtime state, not a fixture: remove it when
  // the test ends (success or failure) so no residue lands in the tree.
  t.after(() => {
    try {
      fs.rmSync(wsDir, { recursive: true, force: true });
    } catch {
      /* a store handle may briefly hold the dir on Windows */
    }
  });
  const runId = 'cli-replay-run-1';
  const effectsPath = path.join(wsDir, 'effects.jsonl');
  const defPath = path.join(wsDir, 'wf.cli-replay.mjs');

  // The honest replay contract rebuilds the Workflow from the persisted
  // definition copy (`workflow.source.*`) and really re-executes invalidated
  // steps — so the run must be produced by the real run command (which binds
  // inputHash to every checkpoint and persists the definition byte copy).
  // phase2-step1 fails transiently until the effects file gains a repair mark.
  fs.writeFileSync(defPath, `
import * as fs from 'node:fs';
const EFFECTS = ${JSON.stringify(effectsPath)};
export default {
  name: 'cli-replay-stress-workflow',
  phases: ['phase-1', 'phase-2'],
  steps: [
    {
      id: 'phase1-step1', name: 'Phase1 Step1', phase: 'phase-1', role: 'worker',
      execute: async () => { fs.appendFileSync(EFFECTS, 'phase1-step1\\n', 'utf-8'); return { phase1: 'ok' }; }
    },
    {
      id: 'phase1-step2', name: 'Phase1 Step2', phase: 'phase-1', role: 'worker', dependsOn: ['phase1-step1'],
      execute: async () => { fs.appendFileSync(EFFECTS, 'phase1-step2\\n', 'utf-8'); return { phase2: 'ok' }; }
    },
    {
      id: 'phase2-step1', name: 'Phase2 Step1', phase: 'phase-2', role: 'worker', dependsOn: ['phase1-step2'],
      execute: async () => {
        const current = fs.existsSync(EFFECTS) ? fs.readFileSync(EFFECTS, 'utf-8') : '';
        if (!current.split('\\n').includes('repair')) throw new Error('Mock step failure');
        fs.appendFileSync(EFFECTS, 'phase2-step1\\n', 'utf-8');
        return { done: true };
      }
    },
  ],
};
`, 'utf-8');

  const setupCode = await executeRun(defPath, { resumeFromFailed: runId, cwd: wsDir });
  assert.equal(setupCode, 1, 'Initial run must fail at the transiently failing phase2-step1');
  const dbPath = path.join(wsDir, '.workflow', 'runs', runId, 'checkpoints.db');
  assert.ok(fs.existsSync(dbPath), 'checkpoints.db must exist for the seeded run');

  // Test Case A: Valid replay starting from step 'phase1-step2'. The engine
  // deletes that checkpoint, genuinely re-executes it and the failed
  // downstream step, and short-circuits the completed upstream.
  fs.appendFileSync(effectsPath, 'repair\n', 'utf-8');
  const exitCodeStep = await executeReplay(runId, { step: 'phase1-step2', cwd: wsDir });
  assert.equal(exitCodeStep, 0, 'Replay from valid step must succeed and return exit code 0');

  // Real re-execution proof: the invalidated step ran again (second side
  // effect) and the previously failed step genuinely executed after repair.
  const effects = fs.readFileSync(effectsPath, 'utf-8').split('\n').filter((line) => line.length > 0);
  assert.deepEqual(
    effects,
    ['phase1-step1', 'phase1-step2', 'repair', 'phase1-step2', 'phase2-step1'],
    'replay must genuinely re-execute the invalidated step, not fabricate a result'
  );

  // Verify checkpoints were updated in db (real completed checkpoint, hash-bound)
  const verifyStore = new SQLiteStateStore(dbPath);
  const replayedCp = await verifyStore.getCheckpoint(runId, 'phase1-step2');
  assert.equal(replayedCp?.status, 'completed');
  assert.ok(replayedCp?.inputHash, 're-executed checkpoint must carry the input binding');
  const allCheckpoints = await verifyStore.getAllCheckpoints(runId);
  verifyStore.close();
  assert.equal(allCheckpoints['phase2-step1']?.status, 'completed', 'the formerly failed step must now be completed for real');
  assert.equal(allCheckpoints['phase1-step1']?.status, 'completed', 'the upstream step must remain short-circuited');

  // Test Case B: Non-existent stepId returns exit code 1
  const exitCodeInvalidStep = await executeReplay(runId, { step: 'non-existent-step-404', cwd: wsDir });
  assert.equal(exitCodeInvalidStep, 1, 'Replay with non-existent step must return exit code 1');

  // Test Case C: Non-existent runId returns exit code 1
  const exitCodeInvalidRun = await executeReplay('ghost-run-id-9999', { cwd: wsDir });
  assert.equal(exitCodeInvalidRun, 1, 'Replay with non-existent runId must return exit code 1');
});

test('CLI Stress 4: init <template> <targetDir> scaffolding and conflict handling', async () => {
  const testDir = setupCleanDir('init-cli');

  // Case A: Scaffold basic template
  const basicDir = path.join(testDir, 'custom-basic-app');
  const exitCodeBasic = await executeInit('basic', { dir: basicDir });
  assert.equal(exitCodeBasic, 0, 'Init basic template must exit 0');

  // Verify generated files
  assert.ok(fs.existsSync(path.join(basicDir, 'workflow.ts')));
  assert.ok(fs.existsSync(path.join(basicDir, 'package.json')));
  assert.ok(fs.existsSync(path.join(basicDir, 'tsconfig.json')));
  assert.ok(fs.existsSync(path.join(basicDir, 'README.md')));
  assert.ok(fs.existsSync(path.join(basicDir, '.gitignore')));

  // Verify package.json contains custom directory basename
  const pkg = JSON.parse(fs.readFileSync(path.join(basicDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, 'custom-basic-app');

  // Verify .gitignore ignores sensitive and build directories
  const gitignore = fs.readFileSync(path.join(basicDir, '.gitignore'), 'utf-8');
  assert.ok(gitignore.includes('node_modules'));
  assert.ok(gitignore.includes('.workflow'));

  // Case B: Scaffold multi-agent template
  const multiDir = path.join(testDir, 'custom-multi-app');
  const exitCodeMulti = await executeInit('multi-agent', { dir: multiDir });
  assert.equal(exitCodeMulti, 0, 'Init multi-agent template must exit 0');
  const multiWorkflow = fs.readFileSync(path.join(multiDir, 'workflow.ts'), 'utf-8');
  assert.ok(multiWorkflow.includes('multi-agent-workflow'));

  // Case C: Invalid template returns code 1
  const exitCodeInvalid = await executeInit('invalid-template-xyz', { dir: path.join(testDir, 'invalid') });
  assert.equal(exitCodeInvalid, 1, 'Invalid template must return exit code 1');

  // Case D: Re-initializing existing non-empty directory without --force fails with code 1
  const exitCodeConflict = await executeInit('basic', { dir: basicDir });
  assert.equal(exitCodeConflict, 1, 'Init into non-empty directory without force must fail with code 1');

  // Case E: Re-initializing with --force succeeds with code 0
  const exitCodeForced = await executeInit('basic', { dir: basicDir, force: true });
  assert.equal(exitCodeForced, 0, 'Init into non-empty directory with force must succeed with code 0');
});
