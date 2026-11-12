/**
 * (Issue #154): the ultracode fixpoint — synthesized
 * scripts land in the project saved-workflow registry with proper
 * frontmatter, discoverable by listSavedWorkflows with project scope; name
 * slugs are filesystem-safe and re-saves are idempotent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeUltracode } from '../../../src/cli/commands/ultracode.js';
import { listSavedWorkflows, parseSavedMeta, saveSavedWorkflow, slugifyWorkflowName } from '../../../src/dwf/saved.js';
import { providerRegistry } from '../../../src/agent/provider.js';
import type { LLMProvider, LLMResponse } from '../../../src/types.js';

const VALID_SCRIPT = [
  'phase("main");',
  'const answer = await agent("worker").ask("Summarize the repository layout");',
  'return { answer };',
  '',
].join('\n');

const respond = (content: string): LLMResponse => ({
  content,
  model: 'ultracode-mock',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
});

function withProvider(fn: () => Promise<void>): Promise<void> {
  const provider: LLMProvider = {
    id: 'ultracode-test-provider',
    name: 'Ultracode test provider',
    async generate() {
      return respond(JSON.stringify({ script: VALID_SCRIPT, notes: 'ok' }));
    },
  };
  providerRegistry.register(provider);
  const previous = providerRegistry.get().id;
  providerRegistry.setDefault(provider.id);
  return fn().finally(() => {
    providerRegistry.setDefault(previous);
  });
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultracode-ws-'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows handle races — best effort */
  }
}

test('slugifyWorkflowName: filesystem-safe slugs, throws on nothing-safe', () => {
  assert.equal(slugifyWorkflowName('My Flow!'), 'my-flow');
  assert.equal(slugifyWorkflowName('  incident  triage '), 'incident-triage');
  assert.throws(() => slugifyWorkflowName('///'), /no filesystem-safe characters/);
});

test('saveSavedWorkflow: lands in the project registry with readable frontmatter', () => {
  const cwd = tempWorkspace();
  try {
    const saved = saveSavedWorkflow(cwd, { name: 'My Flow', description: 'Triage the incident', whenToUse: 'healthz failing' }, VALID_SCRIPT);
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.match(saved.path.replace(/\\/g, '/'), /ultracode-ws-[^/]+\/\.workflow\/workflows\/my-flow\.facade\.ts$/);

    const source = fs.readFileSync(saved.path, 'utf8');
    const meta = parseSavedMeta(source);
    assert.equal(meta.name, 'My Flow');
    assert.equal(meta.description, 'Triage the incident');
    assert.equal(meta.whenToUse, 'healthz failing');
    assert.match(source, /phase\("main"\)/, 'the script body follows the frontmatter');

    const listed = listSavedWorkflows(cwd);
    const mine = listed.find((w) => w.name === 'My Flow');
    assert.ok(mine, 'the registry lists the saved workflow');
    assert.equal(mine!.scope, 'project');
    assert.equal(mine!.scriptPath, saved.path);
  } finally {
    cleanup(cwd);
  }
});

test('saveSavedWorkflow: same name re-save overwrites (idempotent fixpoint)', () => {
  const cwd = tempWorkspace();
  try {
    const first = saveSavedWorkflow(cwd, { name: 'flow', description: 'v1' }, VALID_SCRIPT);
    const second = saveSavedWorkflow(cwd, { name: 'flow', description: 'v2' }, VALID_SCRIPT);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.path, second.path, 'same slug → same file');
      const meta = parseSavedMeta(fs.readFileSync(second.path, 'utf8'));
      assert.equal(meta.description, 'v2', 'the newer description wins');
      const listed = listSavedWorkflows(cwd).filter((w) => w.name === 'flow');
      assert.equal(listed.length, 1, 'no duplicate registration');
    }
  } finally {
    cleanup(cwd);
  }
});

test('executeUltracode --save: synthesizes and fixpoints the registry, exit 0', async () => {
  const cwd = tempWorkspace();
  try {
    await withProvider(async () => {
      const exit = await executeUltracode('Triage the incident', { save: 'Incident Triage', cwd });
      assert.equal(exit, 0);
      const listed = listSavedWorkflows(cwd);
      const mine = listed.find((w) => w.name === 'Incident Triage');
      assert.ok(mine, 'the command saved the workflow into the registry');
      assert.match(mine!.scriptPath.replace(/\\/g, '/'), /incident-triage\.facade\.ts$/);
    });
  } finally {
    cleanup(cwd);
  }
});

test('executeUltracode --save --mock: fixpoint plus an offline trial run', async () => {
  const cwd = tempWorkspace();
  try {
    await withProvider(async () => {
      const exit = await executeUltracode('Triage the incident', { save: 'triage', mock: true, cwd });
      assert.equal(exit, 0, 'the mock trial run of the gate-clean script succeeds end to end');
      assert.ok(fs.existsSync(path.join(cwd, '.workflow', 'workflows', 'triage.facade.ts')));
      // the mock trial run journalled a real run under the workspace
      assert.ok(fs.existsSync(path.join(cwd, '.workflow', 'dwf.sqlite')), 'the trial run produced a journal');
    });
  } finally {
    cleanup(cwd);
  }
});
