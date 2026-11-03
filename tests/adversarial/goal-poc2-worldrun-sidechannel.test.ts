// PoC2 regression: the world.run side channel must not leak host credentials.
// Two defense layers are asserted:
//   1. NAME whitelist — the grandchild spawned by FacadeEngine.spawnCaptured
//      (src/dwf/engine.ts) gets envAllowlist [GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
//      GIT_DIR, GIT_WORK_TREE, NODE_ENV] on top of the platform base, and the
//      sandbox child itself gets buildSandboxEnv() (src/dwf/runner.ts). A decoy
//      key exported in the CLI's parent shell must be absent from the
//      grandchild's env key dump.
//   2. VALUE redaction at the source — engine.ts passes world.run stdout/stderr
//      through redactText (src/dwf/redact.ts) before the script, the journal or
//      the CLI ever see them.
// Unit-level assertions pin the same two layers against dist builds.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSandboxEnv } from '../../dist/src/dwf/runner.js';
import { redactText } from '../../dist/src/dwf/redact.js';
import { REDACTED_STRING, sanitizeEnv } from '../../dist/src/prober/sanitizer.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = path.join(repoRoot, 'tests', 'adversarial', 'fixtures', 'goal-cred-snoop-2-worldrun.ts');
const DECOY = 'sk-decoy-123';

describe('PoC2: world.run env side channel', () => {
  test('decoy env var does not cross the sandbox boundary and any TOKEN= value in world.run output is redacted', () => {
    const dbPath = path.join(os.tmpdir(), `goal-poc2-${process.pid}-${Date.now()}.sqlite`);
    try {
      const res = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'bin', 'workflow.js'), 'run-script', fixture, '--db', dbPath],
        {
          cwd: repoRoot,
          env: { ...process.env, GOAL_POC_TOKEN: DECOY },
          encoding: 'utf8',
          timeout: 50_000,
        },
      );

      const stdout = res.stdout ?? '';
      const stderr = res.stderr ?? '';
      const out = `${stdout}\n${stderr}`;
      assert.equal(res.status, 0, `run-script failed:\n${out}`);

      // Defense layer 2 — redaction at the source: the grandchild prints
      // `TOKEN=<value>`; whatever the value is, the KV rule must mask it.
      assert.match(out, /TOKEN=\*\*\*REDACTED\*\*\*/, 'expected TOKEN=***REDACTED*** in world.run output');

      // Leak surface: the decoy value must not appear anywhere in CLI output.
      assert.ok(!out.includes(DECOY), `decoy value leaked into CLI output:\n${out}`);

      // Defense layer 1 — name whitelist: extract the grandchild's env key dump
      // (ENV_KEYS=<JSON array>) and assert the decoy key is absent. Note: the
      // redactor eats the JSON's opening bracket (`ENV_KEYS=[` matches the
      // ENV_KEYS KV rule), so tolerate a leading ***REDACTED*** sentinel.
      const resultLine = stdout.split('\n').find((l) => l.trim().startsWith('result:'));
      assert.ok(resultLine, `expected a result line in stdout:\n${stdout}`);
      const result = JSON.parse(resultLine!.replace(/^\s*result:\s*/, '')) as { stdout: string };
      const keysLine = result.stdout.split('\n').find((l) => l.startsWith('ENV_KEYS='));
      assert.ok(keysLine, `expected ENV_KEYS line in world.run stdout:\n${result.stdout}`);
      let payload = keysLine!.slice('ENV_KEYS='.length).trimEnd().replace(/^\*\*\*REDACTED\*\*\*/, '');
      if (!payload.startsWith('[')) payload = `[${payload}`;
      const envKeys: string[] = JSON.parse(payload);
      assert.ok(
        !envKeys.includes('GOAL_POC_TOKEN'),
        `decoy key crossed the sandbox boundary; grandchild env keys: ${JSON.stringify(envKeys)}`,
      );
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test('unit: buildSandboxEnv drops the decoy by name and sanitizeEnv/redactText mask it by key', () => {
    const previous = process.env.GOAL_POC_TOKEN;
    process.env.GOAL_POC_TOKEN = DECOY;
    try {
      // Layer 1 — whitelist: the key never survives buildSandboxEnv by NAME.
      const sandboxEnv = buildSandboxEnv();
      assert.ok(!('GOAL_POC_TOKEN' in sandboxEnv), 'buildSandboxEnv must not pass the decoy key through');

      // Layer 2 — value masking for whatever survives a whitelist: the prober
      // masks sensitive-KEYed values, and redactText masks the KV shape in free text.
      assert.equal(sanitizeEnv({ GOAL_POC_TOKEN: DECOY }).GOAL_POC_TOKEN, REDACTED_STRING);
      assert.equal(redactText(`GOAL_POC_TOKEN=${DECOY}`), `GOAL_POC_TOKEN=${REDACTED_STRING}`);
      // The observed grandchild output (`TOKEN=undefined`) is masked by the same rule.
      assert.equal(redactText('TOKEN=undefined'), `TOKEN=${REDACTED_STRING}`);
    } finally {
      if (previous === undefined) delete process.env.GOAL_POC_TOKEN;
      else process.env.GOAL_POC_TOKEN = previous;
    }
  });
});
