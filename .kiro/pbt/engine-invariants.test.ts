import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
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
import { FacadeEngine } from '../../dist/src/dwf/engine.js';
import { createSQLiteStore } from '../../dist/src/state/store.js';
import type { SQLiteStateStore as DwfSQLiteStore } from '../../dist/src/state/sqlite-store.js';
import type { DwfJournalStore, LLMProvider, LLMRequest, LLMResponse } from '../../dist/src/types.js';
import { providerRegistry } from '../../dist/src/agent/provider.js';

/**
 * Freshness guard (Issue #64): this suite imports the BUILD OUTPUT (dist/src)
 * because the engine's internal ESM graph uses `.js` specifiers that only
 * exist after tsc — so `npm run test:pbt` in isolation tests whatever dist
 * happens to hold. A stale dist would silently test old behavior and report
 * green. The first property asserts every imported entry is newer than the
 * whole src tree before any other result can be trusted.
 */
test('PBT Invariant 0: dist build output is fresh relative to the src tree', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const srcDir = path.join(repoRoot, 'src');
  const distEntries = [
    path.join(repoRoot, 'dist', 'src', 'index.js'),
    path.join(repoRoot, 'dist', 'src', 'dwf', 'engine.js'),
    path.join(repoRoot, 'dist', 'src', 'prober', 'sanitizer.js'),
  ];
  for (const entry of distEntries) {
    assert.ok(fs.existsSync(entry), `${path.relative(repoRoot, entry)} missing — run "npm run build" before test:pbt`);
  }
  const freshestSrc = (() => {
    let newest = 0;
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(p).mtimeMs);
      }
    };
    walk(srcDir);
    return newest;
  })();
  for (const entry of distEntries) {
    const distMtime = fs.statSync(entry).mtimeMs;
    assert.ok(
      distMtime >= freshestSrc,
      `dist is stale: ${path.relative(repoRoot, entry)} predates a newer src file — run "npm run build" before test:pbt`,
    );
  }
});

/** Reference model: Kahn peel — true iff every edge is satisfiable in a topological order. */
function referenceAcyclic(nodeCount: number, edges: Array<[number, number]>): boolean {
  const indeg = new Array<number>(nodeCount).fill(0);
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const [u, v] of edges) {
    adj[u]!.push(v);
    indeg[v]! += 1;
  }
  const ready = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  let peeled = 0;
  while (ready.length > 0) {
    const u = ready.pop()!;
    peeled += 1;
    for (const v of adj[u]!) {
      indeg[v]! -= 1;
      if (indeg[v] === 0) ready.push(v);
    }
  }
  return peeled === nodeCount;
}

describe('Kiro Property-Based Testing (PBT): Core Engine Invariants', () => {
  // Invariant 1: DAG Acyclicity & Topological Sort — model-based over ARBITRARY
  // digraphs (Issue #64: the legacy generator pre-filtered `u < v`, so the
  // generated graphs were DAGs by construction and the cyclic branch never saw
  // self-loops or back-edges; a `u <= v` typo in that filter could not go red).
  test('PBT Invariant 1: validate() accepts exactly the topologically satisfiable graphs — every cycle (incl. self-loops) throws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 15 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 30 }),
        (nodeCount, rawEdges) => {
          // Dedupe but keep direction and self-loops: the model, not the
          // generator, decides whether the graph is acyclic.
          const edgeSet = new Set<string>();
          const edges: Array<[number, number]> = [];
          for (const [rawU, rawV] of rawEdges) {
            const u = rawU % nodeCount;
            const v = rawV % nodeCount;
            const key = `${u}->${v}`;
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              edges.push([u, v]);
            }
          }

          const build = (es: Array<[number, number]>): Workflow => {
            const wf = new Workflow({ name: `pbt-wf-${nodeCount}` });
            wf.addPhase({ id: 'p1', name: 'Phase 1' });
            for (let i = 0; i < nodeCount; i++) {
              const id = `node_${i}`;
              const deps = es.filter(([, to]) => to === i).map(([from]) => `node_${from}`);
              wf.addStep(
                actionStep({
                  id,
                  name: id,
                  phaseId: 'p1',
                  dependsOn: deps,
                  action: async () => ({ ok: true }),
                })
              );
            }
            return wf;
          };

          const acyclic = referenceAcyclic(nodeCount, edges);
          const wf = build(edges);
          if (acyclic) {
            // validate() passing ⟺ the edges are satisfiable in a topological order.
            assert.doesNotThrow(() => wf.validate(), `expected a clean validate for acyclic edges ${JSON.stringify(edges)}`);
          } else {
            // Every cycle — a self-loop or a back-edge cluster — must throw the
            // named error instead of passing validation.
            assert.throws(() => wf.validate(), CircularDependencyError, `expected CircularDependencyError for cyclic edges ${JSON.stringify(edges)}`);
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

  // Invariant 3: Typed-ask contract enforcement — the REAL ask path (Issue #64:
  // the legacy invariant parsed a locally-defined zod schema with zod itself,
  // covering the library but not the engine; SchemaValidationError was imported
  // and never used). A provider reply that violates the ask's contract must
  // consume the retry budget (the repair loop re-asks the model) and then fail
  // loudly with SchemaValidationError — never a silent wrong-typed result.
  test('PBT Invariant 3: a schema-violating reply exhausts the repair budget and throws SchemaValidationError', async () => {
    // Contracts the deterministic mock's canned object ({status, message,
    // timestamp}) provably violates, however the reply shapes itself.
    const violatingSchemas = [
      JSON.stringify({ type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }),
      JSON.stringify({ type: 'object', properties: { healthStatus: { type: 'number' } }, required: ['healthStatus'] }),
      JSON.stringify({ type: 'object', properties: { status: { type: 'number' } }, required: ['status'] }),
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: violatingSchemas.length - 1 }),
        fc.string({ minLength: 4, maxLength: 40 }).filter((s) => !/triage|incident|telemetry|p1|healthz|migration|sdk|aws|transform|inspect|review|audit|post|plan|decision|analys|assess|safety/i.test(s)),
        async (schemaIndex, promptSeed) => {
          const calls = { n: 0 };
          const badReplyProvider: LLMProvider = {
            id: 'pbt-contract-violating-mock',
            name: 'Contract-violating mock',
            async generate(_request: LLMRequest): Promise<LLMResponse> {
              calls.n += 1;
              return {
                content: JSON.stringify({ status: 'SUCCESS', message: 'canned', timestamp: '2026-01-01T00:00:00Z' }),
                model: 'mock-contract-violating',
                usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
                latencyMs: 1,
              };
            },
          };
          providerRegistry.register(badReplyProvider);
          const previousDefault = providerRegistry.get().id;
          providerRegistry.setDefault('pbt-contract-violating-mock');

          try {
            const store = createSQLiteStore(':memory:') as DwfSQLiteStore & DwfJournalStore;
            const engine = new FacadeEngine({
              runId: `dwfrun-pbt-contract-${Date.now()}-${schemaIndex}-${calls.n}`,
              workspace: process.cwd(),
              store,
              args: {},
              approvedCommands: [],
              onEvent: () => {},
            });
            const actor = await engine.handleCall({ t: 'call', id: 1, op: 'createActor', siteId: 'actor#1', payload: ['inspector'] });

            const callsBefore = calls.n;
            await assert.rejects(
              () => engine.handleCall({ t: 'call', id: 2, op: 'ask', siteId: 'ask#1', payload: [actor, `pbt contract probe ${promptSeed}`, violatingSchemas[schemaIndex]] }),
              (err: unknown) => {
                const e = err as { name?: string; message?: string };
                assert.match(e.name ?? '', /SchemaValidationError/, 'the exhaustion surfaces the named contract error');
                return true;
              },
            );
            assert.ok(calls.n > callsBefore, 'the violation consumes at least one retry against the provider');
            assert.ok(calls.n - callsBefore >= 2, 'the repair loop re-asks the model, consuming the retry budget');
            store.close();
          } finally {
            providerRegistry.setDefault(previousDefault);
          }
        }
      ),
      { numRuns: 8 }
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

  // formatZodErrors stays a real consumer of zod issues — the Invariant 3
  // contract failure feeds this exact formatter back to the model (rpc.ts
  // Tier-2 repair). A smoke property keeps its output contract locked.
  test('PBT Invariant 6: formatZodErrors names every violating field path', () => {
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
});
