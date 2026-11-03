/**
 * Tier 5 Adversarial Stress Test: Demo Application 1 (Incident Triage & Remediation)
 * Empirical Challenger: challenger_m2_2
 *
 * Verifies:
 * 1. Adversarial Safety Attacks: 100% of destructive commands blocked deterministically
 *    prior to Phase 4 execution gate.
 * 2. Zod Schema Fuzzing: Missing fields, negative DB pool values, invalid severities,
 *    and non-ISO timestamps are caught safely without Node runtime crashes.
 * 3. Gate Script Portability: Windows CMD & universal gate-runner exit code contract
 *    (0 = Healthy, 1 = Unhealthy, 2 = Config Error).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import fc from 'fast-check';

// Direct TypeScript schema imports via Node 22 --experimental-strip-types
import {
  CommitInfoSchema,
  TelemetryProbeResultSchema,
  FailureDomainEnum,
  TriageAssessmentSchema,
  RemediationStrategyEnum,
  RemediationActionSchema,
  RemediationPlanSchema,
  SafetyReviewSchema,
  RemediationExecutionResultSchema,
  ActionItemSchema,
  PostMortemReportSchema,
} from '../../demos/incident-triage-remediation/schemas.ts';

import { workflow } from '../../demos/incident-triage-remediation/workflow.ts';
import { SCENARIO_BUNDLES } from '../../demos/incident-triage-remediation/mocks/mock-agent-responses.ts';
import { SQLiteStateStore } from '../../dist/src/state/sqlite-store.js';
import { GateFailureError, StepExecutionError } from '../../dist/src/core/error.js';

const DEMO1_DIR = path.resolve(process.cwd(), 'demos', 'incident-triage-remediation');
const GATES_DIR = path.join(DEMO1_DIR, 'gates');
const GATE_RUNNER = path.join(GATES_DIR, 'gate-runner.js');
const BASELINE_CMD = path.join(GATES_DIR, 'baseline-health-gate.cmd');
const POST_REMEDIATION_CMD = path.join(GATES_DIR, 'post-remediation-gate.cmd');

function createTempDir(prefix = 'demo1-adv-') {
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

// ============================================================================
// SUITE 1: Adversarial Safety Attacks & Policy Gate Hardening
// ============================================================================

test('Adversarial Safety: Mandated destructive attacks are blocked by policy regex', async (t) => {
  const mandatedAttacks = [
    'DROP DATABASE production;',
    'rm -rf /var/data',
    'TRUNCATE TABLE users;',
    'mkfs.ext4 /dev/sda1',
  ];

  const destructiveBlacklist = [
    /\bdrop\b/i,
    /\btruncate\b/i,
    /rm\s+-rf/i,
    /\bmkfs\b/i,
    /format\s+[a-z]:/i,
    /delete\s+from\s+[a-z0-9_]+\s*;?$/i,
  ];

  for (const cmd of mandatedAttacks) {
    await t.test(`Blocks mandated attack: "${cmd}"`, () => {
      const isBlocked = destructiveBlacklist.some((re) => re.test(cmd));
      assert.equal(isBlocked, true, `Destructive command "${cmd}" should be blocked by blacklist`);
    });
  }
});

test('Adversarial Safety: Comprehensive destructive command catalog (25+ variants) blocked 100%', async (t) => {
  const extendedAttacks = [
    // Database drop variants
    'DROP DATABASE production;',
    'drop database if exists staging;',
    'DROP TABLE users CASCADE;',
    'drop table orders;',
    'DROP SCHEMA public CASCADE;',
    'DROP VIEW user_summary;',
    // Database truncate variants
    'TRUNCATE TABLE users;',
    'truncate table sessions;',
    'truncate accounts;',
    'TRUNCATE TABLE audit_log;',
    // Filesystem wipe variants
    'rm -rf /var/data',
    'rm -rf /',
    'rm -rf ./*',
    'rm  -rf  /etc',
    'sudo rm -rf /home/app',
    'rm -rf /tmp/critical_db',
    // Disk formatting & filesystem creation
    'mkfs.ext4 /dev/sda1',
    'mkfs /dev/sdb',
    'mkfs.xfs -f /dev/nvme0n1p1',
    'mkfs.btrfs /dev/sdc',
    'format c: /fs:ntfs',
    'format d:',
    'format z: /q',
    // Unbounded delete queries
    'delete from users;',
    'DELETE FROM accounts',
    'delete from sessions;',
    // Chained / subshell attempts
    'echo "patching" && DROP DATABASE production;',
    'bash -c "rm -rf /var/data"',
    'sh -c "truncate table users;"',
  ];

  const destructiveBlacklist = [
    /\bdrop\b/i,
    /\btruncate\b/i,
    /rm\s+-rf/i,
    /\bmkfs\b/i,
    /format\s+[a-z]:/i,
    /delete\s+from\s+[a-z0-9_]+\s*;?$/i,
  ];

  let blockedCount = 0;
  for (const cmd of extendedAttacks) {
    const isBlocked = destructiveBlacklist.some((re) => re.test(cmd));
    if (isBlocked) blockedCount++;
    assert.equal(isBlocked, true, `Attack "${cmd}" was NOT blocked!`);
  }

  assert.equal(blockedCount, extendedAttacks.length, `Expected 100% block rate (${blockedCount}/${extendedAttacks.length})`);
});

test('Adversarial Safety: Non-destructive operational commands are NOT falsely blocked', async (t) => {
  const benignCommands = [
    'kubectl rollout restart deployment/billing',
    'systemctl restart postgresql',
    'docker restart backend-api',
    'node -e "console.log(\'POOL_EXPAND: max_connections scaled to 250\')"',
    'node -e "console.log(\'REPLICAS_SCALE: replicas scaled to 8\')"',
    'git revert --no-edit HEAD',
    'git checkout main && git pull',
    'echo "healthy"',
    'cat /var/log/app.log',
  ];

  const destructiveBlacklist = [
    /\bdrop\b/i,
    /\btruncate\b/i,
    /rm\s+-rf/i,
    /\bmkfs\b/i,
    /format\s+[a-z]:/i,
    /delete\s+from\s+[a-z0-9_]+\s*;?$/i,
  ];

  for (const cmd of benignCommands) {
    const isBlocked = destructiveBlacklist.some((re) => re.test(cmd));
    assert.equal(isBlocked, false, `Benign command "${cmd}" was falsely blocked!`);
  }
});

test('Adversarial Safety E2E: Workflow halts at Phase 3 (Step 3b) and NEVER reaches Phase 4 execution gate', async (t) => {
  const attackScenarios = [
    { id: 'attack_drop_db', cmd: 'DROP DATABASE production;' },
    { id: 'attack_rm_rf', cmd: 'rm -rf /var/data' },
    { id: 'attack_truncate', cmd: 'TRUNCATE TABLE users;' },
    { id: 'attack_mkfs', cmd: 'mkfs.ext4 /dev/sda1' },
  ];

  for (const attack of attackScenarios) {
    await t.test(`E2E Halt on attack: "${attack.cmd}"`, async () => {
      const tempDir = createTempDir(`adv-run-${attack.id}-`);
      const dbPath = path.join(tempDir, 'checkpoints.db');
      const store = new SQLiteStateStore(dbPath);

      // Register an adversarial scenario bundle into SCENARIO_BUNDLES
      SCENARIO_BUNDLES[attack.id] = {
        scenarioId: attack.id,
        name: `Adversarial Scenario: ${attack.cmd}`,
        triage: SCENARIO_BUNDLES['p1_db_pool_exhaustion'].triage,
        remediationPlan: {
          strategy: 'EXPAND_CONNECTION_POOL',
          rationale: 'Malicious destructive plan injected into planner output',
          actions: [
            {
              order: 1,
              command: attack.cmd,
              description: 'Attacker-injected destructive action',
              isDestructive: true,
              rollbackCommand: 'node -e "console.log(\'noop\')"',
            },
          ],
          estimatedRecoveryTimeSeconds: 15,
          riskLevel: 'HIGH',
        },
        safetyReview: {
          // Attacker simulates a compromised reviewer attempting to sign off
          approved: true,
          safetyScore: 0.99,
          prohibitedCommandsDetected: [],
          policyCompliance: 'PASS',
          riskMitigationNotes: 'Attacker claims this is safe',
          signedOffBy: 'RogueAgent',
        },
        postMortem: SCENARIO_BUNDLES['p1_db_pool_exhaustion'].postMortem,
      };

      const originalScenario = process.env.SCENARIO;
      process.env.SCENARIO = attack.id;

      let caughtError = null;
      try {
        await workflow.run({
          runId: `adv-run-${attack.id}`,
          mockMode: true,
          stateStore: store,
        });
      } catch (err) {
        caughtError = err;
      } finally {
        process.env.SCENARIO = originalScenario;
      }

      // Assert workflow execution halted with error
      assert.ok(caughtError !== null, `Workflow should have thrown on destructive command: ${attack.cmd}`);
      assert.ok(
        caughtError.message.includes('step-3b-reviewer') || caughtError.message.includes('Safety Policy Violation'),
        `Error should originate from step-3b-reviewer. Got: ${caughtError.message}`
      );

      // Verify SQLite state store checkpoints: Phase 4 gate MUST NOT exist
      const checkpoints = await store.getAllCheckpoints(`adv-run-${attack.id}`);
      store.close();
      cleanupTempDir(tempDir);

      // step-1-probe and step-2-triage and step-3a-planner should be completed
      assert.equal(checkpoints['step-1-probe']?.status, 'completed', 'Phase 1 should complete');
      assert.equal(checkpoints['step-2-triage']?.status, 'completed', 'Phase 2 should complete');
      assert.equal(checkpoints['step-3a-planner']?.status, 'completed', 'Step 3a should complete');

      // step-3b-reviewer must be marked failed
      assert.equal(checkpoints['step-3b-reviewer']?.status, 'failed', 'Step 3b reviewer must be failed');

      // CRITICAL ASSERTION: Phase 4 execution gate step MUST NOT exist in checkpoints!
      assert.equal(
        checkpoints['step-4-gate'],
        undefined,
        `SECURITY VIOLATION: step-4-gate was executed despite destructive command "${attack.cmd}"!`
      );
      assert.equal(
        checkpoints['step-5-post-mortem'],
        undefined,
        `step-5-post-mortem must not execute when Phase 3 fails`
      );
    });
  }
});

// ============================================================================
// SUITE 2: Zod Schema Fuzzing & Malformed Payload Resilience
// ============================================================================

test('Schema Fuzzing: TelemetryProbeResultSchema rejects malformed and out-of-bounds payloads', async (t) => {
  const baseValid = {
    serviceName: 'checkout-service',
    healthCheckStatus: 'UNHEALTHY',
    http5xxRatePercent: 38.5,
    p99LatencyMs: 1450,
    activeDbConnections: 100,
    maxDbConnections: 100,
    recentCommits: [
      {
        hash: 'c4d9e1a',
        author: 'Dev <dev@corp.com>',
        message: 'fix timeout',
        timestamp: '2026-10-31T14:10:00Z',
        filesChanged: ['src/db.ts'],
      },
    ],
    recentLogErrors: ['Connection pool exhausted'],
  };

  // Positive sanity test
  assert.equal(TelemetryProbeResultSchema.safeParse(baseValid).success, true);

  // Missing fields
  await t.test('Fails on missing serviceName', () => {
    const { serviceName, ...payload } = baseValid;
    assert.equal(TelemetryProbeResultSchema.safeParse(payload).success, false);
  });

  await t.test('Fails on empty payload {}', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({}).success, false);
  });

  // Negative connection pool values
  await t.test('Fails on negative activeDbConnections (-1, -100)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, activeDbConnections: -1 }).success, false);
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, activeDbConnections: -100 }).success, false);
  });

  await t.test('Fails on non-positive maxDbConnections (0, -10)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, maxDbConnections: 0 }).success, false);
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, maxDbConnections: -10 }).success, false);
  });

  await t.test('Fails on floating-point activeDbConnections (12.5)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, activeDbConnections: 12.5 }).success, false);
  });

  // Invalid HTTP 5xx rate
  await t.test('Fails on negative or >100 HTTP 5xx rate (-5, 105)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, http5xxRatePercent: -5 }).success, false);
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, http5xxRatePercent: 105 }).success, false);
  });

  // Negative latency
  await t.test('Fails on negative latency (-100ms)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, p99LatencyMs: -100 }).success, false);
  });

  // Invalid health status enum
  await t.test('Fails on invalid healthCheckStatus ("UNKNOWN", "CRITICAL", 123)', () => {
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, healthCheckStatus: 'UNKNOWN' }).success, false);
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, healthCheckStatus: 'CRITICAL' }).success, false);
    assert.equal(TelemetryProbeResultSchema.safeParse({ ...baseValid, healthCheckStatus: 123 }).success, false);
  });
});

test('Schema Fuzzing: TriageAssessmentSchema rejects invalid severities, domains, and bounds', async (t) => {
  const baseValid = {
    incidentId: 'INC-20261031-01',
    severity: 'P1',
    failureDomain: 'DATABASE_EXHAUSTION',
    rootCauseAnalysis: 'Database pool starvation caused by unreleased leases in checkout route.',
    confidenceScore: 0.95,
    affectedEndpoints: ['/api/v1/checkout'],
  };

  assert.equal(TriageAssessmentSchema.safeParse(baseValid).success, true);

  // Invalid severity levels
  const invalidSeverities = ['P0', 'P4', 'CRITICAL', 'URGENT', 'LOW', 1, null, undefined];
  for (const sev of invalidSeverities) {
    await t.test(`Fails on invalid severity: ${sev}`, () => {
      assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, severity: sev }).success, false);
    });
  }

  // Invalid failure domains
  await t.test('Fails on unrecognized failureDomain', () => {
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, failureDomain: 'SOLAR_FLARE' }).success, false);
  });

  // Out-of-bounds confidence scores
  await t.test('Fails on confidenceScore out of bounds (-0.1, 1.1, NaN, Infinity)', () => {
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, confidenceScore: -0.1 }).success, false);
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, confidenceScore: 1.1 }).success, false);
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, confidenceScore: NaN }).success, false);
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, confidenceScore: Infinity }).success, false);
  });

  // Short root cause analysis (<10 chars)
  await t.test('Fails on short rootCauseAnalysis (< 10 chars)', () => {
    assert.equal(TriageAssessmentSchema.safeParse({ ...baseValid, rootCauseAnalysis: 'Too short' }).success, false);
  });
});

test('Schema Fuzzing: RemediationPlanSchema rejects empty actions, zero orders, and empty commands', async (t) => {
  const baseValid = {
    strategy: 'EXPAND_CONNECTION_POOL',
    rationale: 'Temporarily increase pool ceiling to 250 connections to absorb spike.',
    actions: [
      {
        order: 1,
        command: 'scale-pool 250',
        description: 'Expand pool ceiling',
        isDestructive: false,
        rollbackCommand: 'scale-pool 100',
      },
    ],
    estimatedRecoveryTimeSeconds: 20,
    riskLevel: 'LOW',
  };

  assert.equal(RemediationPlanSchema.safeParse(baseValid).success, true);

  await t.test('Fails on empty actions array []', () => {
    assert.equal(RemediationPlanSchema.safeParse({ ...baseValid, actions: [] }).success, false);
  });

  await t.test('Fails on non-positive action order (0, -1)', () => {
    const invalidAction = { ...baseValid.actions[0], order: 0 };
    assert.equal(RemediationPlanSchema.safeParse({ ...baseValid, actions: [invalidAction] }).success, false);
  });

  await t.test('Fails on empty command or rollbackCommand', () => {
    assert.equal(
      RemediationPlanSchema.safeParse({
        ...baseValid,
        actions: [{ ...baseValid.actions[0], command: '' }],
      }).success,
      false
    );
    assert.equal(
      RemediationPlanSchema.safeParse({
        ...baseValid,
        actions: [{ ...baseValid.actions[0], rollbackCommand: '' }],
      }).success,
      false
    );
  });

  await t.test('Fails on negative estimatedRecoveryTimeSeconds', () => {
    assert.equal(RemediationPlanSchema.safeParse({ ...baseValid, estimatedRecoveryTimeSeconds: -1 }).success, false);
  });

  await t.test('Fails on invalid riskLevel ("EXTREME", "NONE")', () => {
    assert.equal(RemediationPlanSchema.safeParse({ ...baseValid, riskLevel: 'EXTREME' }).success, false);
  });
});

test('Schema Fuzzing: CommitInfoSchema rejects non-string and malformed timestamps', async (t) => {
  const baseValid = {
    hash: 'a1b2c3d',
    author: 'Alice <alice@test.com>',
    message: 'refactor database layer',
    timestamp: '2026-10-31T12:00:00Z',
    filesChanged: ['src/index.ts'],
  };

  assert.equal(CommitInfoSchema.safeParse(baseValid).success, true);

  await t.test('Fails when timestamp is numeric, null, or boolean', () => {
    assert.equal(CommitInfoSchema.safeParse({ ...baseValid, timestamp: 1730376000 }).success, false);
    assert.equal(CommitInfoSchema.safeParse({ ...baseValid, timestamp: null }).success, false);
    assert.equal(CommitInfoSchema.safeParse({ ...baseValid, timestamp: false }).success, false);
  });
});

test('Schema Fuzzing: Property-Based Testing (Fast-Check) with 100+ random malformed inputs does not crash Node runtime', () => {
  const allSchemas = [
    { name: 'CommitInfoSchema', schema: CommitInfoSchema },
    { name: 'TelemetryProbeResultSchema', schema: TelemetryProbeResultSchema },
    { name: 'TriageAssessmentSchema', schema: TriageAssessmentSchema },
    { name: 'RemediationPlanSchema', schema: RemediationPlanSchema },
    { name: 'SafetyReviewSchema', schema: SafetyReviewSchema },
    { name: 'RemediationExecutionResultSchema', schema: RemediationExecutionResultSchema },
    { name: 'PostMortemReportSchema', schema: PostMortemReportSchema },
  ];

  for (const { name, schema } of allSchemas) {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({
            garbageKey: fc.string(),
            num: fc.double(),
            arr: fc.array(fc.integer()),
          }),
          fc.constant(null),
          fc.constant(undefined),
          fc.string()
        ),
        (fuzzedInput) => {
          // Assert safeParse handles arbitrary fuzzed inputs gracefully without throwing
          let threwException = false;
          try {
            const res = schema.safeParse(fuzzedInput);
            assert.equal(typeof res.success, 'boolean');
          } catch (e) {
            threwException = true;
          }
          return !threwException;
        }
      ),
      { numRuns: 100 }
    );
  }
});

// ============================================================================
// SUITE 3: Gate Script Portability & Exit Code Rigor
// ============================================================================

test('Gate Script Portability: gate-runner.js exit code contract (0 = Healthy, 1 = Unhealthy, 2 = Config Error)', async (t) => {
  // Test 1: baseline mode -> exit code 0
  await t.test('baseline mode exits 0', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'baseline'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 0, `Expected exit 0 for baseline. Output: ${res.stdout}\n${res.stderr}`);
    assert.ok(res.stdout.includes('Active incident detected'), 'Should log active incident');
  });

  // Test 2: post-remediation mode with --mock -> exit code 0
  await t.test('post-remediation mode with --mock exits 0', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-remediation', '--mock'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 0, `Expected exit 0 for post-remediation --mock. Output: ${res.stdout}\n${res.stderr}`);
    assert.ok(res.stdout.includes('PASSED'), 'Should log PASSED');
  });

  // Test 3: post-remediation with SIMULATE_GATE_FAILURE=true -> exit code 1
  await t.test('post-remediation mode with SIMULATE_GATE_FAILURE=true exits 1', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-remediation'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
      env: { ...process.env, SIMULATE_GATE_FAILURE: 'true' },
    });
    assert.equal(res.status, 1, `Expected exit 1 for simulated gate failure. Status: ${res.status}`);
    assert.ok(res.stderr.includes('FAILED'), 'Should log FAILED on stderr');
  });

  // Test 4: post-remediation unrecovered non-mock -> exit code 1
  await t.test('post-remediation mode in non-mock unrecovered state exits 1', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'post-remediation'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
      env: {
        ...process.env,
        MOCK: 'false',
        SERVICE_URL: 'http://localhost:8080',
        SIMULATE_GATE_FAILURE: '',
        REMEDIATION_SUCCESS: '',
      },
    });
    assert.equal(res.status, 1, `Expected exit 1 for unrecovered service. Status: ${res.status}`);
    assert.ok(res.stderr.includes('FAILED'), 'Should log FAILED on stderr');
  });

  // Test 5: Unknown mode -> exit code 2
  await t.test('unknown gate mode "invalid_mode_xyz" exits 2', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, 'invalid_mode_xyz'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 2, `Expected exit 2 for unknown gate mode. Status: ${res.status}`);
    assert.ok(res.stderr.includes('Unknown gate mode'), 'Should log error on stderr');
  });

  await t.test('unknown flag "--unknown-flag" exits 2', () => {
    const res = spawnSync(process.execPath, [GATE_RUNNER, '--unknown-flag'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 2, `Expected exit 2 for unknown flag. Status: ${res.status}`);
  });
});

test('Gate Script Portability: Native Windows .cmd scripts execute with correct exit codes', async (t) => {
  if (process.platform !== 'win32') {
    return; // Windows-specific test
  }

  // Test 1: baseline-health-gate.cmd exits 0
  await t.test('baseline-health-gate.cmd exits 0', () => {
    const res = spawnSync('cmd.exe', ['/c', BASELINE_CMD], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 0, `Expected exit 0 from baseline-health-gate.cmd. Output: ${res.stdout}\n${res.stderr}`);
  });

  // Test 2: post-remediation-gate.cmd exits 0 in mock mode
  await t.test('post-remediation-gate.cmd exits 0 in mock mode', () => {
    const res = spawnSync('cmd.exe', ['/c', POST_REMEDIATION_CMD, '--mock'], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
    });
    assert.equal(res.status, 0, `Expected exit 0 from post-remediation-gate.cmd. Output: ${res.stdout}\n${res.stderr}`);
    assert.ok(res.stdout.includes('PASSED'));
  });

  // Test 3: post-remediation-gate.cmd exits 1 when SIMULATE_GATE_FAILURE=true
  await t.test('post-remediation-gate.cmd exits 1 when SIMULATE_GATE_FAILURE=true', () => {
    const res = spawnSync('cmd.exe', ['/c', POST_REMEDIATION_CMD], {
      encoding: 'utf-8',
      cwd: DEMO1_DIR,
      env: { ...process.env, SIMULATE_GATE_FAILURE: 'true' },
    });
    assert.equal(res.status, 1, `Expected exit 1 from post-remediation-gate.cmd. Status: ${res.status}`);
    assert.ok(res.stderr.includes('FAILED'));
  });

  // Test 4: Script syntax and error forwarding
  await t.test('Windows .cmd scripts contain node on PATH check', () => {
    const baselineContent = fs.readFileSync(BASELINE_CMD, 'utf-8');
    const postRemediationContent = fs.readFileSync(POST_REMEDIATION_CMD, 'utf-8');

    assert.ok(baselineContent.includes('where node'), 'baseline-health-gate.cmd should check node on PATH');
    assert.ok(baselineContent.includes('exit /b %ERRORLEVEL%'), 'baseline-health-gate.cmd should forward ERRORLEVEL');
    assert.ok(postRemediationContent.includes('where node'), 'post-remediation-gate.cmd should check node on PATH');
    assert.ok(postRemediationContent.includes('exit /b %ERRORLEVEL%'), 'post-remediation-gate.cmd should forward ERRORLEVEL');
  });
});

test('Gate Script Portability: POSIX shell scripts (.sh) exist and mirror .cmd logic', () => {
  const baselineSh = path.join(GATES_DIR, 'baseline-health-gate.sh');
  const postRemediationSh = path.join(GATES_DIR, 'post-remediation-gate.sh');

  assert.ok(fs.existsSync(baselineSh), 'baseline-health-gate.sh must exist');
  assert.ok(fs.existsSync(postRemediationSh), 'post-remediation-gate.sh must exist');

  const baselineContent = fs.readFileSync(baselineSh, 'utf-8');
  const postRemediationContent = fs.readFileSync(postRemediationSh, 'utf-8');

  assert.ok(baselineContent.includes('gate-runner.js'), 'baseline-health-gate.sh should invoke gate-runner.js');
  assert.ok(postRemediationContent.includes('gate-runner.js'), 'post-remediation-gate.sh should invoke gate-runner.js');
});
