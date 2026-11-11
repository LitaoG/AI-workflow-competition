/**
 * Deterministic physical-environment prober — composition root that assembles
 * the objective system truth a workflow consumes via ctx.probe() or the
 * `probe` step type (core/step.ts), so environment-dependent decisions rest
 * on measured facts rather than model guesses. (E-doc §5.1-7 blueprint,
 * verified against code; the blueprint's single prober.ts is physically split
 * into system.ts / git.ts / toolchain.ts / sanitizer.ts with this index as
 * the composition root.)
 *
 * 【Design intent — one snapshot, four probes】
 *
 * 1. Composition: git + toolchain fan out under Promise.all (both are
 *    subprocess-bound and independent) while system stays synchronous inline
 *    (pure os.* reads, no spawn); sanitizeEnv then reduces process.env to
 *    exactly one redacted snapshot. Every sub-probe self-degrades on failure
 *    ('unknown' / fallback values / its own 2s timeouts) instead of rejecting,
 *    so a missing git repo or absent npm can never fail the snapshot itself.
 *
 * 2. Dual-naming normalization: the sub-probes populate only their terse
 *    native fields (totalMemMb, commit, node); the alias block back-fills the
 *    optional duplicates declared on ProberResult (totalMemoryMB, commitHash,
 *    nodeVersion) plus the normalized `tools` map, so consumers reading
 *    either spelling never see undefined. tools.git.installed reuses the git
 *    probe's isGitRepo rather than spawning another git process — one source
 *    of truth per fact.
 *
 * 3. Single sanitized env snapshot (Issue #36): the result carries exactly
 *    one redacted env copy — the redundant duplicate was removed to halve the
 *    accidental-exposure surface (see inline comment in probe()).
 *
 * 4. Identity over audit: snapshotId (`probe-${Date.now()}`) and timestamp
 *    are per-run audit fields; computeFingerprint() deliberately excludes
 *    them and every other volatile field to derive a stable SHA-256
 *    environment identity.
 */

import crypto from 'node:crypto';
import { ProberResult, ProberOptions } from '../types.js';
import { probeSystem } from './system.js';
import { probeGit } from './git.js';
import { probeToolchain } from './toolchain.js';
import { sanitizeEnv } from './sanitizer.js';

/**
 * Compose one ProberResult from the four probes. Never rejects: sub-probe
 * failures degrade in place (git.ts returns a non-repo stub, toolchain falls
 * back to process.version/'installed'), so the caller always receives a
 * fully-shaped snapshot. The alias normalization below fills ProberResult's
 * optional duplicate fields — rationale in the file header.
 */
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

/**
 * Stable SHA-256 identity (64 hex chars) of an environment snapshot.
 *
 * 【Why a hand-picked projection, not the raw result】the hash input keeps
 * only fields that identify WHICH environment this is — platform / arch /
 * CPU count, toolchain versions and the env KEY set — and drops everything
 * that drifts between runs or machines: snapshotId/timestamp (wall clock),
 * memory/uptime (re-measured every second), hostname, dirty state, and env
 * VALUES (redacted and machine-specific; only which keys exist is
 * identity-relevant).
 *
 * 【Branch/commit are NOT environment identity (Issue #137)】they used to be
 * hashed as "repo identity", but they are repo STATE, not the environment:
 * a commit landing between two probe() calls — routine with parallel AI
 * sessions — flipped the fingerprint of an unchanged environment. Worse, the
 * git probe bounds each exec at 2 s, so under host load a probe can report
 * branch/commit as 'unknown' while its sibling seconds later reports the real
 * values. Two probes of one environment must hash identically, so both fields
 * stay out of the projection; the snapshot still carries them as audit data.
 *
 * 【Determinism mechanics】JSON.stringify emits stableObject's keys in
 * literal order, and envKeys is sort()-ed so process.env insertion order
 * (shell/locale dependent) cannot reorder the payload — two identical
 * environments hash identically (locked by tests/unit/prober.test.ts).
 */
export function computeFingerprint(result: ProberResult): string {
  // Deterministic JSON string excluding unstable timestamps
  const stableObject = {
    platform: result.system.platform,
    arch: result.system.arch,
    cpus: result.system.cpus,
    toolchain: {
      node: result.toolchain.node,
      npm: result.toolchain.npm,
      git: result.toolchain.git,
    },
    envKeys: Object.keys(result.env).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableObject)).digest('hex');
}

// Facade re-exports: sub-probe functions + sanitizer primitives form the
// single public surface of the prober package. src/dwf/redact.ts imports the
// redaction constants from HERE (not from sanitizer.ts) so env sanitizing and
// dwf output redaction share one definition of "sensitive" and cannot drift.
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
