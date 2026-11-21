import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSlashArgs } from '../../src/cli/slash-parser.js';
import { runCLI } from '../../src/cli/index.js';

/**
 * Write the shared mock workflow into a caller-owned temp dir. The workflow
 * imports the engine through an absolute file URL so the file stays valid no
 * matter which temp directory it lands in (a fixed relative specifier would
 * resolve against the file's own location). Nothing is written into the
 * controlled tests/unit/fixtures/ (Issue #54, root cause of P-TEST-2).
 */
function writeMockWorkflow(dir: string): string {
  const distIndexUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'src', 'index.js')).href;
  const tmpWfPath = path.join(dir, 'mock-run-workflow.ts');
  fs.writeFileSync(
    tmpWfPath,
    `
import { Workflow, actionStep } from '${distIndexUrl}';

const wf = new Workflow({ name: 'CLIRunTestWorkflow' });
wf.addPhase({ id: 'p1', name: 'Phase 1' });
wf.addStep(
  actionStep({
    id: 'step-ok',
    name: 'Step OK',
    phaseId: 'p1',
    action: async () => ({ success: true }),
  })
);
export default wf;
`
  );
  return tmpWfPath;
}

test('CLI Normalizer: strips slash prefix from /workflow command', () => {
  const input = ['node', 'bin/workflow.js', '/workflow', 'run', 'test.ts'];
  const normalized = normalizeSlashArgs(input);
  assert.deepEqual(normalized, ['node', 'bin/workflow.js', 'run', 'test.ts']);

  const slashColon = ['node', 'bin/workflow.js', '/workflow:run', 'test.ts'];
  assert.deepEqual(normalizeSlashArgs(slashColon), ['node', 'bin/workflow.js', 'run', 'test.ts']);

  const slashChained = ['node', 'bin/workflow.js', '/workflow', '/run', 'test.ts'];
  assert.deepEqual(normalizeSlashArgs(slashChained), ['node', 'bin/workflow.js', 'run', 'test.ts']);

  const slashCommand = ['node', 'bin/workflow.js', '/probe'];
  assert.deepEqual(normalizeSlashArgs(slashCommand), ['node', 'bin/workflow.js', 'probe']);
});

test('CLI Run: executes workflow with --mock flag and exits with code 0', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const tmpWfPath = writeMockWorkflow(tmpDir);

  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', tmpWfPath, '--mock']);
  assert.equal(exitCode, 0);
});

test('CLI Run: non-existent workflow file exits with code 2', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts']);
  assert.equal(exitCode, 2);
});

test('CLI Run: --watch alias parses like --watch-graph (an unregistered option would not reach the file-not-found exit 2)', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts', '--watch']);
  assert.equal(exitCode, 2);
});

test('CLI Run: --no-watch-graph parses (Issue #168: explicit opt-out of the default-on watch view must be a registered option)', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts', '--no-watch-graph']);
  assert.equal(exitCode, 2);
});

test('CLI Run: --approve-cmd parses on run (Issue #226)', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts', '--approve-cmd', 'node']);
  assert.equal(exitCode, 2);
});

test('CLI Graph: exports standalone HTML to specified path', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-graph-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const tmpWfPath = writeMockWorkflow(tmpDir);
  const tmpOutHtml = path.join(tmpDir, 'exported-dag.html');

  const exitCode = await runCLI([
    'node',
    'bin/workflow.js',
    'graph',
    tmpWfPath,
    '--format',
    'html',
    '--output',
    tmpOutHtml,
  ]);

  assert.equal(exitCode, 0);
  assert.ok(fs.existsSync(tmpOutHtml));
  const content = fs.readFileSync(tmpOutHtml, 'utf-8');
  assert.ok(content.startsWith('<!DOCTYPE html>'));
  assert.ok(content.includes('<svg'));
});

test('CLI Probe: outputs valid JSON when --output json is specified', async () => {
  let captured = '';
  const originalLog = console.log;
  console.log = (msg: string) => {
    captured += msg;
  };

  try {
    const exitCode = await runCLI(['node', 'bin/workflow.js', 'probe', '--output', 'json']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(captured);
    assert.ok(parsed.system);
    assert.ok(parsed.git);
    assert.ok(parsed.toolchain);
    assert.ok(parsed.env);
  } finally {
    console.log = originalLog;
  }
});

test('CLI List: displays table of runs from SQLite database (Issue #230)', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'list']);
  assert.equal(exitCode, 0);
});

test('CLI Graph: facade script projects graph cleanly without SyntaxError (Issue #230)', async () => {
  const exitCode = await runCLI([
    'node',
    'bin/workflow.js',
    'graph',
    'apps/incident-triage-remediation/facade.workflow.ts',
  ]);
  assert.equal(exitCode, 0);
});

test('CLI Graph: fresh facade script without prior runs outputs guidance and exits 0 (Issue #230)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-graph-facade-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const scriptPath = path.join(tmpDir, 'new.facade.ts');
  fs.writeFileSync(
    scriptPath,
    `
    phase('Phase 1: Test', () => {
      world.run('echo hello');
    });
    return { ok: true };
  `
  );
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'graph', scriptPath]);
  assert.equal(exitCode, 0);
});

test('CLI Init: scaffolds basic starter template into target directory', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const targetDir = path.join(tmpDir, 'test-scaffold-basic');

  const exitCode = await runCLI(['node', 'bin/workflow.js', 'init', 'basic', '--dir', targetDir]);
  assert.equal(exitCode, 0);
  assert.ok(fs.existsSync(path.join(targetDir, 'workflow.ts')));
  assert.ok(fs.existsSync(path.join(targetDir, 'package.json')));
  assert.ok(fs.existsSync(path.join(targetDir, 'README.md')));
});

test('CLI i18n: --lang zh flag outputs Chinese localized messages', async () => {
  let capturedErr = '';
  const originalErr = console.error;
  console.error = (msg: string) => {
    capturedErr += msg;
  };

  try {
    const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './missing-file.ts', '--lang', 'zh']);
    assert.equal(exitCode, 2);
    assert.ok(capturedErr.includes('未找到工作流文件'));
  } finally {
    console.error = originalErr;
  }
});
