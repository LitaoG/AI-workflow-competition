/**
 * Micro-compactor: tier 1 of the context compaction pipeline (F.md §5.2,
 * Issue #102). It is a read-time projection of ONE oversized tool output.
 *
 * When a tool result is estimated above the threshold, the full output is
 * written to disk (when a spill directory is configured) and the context only
 * keeps a head/tail excerpt plus a file:// reference to the full text. The
 * token estimator is injected, so this module never imports the pipeline at
 * runtime.
 *
 * The spilled file is a new copy on disk that outlives the run, so it goes
 * through the repo's credential redaction (src/dwf/redact.ts) before it is
 * written. The excerpt kept in the context is the output as the tool returned
 * it, like any small result: a tool that can see secrets must redact its own
 * output, as the dwf engine does for world.run. The reference is an absolute
 * file:// URL on purpose: the model needs a path it can read the full text
 * back from, and the caller chooses `spillDir`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactText } from '../../dwf/redact.js';

export interface MicroCompactOptions {
  /** Outputs estimated above this many tokens are projected. */
  thresholdTokens: number;
  /** Characters kept from the start of the output (upper bound). */
  headChars: number;
  /** Characters kept from the end of the output (upper bound). */
  tailChars: number;
  /** Directory that receives the full output; omit to keep only the excerpt. */
  spillDir?: string;
  /** File-name stem for the spilled output; must be unique per tool call. */
  fileStem: string;
  /** Token estimator, injected by the pipeline. */
  estimate: (text: string) => number;
}

export interface MicroCompactResult {
  /** What goes into the context: the output itself, or its excerpt. */
  content: string;
  /** True when the output was projected. */
  compacted: boolean;
  /** Estimated tokens of the original output. */
  originalTokens: number;
  /** Absolute path of the spilled (redacted) full output, when one was written. */
  spilledPath?: string;
}

/** Pass one tool output through, or keep an excerpt and spill the full text. */
export function projectToolOutput(output: string, options: MicroCompactOptions): MicroCompactResult {
  const originalTokens = options.estimate(output);
  if (originalTokens <= options.thresholdTokens) {
    return { content: output, compacted: false, originalTokens };
  }

  let spilledPath: string | undefined;
  let reference = 'full output was not kept';
  if (options.spillDir !== undefined) {
    try {
      fs.mkdirSync(options.spillDir, { recursive: true });
      const target = path.resolve(options.spillDir, `${safeStem(options.fileStem)}.txt`);
      fs.writeFileSync(target, redactText(output), 'utf8');
      spilledPath = target;
      reference = `full output: ${pathToFileURL(target).href}`;
    } catch (err) {
      // A failed spill must not fail the tool call: keep the excerpt only.
      reference = `full output was not kept (spill failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  // The excerpt never keeps more than half of the output, and it is halved
  // until it fits the threshold, so a projection always shrinks the context.
  let headChars = Math.min(options.headChars, Math.floor(output.length / 4));
  let tailChars = Math.min(options.tailChars, Math.floor(output.length / 4));
  let head = safeHead(output, headChars);
  let tail = safeTail(output, tailChars);
  while ((head.length > 0 || tail.length > 0) && options.estimate(head) + options.estimate(tail) > options.thresholdTokens) {
    headChars = Math.floor(headChars / 2);
    tailChars = Math.floor(tailChars / 2);
    head = safeHead(output, headChars);
    tail = safeTail(output, tailChars);
  }

  const omitted = output.length - head.length - tail.length;
  const marker = `\n[... ${omitted} chars omitted, about ${originalTokens} tokens in full; ${reference} ...]\n`;
  return {
    content: `${head}${marker}${tail}`,
    compacted: true,
    originalTokens,
    ...(spilledPath !== undefined ? { spilledPath } : {}),
  };
}

function safeStem(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'tool-output';
}

/** First `n` UTF-16 units, never ending on half of a surrogate pair. */
function safeHead(text: string, n: number): string {
  if (n <= 0) return '';
  let end = Math.min(n, text.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Last `n` UTF-16 units, never starting on half of a surrogate pair. */
function safeTail(text: string, n: number): string {
  if (n <= 0) return '';
  let start = Math.max(0, text.length - n);
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return text.slice(start);
}
