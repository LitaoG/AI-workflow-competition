/**
 * Irreversible redaction for the dwf persistence/emit boundaries — the engine's
 * 铁律 2 "零凭证泄漏" and 哲学 4 "不可逆脱敏".
 *
 * 不可逆、必须在序列化边界之前：任何即将写入 SQLite（dwf_nodes.result_json /
 * dwf_events）、live 视图或随 run 结果返回的字符串，都必须先经过这里。脱敏没有
 * 逆操作——journal 里存的就是掩码后的权威值，重放继承掩码，不存在"以后再还原"。
 *
 * Call points are kept AT the boundary, not scattered through the code:
 * - engine.spawnCaptured — world.run / git.* subprocess output before it is
 *   returned to the script and journalled (masking at the source propagates:
 *   everything the script logs, reports or embeds downstream is already clean);
 * - runner.ts — the sandbox stderr tail, dwf_call_error payloads and the final
 *   run error (events + RunFacadeResult).
 *
 * Masking reuses the prober's exact notion of "sensitive" (SENSITIVE_KEY_REGEX /
 * SENSITIVE_VALUE_REGEX / maskUriCredentials) so env sanitizing and output
 * redaction cannot drift apart.
 *
 * Trade-off, deliberately biased toward over-redaction: a benign key whose NAME
 * matches the sensitive-key regex (e.g. "monkey") loses its value. Losing benign
 * data is acceptable; leaking a credential is not. Bare hex sequences are NOT
 * masked in free text on purpose — git commit hashes live in world.run output
 * and must survive verbatim (the anchored whole-value rule still catches an
 * env-style value that is nothing but hex).
 */
import {
  maskUriCredentials,
  REDACTED_STRING,
  SENSITIVE_KEY_REGEX,
  SENSITIVE_VALUE_REGEX,
} from '../prober/index.js';

/**
 * Credential-shaped tokens WITHOUT a key prefix. Deliberately excludes bare hex
 * (git commit hashes are everywhere in command output and must not be mangled).
 * Pattern literals use single-char classes so the detection rules themselves do
 * not trip secret scanners.
 */
const CREDENTIAL_TOKEN_SHAPES =
  /\b(?:A[K]I[A][0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|githu[b]_pat_[A-Za-z0-9_]{20,}|s[k]-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

/**
 * `sensitive-key = value` / `"sensitiveKey": "value"` — the value is replaced,
 * the key is kept for readability. Built from SENSITIVE_KEY_REGEX.source so the
 * two layers share one definition of "sensitive".
 */
const SENSITIVE_KV_PAIR = new RegExp(
  `(["']?)` +
  `([A-Za-z0-9_.-]*(?:${SENSITIVE_KEY_REGEX.source})[A-Za-z0-9_.-]*)` +
  `(["']?)` +
  `(\\s*[:=]\\s*)` +
  `(["']?)` +
  `([^"'\\s,;)\\]}]+)` +
  `(["']?)`,
  'gi',
);

/** `Bearer <token>` — the common HTTP Authorization shape. */
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Irreversibly redact a free-text value (command output, an error message, a
 * stderr tail) so no credential survives into logs, SQLite or the protocol.
 * Idempotent: masking an already-masked text is a no-op (the runner re-runs it
 * on every stderr chunk).
 */
export function redactText(text: string): string {
  // A value that is nothing but a credential shape (env-style) goes entirely.
  if (SENSITIVE_VALUE_REGEX.test(text)) return REDACTED_STRING;
  let out = maskUriCredentials(text);
  out = out.replace(SENSITIVE_KV_PAIR, (m, q1: string, key: string, q2: string, sep: string, vq1: string, value: string, vq2: string) => {
    // "Authorization: Bearer xyz" — leave the pair for the Bearer rule so the
    // real token is masked, not just the word "Bearer".
    if (value === REDACTED_STRING || /^bearer$/i.test(value)) return m;
    return `${q1}${key}${q2}${sep}${vq1}${REDACTED_STRING}${vq2}`;
  });
  out = out.replace(CREDENTIAL_TOKEN_SHAPES, REDACTED_STRING);
  out = out.replace(BEARER_TOKEN, '$1 ' + REDACTED_STRING);
  return out;
}

/**
 * Irreversibly redact a structured value before it crosses a serialization
 * boundary: strings are redacted via {@link redactText}, object fields whose
 * KEY is sensitive are replaced wholesale (the value never survives, whatever
 * its shape), arrays and nested objects are walked recursively; numbers and
 * booleans pass through.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_REGEX.test(key) ? REDACTED_STRING : redactValue(field);
    }
    return out as unknown as T;
  }
  return value;
}
