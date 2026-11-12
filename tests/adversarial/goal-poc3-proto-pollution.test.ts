/**
 * 攻防回归 — PoC3: 原型链污染（realm 内 vs 跨 realm）.
 *
 * Attack fixtures:
 *  - goal-poc3b-proto-pollution-realm-only.ts — CONTROL: pollution of the realm's OWN
 *    Object.prototype (`({}).__proto__` inside the script) — the former run-level
 *    containment proof;
 *  - goal-poc3-proto-pollution.ts — cross-realm: plant a prop on the HOST Object.prototype
 *    via args.__proto__ (host-realm args object) and read it back with a host-compiled
 *    function; proof rides the return value;
 *  - goal-poc3c-proto-pollution-tojson.ts — protocol mangling: toJSON on the HOST
 *    Object.prototype collapses every parent-bound frame to "PWNED-PROTOCOL".
 *
 * Measured matrix (node v22.23.2, re-measured 2026-11-01 AFTER the static closure —
 * compile.ts PROTOTYPE_CHAIN_PROPS):
 *  - Defense ① check on all three: ok:false — purity-ban(9002) bans
 *    __proto__/constructor/prototype property access in dot AND bracket form,
 *    type-agnostic. The former STATIC GAP is CLOSED: every fixture here is
 *    compile-rejected ("facade script failed compilation", exit 1) before any
 *    sandbox child is spawned (verified with check -j and run-script on all three).
 *  - Defense ② poc3b (realm-only control): SUBSUMED — the vector is statically
 *    unreachable, so run-level containment can no longer be observed through the
 *    facade; the vm-realm containment property itself remains true (poc1's runtime
 *    layer, child-main.ts:299 codeGeneration:{strings:false}).
 *  - Defense ② poc3 / poc3c (cross-realm): SUBSUMED the same way — args-rooted
 *    __proto__/constructor chains are compile-rejected; the host realm is no longer
 *    reachable through facade scripts at all.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POC3 = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc3-proto-pollution.ts');
const POC3B = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc3b-proto-pollution-realm-only.ts');
const POC3C = path.join(ROOT, 'tests', 'adversarial', 'fixtures', 'goal-poc3c-proto-pollution-tojson.ts');
const SPAWN_TIMEOUT_MS = 45_000;

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['bin/workflow.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

test('PoC3 defense ① (control): realm-only prototype pollution fixture is compile-rejected — the vector is statically unreachable (purity-ban 9002)', () => {
  const r = runCli(['run-script', POC3B, '--db', '.workflow/escape-poc3b-test.db']);

  assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
  assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}; stderr=${r.stderr}`);
  // The static layer denies ANY prototype-chain write (realm-internal ones included):
  // the former run-level containment proof is subsumed by an earlier, deterministic
  // rejection — the script never runs.
  assert.ok(
    (r.stderr ?? '').includes('facade script failed compilation'),
    `expected compile failure in stderr, got: ${r.stderr}`,
  );
  assert.ok(
    (r.stderr ?? '').includes('purity-ban(9002)') && (r.stderr ?? '').includes('"__proto__" property access is banned'),
    `expected the __proto__ purity-ban(9002) diagnostic in stderr, got: ${r.stderr}`,
  );
});

describe('PoC3 defense ①: cross-realm prototype pollution — statically closed (purity-ban 9002)', () => {
  // Formerly a .skip block documenting the breach ("hostProof=PWNED-PROTOTYPE-POLLUTION;
  // poc3c mangles the done frame"). The gap is closed by the same compile.ts rule
  // (PROTOTYPE_CHAIN_PROPS, re-measured 2026-11-01: both fixtures are compile-rejected
  // before any sandbox child spawns), so this is converted to real assertions exactly
  // as the former skip text prescribed ("When fixed, convert to: poc3 → run fails").
  test('poc3: host Object.prototype is not reachable from the sandbox — args.__proto__ chain is compile-rejected', () => {
    const r = runCli(['run-script', POC3, '--db', '.workflow/escape-poc3-test.db']);
    assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
    assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}; stderr=${r.stderr}`);
    assert.ok(
      (r.stderr ?? '').includes('purity-ban(9002)') && (r.stderr ?? '').includes('"__proto__" property access is banned'),
      `expected the __proto__ purity-ban(9002) diagnostic in stderr, got: ${r.stderr}`,
    );
  });

  test('poc3c: done-frame mangling is unreachable — the toJSON pollution vector is compile-rejected', () => {
    const r = runCli(['run-script', POC3C, '--db', '.workflow/escape-poc3c-test.db']);
    assert.equal(r.error, undefined, `run-script did not settle in time: ${String(r.error)}`);
    assert.equal(r.status, 1, `expected exit 1, got ${String(r.status)}; stderr=${r.stderr}`);
    assert.ok(
      (r.stderr ?? '').includes('purity-ban(9002)') && (r.stderr ?? '').includes('"__proto__" property access is banned'),
      `expected the __proto__ purity-ban(9002) diagnostic in stderr, got: ${r.stderr}`,
    );
  });
});
