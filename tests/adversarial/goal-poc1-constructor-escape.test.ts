/**
 * TEST-GOAL 阶段4.2 攻防回归 — PoC1: 构造器链逃逸 ({ }).constructor.constructor("return process")().
 *
 * Attack fixtures: tests/adversarial/fixtures/goal-poc1-constructor-escape.ts (direct form)
 *                  tests/adversarial/fixtures/goal-poc1b-constructor-escape-anycast.ts (any-cast form)
 * Run style: node --test straight execution (same import style as .kiro/pbt/engine-invariants.test.ts).
 *
 * Measured matrix (node v22.23.2, worktree feat/issue-28-goal-e2e-pentest, re-measured
 * 2026-11-01 AFTER the static closure — compile.ts PROTOTYPE_CHAIN_PROPS):
 *  - Defense ① `node bin/workflow.js check -j <poc1>`: ok:false — purity-ban(9002)
 *    "\"constructor\" property access is banned". The former STATIC GAP (AST rules
 *    never inspected .constructor chains) is CLOSED: src/dwf/compile.ts bans
 *    constructor/__proto__/prototype property access in dot AND bracket form,
 *    type-agnostic — so the any-cast variant (formerly statically invisible) is
 *    caught too (verified: check -j on both fixtures, ok:false, code 9002).
 *  - Defense ② `node bin/workflow.js run-script <poc1>`: the run fails at FACADE
 *    COMPILATION (exit 1, "facade script failed compilation") before any sandbox
 *    child is spawned. The runtime second layer — vm realm
 *    codeGeneration:{strings:false} (src/dwf/child-main.ts:299) → V8 EvalError
 *    "Code generation from strings disallowed for this context" — remains in place
 *    for any future statically-invisible form, but this vector no longer reaches it.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POC1 = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc1-constructor-escape.ts');
const POC1B = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc1b-constructor-escape-anycast.ts');
const SPAWN_TIMEOUT_MS = 45_000;

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['bin/workflow.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

test('PoC1 defense ①: realm Function string-compilation is denied at compile (purity-ban 9002) and the run exits cleanly', () => {
  const r = runCli(['run-script', POC1, '--db', '.workflow/escape-poc1-test.db']);

  // process alive status: the CLI settled on its own (no timeout kill), child reaped.
  assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
  assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}; stderr=${r.stderr}`);

  // The static layer denies the vector before any sandbox child is spawned
  // (compile.ts purity-ban 9002 on "constructor" property access).
  assert.ok(
    (r.stderr ?? '').includes('facade script failed compilation'),
    `expected compile failure in stderr, got: ${r.stderr}`,
  );
  assert.ok(
    (r.stderr ?? '').includes('purity-ban(9002)') && (r.stderr ?? '').includes('"constructor" property access is banned'),
    `expected the constructor-chain purity-ban(9002) diagnostic in stderr, got: ${r.stderr}`,
  );
});

test('PoC1 defense ①: the any-cast variant (formerly static-invisible form) hits the same purity-ban(9002)', () => {
  const r = runCli(['run-script', POC1B, '--db', '.workflow/escape-poc1b-test.db']);

  assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
  assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}; stderr=${r.stderr}`);
  assert.ok(
    (r.stderr ?? '').includes('facade script failed compilation'),
    `expected compile failure in stderr, got: ${r.stderr}`,
  );
  // The 9002 rule matches property NAMES in the AST, not types — an `any` cast
  // cannot slip a .constructor chain past it.
  assert.ok(
    (r.stderr ?? '').includes('purity-ban(9002)') && (r.stderr ?? '').includes('"constructor" property access is banned'),
    `expected the constructor-chain purity-ban(9002) diagnostic in stderr, got: ${r.stderr}`,
  );
});

describe('PoC1 defense ①: the static check flags the constructor-chain escape (gap closed by purity-ban 9002)', () => {
  // Formerly a .skip block documenting the gap ("static layer returns ok:true").
  // The gap is closed (compile.ts PROTOTYPE_CHAIN_PROPS, re-measured 2026-11-01:
  // `node bin/workflow.js check -j <poc1>` → ok:false, purity-ban 9002), so this is
  // converted to real assertions exactly as the former skip text prescribed.
  test('check -j flags the constructor-chain escape statically', () => {
    const r = runCli(['check', '-j', POC1]);
    const analysis = JSON.parse(r.stdout!) as {
      ok: boolean;
      diagnostics: Array<{ code: number; category: string }>;
    };
    assert.equal(analysis.ok, false, `expected ok:false, got: ${r.stdout}`);
    assert.ok(
      analysis.diagnostics.some((d) => d.category === 'purity-ban' && d.code === 9002),
      `expected a purity-ban 9002 diagnostic, got: ${JSON.stringify(analysis.diagnostics)}`,
    );
  });
});
