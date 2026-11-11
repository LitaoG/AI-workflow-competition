/**
 * Environment sanitizer — the redaction layer behind probe()'s env snapshot
 * and the lexical root of all credential masking in the repo (src/dwf/redact.ts
 * builds on these exact constants). (E-doc §5.1-7 blueprint, verified against
 * code.)
 *
 * 【Design intent — three independent masks per env var】
 *
 * 1. Key-name mask: SENSITIVE_KEY_REGEX.test(key) replaces the value
 *    wholesale. Matching is case-insensitive substring — deliberately biased
 *    toward over-redaction: a benign key literally named "monkey" loses its
 *    value, because losing benign data is acceptable while leaking a
 *    credential is not.
 * 2. Value-shape mask: SENSITIVE_VALUE_REGEX.test(value) replaces the value
 *    wholesale even under an innocent key name — anchored ^…$ whole-value
 *    shapes only (JWT `ey…`, AWS AKIA…, GitHub ghp_…, bare hex), so hex
 *    fragments inside free text (git hashes) are never touched here.
 * 3. URI credential mask: everything else passes through maskUriCredentials(),
 *    so a connection string under a harmless-looking key (DATABASE_URL=
 *    postgres://admin:p4ss@host) still loses BOTH credential components →
 *    `://***:***@` — the user part is masked too, since either half can be a
 *    credential, while the URI shape stays recognizable for debugging.
 *
 * 【Whitelist mode (Issue #36)】inverts the strategy: with envWhitelist only
 * the listed keys survive at all — snapshot minimization instead of
 * redaction, for contexts that know exactly which env vars they need.
 *
 * REDACTED_STRING is the one canonical mask marker; prober snapshots and dwf
 * journal/emit redaction must never invent divergent marker strings.
 */

// Exported so the dwf redaction layer (src/dwf/redact.ts) reuses the exact same
// notion of "sensitive" instead of forking a second regex (same semantics, one place).
// igccsvc_db: Intel graphics DPAPI-encrypted blob carried in plaintext env — see Issue #36.
export const SENSITIVE_KEY_REGEX = /(?:key|token|secret|password|pwd|auth|credential|cert|signature|sigv4|aws_access_key|igccsvc_db|private)/i;
export const SENSITIVE_VALUE_REGEX = /^(?:ey[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{30,}|[0-9a-f]{32,64})$/;
const URI_CREDENTIALS_REGEX = /:\/\/([^/@:]*):([^/@]+)@/g;

export const REDACTED_STRING = '***REDACTED***';

export function maskUriCredentials(value: string): string {
  return value.replace(URI_CREDENTIALS_REGEX, '://***:***@');
}

export function sanitizeEnv(
  env: Record<string, string | undefined> = process.env,
  whitelist?: string[]
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, val] of Object.entries(env)) {
    if (val === undefined || val === null) continue;

    // If whitelist provided, only permit whitelisted keys
    if (whitelist && !whitelist.includes(key)) {
      continue;
    }

    // Redact sensitive keys
    if (SENSITIVE_KEY_REGEX.test(key) || SENSITIVE_VALUE_REGEX.test(val)) {
      sanitized[key] = REDACTED_STRING;
    } else {
      sanitized[key] = maskUriCredentials(val);
    }
  }

  return sanitized;
}
