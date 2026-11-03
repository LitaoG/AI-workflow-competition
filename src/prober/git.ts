import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GitProbe } from '../types.js';

const execAsync = promisify(exec);

export async function probeGit(cwd = process.cwd()): Promise<GitProbe> {
  const fallback: GitProbe = {
    isGitRepo: false,
    branch: '',
    commit: '',
    commitHash: '',
    commitShort: '',
    isDirty: false,
    dirtyFilesCount: 0,
  };

  try {
    // Check if git repo
    await execAsync('git rev-parse --is-inside-work-tree', { cwd, timeout: 2000 });

    const [branchRes, commitRes, statusRes, remoteRes] = await Promise.allSettled([
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 2000 }),
      execAsync('git rev-parse HEAD', { cwd, timeout: 2000 }),
      execAsync('git status --porcelain', { cwd, timeout: 2000 }),
      execAsync('git remote get-url origin', { cwd, timeout: 2000 }),
    ]);

    const branch = branchRes.status === 'fulfilled' ? branchRes.value.stdout.trim() : 'unknown';
    const commit = commitRes.status === 'fulfilled' ? commitRes.value.stdout.trim() : 'unknown';
    const commitShort = commit !== 'unknown' ? commit.substring(0, 7) : 'unknown';

    let isDirty = false;
    let dirtyFilesCount = 0;
    if (statusRes.status === 'fulfilled') {
      const lines = statusRes.value.stdout.trim().split('\n').filter(Boolean);
      dirtyFilesCount = lines.length;
      isDirty = dirtyFilesCount > 0;
    }

    const remoteUrl = remoteRes.status === 'fulfilled' ? remoteRes.value.stdout.trim() : undefined;

    return {
      isGitRepo: true,
      branch,
      commit,
      commitHash: commit,
      commitShort,
      isDirty,
      dirtyFilesCount,
      remoteUrl,
    };
  } catch {
    return fallback;
  }
}
