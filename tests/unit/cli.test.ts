import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSlashArgs } from '../../src/cli/slash-parser.js';
import { runCLI } from '../../src/cli/index.js';

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

test('CLI Run: executes workflow with --mock flag and exits with code 0', async () => {
  const tmpWfPath = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'mock-run-workflow.ts');
  fs.mkdirSync(path.dirname(tmpWfPath), { recursive: true });
  fs.writeFileSync(
    tmpWfPath,
    `
import { Workflow, actionStep } from '../../../dist/src/index.js';

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

  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', tmpWfPath, '--mock']);
  assert.equal(exitCode, 0);
});

test('CLI Run: non-existent workflow file exits with code 2', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts']);
  assert.equal(exitCode, 2);
});

test('CLI Run: --watch alias parses like --watch-graph (D.md 支柱一; an unregistered option would not reach the file-not-found exit 2)', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'run', './non-existent-file-404.ts', '--watch']);
  assert.equal(exitCode, 2);
});

test('CLI Graph: exports standalone HTML to specified path', async () => {
  const tmpWfPath = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'mock-run-workflow.ts');
  const tmpOutHtml = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'exported-dag.html');

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

test('CLI List: displays table of runs from SQLite database', async () => {
  const exitCode = await runCLI(['node', 'bin/workflow.js', 'list']);
  assert.equal(exitCode, 0);
});

test('CLI Init: scaffolds basic starter template into target directory', async () => {
  const targetDir = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'test-scaffold-basic');
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

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
