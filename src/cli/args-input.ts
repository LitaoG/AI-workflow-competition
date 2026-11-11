/**
 * Windows-friendly script-input parsing for the unified run entry
 * (Mission D 支柱一：彻底终结 PowerShell 引号转义地狱).
 */
import * as fs from 'node:fs';

/**
 * 三种等价传参通道，调用方按需混用，后写覆盖先写：
 * - `--args '<json>'`：原有单引号 JSON 形式（PowerShell 下仍会被吞引号，保留兼容）；
 * - `--args-file <file.json>`：文件直传，零转义困扰；
 * - `--set key=value`（可重复）：Key-Value 简写 + 自动类型推断。
 */

/** Infer a natural type for a bare `--set` value: bool / number / JSON / string. */
function inferScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through: a value that merely *looks* JSON-ish stays a string
    }
  }
  return raw;
}

/**
 * Merge repeated `--set key=value` pairs into an args object. A pair without
 * `=` is a hard usage error (reported by the caller with the offending text).
 */
export function parseSetPairs(pairs: string[] | undefined): {
  args: Record<string, unknown>;
  errors: string[];
} {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      errors.push(`--set expects key=value, got: "${pair}"`);
      continue;
    }
    const key = pair.slice(0, eq).trim();
    if (!key) {
      errors.push(`--set key must not be empty: "${pair}"`);
      continue;
    }
    args[key] = inferScalar(pair.slice(eq + 1));
  }
  return { args, errors };
}

/**
 * Read a JSON args file (`--args-file`). Returns the parsed object plus a
 * human-readable error message on failure (invalid JSON / unreadable file).
 */
export function readArgsFile(
  filePath: string | undefined
): { args: Record<string, unknown>; error?: string } {
  if (!filePath) return { args: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { args: {}, error: `--args-file: cannot read "${filePath}": ${(err as Error).message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { args: {}, error: `--args-file: "${filePath}" must contain a JSON object of script args` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (err) {
    return { args: {}, error: `--args-file is not valid JSON: ${(err as Error).message}` };
  }
}

/**
 * Compose the final script args from the three input channels in precedence
 * order: `--args <json>` < `--args-file <file>` < `--set key=value`.
 * Returns `{ args }` on success or `{ error }` with a printed-ready message.
 */
export function composeScriptArgs(input: {
  argsJson?: string;
  argsFile?: string;
  setPairs?: string[];
}): { args?: Record<string, unknown>; error?: string } {
  const args: Record<string, unknown> = {};
  if (input.argsJson) {
    try {
      const parsed = JSON.parse(input.argsJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: '--args must be a JSON object of script args' };
      }
      Object.assign(args, parsed as Record<string, unknown>);
    } catch (err) {
      return { error: `--args is not valid JSON: ${(err as Error).message}` };
    }
  }
  const file = readArgsFile(input.argsFile);
  if (file.error) return { error: file.error };
  Object.assign(args, file.args);
  const sets = parseSetPairs(input.setPairs);
  if (sets.errors.length > 0) return { error: sets.errors.join('; ') };
  Object.assign(args, sets.args);
  return { args };
}
