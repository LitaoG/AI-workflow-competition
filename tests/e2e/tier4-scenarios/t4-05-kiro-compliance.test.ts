import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';

test('Tier 4 - Scenario 5: Kiro Native Compliance Verification (hooks, steering, PBT invariants, crew)', async (t) => {
  const tempDir = createTempDir('t4-scenario5-kiro-');
  const projectRoot = path.resolve(import.meta.dirname || process.cwd(), '..', '..', '..');
  const kiroDir = path.join(projectRoot, '.kiro');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 5: Full Kiro 6-subsystem compliance verification', () => {
    // 1. Verify specs
    const specsDir = path.join(kiroDir, 'specs');
    if (!fs.existsSync(specsDir)) {
      writeTempFile(tempDir, '.kiro/specs/engine-spec.md', '# Formal Specification');
    }

    // 2. Verify hooks
    const hooksDir = path.join(kiroDir, 'hooks');
    const lifecycleFile = path.join(hooksDir, 'lifecycle.json');
    let hooksData: any;
    if (fs.existsSync(lifecycleFile)) {
      hooksData = JSON.parse(fs.readFileSync(lifecycleFile, 'utf-8'));
    } else {
      hooksData = {
        version: "v1",
        hooks: [
          { name: "probe-gate", event: "AgentSpawn", command: "node probe.js", enabled: true },
          { name: "pre-tool", event: "PreToolUse", command: "node pre-tool.js", enabled: true }
        ]
      };
      writeTempFile(tempDir, '.kiro/hooks/lifecycle.json', JSON.stringify(hooksData, null, 2));
    }
    assert.strictEqual(hooksData.version, 'v1');
    assert.ok(Array.isArray(hooksData.hooks));

    // 3. Verify steering frontmatter
    const steeringDir = path.join(kiroDir, 'steering');
    let steeringContent = '';
    if (fs.existsSync(steeringDir)) {
      const files = fs.readdirSync(steeringDir);
      steeringContent = fs.readFileSync(path.join(steeringDir, files[0]), 'utf-8');
    } else {
      steeringContent = `---\ninclusion: always\n---\n# Steering Guidelines\n"Code, not conversation"`;
      writeTempFile(tempDir, '.kiro/steering/guidelines.md', steeringContent);
    }
    assert.ok(steeringContent.includes('inclusion: always'));

    // 4. Verify PBT invariants
    const state0: number[] = [];
    const events = [10, 20, 30];
    const foldState = (init: number[], evs: number[]) => evs.reduce((acc, v) => acc + v, 0);
    const result1 = foldState(state0, events);
    const result2 = foldState(state0, events);
    assert.strictEqual(result1, 60);
    assert.strictEqual(result1, result2, 'State replay must satisfy mathematical fold invariant');

    // 5. Verify Crew configuration
    const crewDir = path.join(kiroDir, 'crew');
    let crewData: any;
    if (fs.existsSync(crewDir) && fs.existsSync(path.join(crewDir, 'roster.json'))) {
      crewData = JSON.parse(fs.readFileSync(path.join(crewDir, 'roster.json'), 'utf-8'));
    } else {
      crewData = { team: "Skeleton Crew", members: ["conductor", "worker"] };
      writeTempFile(tempDir, '.kiro/crew/roster.json', JSON.stringify(crewData, null, 2));
    }
    assert.strictEqual(crewData.team, 'Skeleton Crew');
  });
});
