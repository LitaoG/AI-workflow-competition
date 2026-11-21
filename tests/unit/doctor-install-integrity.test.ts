import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildInstallIntegrityCheck } from '../../src/cli/commands/doctor.js';

/**
 * Issue #205 — install-integrity check branches.
 *
 * The postinstall hook (scripts/link-self.mjs) may be silently skipped when npm
 * runs with ignore-scripts=true; doctor must surface the missing self-link with
 * actionable fix guidance instead of letting apps-scope imports fail later.
 * The check is pure fs over an explicit root dir, so each branch is exercised
 * against a throwaway temp fixture (same heuristic as link-self: apps/ exists).
 */

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-install-'));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function createSelfLink(root: string): void {
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(root, path.join(root, 'node_modules', 'ai-workflow'), process.platform === 'win32' ? 'junction' : 'dir');
}

test('downstream install (no apps/) passes without a self-link', () => {
  const root = makeRoot();
  try {
    // No apps/ directory: tarball/registry installs never carry the demo suite.
    const check = buildInstallIntegrityCheck(root);
    assert.equal(check.name, 'install integrity');
    assert.equal(check.ok, true);
    assert.match(check.detail, /downstream install/);
  } finally {
    cleanup(root);
  }
});

test('dev repo with the self-link present passes', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    createSelfLink(root);
    const check = buildInstallIntegrityCheck(root);
    assert.equal(check.ok, true);
    assert.match(check.detail, /self-link present/);
  } finally {
    cleanup(root);
  }
});

test('dev repo with a stale real directory instead of the link fails loudly', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    // A real (non-symlink) node_modules/ai-workflow directory is what link-self
    // treats as a stale install copy — the doctor must not accept it as the link.
    fs.mkdirSync(path.join(root, 'node_modules', 'ai-workflow'), { recursive: true });
    const check = buildInstallIntegrityCheck(root);
    assert.equal(check.ok, false);
    assert.match(check.detail, /self-link missing/);
    assert.match(check.detail, /link-self\.mjs/);
  } finally {
    cleanup(root);
  }
});

test('dev repo missing the self-link fails with fix guidance for the ignore-scripts case', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    const check = buildInstallIntegrityCheck(root);
    assert.equal(check.ok, false);
    assert.match(check.detail, /ignore-scripts/);
    assert.match(check.detail, /npm rebuild/);
  } finally {
    cleanup(root);
  }
});
