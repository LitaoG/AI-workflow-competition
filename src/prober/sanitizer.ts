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
