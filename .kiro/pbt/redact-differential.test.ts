import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fc from 'fast-check';

import { redactText } from '../../dist/src/dwf/redact.js';
import {
  maskUriCredentials,
  REDACTED_STRING,
  SENSITIVE_KEY_REGEX,
  SENSITIVE_VALUE_REGEX,
} from '../../dist/src/prober/index.js';

// Issue #121 differential lock for redactText (src/dwf/redact.ts).
// `referenceRedactText` is redactText as it was before #121: frozen copies of
// its rules, with the old backtracking key-name pattern. The inputs stay
// short, because that old pattern is quadratic or worse on long runs. A change
// that makes redactText mask differently fails here; a change that means to
// mask differently must update the reference on purpose.

const OLD_CREDENTIAL_TOKEN_SHAPES =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;
const OLD_SENSITIVE_KV_PAIR = new RegExp(
  `(["']?)` +
    `([A-Za-z0-9_.-]*(?:${SENSITIVE_KEY_REGEX.source})[A-Za-z0-9_.-]*)` +
    `(["']?)` +
    `(\\s*[:=]\\s*)` +
    `(["']?)` +
    `([^"'\\s,;)\\]}]+)` +
    `(["']?)`,
  'gi'
);
const OLD_BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

function referenceRedactText(text: string): string {
  if (SENSITIVE_VALUE_REGEX.test(text)) return REDACTED_STRING;
  let out = maskUriCredentials(text);
  out = out.replace(
    OLD_SENSITIVE_KV_PAIR,
    (m: string, q1: string, key: string, q2: string, sep: string, vq1: string, value: string, vq2: string) => {
      if (value === REDACTED_STRING || /^bearer$/i.test(value)) return m;
      return `${q1}${key}${q2}${sep}${vq1}${REDACTED_STRING}${vq2}`;
    }
  );
  out = out.replace(OLD_CREDENTIAL_TOKEN_SHAPES, REDACTED_STRING);
  out = out.replace(OLD_BEARER_TOKEN, '$1 ' + REDACTED_STRING);
  return out;
}

const NAME_PIECES = [
  'a', 'x', 'Z9', '_', '.', '-', 'my', 'db', '.v1', 'k', 'ey', 'tok',
  'key', 'KEY', 'token', 'Secret', 'pwd', 'auth', 'cert', 'private', 'api_key', 'sigv4',
  'password', 'credential', 'signature', 'aws_access_key', 'igccsvc_db',
];
const SEPARATORS = ['=', ':', ' = ', ' :', ': ', '\t=', '==', '=:', ' ', ''];
const QUOTES = ['', '', '"', "'"];
const VALUES = [
  'v', 'hunter2', 'Bearer', 'bearer', REDACTED_STRING, 'a.b-c', 'x y', '"q"', "it's", '', ',',
  'abc;def', 'x)y', '[1]', '{}', 'é', 'sk-0123456789abcdefghijk', 'ghp_0123456789abcdefghij0123456789abcd',
];
const NOISE = [
  ' ', '\n', ',', ';', '(', ')', '[', ']', '{', '}', '"', "'", '/', '@', 'é', 'x', 'key',
  'https://u:p@h/x', 'Bearer abc.def', 'Authorization: Bearer xyz', 'AKIAIOSFODNN7EXAMPLE',
  'xoxb-0123456789-abc', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh',
];

const pick = (items: readonly string[]) => fc.constantFrom(...items);
const keyName = fc.array(pick(NAME_PIECES), { minLength: 1, maxLength: 4 }).map((parts) => parts.join(''));
const pair = fc
  .tuple(pick(QUOTES), keyName, pick(QUOTES), pick(SEPARATORS), pick(QUOTES), pick(VALUES), pick(QUOTES))
  .map((parts) => parts.join(''));
const shapedText = fc
  .array(fc.oneof({ arbitrary: pair, weight: 3 }, { arbitrary: pick(NOISE), weight: 1 }), { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join(''));

describe('Engine PBT: redactText differential lock (Issue #121)', () => {
  test('PBT: redactText masks exactly what the pre-#121 rules masked', () => {
    fc.assert(
      fc.property(fc.oneof(shapedText, fc.string({ maxLength: 40 })), (text) => {
        assert.equal(redactText(text), referenceRedactText(text));
      }),
      { numRuns: 3000 }
    );
  });
});
