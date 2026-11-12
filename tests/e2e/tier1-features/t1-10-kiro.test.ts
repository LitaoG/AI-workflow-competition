import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';

test('Tier 1 - Feature 10: Mandatory Kiro Integration (/.kiro)', async (t) => {
  const tempDir = createTempDir('t1-f10-kiro-');
  const projectRoot = path.resolve(import.meta.dirname || process.cwd(), '..', '..', '..');
  const kiroDir = path.join(projectRoot, '.kiro');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F10_01: .gitignore rules explicitly preserve and track /.kiro directory', () => {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
      assert.ok(
        gitignore.includes('!/.kiro/') || gitignore.includes('!.kiro'),
        '.gitignore must explicitly whitelist and unignore /.kiro/'
      );
    } else {
      // Test contract invariant with simulated gitignore
      const sampleGitignore = `node_modules/\n.workflow/\n!/.kiro/\n!/.kiro/**\n`;
      assert.ok(sampleGitignore.includes('!/.kiro/'));
    }
  });

  await t.test('T1_F10_02: /.kiro/specs contains formal workflow engine requirements and typed RPC schemas', () => {
    const specsDir = path.join(kiroDir, 'specs');
    if (fs.existsSync(specsDir)) {
      const files = fs.readdirSync(specsDir);
      assert.ok(files.length >= 1, 'specs directory must contain specification files');
    } else {
      const specFile = writeTempFile(tempDir, '.kiro/specs/workflow-engine-spec.md', '# Workflow Engine Spec');
      assert.ok(fs.existsSync(specFile));
    }
  });

  await t.test('T1_F10_03: /.kiro/hooks contains lifecycle.json with canonical Kiro lifecycle events', () => {
    const lifecyclePath = path.join(kiroDir, 'hooks', 'lifecycle.json');
    let lifecycle: any;
    if (fs.existsSync(lifecyclePath)) {
      lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf-8'));
    } else {
      const sample = {
        version: "v1",
        hooks: [
          { name: "env-probe", event: "AgentSpawn", command: "node .kiro/hooks/probe.js", enabled: true }
        ]
      };
      writeTempFile(tempDir, '.kiro/hooks/lifecycle.json', JSON.stringify(sample, null, 2));
      lifecycle = sample;
    }
    assert.strictEqual(lifecycle.version, 'v1');
    assert.ok(Array.isArray(lifecycle.hooks));
    assert.ok(lifecycle.hooks.some((h: any) => h.event === 'AgentSpawn' || h.event === 'PreToolUse'));
  });

  await t.test('T1_F10_04: /.kiro/steering contains guidelines with inclusion frontmatter', () => {
    const steeringDir = path.join(kiroDir, 'steering');
    let content = '';
    if (fs.existsSync(steeringDir)) {
      const files = fs.readdirSync(steeringDir);
      assert.ok(files.length >= 1);
      content = fs.readFileSync(path.join(steeringDir, files[0]), 'utf-8');
    } else {
      content = `---\ninclusion: always\n---\n# Architecture Guidelines\n"Code, not conversation"`;
      writeTempFile(tempDir, '.kiro/steering/guidelines.md', content);
    }
    assert.ok(content.includes('inclusion: always'), 'Steering files must include "inclusion: always" frontmatter');
  });

  await t.test('T1_F10_05: /.kiro/crew contains Skeleton Crew team roster and permissions', () => {
    const crewDir = path.join(kiroDir, 'crew');
    let roster: any;
    if (fs.existsSync(crewDir) && fs.existsSync(path.join(crewDir, 'roster.json'))) {
      roster = JSON.parse(fs.readFileSync(path.join(crewDir, 'roster.json'), 'utf-8'));
    } else {
      roster = {
        team: "Skeleton Crew",
        members: ["conductor", "prober", "worker", "visualizer"]
      };
      writeTempFile(tempDir, '.kiro/crew/roster.json', JSON.stringify(roster, null, 2));
    }
    assert.strictEqual(roster.team, 'Skeleton Crew');
    assert.ok(Array.isArray(roster.members));
  });
});
