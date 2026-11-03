import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEnv, maskUriCredentials, REDACTED_STRING } from '../../dist/src/prober/sanitizer.js';
import { probe, computeFingerprint } from '../../dist/src/prober/index.js';

test('Prober Sanitization 1: Secret environment variables masking (AWS, OpenAI, GitHub, etc.)', () => {
  const mockEnv = {
    // Sensitive Keys
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    OPENAI_API_KEY: 'OPENAI-REDACTED-PLACEHOLDER',
    GITHUB_TOKEN: 'GITHUB-REDACTED-PLACEHOLDER',
    ACCESS_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M',
    DB_PASSWORD: 'SuperSecretMasterPassword123!',
    CLIENT_SECRET: 'xoxb-secret-token-12345',
    PRIVATE_KEY: 'REDACTED-PEM-PLACEHOLDER',
    AUTH_CREDENTIALS: 'user:pass',
    SSL_CERT: 'cert-content',

    // Generic Keys with Sensitive Values (Token-like patterns)
    UNKNOWN_VAR_AWS: 'eyJREDACTEDPLACEHOLDERVALUE000000',
    ANOTHER_VAR_GHP: 'deadbeefdeadbeefdeadbeefdeadbeef',

    // Non-Sensitive Keys & Values
    NODE_ENV: 'production',
    PORT: '8080',
    SERVICE_NAME: 'ai-workflow-engine',
    LOG_LEVEL: 'info',
  };

  const sanitized = sanitizeEnv(mockEnv);

  // 1. Verify all sensitive keys are redacted
  assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, REDACTED_STRING);
  assert.equal(sanitized.OPENAI_API_KEY, REDACTED_STRING);
  assert.equal(sanitized.GITHUB_TOKEN, REDACTED_STRING);
  assert.equal(sanitized.ACCESS_TOKEN, REDACTED_STRING);
  assert.equal(sanitized.DB_PASSWORD, REDACTED_STRING);
  assert.equal(sanitized.CLIENT_SECRET, REDACTED_STRING);
  assert.equal(sanitized.PRIVATE_KEY, REDACTED_STRING);
  assert.equal(sanitized.AUTH_CREDENTIALS, REDACTED_STRING);
  assert.equal(sanitized.SSL_CERT, REDACTED_STRING);

  // 2. Verify token-pattern values are redacted even with benign key names
  assert.equal(sanitized.UNKNOWN_VAR_AWS, REDACTED_STRING);
  assert.equal(sanitized.ANOTHER_VAR_GHP, REDACTED_STRING);

  // 3. Verify non-sensitive variables are preserved intact
  assert.equal(sanitized.NODE_ENV, 'production');
  assert.equal(sanitized.PORT, '8080');
  assert.equal(sanitized.SERVICE_NAME, 'ai-workflow-engine');
  assert.equal(sanitized.LOG_LEVEL, 'info');

  // Verify none of the raw secrets appear anywhere in sanitized output
  const rawValues = [
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'OPENAI-REDACTED-PLACEHOLDER',
    'GITHUB-REDACTED-PLACEHOLDER',
    'SuperSecretMasterPassword123!',
    'eyJREDACTEDPLACEHOLDERVALUE000000',
  ];

  for (const raw of rawValues) {
    for (const [k, v] of Object.entries(sanitized)) {
      assert.ok(!v.includes(raw), `Leak detected: key ${k} contains unredacted secret`);
    }
  }
});

test('Prober Sanitization 2: Database connection strings masking credentials to ***', () => {
  const testUris = [
    {
      input: 'postgres://user:pass@host/db',
      expected: 'postgres://***:***@host/db',
    },
    {
      input: 'postgres://admin_user:P%40ssw0rd!@db.internal.aws.com:5432/analytics_prod?sslmode=require',
      expected: 'postgres://***:***@db.internal.aws.com:5432/analytics_prod?sslmode=require',
    },
    {
      input: 'mongodb://admin:pass@host',
      expected: 'mongodb://***:***@host',
    },
    {
      input: 'mongodb://cluster-admin:supersecret@mongo1.example.com:27017,mongo2.example.com:27017/test?replicaSet=rs0',
      expected: 'mongodb://***:***@mongo1.example.com:27017,mongo2.example.com:27017/test?replicaSet=rs0',
    },
    {
      input: 'mysql://root:toor1234@127.0.0.1:3306/production_db',
      expected: 'mysql://***:***@127.0.0.1:3306/production_db',
    },
    {
      input: 'redis://:mypassword@cache.internal:6379/0',
      expected: 'redis://***:***@cache.internal:6379/0',
    },
    {
      input: 'amqp://guest:guest@rabbitmq.local:5672/vhost',
      expected: 'amqp://***:***@rabbitmq.local:5672/vhost',
    },
  ];

  for (const { input, expected } of testUris) {
    const masked = maskUriCredentials(input);
    assert.equal(masked, expected, `URI credential masking failed for ${input}`);
    assert.ok(!masked.includes('pass'), `Password leaked in ${masked}`);
    assert.ok(!masked.includes('supersecret'), `Password leaked in ${masked}`);
  }

  // Also test sanitizeEnv with DATABASE_URL
  const envWithUris = {
    DATABASE_URL: 'postgres://readwrite_user:MySecurePass456@db-instance.rds.amazonaws.com:5432/app_db',
    MONGO_CONNECTION: 'mongodb://svc_account:SecretPass!99@mongodb-cluster:27017/metrics',
    HTTP_ENDPOINT: 'https://api.github.com/repos/owner/repo', // No credentials, should remain unchanged
  };

  const sanitized = sanitizeEnv(envWithUris);
  assert.equal(
    sanitized.DATABASE_URL,
    'postgres://***:***@db-instance.rds.amazonaws.com:5432/app_db'
  );
  assert.equal(
    sanitized.MONGO_CONNECTION,
    'mongodb://***:***@mongodb-cluster:27017/metrics'
  );
  assert.equal(sanitized.HTTP_ENDPOINT, 'https://api.github.com/repos/owner/repo');
});

test('Prober Sanitization 3: Full probe() snapshot sanitization and fingerprint determinism', async () => {
  // Temporarily inject sensitive vars into process.env
  const originalEnv = { ...process.env };
  process.env.AWS_SECRET_ACCESS_KEY = 'AWS-REDACTED-PLACEHOLDER';
  process.env.OPENAI_API_KEY = 'OPENAI-REDACTED-PLACEHOLDER';
  process.env.DATABASE_URL = 'postgres://app:secret123@localhost:5432/testdb';

  try {
    const probeResult1 = await probe();
    const probeResult2 = await probe();

    // Verify probe result env
    assert.equal(probeResult1.env.AWS_SECRET_ACCESS_KEY, REDACTED_STRING);
    assert.equal(probeResult1.env.OPENAI_API_KEY, REDACTED_STRING);
    assert.equal(probeResult1.env.DATABASE_URL, 'postgres://***:***@localhost:5432/testdb');

    // Issue #36: the redundant sanitizedEnv duplicate is gone — env is the single snapshot
    assert.ok(!('sanitizedEnv' in probeResult1), 'probe must not carry a sanitizedEnv duplicate');

    // Verify fingerprint computation is deterministic
    const fp1 = computeFingerprint(probeResult1);
    const fp2 = computeFingerprint(probeResult2);
    assert.equal(fp1, fp2, 'Fingerprint must be identical and deterministic for identical environment');
    assert.match(fp1, /^[0-9a-f]{64}$/, 'Fingerprint must be valid 64-char hex SHA-256');
  } finally {
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DATABASE_URL;
  }
});
