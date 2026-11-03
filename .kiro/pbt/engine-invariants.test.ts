import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fc from 'fast-check';
import { z } from 'zod';

import {
  Workflow,
  actionStep,
  CircularDependencyError,
  SchemaValidationError,
  sanitizeEnv,
  ReplayEngine,
  SQLiteStateStore,
  EventLogWriter,
  EventLogReader,
  formatZodErrors,
} from '../../dist/src/index.js';
import { REDACTED_STRING } from '../../dist/src/prober/sanitizer.js';

describe('Kiro Property-Based Testing (PBT): Core Engine Invariants', () => {
  // Invariant 1: DAG Acyclicity & Topological Sort
  test('PBT Invariant 1: DAG Acyclicity & Topological Sort holds for all random DAGs and detects all cycles', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 15 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 20 }),
        (nodeCount, rawEdges) => {
          const wf = new Workflow({ name: `pbt-wf-${nodeCount}` });
          wf.addPhase({ id: 'p1', name: 'Phase 1' });

          const nodes = Array.from({ length: nodeCount }, (_, i) => `node_${i}`);
          const validAcyclicEdges: [string, string][] = [];

          for (const [rawU, rawV] of rawEdges) {
            const u = rawU % nodeCount;
            const v = rawV % nodeCount;
            if (u < v && !validAcyclicEdges.some(([a, b]) => a === nodes[u] && b === nodes[v])) {
              validAcyclicEdges.push([nodes[u]!, nodes[v]!]);
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

          // Acyclic graph must validate cleanly
          assert.doesNotThrow(() => wf.validate());

          // Introducing an intentional cycle must throw CircularDependencyError
          if (validAcyclicEdges.length > 0) {
            const [u, v] = validAcyclicEdges[0]!;
            const cyclicWf = new Workflow({ name: `pbt-cyclic` });
            cyclicWf.addPhase({ id: 'p1', name: 'Phase 1' });
            for (const step of wf.getAllSteps()) {
              const deps = [...(step.dependsOn || [])];
              if (step.id === u) deps.push(v); // Introduce cycle v -> u
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
      { numRuns: 100 }
    );
  });

  // Invariant 2: Idempotent Replay & Prefix Caching
  test('PBT Invariant 2: Idempotent Replay strictly partitions completed prefix and skips with zero token spend', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 7 }),
        async (totalSteps, splitIndex) => {
          const k = splitIndex % totalSteps;
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-replay-'));
          const dbPath = path.join(tempDir, 'runs.db');
          const store = new SQLiteStateStore(dbPath);
          const replayEngine = new ReplayEngine(store);
          const runId = `run-pbt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const stepIds = Array.from({ length: totalSteps }, (_, i) => `step_${i}`);

          for (let i = 0; i < k; i++) {
            await store.saveCheckpoint(runId, {
              stepId: stepIds[i]!,
              phaseId: 'phase-1',
              status: 'completed',
              input: { param: i },
              output: { result: `val_${i}` },
              tokens: { prompt: 100, completion: 50 },
              durationMs: 15,
            });
          }

          if (k < totalSteps) {
            await store.saveCheckpoint(runId, {
              stepId: stepIds[k]!,
              phaseId: 'phase-1',
              status: 'failed',
              input: { param: k },
              error: 'Simulated error',
              durationMs: 10,
            });
          }

          const plan1 = await replayEngine.analyzeRun(runId, stepIds);
          const plan2 = await replayEngine.analyzeRun(runId, stepIds);

          // Assert idempotency between calls
          assert.deepEqual(plan1.stepsToSkip, plan2.stepsToSkip);
          assert.deepEqual(plan1.stepsToExecute, plan2.stepsToExecute);
          assert.equal(plan1.stepsToSkip.length, k);
          assert.equal(plan1.stepsToExecute.length, totalSteps - k);
          assert.equal(plan1.tokensSavedEstimate, k * 150);

          store.close();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      ),
      { numRuns: 50 }
    );
  });

  // Invariant 3: Schema Contract Enforcement
  test('PBT Invariant 3: Schema Contract rejects any invalid payload and guarantees 100% type soundness', () => {
    const ContractSchema = z.object({
      id: z.string().min(1),
      count: z.number().int().nonnegative(),
      status: z.enum(['pending', 'running', 'completed']),
      tags: z.array(z.string()),
    });

    fc.assert(
      fc.property(fc.jsonValue(), (randomValue) => {
        const result = ContractSchema.safeParse(randomValue);
        if (result.success) {
          assert.equal(typeof result.data.id, 'string');
          assert.ok(result.data.count >= 0);
          assert.ok(['pending', 'running', 'completed'].includes(result.data.status));
          assert.ok(Array.isArray(result.data.tags));
        } else {
          assert.ok(result.error.issues.length > 0);
          const formatted = formatZodErrors(result.error.issues);
          assert.ok(formatted.includes('Field'));
        }
      }),
      { numRuns: 100 }
    );
  });

  // Invariant 4: Monotonic Event Log Ordering
  test('PBT Invariant 4: Monotonic Event Log Ordering assigns strictly increasing sequence and preserves order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 25 }),
        async (eventMessages) => {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-eventlog-'));
          const logPath = path.join(tempDir, 'events.jsonl');
          const writer = new EventLogWriter(logPath);
          const runId = 'pbt-event-run';

          const recorded = [];
          for (const msg of eventMessages) {
            const evt = writer.record({
              workflowId: 'pbt-wf',
              runId,
              stepId: 'step-1',
              type: 'step_complete',
              data: { msg },
            });
            recorded.push(evt);
          }
          writer.close();

          const recovered = await EventLogReader.readAll(logPath);
          assert.equal(recovered.length, eventMessages.length);

          for (let i = 0; i < recovered.length; i++) {
            assert.equal(recovered[i]!.sequence, i + 1);
            if (i > 0) {
              assert.ok(recovered[i]!.sequence > recovered[i - 1]!.sequence);
              assert.ok(new Date(recovered[i]!.timestamp).getTime() >= new Date(recovered[i - 1]!.timestamp).getTime());
            }
          }

          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      ),
      { numRuns: 50 }
    );
  });

  // Invariant 5: Credential Redaction
  test('PBT Invariant 5: Credential Redaction eliminates sensitive keys, tokens, and URI passwords', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{16}$/),
        fc.stringMatching(/^[a-zA-Z0-9_-]{12,24}$/),
        fc.stringMatching(/^[a-zA-Z0-9]{6,16}$/),
        (rawAwsKey, rawSecret, rawPassword) => {
          const awsKey = `AKIA${rawAwsKey}`;
          const uri = `https://user:${rawPassword}@db.internal:5432/app`;

          const envInput: Record<string, string> = {
            AWS_SECRET_ACCESS_KEY: rawSecret,
            DATABASE_URL: uri,
            APP_ENVIRONMENT: 'production_cluster_useast1',
            TOKEN_AUTH: rawSecret,
            AWS_KEY_ID: awsKey,
          };

          const sanitized = sanitizeEnv(envInput);

          assert.equal(sanitized['AWS_SECRET_ACCESS_KEY'], REDACTED_STRING);
          assert.equal(sanitized['TOKEN_AUTH'], REDACTED_STRING);
          assert.equal(sanitized['AWS_KEY_ID'], REDACTED_STRING);
          assert.ok(sanitized['DATABASE_URL']!.includes('://***:***@'));
          assert.ok(!sanitized['DATABASE_URL']!.includes(rawPassword));
          assert.equal(sanitized['APP_ENVIRONMENT'], 'production_cluster_useast1');

          for (const val of Object.values(sanitized)) {
            assert.ok(!val.includes(rawPassword));
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
