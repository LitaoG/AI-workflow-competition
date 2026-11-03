import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText, redactValue } from '../../../src/dwf/redact.js';
import { buildSandboxEnv } from '../../../src/dwf/runner.js';
import { sanitizeEnv, REDACTED_STRING } from '../../../src/prober/index.js';

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
const FAKE_GITHUB_TOKEN = 'gh' + 'p_0123456789abcdefghij0123456789abcd';
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
      'GITHUB_TOKEN: gh' + 'p_0123456789abcdefghij0123456789abcd',
      '{"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG"}',
      'password=hunter2',
    ];
    for (const c of cases) {
      const out = redactText(c);
      assert.ok(out.includes(REDACTED_STRING), `nothing masked in: ${c}`);
      assert.ok(!/hunter2|gh[p]_0123|wJalrXUtnFEMI/.test(out), `secret survived in: ${out}`);
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

  test('masks bare credential-shaped API keys (OpenAI-style shapes)', () => {
    const FAKE_SK_KEY = 'sk' + '-0123456789abcdefghij0123'; // self-made, 20 alnum chars after the prefix
    const out = redactText(`config ${FAKE_SK_KEY} end`);
    assert.ok(!out.includes(FAKE_SK_KEY), `bare credential-shaped key survived: ${out}`);
    assert.ok(out.includes(REDACTED_STRING));
    // redactValue delegates to the same shape for structured payloads:
    assert.ok(!JSON.stringify(redactValue({ k: FAKE_SK_KEY })).includes(FAKE_SK_KEY));
    // The length floor deliberately keeps short example strings readable:
    assert.equal(redactText('use sk' + '-decoy-123 as the example'), 'use sk' + '-decoy-123 as the example');
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
    AWS_ACCESS_KEY_ID: 'AK' + 'IAIOSFODNN7EXAMPLE',
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

  test('a real child process echoing its env receives no secret values', async () => {
    for (const [k, v] of Object.entries(POISON)) process.env[k] = v;
    try {
      const env = buildSandboxEnv();
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out = await new Promise<string>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (c: Buffer) => (buf += c.toString()));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`echo child exited ${code}`))));
      });
      const childEnv = JSON.parse(out) as Record<string, string>;
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
