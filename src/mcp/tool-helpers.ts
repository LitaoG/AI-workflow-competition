/**
 * Shared MCP tool-response helpers — every tool response crosses the
 * redaction boundary exactly once, here, before JSON serialization
 * (GOAL.md 铁律 2). Moved verbatim from server.ts.
 */
import * as path from 'node:path';
import { z } from 'zod';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { domainError, toDomainError, toSerializableError } from '../domain/errors.js';
import type { DomainErrorTag } from '../domain/errors.js';
import { redactValue } from '../dwf/redact.js';
import type { DwfNode, WorkflowEvent } from '../types.js';

/** One per-site execution summary (`workflow_run_script` response field). */
export interface RunSiteSummary {
  siteId: string;
  ordinal: number;
  kind: DwfNode['kind'];
  status: DwfNode['status'];
  durationMs: number;
}

/** Serialize a tool payload as redacted JSON text (strings, keys and nested values masked). */
export function maskedJsonText(payload: unknown): string {
  return JSON.stringify(redactValue(payload), null, 2);
}

/** A successful tool response carrying one text block. */
export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/** A masked JSON tool response. */
export function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return textResult(maskedJsonText(payload));
}

/**
 * A tagged error tool response: the domain error algebra (`{ tag, message, ... }`,
 * 项 5 serialization), redacted before serialization. Any thrown value is mapped
 * onto the algebra with `fallbackTag` so clients always get a parseable body.
 */
export function taggedErrorResult(err: unknown, fallbackTag: DomainErrorTag = 'McpError'): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const safe = redactValue(toSerializableError(toDomainError(err, fallbackTag)));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
}


/**
 * Issue #127: the MCP execute face accepts a script path from the CALLER (the
 * model) — without a boundary, a prompt-injected `workflow_script_run` can
 * point at any file on the machine. The script must live inside the workspace
 * the run executes in (`cwd`, explicit and visible in the call args); the
 * resolved path may not escape it.
 */
export function resolveScriptInsideCwd(rawScriptPath: string, cwd: string): string {
  const scriptPath = path.resolve(cwd, rawScriptPath);
  const normalizedCwd = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (scriptPath !== cwd && !scriptPath.startsWith(normalizedCwd)) {
    throw new Error(
      `script path "${rawScriptPath}" resolves outside the workspace cwd "${cwd}" — the MCP execute face only runs scripts inside the workspace (Issue #127)`
    );
  }
  return scriptPath;
}

/** Map a zod parse failure onto the domain error algebra (never echoes the raw arguments). */
export function zodArgsError(error: z.ZodError): { tag: DomainErrorTag; message: string } {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join('.') : '(root)';
  return domainError(
    'SchemaValidationError',
    `invalid tool arguments: ${where}: ${first?.message ?? 'validation failed'}`,
    { details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
  );
}

/** Parse a journalled JSON string defensively: parsed JSON, or the raw text. */
export function parseMaybeJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Read one run's per-site summaries from the journal (the single source of
 * truth for siteId/ordinal/status/durationMs). Degrades to an empty list with
 * a note instead of failing the whole tool response — the run result itself
 * never depends on this read.
 */
export async function readRunSites(journalPath: string, runId: string): Promise<{ sites: RunSiteSummary[]; sitesError?: string }> {
  const store = new SQLiteStateStore(journalPath);
  try {
    const nodes = await store.getDwfNodes(runId);
    return {
      sites: nodes.map((n) => ({
        siteId: n.siteId,
        ordinal: n.ordinal,
        kind: n.kind,
        status: n.status,
        durationMs: n.durationMs ?? 0,
      })),
    };
  } catch (err) {
    return { sites: [], sitesError: (err as Error).message };
  } finally {
    store.close();
  }
}

/** Count the journal events of one canonical type (the runner/view accounting). */
export function countEvents(events: WorkflowEvent[], type: WorkflowEvent['type']): number {
  return events.filter((e) => e.type === type).length;
}
