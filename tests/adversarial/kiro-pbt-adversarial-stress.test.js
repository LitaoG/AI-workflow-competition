import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fc from 'fast-check';
import { z } from 'zod';

import {
  Workflow,
  actionStep,
  CircularDependencyError,
  SQLiteStateStore,
  ReplayEngine,
  EventLogWriter,
  EventLogReader,
  formatZodErrors,
  sanitizeEnv,
} from '../../dist/src/index.js';
import { REDACTED_STRING } from '../../dist/src/prober/sanitizer.js';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

describe('Kiro Hooks Adversarial Stress Suite', () => {
  const preStepGatePath = path.join(projectRoot, '.kiro', 'hooks', 'pre-step-gate.js');
  const postStepAuditPath = path.join(projectRoot, '.kiro', 'hooks', 'post-step-audit.js');
  const preWorkflowGatePath = path.join(projectRoot, '.kiro', 'hooks', 'pre-workflow-gate.js');
  const stopWorkflowGatePath = path.join(projectRoot, '.kiro', 'hooks', 'stop-workflow-gate.js');

  test('Hook Gate 1: pre-step-gate strictly blocks canonical destructive commands with exit code 2 and [GATE DENIED]', () => {
    const destructiveCommands = [
      'rm -rf /',
      'rm -rf /var/data',
      'format c:',
      'format d:',
      'mkfs',
      'mkfs.ext4 /dev/sda1',
      'git reset --hard',
      'git reset --hard HEAD~1',
      'git push --force origin main',
      'git push --force origin main --tags',
    ];

    for (const cmd of destructiveCommands) {
      const res = spawnSync(process.execPath, [preStepGatePath, cmd], {
        cwd: projectRoot,
        encoding: 'utf8',
      });

      assert.equal(res.status, 2, `Expected exit code 2 for "${cmd}", got ${res.status}`);
      assert.ok(
        res.stderr.includes('[GATE DENIED]'),
        `Expected stderr to contain "[GATE DENIED]" for "${cmd}", got: ${res.stderr}`
      );
      assert.ok(
        res.stderr.includes('policy-guardrails'),
        `Expected stderr to cite policy-guardrails for "${cmd}"`
      );
    }
  });

  test('Hook Gate 2: pre-step-gate blocks casing variations and multi-whitespace permutations', () => {
    const permutations = [
      'RM -RF /',
      'rm   -rf    /',
      'rm\t-rf\t/',
      'FORMAT C:',
      'Format D:',
      'format   e:',
      'GIT RESET --HARD',
      'git   reset   --hard',
      'Git Push --Force Origin Main',
      'git   push   --force   origin   main',
    ];

    for (const cmd of permutations) {
      const res = spawnSync(process.execPath, [preStepGatePath, cmd], {
        cwd: projectRoot,
        encoding: 'utf8',
      });

      assert.equal(res.status, 2, `Expected exit code 2 for permutation "${cmd}", got ${res.status}`);
      assert.ok(res.stderr.includes('[GATE DENIED]'));
    }
  });

  test('Hook Gate 3: pre-step-gate blocks destructive operations injected via PROHIBITED_OP environment variable', () => {
    const res = spawnSync(process.execPath, [preStepGatePath], {
      cwd: projectRoot,
      env: { ...process.env, PROHIBITED_OP: 'rm -rf /' },
      encoding: 'utf8',
    });

    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('[GATE DENIED]'));

    const res2 = spawnSync(process.execPath, [preStepGatePath, 'ls -la'], {
      cwd: projectRoot,
      env: { ...process.env, PROHIBITED_OP: 'format c:' },
      encoding: 'utf8',
    });

    assert.equal(res2.status, 2);
    assert.ok(res2.stderr.includes('[GATE DENIED]'));
  });

  test('Hook Gate 3b: pre-step-gate reads the Kiro STDIN protocol — tool_input.command is gated (Issue #145)', () => {
    // The real Kiro wiring: session context JSON arrives on STDIN while argv
    // and env carry nothing — the deny branch must fire from the stdin payload.
    const evil = spawnSync(process.execPath, [preStepGatePath], {
      cwd: projectRoot,
      input: JSON.stringify({ tool_name: 'execute_bash', tool_input: { command: 'rm -rf /' } }),
      encoding: 'utf8',
    });
    assert.equal(evil.status, 2, `stdin-protocol destructive command must be denied, got ${evil.status}`);
    assert.ok(evil.stderr.includes('[GATE DENIED]'), `stderr must carry the deny marker, got: ${evil.stderr}`);

    const benign = spawnSync(process.execPath, [preStepGatePath], {
      cwd: projectRoot,
      input: JSON.stringify({ tool_name: 'execute_bash', tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    });
    assert.equal(benign.status, 0, 'stdin-protocol benign command must be allowed');
    assert.ok(benign.stdout.includes('[GATE ALLOWED]'));

    // A silent open pipe (spawnSync without input) must not hang the gate:
    // the bounded stdin wait resolves and the hook answers allow promptly.
    const started = Date.now();
    const silent = spawnSync(process.execPath, [preStepGatePath], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(silent.status, 0);
    assert.ok(Date.now() - started < 5000, 'the gate must not hang on a never-closing stdin pipe');
  });

  test('Hook Gate 4: pre-step-gate approves safe and benign commands with exit code 0 and [GATE ALLOWED]', () => {
    const safeCommands = [
      'npm test',
      'npm run build',
      'git status',
      'git log -n 5',
      'git push origin main', // non-force push
      'git reset HEAD~1',     // non-hard reset
      'rm -f temp.txt',        // safe non-root removal
      'ls -la',
      'node bin/workflow.js run',
      '',
    ];

    for (const cmd of safeCommands) {
      const args = cmd ? [preStepGatePath, ...cmd.split(' ')] : [preStepGatePath];
      const res = spawnSync(process.execPath, args, {
        cwd: projectRoot,
        encoding: 'utf8',
      });

      assert.equal(res.status, 0, `Expected exit code 0 for safe command "${cmd}", got ${res.status}`);
      assert.ok(
        res.stdout.includes('[GATE ALLOWED]'),
        `Expected stdout to contain "[GATE ALLOWED]" for "${cmd}", got: ${res.stdout}`
      );
    }
  });

  test('Hook Gate 5: post-step-audit computes SHA-256 hashes of artifacts and handles arbitrary directories', () => {
    // 1. Audit on standard artifacts
    const res = spawnSync(process.execPath, [postStepAuditPath], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.equal(res.status, 0);
    // Issue #145: the audit reports what it actually does — hash listing only,
    // no sequence validation (the journal is the authoritative audit stream).
    assert.ok(res.stdout.includes('[KIRO HOOK] Post-step audit recorded'));
    assert.ok(res.stdout.includes('performs no event-sequence validation'));

    // 2. Audit on temporary isolated environment with synthetic artifacts
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    const tempArtifacts = path.join(tempDir, 'artifacts');
    fs.mkdirSync(tempArtifacts);
    fs.writeFileSync(path.join(tempArtifacts, 'alpha.json'), '{"test": 1}');
    fs.writeFileSync(path.join(tempArtifacts, 'beta.txt'), 'hello world');

    // Run custom audit script logic in tempDir matching relative path structure (.kiro/hooks/../../artifacts)
    const tempHooksDir = path.join(tempDir, '.kiro', 'hooks');
    fs.mkdirSync(tempHooksDir, { recursive: true });
    const tempScript = path.join(tempHooksDir, 'post-step-audit.js');
    fs.copyFileSync(postStepAuditPath, tempScript);

    // Run audit
    const resTemp = spawnSync(process.execPath, [tempScript], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    assert.equal(resTemp.status, 0);
    assert.ok(resTemp.stdout.includes('[AUDIT] artifact hashed: alpha.json'));
    assert.ok(resTemp.stdout.includes('[AUDIT] artifact hashed: beta.txt'));
    assert.ok(resTemp.stdout.includes('[KIRO HOOK] Post-step audit recorded 2 artifact hashes'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('Hook Gate 6: pre-workflow-gate successfully completes deterministic probe with 0 exit code and valid JSON', () => {
    const res = spawnSync(process.execPath, [preWorkflowGatePath], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.equal(res.status, 0, `pre-workflow-gate failed with: ${res.stderr}`);
    assert.ok(res.stdout.includes('[KIRO HOOK] Running Pre-Workflow Environment Probe Gate...'));
    assert.ok(res.stdout.includes('[KIRO HOOK] Environment verified successfully.'));

    // Extract JSON payload
    const jsonMatch = res.stdout.match(/\{[\s\S]*"system"[\s\S]*\}/);
    assert.ok(jsonMatch, 'Expected probe output to contain JSON snapshot');
    const parsed = JSON.parse(jsonMatch[0]);
    assert.ok(parsed.system.platform);
    assert.ok(parsed.git.branch);
    assert.ok(parsed.toolchain.node);
  });

  test('Hook Gate 7: stop-workflow-gate supports continuation checking via JSON decision protocol', () => {
    // 1. Default allow
    const resAllow = spawnSync(process.execPath, [stopWorkflowGatePath], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    assert.equal(resAllow.status, 0);
    const parsedAllow = JSON.parse(resAllow.stdout.trim());
    assert.equal(parsedAllow.decision, 'allow');

    // 2. Forced block
    const resBlock = spawnSync(process.execPath, [stopWorkflowGatePath], {
      cwd: projectRoot,
      env: { ...process.env, KIRO_STOP_BLOCK: 'true' },
      encoding: 'utf8',
    });
    assert.equal(resBlock.status, 0);
    const parsedBlock = JSON.parse(resBlock.stdout.trim());
    assert.equal(parsedBlock.decision, 'block');
    assert.ok(parsedBlock.reason.includes('Active workflow steps remain unverified'));
  });
});

describe('Fast-Check Property-Based Testing: Extended Engine Stress Suite', () => {
  // Extended Invariant 1: Arbitrary DAGs, Scale, and Cycle Detection
  test('Extended PBT 1: 200 random DAGs across wide fan-outs, deep linear chains, and cycle detection', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 25 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 2, maxLength: 30 }),
        (nodeCount, rawEdges) => {
          const wf = new Workflow({ name: `ext-dag-${nodeCount}` });
          wf.addPhase({ id: 'p1', name: 'Phase 1' });

          const nodes = Array.from({ length: nodeCount }, (_, i) => `n_${i}`);
          const validAcyclicEdges = [];

          for (const [rawU, rawV] of rawEdges) {
            const u = rawU % nodeCount;
            const v = rawV % nodeCount;
            // Strict topological order guarantee: u < v
            if (u < v && !validAcyclicEdges.some(([a, b]) => a === nodes[u] && b === nodes[v])) {
              validAcyclicEdges.push([nodes[u], nodes[v]]);
            }
          }

          for (const node of nodes) {
            const deps = validAcyclicEdges.filter(([_, to]) => to === node).map(([from]) => from);
            wf.addStep(
              actionStep({
                id: node,
                name: node,
                phaseId: 'p1',
                dependsOn: deps,
                action: async () => ({ ok: true }),
              })
            );
          }

          // Must validate without throwing
          assert.doesNotThrow(() => wf.validate());

          // Introducing an intentional cycle must throw CircularDependencyError
          if (validAcyclicEdges.length > 0) {
            const [u, v] = validAcyclicEdges[0];
            const cyclicWf = new Workflow({ name: `ext-cyclic` });
            cyclicWf.addPhase({ id: 'p1', name: 'Phase 1' });
            for (const step of wf.getAllSteps()) {
              const deps = [...(step.dependsOn || [])];
              if (step.id === u) deps.push(v); // back-edge v -> u
              cyclicWf.addStep(
                actionStep({
                  id: step.id,
                  name: step.name,
                  phaseId: 'p1',
                  dependsOn: deps,
                  action: async () => ({ ok: true }),
                })
              );
            }
            assert.throws(() => cyclicWf.validate(), CircularDependencyError);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  // Extended Invariant 2: Idempotent Replay, Boundary Values, and Token Accuracy
  test('Extended PBT 2: 100 random replay splits verifying boundary splits and token savings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        async (totalSteps, splitAttempt) => {
          const k = Math.min(splitAttempt, totalSteps);
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-replay-'));
          const dbPath = path.join(tempDir, 'runs.db');
          const store = new SQLiteStateStore(dbPath);
          const replayEngine = new ReplayEngine(store);
          const runId = `run-ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const stepIds = Array.from({ length: totalSteps }, (_, i) => `s_${i}`);

          for (let i = 0; i < k; i++) {
            await store.saveCheckpoint(runId, {
              stepId: stepIds[i],
              phaseId: 'p1',
              status: 'completed',
              input: { idx: i },
              output: { res: i * 2 },
              tokens: { prompt: 200, completion: 100 },
              durationMs: 20,
            });
          }

          if (k < totalSteps) {
            await store.saveCheckpoint(runId, {
              stepId: stepIds[k],
              phaseId: 'p1',
              status: 'failed',
              input: { idx: k },
              error: 'Failure injection',
              durationMs: 10,
            });
          }

          const planA = await replayEngine.analyzeRun(runId, stepIds);
          const planB = await replayEngine.analyzeRun(runId, stepIds);

          // Absolute determinism and idempotency
          assert.deepEqual(planA.stepsToSkip, planB.stepsToSkip);
          assert.deepEqual(planA.stepsToExecute, planB.stepsToExecute);
          assert.equal(planA.stepsToSkip.length, k);
          assert.equal(planA.stepsToExecute.length, totalSteps - k);
          assert.equal(planA.tokensSavedEstimate, k * 300);

          store.close();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      ),
      { numRuns: 100 }
    );
  });

  // Extended Invariant 3: Zod Schema Contract Soundness
  test('Extended PBT 3: 200 arbitrary JSON structures with recursive unions and optional fields', () => {
    const ComplexContract = z.object({
      version: z.literal(1),
      payload: z.discriminatedUnion('type', [
        z.object({ type: z.literal('agent_req'), prompt: z.string().min(1), retries: z.number().int().nonnegative() }),
        z.object({ type: z.literal('gate_eval'), exitCode: z.number().int(), passed: z.boolean() }),
      ]),
      meta: z.record(z.string()).optional(),
    });

    fc.assert(
      fc.property(fc.jsonValue(), (val) => {
        const parsed = ComplexContract.safeParse(val);
        if (parsed.success) {
          assert.equal(parsed.data.version, 1);
          assert.ok(parsed.data.payload.type === 'agent_req' || parsed.data.payload.type === 'gate_eval');
        } else {
          assert.ok(parsed.error.issues.length > 0);
          const formatted = formatZodErrors(parsed.error.issues);
          assert.ok(typeof formatted === 'string' && formatted.length > 0);
        }
      }),
      { numRuns: 200 }
    );
  });

  // Extended Invariant 4: Monotonic Event Log Ordering & High-Volume Concurrency
  test('Extended PBT 4: 100 event stream runs verifying strict monotonicity and payload preservation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            type: fc.constantFrom('step_start', 'step_complete', 'gate_eval', 'probe_done'),
            payload: fc.string({ minLength: 1, maxLength: 30 }),
          }),
          { minLength: 3, maxLength: 35 }
        ),
        async (events) => {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-events-'));
          const logPath = path.join(tempDir, 'events.jsonl');
          const writer = new EventLogWriter(logPath);
          const runId = 'pbt-ext-stream';

          for (const evt of events) {
            writer.record({
              workflowId: 'ext-wf',
              runId,
              stepId: 'step-main',
              type: evt.type,
              data: { payload: evt.payload },
            });
          }
          writer.close();

          const recovered = await EventLogReader.readAll(logPath);
          assert.equal(recovered.length, events.length);

          for (let i = 0; i < recovered.length; i++) {
            assert.equal(recovered[i].sequence, i + 1);
            assert.equal(recovered[i].type, events[i].type);
            assert.equal(recovered[i].data.payload, events[i].payload);

            if (i > 0) {
              assert.ok(recovered[i].sequence > recovered[i - 1].sequence);
              assert.ok(
                new Date(recovered[i].timestamp).getTime() >= new Date(recovered[i - 1].timestamp).getTime()
              );
            }
          }

          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      ),
      { numRuns: 100 }
    );
  });

  // Extended Invariant 5: Credential Redaction Across Multi-Provider Formats
  test('Extended PBT 5: 200 random credential vectors across AWS, GitHub, JWT, connection strings, and casing', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{16}$/),
        fc.stringMatching(/^[a-zA-Z0-9_-]{20,40}$/),
        fc.stringMatching(/^[a-zA-Z0-9]{8,20}$/),
        // The composed key CUSTOM_<safeKey.toUpperCase()> is a BENIGN key only if
        // it does not hit the engine's sensitive-name regex (prober sanitizer:
        // key|token|secret|password|pwd|auth|credential|cert|signature|sigv4|...).
        // A generated key like "0key" composes CUSTOM_0KEY — the engine correctly
        // redacts that by design, and the property must not generate such keys
        // (~3% of random-seed runs hit it: comp CI Issue #17, first CI seed to
        // draw one). Filter the generator to true benign keys.
        fc.stringMatching(/^[a-z0-9_]{4,15}$/).filter(
          (k) => !/(?:key|token|secret|password|pwd|auth|credential|cert|signature|sigv4|aws_access_key|igccsvc_db|private)/i.test(k),
        ),
        (awsSuffix, ghTokenSuffix, dbPass, safeKey) => {
          const awsKey = `AKIA${awsSuffix}`;
          const ghToken = `ghp_${ghTokenSuffix}`;
          const dbUrl = `postgres://svc_user:${dbPass}@prod.db.internal:5432/core`;

          const rawEnv = {
            AWS_ACCESS_KEY_ID: awsKey,
            GITHUB_PERSONAL_ACCESS_TOKEN: ghToken,
            DATABASE_CONNECTION_STRING: dbUrl,
            APP_SECRET_KEY: 'super-secret-salt-val',
            [`CUSTOM_${safeKey.toUpperCase()}`]: 'benign-system-value',
            SERVICE_PORT: '9000',
          };

          const sanitized = sanitizeEnv(rawEnv);

          // All sensitive fields must be neutralized
          assert.equal(sanitized.AWS_ACCESS_KEY_ID, REDACTED_STRING);
          assert.equal(sanitized.GITHUB_PERSONAL_ACCESS_TOKEN, REDACTED_STRING);
          assert.equal(sanitized.APP_SECRET_KEY, REDACTED_STRING);
          assert.ok(sanitized.DATABASE_CONNECTION_STRING.includes('://***:***@'));
          assert.ok(!sanitized.DATABASE_CONNECTION_STRING.includes(dbPass));

          // Safe fields must remain untouched
          assert.equal(sanitized[`CUSTOM_${safeKey.toUpperCase()}`], 'benign-system-value');
          assert.equal(sanitized.SERVICE_PORT, '9000');

          for (const val of Object.values(sanitized)) {
            assert.ok(!val.includes(dbPass));
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
