/**
 * Issue #124: workflow() composition budget accounting.
 *
 * Pre-fix failure mode (all [已验证] on the base): the child was granted the
 * parent's remaining cap, but the parent engine never absorbed the child's
 * spend — N sequential workflow() calls could bill N+1x the cap with a clean
 * completion; the child's dwf_budget_spent events (re-emitted into the
 * parent's stream) overwrote BOTH the settlement record (output_tokens_spent
 * became the child's number) and the parent script's budget view.
 *
 * Repro recipe from the issue: a provider reporting 400 completion tokens per
 * ask, a child doing two asks, a parent that asks once then composes the
 * child twice, budgetTotal 1000. The run must FAIL with a budget-exceeded
 * error around the cap, and the settled row must carry the parent-inclusive
 * total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';
import { createSQLiteStore } from '../../src/state/store.js';
import { executeAnswer } from '../../src/cli/commands/answer.js';
import type { SQLiteStateStore } from '../../src/state/sqlite-store.js';

const BUDGET_CHILD = `/* workflow
name: budget-child
description: Two-ask child for the composition budget probe
*/
phase("Child");
const a = await agent("child-agent", { provider: "budget-probe" }).ask<Answer>("first question");
const b = await agent("child-agent", { provider: "budget-probe" }).ask<Answer>("second question");
return { a: a.ok, b: b.ok };
interface Answer { ok: boolean; }
`;

const BUDGET_PARENT = `
phase("Parent");
const first = await agent("parent-agent", { provider: "budget-probe" }).ask<Answer>("parent ask");
const childA = await workflow("budget-child");
const childB = await workflow("budget-child");
return { first: first.ok, childA, childB };
interface Answer { ok: boolean; }
`;

let probeCalls = 0;
const budgetProbe: LLMProvider = {
  id: 'budget-probe',
  name: 'composition budget probe provider',
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    probeCalls += 1;
    return {
      content: '{"ok":true}',
      model: 'budget-probe',
      latencyMs: 0,
      usage: { promptTokens: 0, completionTokens: 400, totalTokens: 400 },
    };
  },
};
providerRegistry.register(budgetProbe);

function makeProject(): { dir: string; parentPath: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-budget-compose-'));
  const wfDir = path.join(dir, '.workflow', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'budget-child.facade.ts'), BUDGET_CHILD);
  const parentPath = path.join(dir, 'parent.facade.ts');
  fs.writeFileSync(parentPath, BUDGET_PARENT);
  return {
    dir,
    parentPath,
    dbPath: path.join(dir, '.workflow', 'dwf.sqlite'),
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows lock lag */
      }
    },
  };
}

const PARK_PARENT = `
phase("Park");
const a = await agent("park-agent", { provider: "budget-probe" }).ask<Answer>("first");
const b = await agent("park-agent", { provider: "budget-probe" }).ask<Answer>("second");
const approval = await escalate("Continue spending?");
const c = await agent("park-agent", { provider: "budget-probe" }).ask<Answer>("third");
return { c: c.ok };
interface Answer { ok: boolean; }
`;

test('budget persists across a park -> answer boundary (Issue #118)', { timeout: 120_000 }, async () => {
  // budgetTotal 500, two asks bill 800, the run parks at the escalation.
  // The answer resumes the SAME run: without the persisted cap the third ask
  // ran freely (pre-fix the resume completed at 1200); with it the restored
  // (cap, spent-baseline) pair trips the pre-ask check (800 >= 500).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-budget-park-'));
  const scriptPath = path.join(dir, 'park.facade.ts');
  fs.writeFileSync(scriptPath, PARK_PARENT);
  const dbPath = path.join(dir, '.workflow', 'dwf.sqlite');
  try {
    const r1 = await runFacadeScript({ scriptPath, cwd: dir, budgetTotal: 500 });
    assert.equal(r1.status, 'parked', r1.error);
    const store = createSQLiteStore(dbPath) as SQLiteStateStore;
    const row = await store.getDwfRun(r1.runId);
    assert.equal(row?.budgetTotal, 500, 'the cap must be persisted on the run row');
    assert.equal(row?.outputTokensSpent, 800, 'the spent baseline must be persisted');

    const qid = r1.parkedAt?.name as string;
    const exit = await executeAnswer(r1.runId, qid, ['yes'], { dbPath });
    store.close();
    // The resumed leg re-asks under the restored cap: 800 >= 500 must trip.
    assert.equal(exit, 1, 'the answered run must fail on the restored budget (pre-fix it completed)');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows lock lag */
    }
  }
});

test('composition budget: child spend is absorbed, the cap is enforced, settlement is the parent total (Issue #124)', { timeout: 120_000 }, async () => {
  const project = makeProject();
  try {
    probeCalls = 0;
    const r = await runFacadeScript({
      scriptPath: project.parentPath,
      cwd: project.dir,
      budgetTotal: 1000,
    });

    // Pre-fix: parent 400 + unabsorbed children 800+800 completed cleanly at
    // 2000 tokens (2x over the cap). Post-fix the budget must trip.
    assert.equal(r.status, 'failed', `expected a budget failure, got ${r.status}: ${r.error}`);
    assert.match(r.error ?? '', /[Bb]udget/i, `the failure must be budget-driven: ${r.error}`);

    // Every ask bills 400: parent 1 + childA 2 + childB (first ask allowed at
    // a 1-token grant) = 4 calls before the cap trips the second child ask.
    assert.equal(probeCalls, 4, `expected 4 billed asks, got ${probeCalls}`);

    // Settlement: the parent-inclusive total of every BILLED ask — 400 own +
    // 800 childA + 400 childB's first ask (absorbed even though childB then
    // failed) = 1600. NOT the child's last tagged event (was 800 pre-fix) and
    // NOT the parent-only 400.
    const store = createSQLiteStore(project.dbPath) as SQLiteStateStore;
    const row = await store.getDwfRun(r.runId);
    store.close();
    assert.equal(row?.outputTokensSpent, 1600, `settlement must carry the parent-inclusive total, got ${row?.outputTokensSpent}`);
  } finally {
    project.cleanup();
  }
});
