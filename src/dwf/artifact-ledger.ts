/**
 * Artifact ledger — artifact identity, version continuity and the P3 caps
 * (authoring.md parity: 32 ids per run, 16 versions per id, one kind per id,
 * title ≤ 120 / description ≤ 500 chars — all NAMED failures).
 *
 * Versions are run-level facts ("the third version is the third version, not
 * counted from one again"): restored lazily from the journal across the run's
 * whole amend lineage on the first artifact call of this engine instance.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { domainError } from '../domain/errors.js';
import type { WorkflowEventType } from '../types.js';
import type { WorldBoundary } from './host-boundary-dispatcher.js';

const ARTIFACT_FILE_CAP = 20 * 1024 * 1024; // 20 MiB
const ARTIFACT_MD_CAP = 256 * 1024; // 256 KiB
const ARTIFACT_ID_CAP = 32;
const ARTIFACT_VERSION_CAP = 16;
const ARTIFACT_SPEC_BYTES_CAP = 8 * 1024; // 8 KiB serialized spec (canonical parity)
const ARTIFACT_TITLE_CAP = 120;
const ARTIFACT_DESCRIPTION_CAP = 500;

/** The preset declaration family (Issue #38 D8-③): synchronous, void, one-write. */
export const ARTIFACT_PRESET_KINDS = ['chart', 'table', 'metrics', 'board'] as const;
export type ArtifactPresetKind = (typeof ARTIFACT_PRESET_KINDS)[number];

/** Stable JSON stringify (sorted object keys) — the canonical form idempotence compares. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isField(v: unknown): boolean {
  return isPlainObject(v) && typeof v.field === 'string' && v.field.length > 0;
}

/**
 * Validate a preset spec (contract parity, hand-written:
 * a human-readable sentence, not a boolean — the message lands in the run
 * failure and the author edits the script from it). undefined = valid.
 */
function validatePresetSpec(op: ArtifactPresetKind, spec: unknown): string | undefined {
  if (!isPlainObject(spec)) return `${op} spec must be an object literal`;
  if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length > ARTIFACT_TITLE_CAP)) {
    return `${op} spec title must be a string of at most ${ARTIFACT_TITLE_CAP} characters`;
  }
  if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > ARTIFACT_DESCRIPTION_CAP)) {
    return `${op} spec description must be a string of at most ${ARTIFACT_DESCRIPTION_CAP} characters`;
  }
  const fieldList = (v: unknown, name: string): string | undefined => {
    if (!Array.isArray(v) || v.length === 0 || !v.every(isField)) {
      return `${op} spec ${name} must be a non-empty array of { field } entries`;
    }
    return undefined;
  };
  if (op === 'chart') {
    if (!isField(spec.x)) return 'chart spec x must be a { field } entry';
    const y = spec.y;
    if (Array.isArray(y)) {
      if (y.length === 0 || !y.every(isField)) return 'chart spec y must be a { field } entry or a non-empty array of them';
    } else if (!isField(y)) {
      return 'chart spec y must be a { field } entry or a non-empty array of them';
    }
    if (spec.type !== undefined && !['line', 'bar', 'scatter'].includes(String(spec.type))) {
      return 'chart spec type must be "line", "bar" or "scatter"';
    }
    if (spec.scale !== undefined && !['linear', 'log'].includes(String(spec.scale))) {
      return 'chart spec scale must be "linear" or "log"';
    }
    if (spec.baseline !== undefined && !isField(spec.baseline)) return 'chart spec baseline must be a { field } entry';
    return undefined;
  }
  if (op === 'table') {
    const cols = fieldList(spec.columns, 'columns');
    if (cols !== undefined) return cols;
    if (spec.key !== undefined && (typeof spec.key !== 'string' || spec.key.length === 0)) {
      return 'table spec key must be a non-empty string (the field that identifies a row)';
    }
    return undefined;
  }
  if (op === 'metrics') return fieldList(spec.metrics, 'metrics');
  // board
  if (typeof spec.key !== 'string' || spec.key.length === 0) return 'board spec key must be a non-empty string (the field that identifies a card)';
  if (typeof spec.status !== 'string' || spec.status.length === 0) return 'board spec status must be a non-empty string (the field holding the column)';
  if (!Array.isArray(spec.columns) || spec.columns.length === 0 || !spec.columns.every((c) => typeof c === 'string' && c.length > 0)) {
    return 'board spec columns must be a non-empty array of column name strings';
  }
  if (spec.cardTitle !== undefined && (typeof spec.cardTitle !== 'string' || spec.cardTitle.length === 0)) {
    return 'board spec cardTitle must be a non-empty string';
  }
  if (spec.detail !== undefined && (!Array.isArray(spec.detail) || !spec.detail.every(isField))) {
    return 'board spec detail must be an array of { field } entries';
  }
  return undefined;
}

export class ArtifactLedger {
  private artifactVersions = new Map<string, number>();
  private artifactKinds = new Map<string, string>();
  private presets = new Map<string, { kind: ArtifactPresetKind; canonical: string; primary: boolean }>();
  private restored = false;

  constructor(private readonly boundary: WorldBoundary) {}

  /**
   * Walk the run's lineage (self + amend ancestors) — an amend's artifact
   * versions continue from every ancestor that published the same id.
   */
  async ensureRestored(
    store: { getDwfNodes: (runId: string) => Promise<Array<{ kind: string; status: string; resultJson?: string }>>; getDwfRun: (runId: string) => Promise<{ parentRunId?: string } | null> },
    runId: string,
    replayEnabled: boolean,
  ): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    if (!replayEnabled) return;
    const seen = new Set<string>();
    let cursor: string | undefined = runId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const nodes = await store.getDwfNodes(cursor);
      for (const n of nodes) {
        if (n.kind !== 'artifact' || n.status !== 'completed' || n.resultJson === undefined) continue;
        try {
          const v = JSON.parse(n.resultJson) as { id?: string; version?: number };
          if (v.id && typeof v.version === 'number' && v.version > (this.artifactVersions.get(v.id) ?? 0)) {
            this.artifactVersions.set(v.id, v.version);
          }
        } catch {
          /* malformed row — skip */
        }
      }
      const row = await store.getDwfRun(cursor);
      cursor = row?.parentRunId;
    }
  }

  /**
   * Pre-journal admission checks — run BEFORE journalled() so a replayed
   * publish still pays the same validation (and the same kind-registration
   * side effect) as the original code path.
   */
  admit(kind: string, args: unknown[], siteId: string): { id: string; opts: { title?: string; description?: string } } {
    const id = String(args[0] ?? `artifact-${siteId}`);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw domainError('SchemaValidationError', `artifact id "${id}" must match [A-Za-z0-9_.-]{1,64}`, {
        details: { kind: 'artifact', artifactId: id, siteId },
      });
    }
    const opts = (args[2] ?? {}) as { title?: string; description?: string };
    if (opts.title !== undefined && opts.title.length > 120) {
      const e = new Error(`artifact "${id}" title exceeds 120 characters`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    if (opts.description !== undefined && opts.description.length > 500) {
      const e = new Error(`artifact "${id}" description exceeds 500 characters`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    const knownKind = this.artifactKinds.get(id);
    if (knownKind && knownKind !== kind) {
      const e = new Error(`artifact id "${id}" was published as "${knownKind}" and cannot be reused as "${kind}"`);
      e.name = 'ArtifactKindMismatch';
      throw e;
    }
    this.artifactKinds.set(id, kind);
    if (!this.artifactVersions.has(id) && this.artifactKinds.size > ARTIFACT_ID_CAP) {
      const e = new Error(`artifact id count reached the ${ARTIFACT_ID_CAP} per-run cap`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    if ((this.artifactVersions.get(id) ?? 0) >= ARTIFACT_VERSION_CAP) {
      const e = new Error(`artifact "${id}" reached the ${ARTIFACT_VERSION_CAP}-version per-id cap`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    return { id, opts };
  }

  /** The journalled execute callback: measure, version, persist, announce. */
  async publish(
    kind: string,
    id: string,
    input: string,
    opts: { title?: string; description?: string },
    siteId: string,
    ctx: {
      store: { saveArtifact?: (row: { artifactId: string; runId: string; stepId: string; name: string; artifactType: string; content: string; createdAt: string }) => Promise<void> };
      runId: string;
      emit: (type: WorkflowEventType, data: Record<string, unknown>) => void;
    },
  ): Promise<{ id: string; version: number }> {
    let content: string;
    let artifactType: string;
    if (kind === 'file') {
      const abs = this.boundary.resolveInsideWorkspace(input, `artifact.file path`);
      const stat = fs.statSync(abs);
      if (stat.size > ARTIFACT_FILE_CAP) {
        throw domainError('SchemaValidationError', `artifact.file "${input}" is ${stat.size} bytes, over the ${ARTIFACT_FILE_CAP} cap`, {
          details: { kind: 'artifact.file', path: input, bytes: stat.size, cap: ARTIFACT_FILE_CAP, siteId },
        });
      }
      content = fs.readFileSync(abs, 'utf8');
      artifactType = path.extname(abs) === '.html' ? 'text/html' : 'text/plain';
    } else {
      if (input.length > ARTIFACT_MD_CAP) {
        throw domainError('SchemaValidationError', `artifact.markdown "${id}" is ${input.length} chars, over the ${ARTIFACT_MD_CAP} cap`, {
          details: { kind: 'artifact.markdown', artifactId: id, chars: input.length, cap: ARTIFACT_MD_CAP, siteId },
        });
      }
      content = input;
      artifactType = 'text/markdown';
    }
    const version = (this.artifactVersions.get(id) ?? 0) + 1;
    this.artifactVersions.set(id, version);
    await ctx.store.saveArtifact?.({
      artifactId: `${ctx.runId}:${id}`,
      runId: ctx.runId,
      stepId: id,
      name: typeof opts.title === 'string' && opts.title ? opts.title : id,
      artifactType,
      content,
      createdAt: new Date().toISOString(),
    });
    ctx.emit('dwf_artifact', { id, kind, version, bytes: content.length });
    return { id, version };
  }

  /**
   * Issue #38 D8-③ preset declaration (canonical declarePresetArtifact parity).
   * Pure admission + state mutation — the caller journals the returned record.
   * Throws (failRun semantics — presets are void, there is no catch channel):
   * spec invalid / kind mismatch / different re-declaration / primary conflict
   * / per-run id cap. An IDENTICAL re-declaration is a no-op (returns the
   * first record, journals nothing new — the caller's journalled() dedups).
   */
  declarePreset(op: string, args: unknown[], siteId: string): { id: string; kind: ArtifactPresetKind; spec: unknown; canonical: string; primary: boolean; fresh: boolean } {
    if (!(ARTIFACT_PRESET_KINDS as readonly string[]).includes(op)) {
      throw domainError('SchemaValidationError', `artifact.${op} is not a preset member — presets are chart | table | metrics | board`, { details: { kind: 'artifact', op, siteId } });
    }
    const kind = op as ArtifactPresetKind;
    const id = args[0];
    if (typeof id !== 'string' || id === '') {
      throw domainError('SchemaValidationError', `artifact.${kind}: id must be a non-empty string`, { details: { kind: 'artifact', op, siteId } });
    }
    const spec = args[1];
    const problem = validatePresetSpec(kind, spec);
    if (problem !== undefined) {
      throw domainError('SchemaValidationError', `artifact "${id}" has an invalid spec: ${problem}`, { details: { kind: 'artifact', artifactId: id, op, siteId } });
    }
    const canonical = canonicalJson(spec);
    if (utf8ByteLength(canonical) > ARTIFACT_SPEC_BYTES_CAP) {
      throw domainError('SchemaValidationError', `artifact "${id}" spec is ${utf8ByteLength(canonical)} bytes serialized, over the ${ARTIFACT_SPEC_BYTES_CAP}-byte limit`, { details: { kind: 'artifact', artifactId: id, op, siteId } });
    }
    const knownKind = this.artifactKinds.get(id);
    if (knownKind !== undefined && knownKind !== kind) {
      const e = new Error(`artifact id "${id}" is already a ${knownKind} and cannot be declared as a ${kind} — an id belongs to one artifact kind for the whole run`);
      e.name = 'ArtifactKindMismatch';
      throw e;
    }
    const existing = this.presets.get(id);
    if (existing !== undefined) {
      if (existing.canonical !== canonical) {
        const e = new Error(`artifact "${id}" was already declared with a different spec — the spec for one id must stay identical (an identical re-declaration is a no-op); declare it once at the top of the script`);
        e.name = 'ArtifactRedeclared';
        throw e;
      }
      // identical re-declaration: no-op — no new journal row, no event (canonical parity).
      return { id, kind, spec, canonical, primary: existing.primary, fresh: false };
    }
    const wantsPrimary = isPlainObject(spec) && spec.primary === true;
    if (wantsPrimary) {
      for (const [heldId, held] of this.presets) {
        if (held.primary && heldId !== id) {
          const e = new Error(`artifact "${heldId}" is already this run's primary — at most one id per run is the primary; declare "${id}" without primary`);
          e.name = 'ArtifactPrimaryConflict';
          throw e;
        }
      }
    }
    if (!this.artifactVersions.has(id) && this.artifactKinds.size + 1 > ARTIFACT_ID_CAP) {
      const e = new Error(`artifact id count reached the ${ARTIFACT_ID_CAP} per-run cap — reuse an existing id or publish fewer artifacts`);
      e.name = 'ArtifactCapExceeded';
      throw e;
    }
    this.artifactKinds.set(id, kind);
    this.presets.set(id, { kind, canonical, primary: wantsPrimary });
    return { id, kind, spec, canonical, primary: wantsPrimary, fresh: true };
  }
}
