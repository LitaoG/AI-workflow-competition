import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText, redactValue } from '../../../src/dwf/redact.js';
import { buildSandboxEnv } from '../../../src/dwf/runner.js';
import { sanitizeEnv, REDACTED_STRING, SENSITIVE_KEY_REGEX } from '../../../src/prober/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    cur = path.dirname(cur);
  }
  return path.resolve(startDir, '../..');
}

const REPO_ROOT = findRepoRoot(__dirname);

/** Fake, self-made token shapes — nothing here is a real credential. */
const FAKE_GITHUB_TOKEN = 'ghp_0123456789abcdefghij0123456789abcd';
const FAKE_URI_SECRET = 'https://alice:pat-123456@github.com/org/repo.git';

describe('redactText — irreversible masking at serialization boundaries', () => {
  test('masks credentials embedded in URLs (git remote shape)', () => {
    const out = redactText(`remote origin ${FAKE_URI_SECRET}`);
    assert.ok(!out.includes('pat-123456'), `password survived: ${out}`);
    assert.ok(!out.includes('alice:'), `username survived: ${out}`);
    assert.ok(out.includes('://***:***@github.com/org/repo.git'));
  });

  test('masks sensitive key=value / key: value pairs, in plain and JSON shape', () => {
    const cases = [
      'MY_SECRET=hunter2secret',
      'GITHUB_TOKEN: ghp_0123456789abcdefghij0123456789abcd',
      '{"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG"}',
      'password=hunter2',
    ];
    for (const c of cases) {
      const out = redactText(c);
      assert.ok(out.includes(REDACTED_STRING), `nothing masked in: ${c}`);
      assert.ok(!/hunter2|ghp_0123|wJalrXUtnFEMI/.test(out), `secret survived in: ${out}`);
    }
    // The key stays readable for debugging; only the value is destroyed.
    assert.ok(redactText('MY_SECRET=hunter2secret').startsWith('MY_SECRET='));
    assert.equal(redactText('{"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG"}'), '{"AWS_SECRET_ACCESS_KEY": "***REDACTED***"}');
  });

  test('masks bare credential-shaped tokens and Bearer headers', () => {
    const out = redactText(`pushed with ${FAKE_GITHUB_TOKEN} and Authorization: Bearer abc.def.ghi`);
    assert.ok(!out.includes(FAKE_GITHUB_TOKEN));
    assert.ok(!out.includes('abc.def.ghi'));
    assert.ok(out.includes('Bearer ***REDACTED***'));
  });

  test('masks bare sk- family API keys (OpenAI-style shapes)', () => {
    const FAKE_SK_KEY = 'sk-0123456789abcdefghij0123'; // self-made, 20 alnum chars after sk-
    const out = redactText(`config ${FAKE_SK_KEY} end`);
    assert.ok(!out.includes(FAKE_SK_KEY), `bare sk- key survived: ${out}`);
    assert.ok(out.includes(REDACTED_STRING));
    // redactValue delegates to the same shape for structured payloads:
    assert.ok(!JSON.stringify(redactValue({ k: FAKE_SK_KEY })).includes(FAKE_SK_KEY));
    // The length floor deliberately keeps short example strings readable:
    assert.equal(redactText('use sk-decoy-123 as the example'), 'use sk-decoy-123 as the example');
    // Idempotent, like every other shape:
    assert.equal(redactText(out), out);
  });

  test('masks the IGCCSVC_DB DPAPI blob (Issue #36 — sensitive-key list is shared with the prober)', () => {
    const FAKE_BLOB = 'A'.repeat(416); // real value's shape: 416-char DPAPI blob, no credential-ish name substring
    // Free-text KV path (spawn output / stderr tails):
    const out = redactText(`IGCCSVC_DB=${FAKE_BLOB}`);
    assert.ok(!out.includes(FAKE_BLOB), 'IGCCSVC_DB value survived redactText');
    assert.ok(out.startsWith('IGCCSVC_DB='), 'the key stays readable; only the value is destroyed');
    assert.ok(out.includes(REDACTED_STRING));
    // Structured-payload path (journalled values): sensitive KEY destroyed wholesale.
    const structured = redactValue({ IGCCSVC_DB: FAKE_BLOB, keep: 1 });
    assert.equal(structured.IGCCSVC_DB, REDACTED_STRING, 'IGCCSVC_DB key must lose its value entirely');
    assert.equal(structured.keep, 1);
    // Idempotent:
    assert.equal(redactText(out), out);
  });

  test('does NOT mask bare hex (git hashes) or ordinary output', () => {
    const hash = '3f03d40a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e';
    const out = redactText(`commit ${hash}\nv20.11.0\nhello dwf`);
    assert.ok(out.includes(hash), 'git commit hashes must survive verbatim');
    assert.equal(out, `commit ${hash}\nv20.11.0\nhello dwf`);
  });

  test('replaces a value that is nothing but a credential shape (env-style)', () => {
    assert.equal(redactText('3f03d40a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e'), REDACTED_STRING);
  });

  test('is idempotent (the runner re-runs it on every stderr chunk)', () => {
    const dirty = [
      `remote origin ${FAKE_URI_SECRET}`,
      'MY_SECRET=hunter2secret',
      `GITHUB_TOKEN: ${FAKE_GITHUB_TOKEN}`,
      'Authorization: Bearer abc.def.ghi',
      'commit 3f03d40a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e',
    ].join('\n');
    const once = redactText(dirty);
    assert.equal(redactText(once), once);
  });

  test('crafted 1 MB inputs are masked in linear time, whichever rule they aim at (Issue #121)', () => {
    // A backtracking regex blocks the event loop, so no timer in this process
    // could stop it: every input runs in one child with a hard time limit.
    // Before the fix, the plain `x` run alone took about 40 minutes.
    const words = SENSITIVE_KEY_REGEX.source.replace(/^\(\?:|\)$/g, '').split('|');
    assert.ok(words.every((w) => /^[a-z0-9_]+$/.test(w)), `unexpected SENSITIVE_KEY_REGEX shape: ${SENSITIVE_KEY_REGEX.source}`);
    const units = [
      // A long run of each character class the rules scan.
      'x', 'Z', '0', 'f', '_', '.', '-', ' ', '\t', '\n', '=', ':', '/', '@', '"', "'", '+', '~', 'é',
      'a.b-', 'a_b', 'a:b', 'a=b',
      // Each sensitive word, repeated, and as a key with a separator.
      ...words,
      ...words.map((w) => `${w}=`),
      'token: ',
      // Each credential prefix, repeated. `eyJ-` / `-eyJ` joined when #122 was
      // fixed: the JWT shape rule was quadratic on them (every dash before an
      // `eyJ` is a word boundary, so one run hosted a start per 4 chars).
      'sk-', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'AKIA', 'eyJ-', '-eyJ', 'Bearer ', '://a:',
    ];
    const redactUrl = new URL('../../../src/dwf/redact.js', import.meta.url).href;
    const script = [
      `const { redactText } = await import(${JSON.stringify(redactUrl)});`,
      `const results = [];`,
      `for (const unit of ${JSON.stringify(units)}) {`,
      `  const run = unit.repeat(Math.ceil(1048576 / unit.length));`,
      `  const out = redactText('start ' + run + ' token=hunter2 end');`,
      `  results.push({`,
      `    unit,`,
      `    masked: !out.includes('hunter2') && out.endsWith(' end'),`,
      `    kept: out === 'start ' + run + ' token=' + ${JSON.stringify(REDACTED_STRING)} + ' end',`,
      `  });`,
      `}`,
      `process.stdout.write(JSON.stringify(results));`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(child.error, undefined, `the child did not finish within 30 s: ${child.error?.message}`);
    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout) as Array<{ unit: string; masked: boolean; kept: boolean }>;
    assert.deepEqual(results.map((r) => r.unit), units);
    for (const r of results) assert.ok(r.masked, `the secret after a run of ${JSON.stringify(r.unit)} survived`);
    // A run that no rule matches is kept as it is.
    for (const unit of ['x', 'key', 'a.b-']) {
      assert.ok(results.find((r) => r.unit === unit)?.kept, `a run of ${JSON.stringify(unit)} was changed`);
    }
  });
});

describe('redactText — Issue #122, the JWT shape rule in linear time', () => {
  // The pre-#122 combined rule, kept verbatim as the differential oracle.
  const LEGACY_COMBINED_SHAPES =
    /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

  // Wrapping that provably leaves the other four stages inert, so comparing
  // redactText is exactly comparing stage 4: the wrapper defeats the anchored
  // whole-value rule (stage 1); the alphabet carries no '/', ':' or '=' (stages
  // 2 and 3 cannot fire) and cannot spell "Bearer" (no 'r', stage 5).
  const wrap = (s: string) => 'p ' + s + ' q';

  test('matches the combined rule verbatim — 30,000 seeded differential cases', () => {
    // Deterministic xorshift, so any divergence is reproducible from this seed.
    let state = 0x12345678 | 0;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const units = [
      'eyJ', 'e', 'y', 'J', 'a', 'A', 'Z', '0', '9', '-', '_', '.', ' ',
      'ghp_', 'github_pat_', 'sk-', 'xoxb-', 'AKIA', 'B',
    ];
    let diffs = 0;
    for (let i = 0; i < 30_000; i += 1) {
      const count = 1 + Math.floor(next() * (i % 100 === 0 ? 80 : 24));
      let s = '';
      for (let k = 0; k < count; k += 1) s += units[Math.floor(next() * units.length)];
      const input = wrap(s);
      const expected = input.replace(LEGACY_COMBINED_SHAPES, REDACTED_STRING);
      const actual = redactText(input);
      if (actual !== expected) {
        diffs += 1;
        if (diffs <= 3) {
          console.error(`diff case #${i}: input=${JSON.stringify(input)} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
        }
      }
    }
    assert.equal(diffs, 0, 'the linear scanner diverged from the combined rule');
  });

  test('semantic cases the run memo must not break', () => {
    // `x-eyJ…` — the dash before `eyJ` is a word boundary; the shape matches.
    const jwt = `eyJ${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(12)}`;
    assert.equal(redactText(wrap('x-' + jwt)), wrap('x-' + REDACTED_STRING));
    // A real JWT right after three bare `eyJ-` units: the first attempt spans
    // all of it and must still succeed.
    assert.equal(redactText(wrap('eyJ-eyJ-eyJ-' + jwt)), wrap(REDACTED_STRING));
    // The naive version of the #122 optimization ("skip the rest of the run
    // after a failed start") would leave this `sk-` token UNMASKED: it sits
    // inside the very run the failed JWT attempt scanned. Only JWT attempts
    // may be skipped, never the other shapes.
    const mixed = `eyJ${'a'.repeat(20)}-sk-${'b'.repeat(25)}`;
    assert.equal(redactText(wrap(mixed)), wrap(`eyJ${'a'.repeat(20)}-${REDACTED_STRING}`));
    // A failed run, then a real JWT in a new run: the memo must not leak past
    // the run that failed.
    assert.equal(redactText(wrap(`eyJ${'a'.repeat(20)} ${jwt}`)), wrap(`eyJ${'a'.repeat(20)} ${REDACTED_STRING}`));
  });

  test('3 MB of real JWT tokens are masked in linear time (Issue #122)', () => {
    // Many JWT tokens and NO other shape: an implementation that re-scans the
    // remaining text after every consumed token is quadratic on this (an
    // intermediate version of the fix took ~5.4 s for 700 KB here).
    const jwt = `eyJ${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(12)}`;
    const token = 'x-' + jwt + ' ';
    const redactUrl = new URL('../../../src/dwf/redact.js', import.meta.url).href;
    const script = [
      `const { redactText } = await import(${JSON.stringify(redactUrl)});`,
      `const { REDACTED_STRING } = await import(${JSON.stringify(new URL('../../../src/prober/index.js', import.meta.url).href)});`,
      `const token = ${JSON.stringify(token)};`,
      `const input = token.repeat(Math.ceil(3145728 / token.length));`,
      `const out = redactText(input);`,
      `process.stdout.write(String(out === ('x-' + REDACTED_STRING + ' ').repeat(Math.ceil(3145728 / token.length))));`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(child.error, undefined, `the child did not finish within 20 s: ${child.error?.message}`);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'true', 'every token must be masked, verbatim');
  });
});

describe('redactValue — structured payloads', () => {
  test('walks objects/arrays; sensitive KEYS are destroyed wholesale; numbers pass through', () => {
    const input = {
      exitCode: 0,
      stdout: 'MY_SECRET=hunter2secret\n',
      stderr: '',
      nested: { AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI', keep: 'plain' },
      list: ['token=abc123', 5],
    };
    const out = redactValue(input);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'MY_SECRET=***REDACTED***\n');
    assert.equal(out.nested.AWS_SECRET_ACCESS_KEY, REDACTED_STRING, 'a sensitive-named key must lose its value entirely');
    assert.equal(out.nested.keep, 'plain');
    assert.deepEqual(out.list, ['token=***REDACTED***', 5]);
  });

  test('masks a credential-shaped KEY, not only values (Issue #104)', () => {
    const GHP = 'ghp_0123456789abcdefghij0123456789abcd';
    const out = redactValue({ [GHP]: { note: 'x' }, AWS_SECRET_ACCESS_KEY: 'plain', keep: 'ok' }) as Record<string, unknown>;
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes(GHP), `credential-shaped key survived: ${serialized}`);
    assert.ok(Object.keys(out).includes(REDACTED_STRING), 'a credential-shaped key must become the redacted marker');
    assert.equal(out.AWS_SECRET_ACCESS_KEY, REDACTED_STRING, 'a sensitive-NAMED key still loses its value');
    assert.equal(out.keep, 'ok', 'benign keys and values pass through');
  });

  test('keeps BOTH credential keys when two mask to the same placeholder (#104 F1)', () => {
    const GHP1 = 'ghp_0123456789abcdefghij0123456789abcd';
    const GHP2 = 'ghp_zyxwvutsrqponmlkjihgfedcba0123456789';
    const out = redactValue({ [GHP1]: 'first', [GHP2]: 'second' }) as Record<string, unknown>;
    const keys = Object.keys(out);
    assert.equal(keys.length, 2, `a masked-key collision dropped an entry: ${JSON.stringify(keys)}`);
    assert.deepEqual(new Set(keys).size, 2, 'placeholders must be distinct');
    assert.equal(out[keys[0]], 'first', 'first entry value survives');
    assert.equal(out[keys[1]], 'second', 'second entry value survives');
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes(GHP1) && !serialized.includes(GHP2), 'no credential key text survives');
    // Deterministic: the same input always redacts to the same shape.
    const again = redactValue({ [GHP1]: 'first', [GHP2]: 'second' }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(again), keys, 'masking must be deterministic for journal replay');
  });

  test('masks a credential that is only PART of a key (#104 F2)', () => {
    const GHP = 'ghp_0123456789abcdefghij0123456789abcd';
    const out = redactValue({ [`Bearer ${GHP}`]: 'v1', [`https://user:${GHP}@github.com/x`]: 'v2', plain: 'ok' }) as Record<string, unknown>;
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes(GHP), `partial-credential key survived: ${serialized}`);
    assert.equal(out['Bearer ' + REDACTED_STRING], 'v1', 'bearer-prefixed key masked, context kept');
    // URI userinfo goes through maskUriCredentials, whose own marker is `***`
    // (user AND password fields), not REDACTED_STRING.
    assert.ok(Object.keys(out).some((k) => k.startsWith('https://***:') && !k.includes(GHP)), 'URI-embedded credential key masked');
    assert.equal(out.plain, 'ok', 'benign key untouched');
  });
});

describe('sanitizeEnv — the masking layer applied on top of the whitelist', () => {
  test('value-masks sensitive-named keys and credential-shaped values', () => {
    const env = sanitizeEnv({
      SAFE_VAR: 'hello',
      DWF_SECRET_TOKEN: 'super-secret',
      GITHash: '3f03d40a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e',
      GIT_REMOTE: FAKE_URI_SECRET,
    });
    assert.equal(env.SAFE_VAR, 'hello');
    assert.equal(env.DWF_SECRET_TOKEN, REDACTED_STRING);
    assert.equal(env.GITHash, REDACTED_STRING, 'a whole-value hex token is masked even under a benign key');
    assert.equal(env.GIT_REMOTE, 'https://***:***@github.com/org/repo.git');
  });
});

describe('buildSandboxEnv — the env the runner actually injects (whitelist + mask)', () => {
  const POISON = {
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    GITHUB_TOKEN: FAKE_GITHUB_TOKEN,
    MY_SECRET: 'hunter2',
  };

  test('drops/masks credential env vars, keeps the platform-critical base', () => {
    for (const [k, v] of Object.entries(POISON)) process.env[k] = v;
    try {
      const env = buildSandboxEnv();
      // Bedrock/provider credentials are host-side only (src/agent/bedrock-provider.ts) —
      // they must never enter the sandbox by name or value.
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.MY_SECRET, undefined);
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'the Electron shim must survive');
      assert.ok(env.PATH, 'PATH must survive: children cannot even spawn without it');
      if (process.platform === 'win32') {
        assert.ok(env.SYSTEMROOT, 'Windows children need SystemRoot');
      } else {
        assert.ok(env.HOME, 'POSIX children need HOME');
      }
    } finally {
      for (const k of Object.keys(POISON)) delete process.env[k];
    }
  });

  test('a real child process echoing its env receives no secret values', () => {
    for (const [k, v] of Object.entries(POISON)) process.env[k] = v;
    try {
      const env = buildSandboxEnv();
      // spawnSync (bounded, tree-free) per Issue #198: the unit suite keeps pure
      // isolation semantics — no async child-process trees may outlive a call.
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`echo child exited ${child.status}`);
      const childEnv = JSON.parse(child.stdout) as Record<string, string>;
      assert.equal(childEnv.AWS_ACCESS_KEY_ID, undefined, 'AWS key leaked into the child env!');
      assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined, 'AWS secret leaked into the child env!');
      assert.equal(childEnv.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN leaked into the child env!');
      assert.equal(childEnv.MY_SECRET, undefined, 'MY_SECRET leaked into the child env!');
      assert.ok(childEnv.PATH, 'child PATH missing');
      assert.equal(childEnv.ELECTRON_RUN_AS_NODE, '1');
    } finally {
      for (const k of Object.keys(POISON)) delete process.env[k];
    }
  });
});

test('ProberResult.env keeps its "Strictly sanitized/redacted" contract note', () => {
  // The contract comment (formerly src/types.ts) now lives in the domain layer.
  const workflowTypes = fs.readFileSync(path.join(REPO_ROOT, 'src', 'domain', 'workflow-types.ts'), 'utf8');
  assert.match(workflowTypes, /env: Record<string, string>; \/\/ Strictly sanitized\/redacted/);
});
