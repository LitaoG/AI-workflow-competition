import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSystem } from '../../src/prober/system.js';
import { probeGit } from '../../src/prober/git.js';
import { probeToolchain } from '../../src/prober/toolchain.js';
import { sanitizeEnv } from '../../src/prober/sanitizer.js';
import { probe, computeFingerprint } from '../../src/prober/index.js';

test('Prober: detects platform, architecture, and memory metrics', () => {
  const sys = probeSystem();
  assert.equal(sys.platform, process.platform);
  assert.equal(sys.arch, process.arch);
  assert.ok(sys.cpus > 0);
  assert.ok(sys.totalMemMb > 0);
  assert.ok(sys.nodeVersion.startsWith('v'));
});

test('Prober: detects git branch, commit hash, and dirty status gracefully', async () => {
  const git = await probeGit();
  assert.equal(typeof git.isGitRepo, 'boolean');
  assert.equal(typeof git.branch, 'string');
  assert.equal(typeof git.commit, 'string');
  assert.equal(typeof git.isDirty, 'boolean');
});

test('Prober: detects installed node, npm, and git toolchains honestly', async () => {
  const toolchain = await probeToolchain();
  assert.ok(toolchain.node.length > 0);
  // Honesty contract (Issue #88): a tool reports a measured version or undefined —
  // never a fabricated placeholder.
  assert.ok(toolchain.npm === undefined || toolchain.npm.length > 0);
  assert.ok(toolchain.git === undefined || toolchain.git.length > 0);
});

test('Prober: strictly sanitizes and redacts all secret environment keys', () => {
  const mockEnv = {
    AWS_SECRET_ACCESS_KEY: 'secret123',
    GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    DATABASE_PASSWORD: 'pass',
    NODE_ENV: 'production',
  };

  const sanitized = sanitizeEnv(mockEnv);
  assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, '***REDACTED***');
  assert.equal(sanitized.GITHUB_TOKEN, '***REDACTED***');
  assert.equal(sanitized.DATABASE_PASSWORD, '***REDACTED***');
  assert.equal(sanitized.NODE_ENV, 'production');
});

test('Prober: produces consistent SHA-256 fingerprint for identical environment snapshot', async () => {
  const res1 = await probe();
  const res2 = { ...res1 };

  const hash1 = computeFingerprint(res1);
  const hash2 = computeFingerprint(res2);

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test('Prober: masks embedded credentials in connection string URIs', () => {
  const mockEnv = {
    DATABASE_URL: 'postgresql://admin:password123@db.prod.internal:5432/main',
    REDIS_URL: 'redis://:supersecret@cache.internal:6379/0',
    MONGO_URI: 'mongodb://root:myPass@cluster.mongodb.net/test?retryWrites=true',
    PUBLIC_API_URL: 'https://api.example.com/v1',
  };

  const sanitized = sanitizeEnv(mockEnv);
  assert.equal(sanitized.DATABASE_URL, 'postgresql://***:***@db.prod.internal:5432/main');
  assert.equal(sanitized.REDIS_URL, 'redis://***:***@cache.internal:6379/0');
  assert.equal(sanitized.MONGO_URI, 'mongodb://***:***@cluster.mongodb.net/test?retryWrites=true');
  assert.equal(sanitized.PUBLIC_API_URL, 'https://api.example.com/v1');
});

test('Prober: redacts the IGCCSVC_DB DPAPI blob carried in plaintext env (Issue #36)', () => {
  const blob = 'A'.repeat(416); // same shape as the real Windows IGCCSVC_DB value (416 chars)
  const sanitized = sanitizeEnv({ IGCCSVC_DB: blob, NODE_ENV: 'production' });
  assert.equal(sanitized.IGCCSVC_DB, '***REDACTED***');
  assert.equal(sanitized.NODE_ENV, 'production');
});

