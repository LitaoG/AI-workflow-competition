/**
 * TEST-GOAL 4.2 PoC1 regression: 500-level deep type chain / true recursive type
 * handed to ask<T> — resource bomb against the facade compiler's check.
 *
 * Attack (fixtures, not compiled by tsconfig — tests/adversarial excluded):
 *   tests/adversarial/fixtures/goal-poc1-deep-type.ts        — 500 nested interfaces A499→A0, ask<A499>
 *   tests/adversarial/fixtures/goal-poc1-recursive-cycle.ts  — self-referential Chain type
 *
 * Defense under test (src/dwf/schema-synth.ts):
 *   - MAX_DEPTH = 8  → diagnostic 9005 "ask<T> type nests deeper than 8 levels"
 *   - path-scoped seen-set → precise diagnostic 9015 "recursive type at site ask#N: <type>"
 * The check must TERMINATE with diagnostics (tooling-level catchable, run never starts),
 * never hang. Live PoC run measured ~1.2s wall for both (watchdog 120s never hit).
 *
 * Run style mirrors .kiro/pbt/engine-invariants.test.ts: node --test, imports from dist.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { analyzeFacadeScript } from '../../dist/src/dwf/compile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '..', '..');
const deepFixture = path.join(here, 'fixtures', 'goal-poc1-deep-type.ts');
const cycleFixture = path.join(here, 'fixtures', 'goal-poc1-recursive-cycle.ts');

/** 60s hard upper bound per check — the ask's requirement: give a timeout upper bound. */
const CHECK_WALL_BUDGET_MS = 60_000;

describe('TEST-GOAL PoC1: ask<T> deep/recursive type resource bomb', () => {
  test('check terminates with diagnostic 9005 on a 500-level type chain (no hang)', () => {
    const source = fs.readFileSync(deepFixture, 'utf8');
    const t0 = Date.now();
    const analysis = analyzeFacadeScript(source);
    const wallMs = Date.now() - t0;

    const synth = analysis.diagnostics.filter((d) => d.category === 'schema-synth');
    assert.equal(synth.length, 1, `expected exactly one schema-synth diagnostic, got ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(synth[0]!.code, 9005, 'depth-cap diagnostic code');
    assert.match(synth[0]!.message, /nests deeper than 8 levels/);
    assert.ok(wallMs < CHECK_WALL_BUDGET_MS, `check took ${wallMs}ms, over the ${CHECK_WALL_BUDGET_MS}ms bound`);
  });

  test('check terminates with precise diagnostic 9015 on a true recursive type (no stack burn)', () => {
    const source = fs.readFileSync(cycleFixture, 'utf8');
    const t0 = Date.now();
    const analysis = analyzeFacadeScript(source);
    const wallMs = Date.now() - t0;

    const synth = analysis.diagnostics.filter((d) => d.category === 'schema-synth');
    assert.equal(synth.length, 1);
    assert.equal(synth[0]!.code, 9015, 'recursion diagnostic code');
    assert.match(synth[0]!.message, /recursive type at site ask#\d+: Chain/);
    assert.ok(wallMs < CHECK_WALL_BUDGET_MS, `check took ${wallMs}ms, over the ${CHECK_WALL_BUDGET_MS}ms bound`);
  });

  test('CLI end-to-end: workflow check exits 1 with the diagnostic, killed=false (watchdog 55s)', async () => {
    const t0 = Date.now();
    const result = await new Promise<{ code: number | null; stderr: string; killed: boolean }>((resolve) => {
      const child = spawn(process.execPath, ['bin/workflow.js', 'check', deepFixture], {
        cwd: worktreeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (d) => (stderr += d));
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 55_000);
      child.on('close', (code, signal) => {
        clearTimeout(watchdog);
        resolve({ code, stderr, killed: signal === 'SIGKILL' });
      });
    });
    const wallMs = Date.now() - t0;

    assert.equal(result.killed, false, 'check must terminate on its own (no watchdog kill)');
    assert.equal(result.code, 1, 'compile failure exits 1');
    assert.match(result.stderr, /schema-synth\(9005\)/);
    assert.ok(wallMs < CHECK_WALL_BUDGET_MS, `CLI check took ${wallMs}ms, over the ${CHECK_WALL_BUDGET_MS}ms bound`);
  });
});
