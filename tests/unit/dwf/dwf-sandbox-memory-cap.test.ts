/**
 * Issue #18 — sandbox memory cap single-source + the 1.5× commit-cap contract.
 *
 * History: DEFAULT_SANDBOX_MAX_OLD_SPACE_MB was defined twice (runner.ts and
 * sandbox-launch.ts) and the Job Object commit cap was computed from the local
 * runner constant — it never saw the AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB env
 * override, so env=2048 kept a 768 MB commit cap under a 2048 MB heap cap and
 * a runaway child died of Job Object force-kill instead of its own OOM.
 *
 * Locks here (pure functions + static source scans — the unit suite keeps pure
 * isolation semantics, P-TEST-5; no child processes are spawned):
 *   1. the constant is defined exactly once across src/ (sandbox-launch.ts),
 *      and runner.ts no longer declares or references it;
 *   2. resolveSandboxMaxOldSpaceMb: explicit option → env → 512 default, with
 *      junk / zero / negative env values rejected;
 *   3. buildSandboxChildArgs argv carries the env-resolved heap cap;
 *   4. the commit-cap site in runner.ts derives from the SAME resolver with the
 *      1.5× factor — commit cap == round(1.5 × effective heap cap) on every
 *      path, including the env one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SANDBOX_MAX_OLD_SPACE_MB,
  buildSandboxChildArgs,
  resolveSandboxMaxOldSpaceMb,
} from '../../../src/dwf/sandbox-launch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(startDir, '../..');
}

const REPO_ROOT = findRepoRoot(__dirname);
const ENV_NAME = 'AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB';

/** Run fn with AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB set (or deleted), restored after. */
function withEnv<T>(raw: string | undefined, fn: () => T): T {
  const prev = process.env[ENV_NAME];
  try {
    if (raw === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = raw;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = prev;
  }
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------ ① single source

test('#18 ① DEFAULT_SANDBOX_MAX_OLD_SPACE_MB is defined exactly once across src/', () => {
  const srcRoot = path.join(REPO_ROOT, 'src');
  const definition = /const\s+DEFAULT_SANDBOX_MAX_OLD_SPACE_MB\s*=/;
  const defining: string[] = [];
  for (const file of listTsFiles(srcRoot)) {
    const src = fs.readFileSync(file, 'utf8');
    if (definition.test(src)) defining.push(path.relative(REPO_ROOT, file));
  }
  assert.deepEqual(defining, [path.join('src', 'dwf', 'sandbox-launch.ts')],
    'the sandbox heap-cap default must have exactly one definition site: src/dwf/sandbox-launch.ts');
  // the surviving definition is the exported one — the shared resolver reads it.
  const launchSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'dwf', 'sandbox-launch.ts'), 'utf8');
  assert.match(launchSrc, /export\s+const\s+DEFAULT_SANDBOX_MAX_OLD_SPACE_MB\s*=\s*512/);
  // runner.ts must not declare nor reference the constant — the commit cap goes
  // through resolveSandboxMaxOldSpaceMb (the env path is invisible to a bare
  // constant reference, which is the bug this Issue fixes).
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'dwf', 'runner.ts'), 'utf8');
  assert.ok(!runnerSrc.includes('DEFAULT_SANDBOX_MAX_OLD_SPACE_MB'),
    'runner.ts must not declare or reference DEFAULT_SANDBOX_MAX_OLD_SPACE_MB');
});

// ------------------------------------------------------------------ ② resolution order

test('#18 ② resolveSandboxMaxOldSpaceMb: explicit option → env → 512 default', () => {
  withEnv(undefined, () => {
    assert.equal(resolveSandboxMaxOldSpaceMb(undefined), DEFAULT_SANDBOX_MAX_OLD_SPACE_MB);
    assert.equal(DEFAULT_SANDBOX_MAX_OLD_SPACE_MB, 512);
    assert.equal(resolveSandboxMaxOldSpaceMb(2048), 2048);
  });
  withEnv('2048', () => {
    assert.equal(resolveSandboxMaxOldSpaceMb(undefined), 2048, 'the env override must be honored');
    assert.equal(resolveSandboxMaxOldSpaceMb(4096), 4096, 'the explicit option wins over the env');
  });
  // junk / zero / negative / fractional env values: floor or fall back to default
  assert.equal(withEnv('junk', () => resolveSandboxMaxOldSpaceMb(undefined)), DEFAULT_SANDBOX_MAX_OLD_SPACE_MB);
  assert.equal(withEnv('0', () => resolveSandboxMaxOldSpaceMb(undefined)), DEFAULT_SANDBOX_MAX_OLD_SPACE_MB);
  assert.equal(withEnv('-5', () => resolveSandboxMaxOldSpaceMb(undefined)), DEFAULT_SANDBOX_MAX_OLD_SPACE_MB);
  assert.equal(withEnv('2048.9', () => resolveSandboxMaxOldSpaceMb(undefined)), 2048);
});

// ------------------------------------------------------------------ ③ argv carries the effective cap

test('#18 ③ buildSandboxChildArgs argv carries the env-resolved heap cap', () => {
  withEnv(undefined, () => {
    assert.equal(buildSandboxChildArgs('entry.js', 'script.js', 'args.json')[0], '--max-old-space-size=512');
  });
  withEnv('2048', () => {
    assert.equal(buildSandboxChildArgs('entry.js', 'script.js', 'args.json')[0], '--max-old-space-size=2048');
  });
});

// ------------------------------------------------------------------ ④ commit cap = 1.5 × effective cap

test('#18 ④ the Job Object commit cap derives from the same resolver at 1.5×', () => {
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'dwf', 'runner.ts'), 'utf8');
  const site = runnerSrc.split('\n').find((line) => line.includes('processMemoryLimitMb'));
  assert.ok(site, 'the processMemoryLimitMb site was not found in runner.ts');
  assert.match(site, /Math\.round\(/);
  assert.match(site, /resolveSandboxMaxOldSpaceMb\(/,
    'the commit cap must be computed from the same resolver buildSandboxChildArgs uses (env path included)');
  assert.match(site, /\*\s*1\.5/);
  // the 1.5× arithmetic holds on every resolution path — spot-check the two
  // paths that matter (default baseline and the env override that used to break
  // the contract: env=2048 previously kept a 768 MB commit cap).
  assert.equal(withEnv(undefined, () => Math.round(resolveSandboxMaxOldSpaceMb(undefined) * 1.5)), 768);
  assert.equal(withEnv('2048', () => Math.round(resolveSandboxMaxOldSpaceMb(undefined) * 1.5)), 3072);
});
