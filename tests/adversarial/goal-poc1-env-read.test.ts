// PoC1 regression: a facade script must NOT be able to read host credentials out
// of process.env — the compile-time purity gate bans the `process` identifier
// outright (src/dwf/compile.ts BANNED_IDENTIFIERS, diagnostic 9002).
//
// Attack vector: GOAL_POC_TOKEN=sk-decoy-123 is exported in the CLI's parent
// shell; the fixture tests/adversarial/fixtures/goal-cred-snoop-1-env-read.ts
// tries `process.env.GOAL_POC_TOKEN` and would smuggle the value into the run
// result if compilation let it through.
//
// Run style follows .kiro/pbt/engine-invariants.test.ts: plain `node --test`
// over TypeScript (type-stripped), no framework.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = path.join(repoRoot, 'tests', 'adversarial', 'fixtures', 'goal-cred-snoop-1-env-read.ts');
const DECOY = 'sk-decoy-123';

describe('PoC1: static interception of process.env credential reads', () => {
  test('run-script rejects the env-read script with purity-ban 9002 and the decoy value never reaches any output', () => {
    const dbPath = path.join(os.tmpdir(), `goal-poc1-${process.pid}-${Date.now()}.sqlite`);
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

      const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

      // Defense line: compile-time purity ban — the script never reaches the sandbox.
      assert.notEqual(res.status, 0, `expected compile rejection, got success output:\n${out}`);
      assert.match(out, /purity-ban\(9002\)/, 'expected the 9002 purity-ban diagnostic');
      assert.match(out, /"process" is banned/, 'expected the ban message naming `process`');

      // Leak surface: the decoy credential must not appear anywhere in CLI output.
      assert.ok(!out.includes(DECOY), `decoy value leaked into CLI output:\n${out}`);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});
