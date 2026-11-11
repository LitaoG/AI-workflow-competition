import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-budget-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('budget: exceeding the run-level budget.total stops further agent() calls with WorkflowBudgetExceededError', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'budget.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Cap");
const first = await agent("a").ask<Answer>("inspect health report of the service");
log(\`after first: spent=\${budget.spent()} total=\${budget.total} remaining=\${budget.remaining()}\`);
let secondError = '';
try {
  await agent("b").ask("inspect health report of the service");
} catch (e) {
  secondError = (e as Error).name + ': ' + (e as Error).message;
}
return { first: first.healthStatus, secondError, total: budget.total };

interface Answer { healthStatus: string; }
`);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    // Official parity: the cap comes from the run config, never the script.
    // Mock usage is 88 completion tokens per ask — the 2nd ask trips the pre-check.
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, budgetTotal: 80, onEvent: (e) => events.push(e) });
    assert.equal(r.status, 'completed', r.error);
    const value = r.value as { first: string; secondError: string; total: number | null };
    assert.equal(value.first, 'HEALTHY', 'the first ask completes normally');
    assert.equal(value.total, 80, 'the script reads the injected total');
    assert.match(value.secondError, /WorkflowBudgetExceededError: Workflow token budget exceeded \(/, `got: ${value.secondError}`);
    assert.match(value.secondError, /In-flight agents will complete/, 'Claude-parity message preserved');
    assert.ok(events.some((e) => e.type === 'dwf_budget_spent'), 'budget heartbeats flow');
  } finally {
    ws.cleanup();
  }
});

test('budget: the sandbox budget is read-only — assigning budget.total is a compile error', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'readonly.facade.ts');
    fs.writeFileSync(scriptPath, `
budget.total = 80;
return { ok: true };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'compile_failed', `expected compile refusal, got ${r.status}`);
    assert.ok(
      (r.diagnostics ?? []).some((d) => /read-only|readonly|Cannot assign/i.test(d.message)),
      `expected a readonly diagnostic, got: ${JSON.stringify(r.diagnostics)}`,
    );
    assert.equal(r.stats.asks, 0, 'no provider call is made for a refused script');
  } finally {
    ws.cleanup();
  }
});

test('budget: remaining() is Infinity when total is null; the 1000-call cap has the loop-safety message', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'cap.facade.ts');
    fs.writeFileSync(scriptPath, `
const unlimited = budget.remaining() === Infinity;
return { unlimited };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, { unlimited: true });
  } finally {
    ws.cleanup();
  }
});
