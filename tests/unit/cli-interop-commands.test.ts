import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeSetup } from '../../src/cli/commands/setup-interop.js';
import { executeExportSchema } from '../../src/cli/commands/export-schema.js';
import { executeNew, NEW_TEMPLATES } from '../../src/cli/commands/new.js';
import { executeDemo } from '../../src/cli/commands/demo.js';
import { executeInspect } from '../../src/cli/commands/inspect.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';

const FACADE_SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('setup --target all lands the full adapter matrix with parseable JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-all-'));
  try {
    const exit = await executeSetup({ target: 'all', dir });
    assert.equal(exit, 0);

    const expected = [
      path.join('.mcp.json'),
      path.join('.claude', 'skills', 'ai-workflow', 'SKILL.md'),
      path.join('.claude', 'settings.json'),
      path.join('.opencode', 'agent', 'workflow-runner.md'),
      path.join('.opencode', 'command', 'workflow.md'),
      path.join('.opencode', 'opencode.json'),
      path.join('.codex', 'instructions.md'),
      path.join('.codex', 'tools.json'),
      path.join('.zcode', 'config.json'),
    ];
    for (const rel of expected) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `setup must write ${rel}`);
    }

    // review HIGH: .codex/tools.json must be PURE JSON (a `//` comment prefix
    // made every OpenAI function-calling consumer fail JSON.parse).
    const tools = JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'tools.json'), 'utf8'));
    assert.ok(Array.isArray(tools) && tools.length === 10, 'tools.json must carry the 10 real workflow_* tools');
    for (const t of tools) {
      assert.equal(t.type, 'function');
      assert.ok(String(t.function?.name).startsWith('workflow_'));
    }

    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(Array.isArray(settings.permissions?.allow), 'settings.json must be valid JSON with permissions');

    const zcode = JSON.parse(fs.readFileSync(path.join(dir, '.zcode', 'config.json'), 'utf8'));
    assert.equal(zcode.workflow?.cli, 'node bin/workflow.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export-schema --format openai is byte-identical to what setup writes for .codex/tools.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-schema-'));
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '));
    const exit = await executeExportSchema({ format: 'openai' });
    assert.equal(exit, 0);
    const fromStdout = JSON.parse(logs.join('\n'));
    assert.equal(fromStdout.length, 10);

    const outFile = path.join(dir, 'tools.json');
    const outExit = await executeExportSchema({ format: 'openai', out: outFile });
    assert.equal(outExit, 0);

    // review HIGH: regeneration must reproduce the same bytes — the committed
    // tools.json previously carried a comment prefix the exporter never writes.
    const setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-parity-'));
    try {
      await executeSetup({ target: 'codex', dir: setupDir });
      assert.equal(
        fs.readFileSync(outFile, 'utf8'),
        fs.readFileSync(path.join(setupDir, '.codex', 'tools.json'), 'utf8'),
        'export-schema and setup must emit identical tools.json bytes',
      );
    } finally {
      fs.rmSync(setupDir, { recursive: true, force: true });
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export-schema rejects unsupported formats', async () => {
  assert.equal(await executeExportSchema({ format: 'yaml' }), 1);
});

test('new <name> scaffolds a compile-oriented facade file for each registered template', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-scaffold-'));
  try {
    for (const template of Object.keys(NEW_TEMPLATES)) {
      const name = `flow-${template}`;
      const exit = await executeNew(name, { template, dir });
      assert.equal(exit, 0, `template ${template} must scaffold`);
      const file = path.join(dir, `${name}.facade.ts`);
      assert.ok(fs.existsSync(file), `${template} scaffold file must exist`);
      const body = fs.readFileSync(file, 'utf8');
      assert.ok(body.includes(name), 'scaffold must embed the workflow name');
      assert.ok(!body.includes('<NAME>'), 'scaffold must not leak the template placeholder');
    }
    // Name guards.
    assert.equal(await executeNew(undefined, { dir }), 1);
    assert.equal(await executeNew('bad name!', { dir }), 1);
    // Existing file guard.
    assert.equal(await executeNew('flow-code-review', { template: 'code-review', dir }), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('demo runs the flagship facade offline and exports the Studio HTML without opening a browser', { timeout: 60000 }, async () => {
  const exit = await executeDemo({ noOpen: true });
  assert.equal(exit, 0);
  const htmlPath = path.join(process.cwd(), '.workflow', 'views', 'demo.html');
  assert.ok(fs.existsSync(htmlPath), 'demo must export a Studio HTML artifact');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(html.includes('AI-Workflow Studio'));
  assert.ok(!html.includes('__STUDIO_SNAPSHOT__'), 'snapshot placeholder must be replaced');
});

test('inspect resolves facade runs through the default journal probe (no --db needed)', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-probe-'));
  const originalCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    const scriptPath = path.join(dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, FACADE_SCRIPT);
    // runFacadeScript journals to <cwd>/.workflow/dwf.sqlite (its default) and
    // never creates checkpoints.db — the exact surface QUICKSTART advertises.
    const run = await runFacadeScript({ scriptPath, cwd: dir });

    // A pre-existing builder runs.db must NOT shadow the facade journal: the
    // probe resolves by content (which store actually knows the runId).
    fs.mkdirSync(path.join(dir, '.workflow'), { recursive: true });
    new SQLiteStateStore(path.join(dir, '.workflow', 'runs.db')).close();

    process.chdir(dir);
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '));
    const exit = await executeInspect(run.runId);
    assert.equal(exit, 0, `inspect must find the facade run via the default probe (logs: ${logs.join('\n')})`);
    assert.ok(logs.join('\n').includes(run.runId), 'inspect must render the facade run');

    // Unknown run in a workspace with journals → clean not-found exit 1.
    const missing = await executeInspect('dwfrun-does-not-exist');
    assert.equal(missing, 1);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup merges shared configs instead of overwriting them (Issue #114)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-merge-'));
  try {
    // A user with their own MCP server, deny rules and hooks.
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'my-own-server': { type: 'stdio', command: 'my-server', args: [] } } }, null, 2)
    );
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(my-own-tool:*)'], deny: ['Bash(rm -rf:*)'] }, hooks: { PostToolUse: [] } }, null, 2)
    );

    const exit = await executeSetup({ target: 'claude', dir });
    assert.equal(exit, 0);

    const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['my-own-server'], "the user's own MCP server must survive");
    assert.equal(mcp.mcpServers['ai-workflow'].command, 'workflow', 'a foreign project gets the global bin (no bin/workflow.js there)');

    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.deny, ['Bash(rm -rf:*)'], 'deny rules must survive');
    assert.deepEqual(settings.hooks, { PostToolUse: [] }, 'hooks must survive');
    for (const entry of ['Bash(my-own-tool:*)', 'Bash(workflow:*)']) {
      assert.ok(settings.permissions.allow.includes(entry), `allow must contain ${entry}`);
    }
    // Issue #127: the blanket `mcp__ai-workflow` allow is GONE — only the
    // read-only tools are pre-approved, the execute tools keep their prompts.
    assert.ok(!settings.permissions.allow.includes('mcp__ai-workflow'), 'no blanket MCP allow');
    for (const tool of ['workflow_script_check', 'workflow_inspect_run', 'workflow_get_run', 'workflow_graph', 'workflow_probe', 'workflow_inspect']) {
      assert.ok(settings.permissions.allow.includes(`mcp__ai-workflow__${tool}`), `read-only tool pre-approved: ${tool}`);
    }
    for (const tool of ['workflow_script_run', 'workflow_run_script', 'workflow_replay']) {
      assert.ok(!settings.permissions.allow.includes(`mcp__ai-workflow__${tool}`), `execute tool NOT pre-approved: ${tool}`);
    }
    assert.ok(!settings.permissions.allow.includes('Bash(node bin/workflow.js:*)'), 'a foreign project must not allow-list a bin path that does not exist there');

    // Idempotent: a second run must not duplicate allow entries.
    await executeSetup({ target: 'claude', dir });
    const settings2 = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings2.permissions.allow.length, settings.permissions.allow.length, 're-running setup must not duplicate allow entries');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup keeps repo-relative invocation inside the engine repo and aborts on unparseable configs (Issue #114)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-repo-'));
  try {
    // Engine-repo shape: bin/workflow.js exists -> local invocation + the
    // repo-relative allow entry come back.
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'workflow.js'), '// engine entry');
    const exit = await executeSetup({ target: 'claude', dir });
    assert.equal(exit, 0);
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['ai-workflow'].command, 'node');
    assert.match(mcp.mcpServers['ai-workflow'].args[0], /bin\/workflow\.js$/);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('Bash(node bin/workflow.js:*)'));

    // A shared config that exists but is unparseable must abort WITHOUT a
    // partial write — the user's broken-but-theirs file stays byte-identical.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-broken-'));
    try {
      const broken = '{ not json !!!';
      fs.mkdirSync(path.join(dir2, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir2, '.mcp.json'), broken);
      const exit2 = await executeSetup({ target: 'claude', dir: dir2 });
      assert.equal(exit2, 1, 'setup must fail loudly on a config it cannot read');
      assert.equal(fs.readFileSync(path.join(dir2, '.mcp.json'), 'utf8'), broken, "the user's file must stay untouched");
      assert.ok(!fs.existsSync(path.join(dir2, '.claude', 'settings.json')), 'no partial write past the failure');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
