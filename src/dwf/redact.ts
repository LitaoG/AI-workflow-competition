/**
 * Irreversible redaction for the dwf persistence/emit boundaries — GOAL.md
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
 * Credential-shaped tokens WITHOUT a key prefix — catches credentials sitting
 * in free text where no sensitive key name advertises them. Shapes (verified
 * against the regex): AKIA+16 uppercase (AWS access key id); gh[pousr]_+20 =
 * ghp/gho/ghu/ghs/ghr (GitHub classic PAT / OAuth / user- & server-to-server /
 * refresh) plus github_pat_+20 (fine-grained PAT); sk-+20 contiguous alnum
 * (legacy OpenAI keys — note hyphenated sk-proj-* does NOT match here: the
 * hyphen breaks the alnum run, so project keys rely on the SENSITIVE_KV_PAIR
 * layer when they appear under an api-key label); xox[baprs]- (Slack);
 * eyJ.<seg>.<seg> (three-segment JWT). Deliberately excludes bare hex (git
 * commit hashes are everywhere in command output and must not be mangled).
 */
const CREDENTIAL_SHAPES_NO_JWT =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

/**
 * The three-segment JWT shape on its own, in sticky form for positioned
 * attempts (see {@link replaceCredentialShapes}). It is isolated because it is
 * the only shape whose continuation class `[A-Za-z0-9_-]` contains `-`: one
 * contiguous run can host many `eyJ` start positions (every dash before an
 * `eyJ` is a word boundary), while the `.` the shape needs next can never
 * occur inside that run — so each start scans the whole run and fails, which
 * made a naive per-start attempt quadratic (Issue #122).
 */
const JWT_CREDENTIAL_SHAPE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/y;

/**
 * `sensitive-key = value` / `"sensitiveKey": "value"` — the value is replaced,
 * the key is kept for readability. Built from SENSITIVE_KEY_REGEX.source so the
 * two layers share one definition of "sensitive".
 *
 * The key name is one whole run of `[A-Za-z0-9_.-]` that contains a sensitive
 * word, and it is matched in linear time (Issue #121): it may only start where
 * a run starts (lookbehind), the run is checked for a sensitive word in one
 * forward scan (lazy lookahead), and the run is then consumed once with no
 * backtracking into it (lookahead capture + backreference, an atomic group).
 * The old `[…]*word[…]*` form gave the same matches, because a matching key
 * always spans a whole run, but it retried from every position inside a run,
 * which is quadratic on long runs such as base64url or hex dumps.
 */
const SENSITIVE_KV_PAIR = new RegExp(
  `(["']?)` +
  `(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*?(?:${SENSITIVE_KEY_REGEX.source}))(?=([A-Za-z0-9_.-]+))\\2` +
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
 *
 * Five ordered stages, and the order is load-bearing: whole-value (an
 * env-style text that is nothing but a credential) → URI credentials →
 * key=value pairs → bare token shapes → Bearer headers. Whole-value runs
 * first so a pure credential never reaches the pair parser; KV pairs run
 * before bare shapes so a labeled secret keeps its readable key.
 */
/** `true` for the characters JavaScript's `\b` treats as word characters. */
function isRegexWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/** `true` for `[A-Za-z0-9_-]` — the character class a JWT body traverses. */
function isJwtRunChar(code: number): boolean {
  return isRegexWordChar(code) || code === 0x2d; // -
}

/**
 * Stage 4 — replaces every bare credential shape with {@link REDACTED_STRING}.
 * Matches are exactly those of the original combined rule
 * `\b(?:AKIA…|gh…|github_pat_…|sk-…|xox…|eyJ…)\b` under a global replace;
 * only the JWT branch's cost changed (Issue #122).
 *
 * A global replace takes the leftmost match and resumes after it. At any one
 * index at most one branch can match — the branch prefixes are mutually
 * exclusive (`eyJ` shares no first character with any other branch; `gh` vs
 * `github_pat_` is settled by the preserved alternation order) — so the loop
 * compares the leftmost non-JWT match (one native scan) with the leftmost
 * viable `eyJ` start and takes the earlier one. Candidates inside an already
 * consumed match are never probed, exactly like the engine resumes after a
 * match.
 *
 * The quadratic part is memoized away: once a JWT attempt fails AFTER its
 * `eyJ` prefix matched, the greedy scan has walked the contiguous
 * `[A-Za-z0-9_-]` run to its end S and found no completing `.` there. Any
 * later `eyJ` start inside that same run scans a strict sub-slice ending at
 * the SAME S (the run end does not depend on the start), so it must fail too
 * and is skipped. Only JWT attempts are skipped — the other branches can still
 * match inside such a run (e.g. `sk-…` after a dash) and are tried everywhere.
 */
function replaceCredentialShapes(text: string): string {
  // With no `eyJ` anywhere the JWT branch can never match, so a plain replace
  // of the remaining five shapes IS the combined rule — one native pass.
  if (!text.includes('eyJ')) {
    return text.replace(CREDENTIAL_SHAPES_NO_JWT, REDACTED_STRING);
  }
  let out = '';
  let emittedUpTo = 0; // start of the region not yet copied to `out`
  let pos = 0; // leftmost index not yet decided (>= emittedUpTo; failures advance it without emitting)
  let jwtFailRunEnd = -1; // memo: every `eyJ` start below this index is proven to fail
  let probeFrom = 0; // monotonic `eyJ` probe cursor (amortizes indexOf)
  let cand = -1; // probed viable JWT candidate not yet attempted (-1 = none)
  let m: RegExpExecArray | null = null;
  let mDone = false; // the exec already returned null: no non-JWT match exists at or after pos
  while (true) {
    // A candidate found earlier stays viable across iterations unless the scan
    // moved past it (a consumed match may cover it) or the memo caught up.
    if (cand !== -1 && (cand < pos || cand < jwtFailRunEnd)) cand = -1;
    if (cand === -1) {
      // Leftmost viable JWT candidate >= pos: an `eyJ` occurrence that the memo
      // has not ruled out and that has a `\b` in front. The probe cursor only
      // ever moves forward, so each occurrence is examined exactly once.
      if (probeFrom < pos) probeFrom = pos;
      for (;;) {
        const c = text.indexOf('eyJ', probeFrom);
        if (c === -1) break;
        probeFrom = c + 1;
        if (c < jwtFailRunEnd) continue;
        if (c > 0 && isRegexWordChar(text.charCodeAt(c - 1))) continue; // no \b
        cand = c;
        break;
      }
    }
    if (m === null && !mDone) {
      CREDENTIAL_SHAPES_NO_JWT.lastIndex = pos;
      m = CREDENTIAL_SHAPES_NO_JWT.exec(text); // leftmost non-JWT match >= pos
      // A null stays null: matches only consume, so pos never moves backwards.
      // Remembering it keeps inputs with many JWT tokens but no other shape
      // linear (otherwise every consumed token would rescan the whole tail).
      if (m === null) mDone = true;
    }
    if (cand !== -1 && (m === null || cand < m.index)) {
      const e = cand;
      cand = -1;
      JWT_CREDENTIAL_SHAPE.lastIndex = e;
      const j = JWT_CREDENTIAL_SHAPE.exec(text);
      if (j) {
        out += text.slice(emittedUpTo, j.index) + REDACTED_STRING;
        emittedUpTo = pos = j.index + j[0].length;
        m = null; // the consumed span may cover it
        continue;
      }
      // Failed after the prefix matched: memoize the run end (Issue #122).
      let runEnd = e + 3;
      while (runEnd < text.length && isJwtRunChar(text.charCodeAt(runEnd))) runEnd += 1;
      if (runEnd > jwtFailRunEnd) jwtFailRunEnd = runEnd;
      pos = e + 1; // scanning moves on; nothing was consumed
      continue;
    }
    if (m !== null) {
      out += text.slice(emittedUpTo, m.index) + REDACTED_STRING;
      emittedUpTo = pos = m.index + m[0].length;
      m = null; // `cand` survives: it is ahead of m.index, and dies above if the span covered it
      continue;
    }
    return out + text.slice(emittedUpTo);
  }
}

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
  out = replaceCredentialShapes(out);
  out = out.replace(BEARER_TOKEN, '$1 ' + REDACTED_STRING);
  return out;
}

/**
 * Irreversibly redact a structured value before it crosses a serialization
 * boundary: strings are redacted via {@link redactText}, object fields whose
 * KEY is sensitive are replaced wholesale (the value never survives, whatever
 * its shape), a credential-shaped KEY itself is masked (a secret can arrive as
 * a map key, not only a value), arrays and nested objects are walked
 * recursively; numbers and booleans pass through.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const emitted = new Set<string>();
    let maskedKeySeq = 0;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      // The KEY itself can be a credential: agent output is parsed into objects,
      // so a bare `ghp_…` / `AKIA…` / JWT token can arrive AS a map key, not only
      // a value. Mask credential-shaped key text (redactText leaves an ordinary
      // key untouched); a sensitive-NAMED key still loses its value wholesale.
      const safeKey = redactText(key);
      let outKey = safeKey;
      if (safeKey !== key) {
        // Two different credential keys mask to the SAME placeholder — without
        // disambiguation the second write would silently overwrite the first
        // entry and its value would be lost. Suffix is deterministic (insertion
        // order), so the same input always redacts to the same shape.
        maskedKeySeq += 1;
        if (emitted.has(outKey)) outKey = `${outKey}#${maskedKeySeq}`;
      }
      emitted.add(outKey);
      out[outKey] = SENSITIVE_KEY_REGEX.test(key) ? REDACTED_STRING : redactValue(field);
    }
    return out as unknown as T;
  }
  return value;
}
