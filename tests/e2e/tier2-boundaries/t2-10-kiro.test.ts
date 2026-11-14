import test from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';

// Tier 2 boundary, Feature 10 (hook/gate integration): the CONTRACT a hook or
// gate command must satisfy is EXIT-CODE based — exit 0 allows the call, exit 2
// blocks it with the reason on stderr. The previous revision of this file only
// asserted `fs.existsSync(hookPath)` (plus three literal-echo tests and one
// hardcoded-constant check) — none of the five subtests could ever fail, and
// none imported the product. src/ contains no Kiro-specific surface (grep: 0
// files), so the only honest real-behavior test here is the hook contract
// itself, executed for real. The 2026-11-14 self-review (finding
// tests/e2e/tier2-boundaries/t2-10-kiro.test.ts:14-66, confirmed) records the
// history; the four cannot-fail subtests were removed rather than kept
// inflating the tier pass counts.
test('Tier 2 - Boundary: hook script exit codes gate tool calls (executed, not asserted on disk)', async (t) => {
  const tempDir = createTempDir('t2-f10-kiro-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  // No shebang: the hook is executed via `process.execPath hookPath` (node
  // resolves it directly); a shebang not at byte 0 of the file is a SyntaxError.
  const hookScript = `const tool = process.argv[2];
if (tool === 'dangerous_tool') {
  process.stderr.write('Blocked: destructive operation prohibited by policy');
  process.exit(2);
}
process.exit(0);
`;
  const hookPath = writeTempFile(tempDir, 'hooks/pre-tool.js', hookScript);

  await t.test('T2_F10_01: exit 0 allows the tool call', () => {
    const allowed = spawnSync(process.execPath, [hookPath, 'safe_tool'], { encoding: 'utf8' });
    assert.strictEqual(allowed.status, 0, 'a safe tool call must pass the hook');
    assert.strictEqual(allowed.stderr, '', 'an allowed call must not emit a block reason');
  });

  await t.test('T2_F10_02: exit 2 blocks with the policy message on stderr', () => {
    const blocked = spawnSync(process.execPath, [hookPath, 'dangerous_tool'], { encoding: 'utf8' });
    assert.strictEqual(blocked.status, 2, 'exit code 2 is the blocking contract');
    assert.ok(
      blocked.stderr.includes('Blocked: destructive operation'),
      'the block reason must reach stderr so the host can surface it',
    );
  });
});
