/**
 * World boundary executor — the deterministic, read-side half of the child's
 * `__host.*` surface: `files.*` and `git.*` reads plus supervised command
 * execution. Pure execution, no journal policy: the engine wraps every call in
 * `journalled()` and owns replay/authorization; this module only measures the
 * workspace and enforces the resource caps (reject, never truncate — the
 * canonical world-read caps contract).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRepomap } from '../context/repomap.js';
import { sliceTargetFile } from '../context/slice.js';
import { spawnSupervised, SPAWN_ENV_ALLOWLIST } from '../process-supervision.js';
import { WorldRunResult } from './protocol.js';
import { domainError } from '../domain/errors.js';
import { redactText } from './redact.js';
import { globFiles, globToRegExp } from './glob.js';

const FILE_READ_CAP = 1024 * 1024; // 1 MiB — files.read rejects over this
const GREP_MATCH_CAP = 2000;
const GREP_BYTES_CAP = 256 * 1024; // 256 KiB
const WORLD_OUTPUT_CAP = 16 * 1024 * 1024; // 16 MiB per stream (rejects, never truncates)
const GIT_DIFF_CAP = 512 * 1024; // 512 KiB — git.diff rejects over this
const WORLD_DEFAULT_TIMEOUT_MS = 300_000;

export class WorldBoundary {
  constructor(private readonly workspace: string) {}

  /** Dispatch one `worldRead` op (files.* / git.*). */
  async read(readOp: string, args: unknown[], siteId: string): Promise<unknown> {
    switch (readOp) {
      case 'files.glob': {
        const pattern = String(args[0] ?? '**/*');
        const files = globFiles(this.workspace, pattern, { maxFiles: 2000 });
        if (files.length > 2000) {
          throw domainError('SchemaValidationError', `files.glob matched more than 2000 files — narrow the pattern`, {
            details: { op: 'files.glob', pattern, matched: files.length, cap: 2000, siteId },
          });
        }
        return files;
      }
      case 'files.read': {
        const rel = String(args[0] ?? '');
        const abs = this.resolveInsideWorkspace(rel, 'files.read path');
        const stat = fs.statSync(abs);
        if (stat.size > FILE_READ_CAP) {
          throw domainError('SchemaValidationError', `files.read "${rel}" is ${stat.size} bytes, over the ${FILE_READ_CAP} cap`, {
            details: { op: 'files.read', path: rel, bytes: stat.size, cap: FILE_READ_CAP, siteId },
          });
        }
        return fs.readFileSync(abs, 'utf8');
      }
      case 'files.grep':
        return this.grepWorkspace(String(args[0] ?? ''), args[1] === undefined || args[1] === null ? undefined : String(args[1]), siteId);
      case 'files.map': {
        // y.md pillar 2: the AST symbol map for one file — relevant
        // declarations plus the import/importer neighborhood, under a hard
        // slice budget. Read-only, like every files.* op.
        const rel = String(args[0] ?? '');
        const abs = this.resolveInsideWorkspace(rel, 'files.map path');
        const map = buildRepomap(this.workspace, rel);
        const slice = sliceTargetFile(abs, new Set(map.symbols));
        return { target: rel, text: slice.text, truncated: slice.truncated, keptSymbols: slice.keptSymbols, ranked: map.ranked };
      }
      case 'git.changedFiles': {
        const base = args[0] === undefined || args[0] === null ? undefined : String(args[0]);
        if (!base) {
          const res = await this.spawnCaptured('git', ['status', '--porcelain']);
          if (res.exitCode !== 0) {
            throw domainError('ProberError', `git.status failed: ${res.stderr.slice(0, 500)}`, {
              details: { command: 'git status --porcelain', exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
            });
          }
          return parsePorcelainPaths(res.stdout);
        }
        const res = await this.spawnCaptured('git', ['diff', '--name-only', base]);
        if (res.exitCode !== 0) {
          throw domainError('ProberError', `git.diff --name-only failed: ${res.stderr.slice(0, 500)}`, {
            details: { command: `git diff --name-only ${base}`, exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
          });
        }
        return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      }
      case 'git.diff': {
        // G5: explicit base semantics — diff against HEAD unless a base is given
        // (bare `git diff` compares worktree-vs-index, which is NOT the
        // documented 'diff against base, default HEAD' contract) + a
        // rejecting 512KB cap.
        const gitArgs = ['diff', String(args[0] ?? 'HEAD')];
        if (args[1] !== undefined && args[1] !== null) gitArgs.push('--', String(args[1]));
        const res = await this.spawnCaptured('git', gitArgs);
        if (res.exitCode !== 0) {
          throw domainError('ProberError', `git.diff failed: ${res.stderr.slice(0, 500)}`, {
            details: { command: gitArgs.join(' '), exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
          });
        }
        if (res.stdout.length > GIT_DIFF_CAP) {
          throw domainError('SchemaValidationError', `git.diff output is ${res.stdout.length} bytes, over the ${GIT_DIFF_CAP} cap — narrow with a base and path`, {
            details: { op: 'git.diff', bytes: res.stdout.length, cap: GIT_DIFF_CAP, siteId },
          });
        }
        return res.stdout;
      }
      case 'git.status': {
        const [branchRes, porcelain] = await Promise.all([
          this.spawnCaptured('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
          this.spawnCaptured('git', ['status', '--porcelain']),
        ]);
        const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : undefined;
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];
        for (const line of porcelain.stdout.split('\n')) {
          if (!line.trim()) continue;
          const x = line[0];
          const y = line[1];
          const p = line.slice(3);
          if (x === '?') untracked.push(p);
          else if (x !== ' ') staged.push(p);
          if (y && y !== ' ' && x !== '?') unstaged.push(p);
        }
        return { branch, clean: porcelain.stdout.trim() === '', staged, unstaged, untracked };
      }
      case 'git.log': {
        // D8④: over-cap requests are structurally rejected — never silently
        // clamped (canonical world-read caps contract: reject, don't truncate).
        const requested = Number(args[0] ?? 20) || 20;
        if (requested > 100) {
          throw domainError('SchemaValidationError', `git.log count ${requested} exceeds the 100-entry cap — request fewer commits`, {
            details: { op: 'git.log', requested, cap: 100, siteId },
          });
        }
        const count = Math.max(requested, 1);
        const res = await this.spawnCaptured('git', ['log', `-n`, String(count), '--pretty=format:%H%x1f%s%x1f%an%x1f%aI']);
        if (res.exitCode !== 0) {
          throw domainError('ProberError', `git.log failed: ${res.stderr.slice(0, 500)}`, {
            details: { command: `git log -n ${count}`, exitCode: res.exitCode, stderr: res.stderr.slice(0, 500), siteId },
          });
        }
        return res.stdout.split('\n').filter(Boolean).map((line) => {
          const [hash, subject, author, date] = line.split('\x1f');
          return { hash, subject, author, date };
        });
      }
      default:
        throw domainError('AgentError', `unknown world read: ${readOp}`, {
          details: { readOp, siteId },
        });
    }
  }

  grepWorkspace(pattern: string, glob: string | undefined, siteId: string): Array<{ path: string; line: number; text: string }> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      throw domainError('SchemaValidationError', `files.grep pattern is not a valid regex: ${(e as Error).message}`, {
        details: { op: 'files.grep', pattern },
        cause: (e as Error).message,
      });
    }
    const include = glob ? globToRegExp(glob) : null;
    const scannedPattern = include ? glob!.replace(/^\*\*\//, '**/') : '**/*';
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let bytes = 0;
    const files = globFiles(this.workspace, scannedPattern, { maxFiles: 5000 });
    // D8④: an over-cap corpus is a named rejection, not a silent narrowing of
    // the search set (mirror of the files.glob cap check above).
    if (files.length > 5000) {
      throw domainError('SchemaValidationError', `files.grep scanned more than 5000 files — narrow the glob`, {
        details: { op: 'files.grep', pattern: scannedPattern, scanned: files.length, cap: 5000, siteId },
      });
    }
    for (const rel of files) {
      if (include && !include.test(rel)) continue;
      let text: string;
      try {
        const stat = fs.statSync(path.join(this.workspace, rel));
        if (stat.size > FILE_READ_CAP) continue;
        text = fs.readFileSync(path.join(this.workspace, rel), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) });
          bytes += lines[i].length;
          if (matches.length >= GREP_MATCH_CAP || bytes > GREP_BYTES_CAP) {
            throw domainError('SchemaValidationError', `files.grep results over cap (${GREP_MATCH_CAP} matches / ${GREP_BYTES_CAP} bytes) — narrow the pattern or glob`, {
              details: { op: 'files.grep', matches: matches.length, matchCap: GREP_MATCH_CAP, bytesCap: GREP_BYTES_CAP },
            });
          }
        }
      }
    }
    return matches;
  }

  /**
   * Supervised spawn: the child runs in its own process group (POSIX) with a
   * sanitized environment, and a timeout kills the WHOLE tree — a command that
   * spawned grandchildren cannot outlive its cap. Facade contract: timeout and
   * spawn failure reject; nonzero exits resolve.
   */
  spawnCaptured(cmd: string, args: string[], timeoutMs?: number): Promise<WorldRunResult> {
    const timeout = timeoutMs ?? WORLD_DEFAULT_TIMEOUT_MS;
    const supervised = spawnSupervised(cmd, args, {
      cwd: this.workspace,
      timeoutMs: timeout,
      envAllowlist: SPAWN_ENV_ALLOWLIST,
    });
    return new Promise<WorldRunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      supervised.child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < WORLD_OUTPUT_CAP) stdout += chunk.toString('utf8');
      });
      supervised.child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < WORLD_OUTPUT_CAP) stderr += chunk.toString('utf8');
      });
      void supervised.result.then((res) => {
        if (res.timedOut) {
          reject(domainError('SandboxTimeout', `world.run "${cmd}" timed out after ${timeout}ms (process tree killed)`, {
            details: { cmd, timeoutMs: timeout },
          }));
          return;
        }
        if (res.exitCode === -1 && supervised.child.exitCode === null && res.stderr.startsWith('spawn ')) {
          reject(domainError('SandboxSpawnError', res.stderr, { details: { cmd, stderr: res.stderr } }));
          return;
        }
        // Irreversible redaction at the source (GOAL.md 铁律 2): the value the
        // script sees IS the journalled value — git-remote URLs with embedded
        // credentials and token-shaped output never reach result_json, the
        // live view, or anything the script logs downstream.
        resolve({ exitCode: res.exitCode, stdout: redactText(stdout), stderr: redactText(stderr) });
      });
    });
  }

  /** Resolve a workspace-relative path, refusing anything that escapes it. */
  resolveInsideWorkspace(rel: string, what: string): string {
    const workspace = path.resolve(this.workspace);
    const abs = path.resolve(workspace, rel.replace(/\\/g, '/'));
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
      throw domainError('SchemaValidationError', `${what} "${rel}" escapes the workspace`, {
        details: { what, path: rel },
      });
    }
    return abs;
  }
}

export function parsePorcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    out.push(line.slice(3).trim());
  }
  return out;
}
