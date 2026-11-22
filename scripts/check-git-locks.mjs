#!/usr/bin/env node
// Stale git lock-file guard (Issue #253): Windows force-kills of git subprocesses
// (concurrent aborts, gate timeouts) can leave a zero-byte `.git/index.lock`
// behind — every later git command then dies with
// `fatal: Unable to create '...index.lock': File exists` and the message does
// not explain itself. This script gives the gate/cleanup chain a mechanical
// probe:
//   - zero-byte lock        → STALE (safe to remove with --fix)
//   - non-empty old lock    → STALE (older than the freshness threshold)
//   - non-empty fresh lock  → ACTIVE (a git op is presumably running — report, exit 0)
//
// Exit codes: 0 = clean or only active locks; 1 = stale lock(s) found.
// `--fix` removes ZERO-BYTE locks only and never a non-empty lock (a non-empty
// lock may hold in-flight index data; removal is a human decision after
// confirming no git process is running).
//
// Usage: node scripts/check-git-locks.mjs [--fix] [--repo <path>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Classification logic lives in src/git-locks.ts (typed + unit-pinned at
// tests/unit/git-locks.test.ts); this thin CLI wrapper resolves the compiled
// module — run `npm run build` first if dist is missing.
let classifyLock;
try {
  ({ classifyLock } = await import('../dist/src/git-locks.js'));
} catch {
  console.error('check-git-locks: dist/src/git-locks.js not found — run `npm run build` first.');
  process.exit(1);
}

function findIndexLocks(gitDir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(gitDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(gitDir, entry.name);
    if (entry.isDirectory()) {
      // `.git/worktrees/<name>/index.lock` covers linked worktrees; recurse
      // so sibling worktree shells are reported too (Issue #67 family).
      findIndexLocks(full, out);
    } else if (entry.name === 'index.lock') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve the COMMON git dir: a linked worktree's `.git` is a file pointer
 * ("gitdir: <main>/.git/worktrees/<name>") — scan its grandparent (the main
 * .git) so the main index.lock and sibling worktree locks are all covered.
 */
function resolveCommonGitDir(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
  if (!pointer) return null;
  return path.resolve(path.resolve(repoRoot, pointer[1]), '..', '..');
}

export function main(argv = process.argv.slice(2)) {
  const fix = argv.includes('--fix');
  const repoFlagIdx = argv.indexOf('--repo');
  const repoRoot = repoFlagIdx >= 0 ? path.resolve(argv[repoFlagIdx + 1]) : process.cwd();
  const gitDir = resolveCommonGitDir(repoRoot);
  if (!gitDir) {
    console.error(`check-git-locks: no .git directory under ${repoRoot}`);
    return 1;
  }

  const locks = findIndexLocks(gitDir);
  if (locks.length === 0) {
    console.log('check-git-locks: no index.lock present — clean.');
    return 0;
  }

  const now = Date.now();
  let staleCount = 0;
  for (const lockPath of locks) {
    let stat;
    try {
      stat = fs.statSync(lockPath);
    } catch (err) {
      console.warn(`check-git-locks: cannot stat ${lockPath}: ${err.message}`);
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    const state = classifyLock(stat.size, ageMs);
    if (state === 'active') {
      console.log(`check-git-locks: ACTIVE lock (a git op may be running) — ${lockPath} (${stat.size} bytes, ${Math.round(ageMs / 1000)}s old)`);
      continue;
    }
    staleCount++;
    console.error(
      `check-git-locks: STALE lock (${state === 'stale-empty' ? 'zero-byte' : `${Math.round(ageMs / 60000)}min old`}) — ${lockPath}\n` +
      '  Every git read/write will fail with "Unable to create ...index.lock: File exists" until it is removed.\n' +
      '  Confirm no git process is running, then: del "' + lockPath + '"   (or rerun this script with --fix)',
    );
    if (fix && state === 'stale-empty') {
      try {
        fs.rmSync(lockPath);
        console.log(`check-git-locks: --fix removed zero-byte lock ${lockPath}`);
        staleCount--;
      } catch (err) {
        console.error(`check-git-locks: --fix failed on ${lockPath}: ${err.message}`);
      }
    }
  }
  if (staleCount > 0) {
    console.error(`check-git-locks: ${staleCount} stale lock(s) found — unblock git before continuing.`);
    return 1;
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const selfPath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && invoked === selfPath) {
  process.exit(main());
}
