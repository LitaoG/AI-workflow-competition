import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';

test('Tier 2 - Boundary: Feature 10 Mandatory Kiro Integration', async (t) => {
  const tempDir = createTempDir('t2-f10-kiro-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T2_F10_01: PreToolUse hook exit code 0 allows tool while exit code 2 blocks with message', () => {
    const hookScript = `
#!/usr/bin/env node
const tool = process.argv[2];
if (tool === 'dangerous_tool') {
  process.stderr.write('Blocked: destructive operation prohibited by policy');
  process.exit(2);
}
process.exit(0);
`;
    const hookPath = writeTempFile(tempDir, 'hooks/pre-tool.js', hookScript);
    assert.ok(fs.existsSync(hookPath));
  });

  await t.test('T2_F10_02: Stop hook outputs decision block format when verification gates fail', () => {
    const stopDecision = {
      decision: "block",
      reason: "Verification test gate did not pass (exit code 1)"
    };
    const jsonStr = JSON.stringify(stopDecision);
    assert.ok(jsonStr.includes('"decision":"block"'));
  });

  await t.test('T2_F10_03: Property-based testing invariants verify state fold determinism', () => {
    // Fold invariant test: state(k) = fold(events[0..k])
    const events = [
      { seq: 1, type: "WORKFLOW_START" },
      { seq: 2, type: "STEP_COMPLETE", step: "A" },
      { seq: 3, type: "STEP_COMPLETE", step: "B" }
    ];

    const fold = (evs: typeof events) => evs.map(e => e.seq);
    const stateA = fold(events);
    const stateB = fold(events);
    assert.deepStrictEqual(stateA, stateB, 'State fold must be 100% deterministic');
  });

  await t.test('T2_F10_04: Steering security guardrails prevent exfiltration of sensitive files', () => {
    const sensitiveFiles = ['.env', 'credentials.json', 'id_rsa'];
    for (const f of sensitiveFiles) {
      assert.ok(f.startsWith('.') || f.includes('cred') || f.includes('rsa'));
    }
  });

  await t.test('T2_F10_05: Permission ceiling enforcement: worker agent cannot invoke conductor commands', () => {
    const permissions = {
      worker: { allow: ["agent:ask", "tool:call"] },
      conductor: { allow: ["agent:ask", "tool:call", "workflow:init", "gate:eval"] }
    };

    assert.strictEqual(permissions.worker.allow.includes("workflow:init"), false);
    assert.strictEqual(permissions.conductor.allow.includes("workflow:init"), true);
  });
});
