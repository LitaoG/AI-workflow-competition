import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCLI } from '../../src/cli/index.js';

test('CLI Run: official example under apps/ auto-authorizes commands in --mock mode (Issue #260)', async () => {
  // Test running facade workflow under apps/ with --mock without explicit --approve-cmd
  const exitCode = await runCLI([
    'node',
    'bin/workflow.js',
    'run',
    'apps/incident-triage-remediation/facade.workflow.ts',
    '--mock',
    '--cwd',
    'apps/incident-triage-remediation',
  ]);
  assert.equal(exitCode, 0, 'Official example with --mock should auto-authorize and exit 0');
});
