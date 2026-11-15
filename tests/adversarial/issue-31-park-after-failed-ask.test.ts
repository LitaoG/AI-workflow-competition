/**
 * Issue #31 (2026-11-15, park deadlock) regression — a failed ask must release
 * the runner's in-flight slot so a later hole/escalate can still park.
 *
 * Attack (fixture, run byte-identical from a temp run dir built by this test):
 *   tests/adversarial/fixtures/issue-31-park-after-failed-ask.ts — a doomed ask
 *   (provider always throws an unrecognized message → classifier fatal,
 *   non-retryable, NOT a policy stop), caught in-script, then
 *   `await hole<string>('await-human', ...)`.
 *
 * Defenses under test:
 *   - src/dwf/runner.ts onEvent counter: a live ask settles exactly one of
 *     dwf_ask_complete (success) or dwf_node_failed (both failure shapes:
 *     cancelled:true AbortError branch and a plain journalled failure;
 *     replayed:true re-emits excluded — they never had a dwf_ask_start).
 *     Before the fix a plain failed ask decremented nothing: engineIdle()
 *     stayed false forever, maybePark's first guard returned, the 10s fallback
 *     never armed, and the run hung to the whole-run killTimer as `failed` —
 *     misfiling a human-interaction pause as a failure and locking BOTH human
 *     doors (fillHoleAndRun and `workflow answer` gate on status === 'parked',
 *     src/dwf/fill-hole.ts refused the fill).
 *   - The fill door: with the run properly parked, fillHoleAndRun ACCEPTS and
 *     the amend fork replays the journalled failure (replayed:true — the
 *     counter's exclusion case) into the script catch at zero live cost and
 *     completes through the spliced body.
 *
 * Numbering note: an older, CLOSED issue also carried #31 (the ADV4
 * microtask-escape preseed, 2026-11-02); this file tracks the NEW open issue
 * #31 (park deadlock) — the two files' "Issue #31" references are unrelated.
 *
 * Observability: the parked run's value is the park envelope, so the catch
 * observation rides the fill fork's return value (the spliced body closes over
 * the script's bindings).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFacadeScript, fillHoleAndRun } from '../../dist/src/dwf/runner.js';
import { providerRegistry } from '../../dist/src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../dist/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'issue-31-park-after-failed-ask.ts');

const RUN_WALL_BUDGET_MS = 55_000; // the park lands ~10-12s in (10s fallback); the killTimer path this guards against needs 600s

/** Always throws an unrecognized message: classifier → fatal, non-retryable, not a policy stop. */
class DoomedFailProvider implements LLMProvider {
  readonly id = 'doomed-fail-test';
  readonly name = 'Doomed failing test provider';
  calls = 0;
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    throw new Error('doomed: deterministic test failure (doomed-fail-test)');
  }
}

async function makeRunDir(fixturePath: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'issue-31-park-'));
  await fs.promises.copyFile(fixturePath, path.join(dir, 'attack.ts'));
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
        console.warn(`issue-31-park: temp run dir not removable yet (child exit race): ${(err as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe('Issue #31 (park deadlock): a caught failed ask must not block parking or filling', () => {
  test('failed ask → caught → hole: run parks (not killTimer-failed); fill accepted and completes', { timeout: 90_000 }, async () => {
    const dir = await makeRunDir(fixture);
    const doomed = new DoomedFailProvider();
    providerRegistry.register(doomed);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    try {
      const result = await runFacadeScript({
        scriptPath: path.join(dir, 'attack.ts'),
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'issue31.db'),
        runTimeoutMs: RUN_WALL_BUDGET_MS,
        onEvent: (e) => events.push(e),
      });
      // The load-bearing defense: parked, not killTimer-failed.
      assert.equal(
        result.status,
        'parked',
        `expected parked, got ${result.status}: ${result.error === undefined ? '(no error text)' : String(result.error).slice(0, 400)}`,
      );
      assert.equal(result.parkedAt?.name, 'await-human');
      assert.equal(result.parkedAt?.kind, 'hole');
      assert.equal(result.stats.asks, 1, 'the doomed ask counted once');

      // Event-level counter symmetry on the live run: the failed ask settled
      // via dwf_node_failed (kind ask, NOT cancelled, NOT replayed).
      const starts = events.filter((e) => e.type === 'dwf_ask_start').length;
      const completes = events.filter((e) => e.type === 'dwf_ask_complete').length;
      const liveAskFailures = events.filter(
        (e) => e.type === 'dwf_node_failed'
          && (e.data as { kind?: string }).kind === 'ask'
          && (e.data as { replayed?: boolean }).replayed !== true,
      ).length;
      assert.equal(starts, 1);
      assert.equal(completes, 0, 'a failed ask never fires dwf_ask_complete');
      assert.equal(liveAskFailures, 1, 'the failed ask settled via dwf_node_failed');
      assert.equal(starts, completes + liveAskFailures, 'every ask_start has a symmetric settle (complete or failure)');
      assert.equal(events.filter((e) => e.type === 'dwf_parked').length, 1, 'the terminal dwf_parked event fired');

      // The second symptom: the human door refused non-parked runs. With the
      // run properly parked the fill is ACCEPTED and the fork completes —
      // its replayed:true node_failed must NOT decrement (the fork has no
      // live ask before the spliced body).
      const fill = await fillHoleAndRun({
        runId: result.runId,
        holeName: 'await-human',
        // hole<string>: the body's return IS the hole's value — the script's own
        // return then carries the catch observation (doomedAskFailed etc.).
        body: "return 'HUMAN-FILL-ANSWER';",
        cwd: dir,
        dbPath: path.join(dir, '.workflow', 'issue31.db'),
      });
      assert.equal(fill.status, 'accepted', `fill refused: ${fill.error ?? JSON.stringify(fill.diagnostics)}`);
      assert.equal(fill.run!.status, 'completed', `forked run failed: ${fill.run!.error}`);
      const value = fill.run!.value as { doomedAskFailed?: boolean; doomedFailureName?: string; answer?: string };
      assert.equal(value.doomedAskFailed, true, 'the fork replayed the journalled failure into the script catch');
      assert.equal(value.answer, 'HUMAN-FILL-ANSWER');
      assert.equal(typeof value.doomedFailureName, 'string');
    } finally {
      await rmRunDir(dir);
    }
  });
});
