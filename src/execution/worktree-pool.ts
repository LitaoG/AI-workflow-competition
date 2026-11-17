/**
 * Git worktree physical isolation for subagent tasks (Issue #140).
 *
 * Wiring disclosure (Issue #123): this pool is NOT wired into the dwf swarm
 * path — the engine consumes only src/execution/swarm-dispatcher.ts (the
 * concurrency window formula). Per-task worktree isolation exists here and in
 * its unit tests (docs/absorbed-capabilities.md CAP-003), while the public
 * swarm contract in src/dwf/facade-dts.ts explicitly states "All tasks share
 * this run's working tree (no per-task worktree)". Wiring it in — or retiring
 * it — is a pending decision.
 *
 * A pool mints one physical worktree per task key, at a branch cut from the
 * workspace's HEAD, under a pool directory beside the workspace (never inside
 * it — AGENTS.md §1.8 sibling-directory discipline). Semantics mirror the
 * canonical subagent contract:
 *   - a task that changed nothing is removed on release (zero residue), and
 *   - a task with changes is KEPT for review, its worktreePath/branch/diff
 *     handed back to the caller (reference parity),
 *   - mergeIntoBase fast-forwards/merges a lease's branch back into the base
 *     branch from the main workspace, failing loudly on conflicts.
 *
 * Windows note (P-ENV-2): worktree removal races file-handle locks (indexers,
 * watchers). Removal retries once after a short backoff; a still-locked tree is
 * reported, not silently leaked.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const execAsync = promisify(exec);

export interface WorktreeLease {
  /** Stable task key the lease was acquired for. */
  taskKey: string;
  /** Physical working tree path (outside the main workspace). */
  worktreePath: string;
  /** Branch cut at HEAD for this task (swarm/<pool>/<key>). */
  branch: string;
}

export interface ReleaseReport {
  taskKey: string;
  /** True when the task changed nothing and the tree was removed. */
  removed: boolean;
  /** True when the task left changes behind (tree kept for review). */
  dirty: boolean;
  worktreePath?: string;
  branch?: string;
  /** `git status --porcelain` of a dirty tree, for the review surface. */
  status?: string;
}

export interface PoolOptions {
  /** The main workspace (a git checkout). */
  workspace: string;
  /** Pool root; defaults to `<workspace>-swarm-worktrees` beside the workspace. */
  poolDir?: string;
  /** Branch leases are cut from; defaults to the workspace's current HEAD. */
  baseRef?: string;
}

/** Task keys become directory and branch segments — keep both filesystem- and ref-safe. */
function sanitizeKey(taskKey: string): string {
  const cleaned = taskKey.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) throw new Error(`worktree-pool: task key "${taskKey}" has no filesystem-safe characters`);
  return cleaned.slice(0, 80);
}

export class WorktreePool {
  private readonly workspace: string;
  private readonly poolDir: string;
  private readonly baseRef: string;
  private readonly poolId = randomBytes(3).toString('hex');
  private readonly leases = new Map<string, WorktreeLease>();
  /**
   * Serializes base-repo mutations. Concurrent acquire/mergeIntoBase is the
   * API's intended usage (a swarm fans out tasks), but every mutation runs
   * `git` against the SAME workspace — and git does not retry `.git/index.lock`
   * acquisition: a loser exits fatal immediately. Measured on Linux CI
   * (Issue #29, unit #235): 4 concurrent worktree-add/merge calls collide at
   * ~30% per run. The chain keeps the lease operations one-at-a-time without
   * changing their external async signatures.
   */
  private baseOps: Promise<unknown> = Promise.resolve();

  constructor(options: PoolOptions) {
    this.workspace = path.resolve(options.workspace);
    this.poolDir = options.poolDir
      ? path.resolve(options.poolDir)
      : path.join(path.dirname(this.workspace), `${path.basename(this.workspace)}-swarm-worktrees`);
    this.baseRef = options.baseRef ?? 'HEAD';
  }

  /** The pool root on disk (created lazily by the first acquire). */
  get root(): string {
    return this.poolDir;
  }

  listLeases(): WorktreeLease[] {
    return [...this.leases.values()];
  }

  /** Run one base-repo mutation at the tail of the serialization chain, surviving prior failures. */
  private serializeBase<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.baseOps.then(fn, fn);
    this.baseOps = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Mint (or return the existing) worktree for one task, on its own branch at the base ref. */
  async acquire(taskKey: string): Promise<WorktreeLease> {
    const existing = this.leases.get(taskKey);
    if (existing) return existing;
    const safe = sanitizeKey(taskKey);
    const worktreePath = path.join(this.poolDir, `task-${safe}`);
    const branch = `swarm/${this.poolId}/${safe}`;
    fs.mkdirSync(this.poolDir, { recursive: true });
    // A branch per task (canonical parity: changes stay addressable for merge);
    // -B tolerates a re-acquire after a crash left the branch behind.
    // Serialized: concurrent worktree adds race .git/index.lock (Issue #29).
    await this.serializeBase(() =>
      this.git(`worktree add -B ${branch} ${JSON.stringify(worktreePath)} ${this.baseRef}`),
    );
    const lease: WorktreeLease = { taskKey, worktreePath, branch };
    this.leases.set(taskKey, lease);
    return lease;
  }

  /**
   * Release a task's tree: clean trees are removed (zero residue); dirty trees
   * are kept and reported with path/branch/status for review.
   */
  async release(taskKey: string): Promise<ReleaseReport> {
    const lease = this.leases.get(taskKey);
    if (!lease) throw new Error(`worktree-pool: no lease for task "${taskKey}"`);
    const status = (await this.gitAt(lease.worktreePath, 'status --porcelain')).stdout;
    const dirty = status.trim().length > 0;
    if (!dirty) {
      await this.removeWorktree(lease);
      this.leases.delete(taskKey);
      return { taskKey, removed: true, dirty: false };
    }
    return { taskKey, removed: false, dirty: true, worktreePath: lease.worktreePath, branch: lease.branch, status };
  }

  /**
   * Merge serialization: git allows one merge at a time per worktree. The pool's
   * whole point is concurrent tasks, so concurrent mergeIntoBase calls into the
   * same base workspace must queue — on a slow runner two merges genuinely
   * overlap and the second hits the first's unresolved MERGE_HEAD
   * ("You have not concluded your merge"), a pure scheduling race, not a
   * conflict (comp CI Issue #17, second occurrence of the family — the first
   * was recorded after the v2.4.1 merge).
   */
  private mergeChain: Promise<void> = Promise.resolve();

  /** Merge a lease's branch back into the base branch, from the main workspace. */
  mergeIntoBase(taskKey: string): Promise<void> {
    const run = this.mergeChain.then(() => this.mergeIntoBaseOnce(taskKey));
    // Keep the chain alive even when a merge rejects (conflicts are the
    // caller's to resolve — the next queued merge must still run).
    this.mergeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mergeIntoBaseOnce(taskKey: string): Promise<void> {
    const lease = this.leases.get(taskKey);
    if (!lease) throw new Error(`worktree-pool: no lease for task "${taskKey}"`);
    try {
      // Serialized: concurrent merges race .git/index.lock and a loser dies
      // fatal before any conflict semantics exist (Issue #29).
      await this.serializeBase(() =>
        this.git(`merge --no-ff -m "swarm merge: ${lease.branch}" ${lease.branch}`),
      );
    } catch (err) {
      const message = (err as { stderr?: string; message?: string }).stderr || (err as Error).message;
      // Leave the merge conflict in place for the caller to resolve or abort;
      // surface which task collided.
      throw new Error(`worktree-pool: merge of "${lease.branch}" hit conflicts — resolve in the workspace or 'git merge --abort': ${message}`);
    }
  }

  /** Drop a lease's tree regardless of dirtiness (caller-decided discard). */
  async discard(taskKey: string): Promise<void> {
    const lease = this.leases.get(taskKey);
    if (!lease) return;
    await this.removeWorktree(lease);
    this.leases.delete(taskKey);
  }

  /**
   * Final sweep: remove every clean tree, keep and report the dirty ones.
   * The pool itself is best-effort pruned when no lease survives.
   */
  async dispose(): Promise<ReleaseReport[]> {
    const reports: ReleaseReport[] = [];
    for (const lease of this.listLeases()) {
      reports.push(await this.release(lease.taskKey));
    }
    try {
      await this.git('worktree prune');
    } catch {
      /* best effort */
    }
    return reports;
  }

  private async removeWorktree(lease: WorktreeLease): Promise<void> {
    try {
      await this.git(`worktree remove --force ${JSON.stringify(lease.worktreePath)}`);
    } catch (first) {
      // P-ENV-2: Windows file-handle locks release asynchronously — retry once.
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await this.git(`worktree remove --force ${JSON.stringify(lease.worktreePath)}`);
      } catch {
        throw new Error(`worktree-pool: worktree "${lease.worktreePath}" could not be removed (file handle lock?): ${(first as Error).message}`);
      }
    }
  }

  private git(args: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${args}`, { cwd: this.workspace, timeout: 60_000 });
  }

  private gitAt(cwd: string, args: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${args}`, { cwd, timeout: 60_000 });
  }
}

/** Convenience for tests and callers that just need a pool beside a temp workspace. */
export function makePool(workspace: string, poolDir?: string): WorktreePool {
  return new WorktreePool({ workspace, poolDir: poolDir ?? path.join(os.tmpdir(), `swarm-wt-${randomBytes(4).toString('hex')}`) });
}
