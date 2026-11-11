/**
 * Author-position mapping — maps a generated `workflow.facade.js` stack frame
 * back to the author's script row/column through the run's source map, plus
 * the runId mint. Pure helpers; the source-map test-suite (#126 §2.2) imports
 * the two mapping functions via runner.ts re-exports.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceMap } from 'node:module';
import { randomBytes } from 'node:crypto';

export function mintRunId(): string {
  const now = new Date();
  const ts = now.getTime().toString(36);
  return `dwfrun-${ts}-${randomBytes(3).toString('hex')}`;
}

/**
 * The `workflow.facade.js` frame a script error was raised at — the TOP frame of
 * the child's stack (the throw site), 1-based line/column.
 */
export function firstFacadeStackFrame(stack: string | undefined): { line: number; column: number } | undefined {
  if (!stack) return undefined;
  for (const match of stack.matchAll(/workflow\.facade\.js:(\d+):(\d+)/g)) {
    const line = Number(match[1]);
    const column = Number(match[2]);
    if (Number.isFinite(line) && Number.isFinite(column) && line > 0 && column > 0) return { line, column };
  }
  return undefined;
}

/**
 * Map a generated `workflow.facade.js` position back to the author's script
 * through the run's source map. Both the vm frames and the SourceMap entries are
 * consumed 0-based; the wrapped source carries exactly one prelude line, so the
 * mapped 0-based line IS the author's 1-based line.
 */
export function mapToAuthorPosition(line: number, column: number, mapJson: string): { line: number; column: number } | undefined {
  try {
    const entry = new SourceMap(JSON.parse(mapJson)).findEntry(line - 1, column - 1);
    if (!('originalLine' in entry) || entry.originalLine < 1) return undefined;
    const originalColumn = 'originalColumn' in entry ? entry.originalColumn : 0;
    return { line: entry.originalLine, column: originalColumn + 1 };
  } catch {
    return undefined;
  }
}

/** The ` (script line N, column M)` suffix for a script error, or '' when unmappable. */
export function describeAuthorPosition(runDir: string, stack: string | undefined): string {
  try {
    const mapPath = path.join(runDir, 'script.js.map');
    if (!fs.existsSync(mapPath)) return '';
    const frame = firstFacadeStackFrame(stack);
    if (!frame) return '';
    const position = mapToAuthorPosition(frame.line, frame.column, fs.readFileSync(mapPath, 'utf8'));
    return position ? ` (script line ${position.line}, column ${position.column})` : '';
  } catch {
    return '';
  }
}
