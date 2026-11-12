/**
 * PoC3 regression: agent storm — 64 concurrent mock subagents, and a
 * 1280-ask loop that runs into the 1000-call cap.
 *
 * Attack (fixtures, run byte-identical from a temp run dir built by this test):
 *   tests/adversarial/fixtures/goal-poc3-agent-storm.ts  — 64 agents x 1 ask, Promise.all
 *   tests/adversarial/fixtures/goal-poc3-cap-caught.ts   — 64 x 20 = 1280 asks, cap caught
 *   tests/adversarial/fixtures/goal-poc3-cap-uncaught.ts — same trip, uncaught
 *
 * Defenses under test:
 *   - src/dwf/engine.ts:418-431  withAskSeat FIFO seat gate (maxConcurrency, engine
 *     default min(16, max(2, cores-2)) at engine.ts:36): the 64-storm completes, every
 *     ask executes exactly once (journal: 64 completed ask nodes), nothing crashes.
 *   - src/dwf/engine.ts:124 + 286-294  AGENT_CALL_CAP = 1000 → ask #1001 rejects with
 *     WorkflowAgentCapError; CATCHABLE in-script (run survives), uncaught it fails the
 *     run structurally. Live PoC run: 1280 attempted, 1000 executed, error at ask#3.
 *   - src/dwf/governor.ts:1-4  the AIMD bucket "Providers without signals (mock) never
 *     trip it" — scheduling stays clean under the mock storm (asserted via full success).
 *
 * Observability: caught fixtures carry their observations in the run's RETURN VALUE
 * (result.value) — script-level log()/report() content is dropped by the child realm
 * (child-main.ts:95-96 forwards the lowered site id, lower.ts:137-141, as the payload;
 * found during this PoC, reported to the run owner).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFacadeScript } from '../../dist/src/dwf/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stormFixture = path.join(here, 'fixtures', 'goal-poc3-agent-storm.ts');
const capCaughtFixture = path.join(here, 'fixtures', 'goal-poc3-cap-caught.ts');
const capUncaughtFixture = path.join(here, 'fixtures', 'goal-poc3-cap-uncaught.ts');

const SEAT = 4; // CLI -c default, mirrors the live PoC run
const RUN_WALL_BUDGET_MS = 55_000; // per-run bound; each test file stays far under 60s

async function makeRunDir(fixture: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'goal-poc3-storm-'));
  await fs.promises.copyFile(fixture, path.join(dir, 'attack.ts'));
  return dir;
}

/**
 * The sandbox child is killed asynchronously at finish; on Windows its working
 * directory keeps the temp run dir locked for a moment. Retry the rmdir a few
 * times before giving up (and never fail a defense assertion over cleanup).
 */
async function rmRunDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 5) {
        console.warn(`goal-poc3: temp run dir not removable yet (child exit race): ${(err as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe('PoC3: 64-agent mock storm and the 1000-call breaker', () => {
  test('64 concurrent mock agents: run completes, all 64 asks journalled completed', async () => {
    const dir = await makeRunDir(stormFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'poc3.db'),
        maxConcurrency: SEAT,
        runTimeoutMs: RUN_WALL_BUDGET_MS,
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.stats.asks, 64, 'each of the 64 agents answered exactly once');
      const value = result.value as { answered?: number };
      assert.ok(value && value.answered === 64, `expected {answered: 64}, got ${JSON.stringify(result.value)}`);
    } finally {
      await rmRunDir(dir);
    }
  });

  test('cap breaker (caught): 1280 attempted asks stop at 1000 with WorkflowAgentCapError, run survives', async () => {
    const dir = await makeRunDir(capCaughtFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'poc3.db'),
        maxConcurrency: SEAT,
        runTimeoutMs: RUN_WALL_BUDGET_MS,
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.stats.asks, 1000, 'dispatch stops exactly at the 1000-call cap');
      const value = result.value as { answered?: number; capped?: boolean; capName?: string; capMessage?: string };
      assert.ok(value && value.capped === true, `expected {capped: true}, got ${JSON.stringify(result.value)}`);
      assert.equal(value.capName, 'WorkflowAgentCapError');
      assert.match(String(value.capMessage), /agent\(\) call cap reached \(1000\)/);
    } finally {
      await rmRunDir(dir);
    }
  });

  test('cap breaker (uncaught): structural run failure naming WorkflowAgentCapError', async () => {
    const dir = await makeRunDir(capUncaughtFixture);
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'poc3.db'),
        maxConcurrency: SEAT,
        runTimeoutMs: RUN_WALL_BUDGET_MS,
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /agent\(\) call cap reached \(1000\)/);
      assert.equal(result.stats.asks, 1000, 'no ask beyond the cap ever dispatches');
    } finally {
      await rmRunDir(dir);
    }
  });
});
