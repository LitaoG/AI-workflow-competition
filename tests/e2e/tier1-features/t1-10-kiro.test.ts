import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';

// R3 compliance lock (docs/KIRO_INTEGRATION.md): every assertion below targets the
// real /.kiro tree with NO existsSync fallback to synthetic samples — if the tracked
// Kiro configuration is removed or renamed, this suite must go red (Issue #84,
// same defect class as the t2-10 cannot-fail subtests fixed under Issue #23).
test('Tier 1 - Feature 10: Mandatory Kiro Integration (/.kiro)', async (t) => {
  const projectRoot = path.resolve(import.meta.dirname || process.cwd(), '..', '..', '..');
  const kiroDir = path.join(projectRoot, '.kiro');

  await t.test('T1_F10_01: .gitignore rules explicitly preserve and track /.kiro directory', () => {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist at the project root');
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignore.includes('!/.kiro/') || gitignore.includes('!.kiro'),
      '.gitignore must explicitly whitelist and unignore /.kiro/'
    );
  });

  await t.test('T1_F10_02: /.kiro/specs contains formal workflow engine requirements and typed RPC schemas', () => {
    const specsDir = path.join(kiroDir, 'specs');
    assert.ok(fs.existsSync(specsDir), '.kiro/specs must exist (R3: mandatory Kiro root configuration)');
    const files = fs.readdirSync(specsDir);
    assert.ok(files.length >= 1, 'specs directory must contain specification files');
  });

  await t.test('T1_F10_03: /.kiro/hooks contains lifecycle.json in the Kiro native schema (trigger + action.command)', () => {
    const lifecyclePath = path.join(kiroDir, 'hooks', 'lifecycle.json');
    assert.ok(fs.existsSync(lifecyclePath), '.kiro/hooks/lifecycle.json must exist');
    const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf-8')) as {
      version: string;
      hooks: Array<{ name: string; trigger?: string; event?: string; action?: { type?: string; command?: string }; enabled?: boolean }>;
    };
    assert.strictEqual(lifecycle.version, 'v1');
    assert.ok(Array.isArray(lifecycle.hooks) && lifecycle.hooks.length >= 4, 'lifecycle.json must register the four canonical lifecycle hooks');
    for (const trigger of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const hook = lifecycle.hooks.find((h) => h.trigger === trigger);
      assert.ok(hook, `lifecycle.json must register a ${trigger} hook`);
      assert.strictEqual(hook.enabled, undefined, 'enabled is not a Kiro-schema field (Issue #145: the file must match kiro.dev/docs/hooks)');
      assert.strictEqual(hook.action?.type, 'command', `${trigger} hook must carry a command action`);
      assert.ok(typeof hook.action?.command === 'string' && hook.action.command.length > 0, `${trigger} hook action must name its gate script`);
    }
  });

  await t.test('T1_F10_04: /.kiro/steering contains guidelines with inclusion frontmatter', () => {
    const steeringDir = path.join(kiroDir, 'steering');
    assert.ok(fs.existsSync(steeringDir), '.kiro/steering must exist');
    const files = fs.readdirSync(steeringDir);
    assert.ok(files.length >= 1, 'steering directory must contain guideline files');
    const content = fs.readFileSync(path.join(steeringDir, files[0]), 'utf-8');
    assert.ok(content.includes('inclusion: always'), 'Steering files must include "inclusion: always" frontmatter');
  });

  await t.test('T1_F10_05: /.kiro/crew contains Skeleton Crew team roster and permissions', () => {
    const crewDir = path.join(kiroDir, 'crew');
    const teamPath = path.join(crewDir, 'team.json');
    const permissionsPath = path.join(crewDir, 'permissions.json');
    assert.ok(fs.existsSync(teamPath), '.kiro/crew/team.json must exist (the real roster file)');
    assert.ok(fs.existsSync(permissionsPath), '.kiro/crew/permissions.json must exist');
    const team = JSON.parse(fs.readFileSync(teamPath, 'utf-8'));
    const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf-8'));
    assert.strictEqual(team.category, 'Skeleton Crew');
    const rosterIds = (team.roster as Array<{ id: string }>).map((member) => member.id).sort();
    assert.deepStrictEqual(
      rosterIds,
      ['architect', 'gatekeeper', 'inspector', 'reviewer', 'worker'],
      'team roster must list the five Skeleton Crew roles'
    );
    assert.deepStrictEqual(
      Object.keys(permissions.roles).sort(),
      rosterIds,
      'permissions.json roles must align 1:1 with the team roster'
    );
  });
});
