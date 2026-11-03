/**
 * Minimal workspace glob for `files.glob()` / grep filtering — no dependency.
 * Supports `**` (any depth, may sit alone as a segment), `*` (within a segment),
 * `?` (one char). Patterns are workspace-relative with `/` separators.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GlobOptions {
  /** Skip these directory names during the walk (defaults: node_modules, .git, dist). */
  ignoreDirs?: string[];
  maxFiles?: number;
}

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', '.workflow']);

export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  const escapeSegment = (seg: string): string =>
    seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');

  // Built as a string, not joined with '/': a mid-pattern `**` already ends
  // with '/', so joining would insert a second separator and break every
  // `a/**/b` form (e.g. `src/**/*.ts` matched nothing).
  let re = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '**') {
      if (i === segments.length - 1) {
        re += '(?:.*)?';
      } else {
        re += '(?:[^/]+/)*'; // swallows the slash the join would have added
        continue;
      }
    } else {
      re += escapeSegment(seg);
    }
    if (i < segments.length - 1) re += '/';
  }
  return new RegExp(`^${re}$`);
}

/** Walk the workspace and return workspace-relative paths matching the glob, sorted. */
export function globFiles(workspace: string, pattern: string, options: GlobOptions = {}): string[] {
  const ignore = new Set(options.ignoreDirs ?? [...DEFAULT_IGNORE]);
  const maxFiles = options.maxFiles ?? 2000;
  const re = globToRegExp(pattern);
  const out: string[] = [];
  walk(workspace, '');
  out.sort();
  return out;

  function walk(absDir: string, relDir: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (out.length > maxFiles) return false;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        if (!walk(path.join(absDir, entry.name), rel)) return false;
      } else if (entry.isFile()) {
        if (re.test(rel)) out.push(rel);
      }
    }
    return true;
  }
}
