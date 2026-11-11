import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

/** Provider that always throws a quota error — the policy-stop class. */
class QuotaProvider implements LLMProvider {
  readonly id = 'dwf-quota';
  readonly name = 'Quota provider';
  calls = 0;
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    throw new Error('HTTP 403: quota exceeded for this billing period');
  }
}

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-policy-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('G7: a quota error settles the run as stopped (provider), retry-free and resumable', async () => {
  const quota = new QuotaProvider();
  providerRegistry.register(quota);
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'quota.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Ask");
const out = await agent("doomed", { provider: "dwf-quota" }).ask<Answer>("inspect health report of the service");
return out;
interface Answer { healthStatus: string; }
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, approvedCommands: ['node'] });
    assert.equal(r.status, 'stopped', `expected stopped(provider), got ${r.status}: ${r.error}`);
    assert.match(r.error ?? '', /quota exceeded/);
    assert.equal(quota.calls, 1, 'policy stops must not retry-storm');
    // the run row records 'stopped' — resumable once the user fixes the quota
  } finally {
    ws.cleanup();
  }
});

test('G8: an amend that writes via world.run closes the imported cache — later reads see the NEW file', async () => {
  const ws = makeWorkspace();
  try {
    // Base run: journal a read of the OLD content.
    fs.writeFileSync(path.join(ws.dir, 'note.txt'), 'OLD VALUE');
    const baseScript = path.join(ws.dir, 'base.facade.ts');
    fs.writeFileSync(baseScript, `
phase("Read");
const content = await files.read("note.txt");
return { content };
`);
    const base = await runFacadeScript({ scriptPath: baseScript, cwd: ws.dir, approvedCommands: ['node'] });
    assert.equal(base.status, 'completed');

    // Amend: world.run REWRITES the file, then reads it — the imported cache must be
    // closed by the write, so the read returns the NEW value, not the journalled old one.
    const amendScript = path.join(ws.dir, 'amend.facade.ts');
    fs.writeFileSync(amendScript, `
phase("Write then read");
await world.run("node", ["-e", "require('node:fs').writeFileSync('note.txt', 'NEW VALUE')"]);
const content = await files.read("note.txt");
return { content };
`);
    const amend = await runFacadeScript({ scriptPath: amendScript, cwd: ws.dir, amendRunId: base.runId, approvedCommands: ['node'] });
    assert.equal(amend.status, 'completed', amend.error);
    assert.equal((amend.value as { content: string }).content, 'NEW VALUE', 'the read must see the post-write file, not the prior run cache');
  } finally {
    ws.cleanup();
  }
});
