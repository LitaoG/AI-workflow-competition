/**
 * Sandbox launch configuration — the child process's environment, argv and
 * clock knobs. Pure functions over the runner options; no I/O beyond reading
 * the two AI_WORKFLOW_* environment variables.
 */
import { buildSanitizedEnv } from '../process-supervision.js';
import { sanitizeEnv } from '../prober/index.js';

/** Default V8 heap cap (MB) for the sandbox child — see buildSandboxChildArgs. */
const DEFAULT_SANDBOX_MAX_OLD_SPACE_MB = 512;

/** Official 2.1.316 stall window default (90000ms); 0 disables the clock. */
export const DEFAULT_STALL_MS = 90_000;

/**
 * The sandbox child's environment — two independent layers (GOAL.md 铁律 2):
 * ① buildSanitizedEnv whitelist (process-supervision): only the platform-critical
 *    base plus explicit allows; the caller's shell credentials never pass by NAME.
 * ② prober sanitizeEnv: whatever survived the whitelist is value-masked
 *    (sensitive keys → ***REDACTED***, credentialed URLs → ://***:***@), so a
 *    sensitive-shaped value cannot slip through by SHAPE.
 * ELECTRON_RUN_AS_NODE is re-set here so an Electron-hosted CLI never boots a
 * Chromium helper in the sandbox. Exported for the redaction test-suite.
 */
export function buildSandboxEnv(): NodeJS.ProcessEnv {
  return sanitizeEnv(buildSanitizedEnv([], { ELECTRON_RUN_AS_NODE: '1' }));
}

/** Strictly-positive integer parse: junk, zero and negatives yield undefined. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * The sandbox child's node argv — `--max-old-space-size=<cap>` FIRST (node
 * options must precede the entry path), then the child entry, the lowered
 * script path and the run-args JSON file path (G4: args live on disk, never
 * argv — argv dies at Windows' 32,767-character limit; child-main still
 * accepts an inline JSON payload from an older parent).
 *
 * The cap bounds the sandbox heap (GOAL.md process safety): a runaway facade
 * script dies of its own OOM instead of exhausting the host — lifecycle
 * supervision (killTree) bounds WHEN a process dies, the heap cap bounds HOW
 * BIG it may grow first. Resolution order: explicit runner option
 * (`RunFacadeOptions.sandboxMaxOldSpaceSizeMb`) → `AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB`
 * environment variable → 512 MB. Exported for the supervision test-suite.
 */
export function buildSandboxChildArgs(
  childEntry: string,
  scriptJsPath: string,
  argsJson: string,
  maxOldSpaceSizeMb?: number,
  budgetTotal?: number,
): string[] {
  const cap = maxOldSpaceSizeMb ?? parsePositiveInt(process.env.AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB) ?? DEFAULT_SANDBOX_MAX_OLD_SPACE_MB;
  return [
    `--max-old-space-size=${cap}`,
    childEntry,
    scriptJsPath,
    argsJson,
    budgetTotal === undefined ? '' : String(budgetTotal),
  ];
}

/** explicit option wins, then AI_WORKFLOW_STALL_MS, then the 90s default. */
export function resolveStallMs(explicit: number | undefined): number {
  if (explicit !== undefined) return Math.max(0, Math.floor(explicit));
  const raw = process.env.AI_WORKFLOW_STALL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_STALL_MS;
}
