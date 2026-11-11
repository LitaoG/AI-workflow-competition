/**
 * Saved workflows registry (P2): facade scripts with a frontmatter block become
 * named, discoverable workflows — `.workflow/workflows/<name>.facade.ts` (project)
 * plus an optional global directory. `workflow workflows list` enumerates them,
 * `workflow workflows run <name>` runs by name. Mirrors ZCode's `.zcode/workflows/`
 * save format (`/* zcode-workflow` YAML block) adapted to this engine.
 *
 * Frontmatter (the first `/* workflow ... *​/` block comment in the file):
 *   /* workflow
 *   name: incident-triage
 *   description: Triage a P1 incident and auto-remediate with safety review
 *   whenToUse: healthz failing under burst traffic
 *   args:
 *     telemetry:
 *       type: string
 *       description: Telemetry context to triage
 *       default: "healthz 500s"
 *   *​/
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SavedWorkflowArg {
  type: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface SavedWorkflow {
  name: string;
  description: string;
  whenToUse?: string;
  args: Record<string, SavedWorkflowArg>;
  /** Absolute path of the facade script. */
  scriptPath: string;
  /** Which registry it came from. */
  scope: 'project' | 'global';
}

function projectDir(cwd: string): string {
  return path.join(cwd, '.workflow', 'workflows');
}

function globalDir(): string {
  return path.join(os.homedir(), '.workflow', 'workflows');
}

function unquote(v: string): string {
  return v.replace(/^['"]|['"]$/g, '');
}

function parseScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Parse the saved-workflow frontmatter: top-level scalars + one indent level of args. */
export function parseSavedMeta(source: string): { name?: string; description?: string; whenToUse?: string; args: Record<string, SavedWorkflowArg> } {
  const result: { name?: string; description?: string; whenToUse?: string; args: Record<string, SavedWorkflowArg> } = { args: {} };
  const match = /\/\*\s*workflow\b([\s\S]*?)\*\//.exec(source);
  if (!match) return result;

  let currentArg: SavedWorkflowArg | null = null;
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/^\s*\*\s?/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = unquote(rawValue.trim());
    const isTopLevel = !/^\s/.test(line);

    if (isTopLevel) {
      currentArg = null;
      if (key === 'name') result.name = value;
      else if (key === 'description') result.description = value;
      else if (key === 'whenToUse') result.whenToUse = value;
      continue;
    }

    if (value === '' && /^[A-Za-z][A-Za-z0-9_]*:$/.test(trimmed)) {
      // a named arg entry like "telemetry:" — open it
      currentArg = { type: 'string' };
      result.args[key] = currentArg;
      continue;
    }
    if (currentArg) {
      if (key === 'type' && ['string', 'number', 'boolean', 'json'].includes(value)) currentArg.type = value as SavedWorkflowArg['type'];
      else if (key === 'description') currentArg.description = value;
      else if (key === 'required') currentArg.required = value === 'true';
      else if (key === 'default') currentArg.default = parseScalar(value);
    }
  }
  return result;
}

/** Discover saved workflows from the project and global registries (project shadows global). */
export function listSavedWorkflows(cwd: string = process.cwd()): SavedWorkflow[] {
  const out: SavedWorkflow[] = [];
  const seen = new Set<string>();
  for (const [scope, dir] of [['project', projectDir(cwd)], ['global', globalDir()]] as const) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.facade.ts')) continue;
      const abs = path.join(dir, entry.name);
      try {
        const source = fs.readFileSync(abs, 'utf8');
        const meta = parseSavedMeta(source);
        // P3 hard validation (Claude-parity: "… has invalid meta: … skipping"):
        // a file WITH a workflow block but no usable meta must not vanish silently.
        if (!meta.name) {
          if (/\/\*\s*workflow/.test(source)) {
            console.error(`[saved-workflows] skipping ${abs}: frontmatter has no non-empty "name:"`);
          }
          continue;
        }
        if (!meta.description) {
          console.error(`[saved-workflows] skipping "${meta.name}" (${abs}): frontmatter has no non-empty "description:"`);
          continue;
        }
        if (seen.has(meta.name)) {
          console.error(`[saved-workflows] skipping ${abs}: duplicate workflow name "${meta.name}" (first registration wins)`);
          continue;
        }
        seen.add(meta.name);
        out.push({ name: meta.name, description: meta.description, whenToUse: meta.whenToUse, args: meta.args, scriptPath: abs, scope });
      } catch (err) {
        console.error(`[saved-workflows] skipping ${abs}: unreadable (${(err as Error).message})`);
        continue;
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Validate call-site args against a saved workflow's declarations; fills defaults. */
export function validateSavedArgs(meta: SavedWorkflow, args: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const merged: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(meta.args)) {
    if (args[key] !== undefined) merged[key] = args[key];
    else if (decl.default !== undefined) merged[key] = decl.default;
    else if (decl.required) return { ok: false, error: `missing required arg "${key}"${decl.description ? ` (${decl.description})` : ''}` };
  }
  return { ok: true, args: merged };
}

/**
 * Filename-safe slug for a saved workflow (sibling-directory discipline,
 * AGENTS.md §1.8: no spaces, no path separators). Throws when nothing safe
 * survives — a nameless workflow must never silently land on disk.
 */
export function slugifyWorkflowName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) throw new Error(`workflow name "${name}" has no filesystem-safe characters`);
  return cleaned.slice(0, 64);
}

/**
 * Persist a facade script into the PROJECT registry with saved-workflow
 * frontmatter (Project Y Phase 7b, Issue #154). Same name+slug → overwrite
 * (an idempotent re-save of the workflow under refinement), so the registry
 * never accumulates duplicates of one workflow. The registry name stays
 * verbatim (frontmatter); only the filename is slugged.
 */
export function saveSavedWorkflow(
  cwd: string,
  meta: { name: string; description: string; whenToUse?: string },
  script: string,
): { ok: true; path: string; slug: string } | { ok: false; error: string } {
  try {
    const slug = slugifyWorkflowName(meta.name);
    const dir = projectDir(path.resolve(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = [
      '/* workflow',
      ` * name: ${meta.name}`,
      ` * description: ${meta.description}`,
      ...(meta.whenToUse ? [` * whenToUse: ${meta.whenToUse}`] : []),
      ' */',
      '',
    ].join('\n');
    const body = script.replace(/^\n+/, '');
    const file = path.join(dir, `${slug}.facade.ts`);
    fs.writeFileSync(file, `${frontmatter}${body}${body.endsWith('\n') ? '' : '\n'}`);
    return { ok: true, path: file, slug };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
