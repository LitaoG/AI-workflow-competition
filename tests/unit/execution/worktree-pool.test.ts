/**
 * (Issue #140): WorktreePool lifecycle — acquire on its own
 * branch, release removes clean trees (zero residue), keeps dirty ones for
 * review, merges back, and disposes without residue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorktreePool } from '../../../src/execution/worktree-pool.js';

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wt-repo-'));
  const git = (args: string): void => {
    execSync(`git ${args}`, { cwd: dir, stdio: 'pipe' });
  };
  git('init -b main');
  git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add -A');
  git('commit -m seed');
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } },
  };
}

const worktrees = (dir: string): string[] =>
  execSync('git worktree list --porcelain', { cwd: dir, stdio: 'pipe' }).toString()
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim())
    // git prints forward slashes on Windows — compare resolved native paths.
    .map((w) => path.resolve(w));

test('acquire mints one worktree per task on its own branch; release removes the clean tree', async () => {
  const repo = makeRepo();
  try {
    const pool = new WorktreePool({ workspace: repo.dir });
    const lease = await pool.acquire('scan-files');
    assert.ok(fs.existsSync(path.join(lease.worktreePath, 'seed.txt')), 'the tree carries the base content');
    assert.match(lease.branch, /^swarm\//);
    assert.ok(worktrees(repo.dir).some((w) => w === path.resolve(lease.worktreePath)), 'git registers the worktree');

    // same key re-acquires the same lease; different key gets its own tree
    const again = await pool.acquire('scan-files');
    assert.equal(again.worktreePath, lease.worktreePath);
    const other = await pool.acquire('other-task');
    assert.notEqual(other.worktreePath, lease.worktreePath);

    // clean tree → removed on release, zero residue
    const report = await pool.release('scan-files');
    assert.equal(report.removed, true);
    assert.equal(report.dirty, false);
    assert.ok(!fs.existsSync(lease.worktreePath), 'the clean tree is gone from disk');
    assert.ok(!worktrees(repo.dir).some((w) => w === path.resolve(lease.worktreePath)), 'git no longer lists the worktree');
    await pool.discard('other-task');
  } finally {
    repo.cleanup();
  }
});

test('a dirty tree is kept on release and reported with path/branch/status', async () => {
  const repo = makeRepo();
  try {
    const pool = new WorktreePool({ workspace: repo.dir });
    const lease = await pool.acquire('writer');
    fs.writeFileSync(path.join(lease.worktreePath, 'out.txt'), 'produced\n');
    const report = await pool.release('writer');
    assert.equal(report.removed, false);
    assert.equal(report.dirty, true);
    assert.equal(report.worktreePath, lease.worktreePath);
    assert.equal(report.branch, lease.branch);
    assert.match(report.status ?? '', /out\.txt/, 'the status surface names the change');
    assert.ok(fs.existsSync(lease.worktreePath), 'a dirty tree survives for review');
    await pool.discard('writer');
  } finally {
    repo.cleanup();
  }
});

test('mergeIntoBase brings a task branch back into the base branch', async () => {
  const repo = makeRepo();
  try {
    const pool = new WorktreePool({ workspace: repo.dir });
    const lease = await pool.acquire('merger');
    fs.writeFileSync(path.join(lease.worktreePath, 'contribution.txt'), 'merged\n');
    // Adjudication (Issue #298): Omit explicit shell: 'bash'. Node's default platform shells
    // (cmd.exe on Win32, /bin/sh on POSIX) natively support '&&' command chaining portably,
    // whereas explicitly passing shell: 'bash' on Windows introduces severe non-determinism
    // (if WSL bash.exe in System32 takes PATH precedence, it fails on Windows drive-letter cwds,
    // and fails on bare Windows without bash).
    execSync('git add -A && git commit -m task-work', { cwd: lease.worktreePath, stdio: 'pipe' });
    await pool.mergeIntoBase('merger');
    const merged = fs.readFileSync(path.join(repo.dir, 'contribution.txt'), 'utf8');
    assert.equal(merged.trim(), 'merged', 'the task contribution landed in the base branch');
    const head = execSync('git log --oneline -1', { cwd: repo.dir, stdio: 'pipe' }).toString();
    assert.match(head, /swarm merge: /, 'the merge commit is labeled');
    await pool.discard('merger');
  } finally {
    repo.cleanup();
  }
});

test('dispose removes clean trees and keeps dirty ones with reports', async () => {
  const repo = makeRepo();
  try {
    const pool = new WorktreePool({ workspace: repo.dir });
    const clean = await pool.acquire('clean-task');
    const dirty = await pool.acquire('dirty-task');
    fs.writeFileSync(path.join(dirty.worktreePath, 'keep.txt'), 'x\n');
    const reports = await pool.dispose();
    assert.equal(reports.length, 2);
    const cleanReport = reports.find((r) => r.taskKey === 'clean-task')!;
    const dirtyReport = reports.find((r) => r.taskKey === 'dirty-task')!;
    assert.equal(cleanReport.removed, true);
    assert.equal(dirtyReport.removed, false);
    assert.ok(!fs.existsSync(clean.worktreePath), 'clean tree removed by dispose');
    assert.ok(fs.existsSync(dirty.worktreePath), 'dirty tree kept by dispose');
    // the dirty tree still registers in git (kept for review)
    assert.ok(worktrees(repo.dir).some((w) => w === path.resolve(dirty.worktreePath)));
    await pool.discard('dirty-task');
  } finally {
    repo.cleanup();
  }
});

test('concurrent tasks write different files, merge back cleanly, zero residue', async () => {
  const repo = makeRepo();
  try {
    const pool = new WorktreePool({ workspace: repo.dir });
    const TASKS = 4;
    const leases = await Promise.all(
      Array.from({ length: TASKS }, (_, i) => pool.acquire(`writer-${i}`)),
    );
    assert.equal(new Set(leases.map((l) => l.worktreePath)).size, TASKS, 'each task gets its own tree');

    // every task writes its own file in its own tree and lands it on the base
    await Promise.all(leases.map(async (lease, i) => {
      fs.writeFileSync(path.join(lease.worktreePath, `contribution-${i}.txt`), `from task ${i}\n`);
      // Adjudication (Issue #298): Omit explicit shell: 'bash'. Node's default platform shells
      // (cmd.exe on Win32, /bin/sh on POSIX) natively support '&&' command chaining portably,
      // whereas explicitly passing shell: 'bash' on Windows introduces severe non-determinism
      // (if WSL bash.exe in System32 takes PATH precedence, it fails on Windows drive-letter cwds,
      // and fails on bare Windows without bash).
      execSync('git add -A && git commit -m "task work"', { cwd: lease.worktreePath, stdio: 'pipe' });
      await pool.mergeIntoBase(lease.taskKey);
    }));

    // every contribution merged, none clobbered another
    for (let i = 0; i < TASKS; i++) {
      assert.equal(fs.readFileSync(path.join(repo.dir, `contribution-${i}.txt`), 'utf8').trim(), `from task ${i}`);
    }

    // merged trees are clean → dispose removes them all; only the main tree remains
    const reports = await pool.dispose();
    assert.equal(reports.length, TASKS);
    assert.ok(reports.every((r) => r.removed), 'merged trees are clean and removed');
    assert.equal(worktrees(repo.dir).length, 1, 'git worktree list is back to the main tree only');
  } finally {
    repo.cleanup();
  }
});
