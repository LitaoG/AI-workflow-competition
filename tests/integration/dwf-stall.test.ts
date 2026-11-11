import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { LLMProvider } from '../../src/types.js';

const slowProvider: LLMProvider = {
  id: 'stall-facade-test',
  name: 'Slow facade stall test provider',
  async generate() {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { content: '{"ok":true}', model: 'slow-facade-test', latencyMs: 80 };
  },
};
providerRegistry.register(slowProvider);

const SCRIPT = `
phase("Stall");
const reply = await agent("slow", { provider: "stall-facade-test" }).ask("do the thing");
return reply;
`;

function makeProject(): { dir: string; scriptPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-stall-'));
  const scriptPath = path.join(dir, 'stall.facade.ts');
  fs.writeFileSync(scriptPath, SCRIPT);
  return { dir, scriptPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

// Wall-clock headroom (Issue #148): the stall cycle is deterministic in
// TRIGGER (provider sleeps 80ms vs a 20ms window — every attempt stalls) but
// not in DURATION: one attempt = a child-realm spawn + script compile + an
// 80ms call, times the retry chain with its backoff. Under a saturated host
// (default node --test concurrency = cores) the whole cycle measured 33.7s —
// past this test's old 30s cap, so the harness cancelled a healthy failure.
// 120s absorbs a 4x slowdown while still bounding a genuinely hung run.
const STALL_TEST_TIMEOUT_MS = 120_000;

test('facade run fails with a stall error when stallMs is set', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const project = makeProject();
  try {
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir, stallMs: 20 });
    assert.equal(r.status, 'failed', `expected a stall failure, got ${r.status}`);
    assert.match(r.error ?? '', /stalled — no progress for 20ms/);
  } finally {
    project.cleanup();
  }
});

test('facade run completes when stallMs=0 disables the clock', { timeout: STALL_TEST_TIMEOUT_MS }, async () => {
  const project = makeProject();
  try {
    const r = await runFacadeScript({ scriptPath: project.scriptPath, cwd: project.dir, stallMs: 0 });
    assert.equal(r.status, 'completed', r.error);
    assert.equal(r.value, '{"ok":true}');
  } finally {
    project.cleanup();
  }
});