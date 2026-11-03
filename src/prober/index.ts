import crypto from 'node:crypto';
import { ProberResult, ProberOptions } from '../types.js';
import { probeSystem } from './system.js';
import { probeGit } from './git.js';
import { probeToolchain } from './toolchain.js';
import { sanitizeEnv } from './sanitizer.js';

export async function probe(options?: ProberOptions): Promise<ProberResult> {
  const [git, toolchain] = await Promise.all([
    probeGit(options?.cwd),
    probeToolchain(),
  ]);
  const system = probeSystem();
  const env = sanitizeEnv(process.env, options?.envWhitelist);

  system.totalMemoryMB = system.totalMemMb;
  system.freeMemoryMB = system.freeMemMb;

  git.commitHash = git.commit;

  toolchain.nodeVersion = toolchain.node;
  toolchain.tools = {
    node: { installed: true, version: toolchain.node },
    npm: { installed: Boolean(toolchain.npm), version: toolchain.npm },
    git: { installed: git.isGitRepo, version: toolchain.git },
  };

  // Single sanitized env snapshot only (Issue #36): the redundant sanitizedEnv
  // duplicate (same data, [REDACTED] marker style) was removed — one redacted
  // copy in the result halves the accidental-exposure surface.
  return {
    snapshotId: `probe-${Date.now()}`,
    timestamp: new Date().toISOString(),
    system,
    git,
    toolchain,
    env,
  };
}

export function computeFingerprint(result: ProberResult): string {
  // Deterministic JSON string excluding unstable timestamps
  const stableObject = {
    platform: result.system.platform,
    arch: result.system.arch,
    cpus: result.system.cpus,
    branch: result.git.branch,
    commit: result.git.commit,
    toolchain: {
      node: result.toolchain.node,
      npm: result.toolchain.npm,
      git: result.toolchain.git,
    },
    envKeys: Object.keys(result.env).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableObject)).digest('hex');
}

export { probeSystem } from './system.js';
export { probeGit } from './git.js';
export { probeToolchain } from './toolchain.js';
export {
  sanitizeEnv,
  maskUriCredentials,
  REDACTED_STRING,
  SENSITIVE_KEY_REGEX,
  SENSITIVE_VALUE_REGEX,
} from './sanitizer.js';
