import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-mock-typed-ask-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

// Issue #267 end-to-end: a typed ask whose actor name trips a canned routing
// branch with a schema-disjoint body used to fail schema validation 3× and
// kill the whole run (live: run dwfrun-mwrsjrih-fd97a0, actor
// "board-reviewer" → safetyJson() vs a {looksRenderable, reason} schema).
// With the disjoint guard the run completes and the synthesized body
// validates.
test('mock typed ask: disjoint canned routing no longer kills the run', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'typed-ask.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Ask");
interface BoardVerdict {
  /** whether the board HTML is structurally renderable */
  looksRenderable: boolean;
  /** one-sentence reason */
  note: string;
}
const verdict = await agent("board-reviewer").ask<BoardVerdict>("One sentence: is the board HTML structurally renderable?");
return { looksRenderable: verdict.looksRenderable, note: verdict.note };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    const value = r.value as { looksRenderable: boolean; note: string };
    assert.equal(typeof value.looksRenderable, 'boolean', 'synthesized boolean field survives the typed RPC');
    assert.equal(typeof value.note, 'string', 'synthesized string field survives the typed RPC');
  } finally {
    ws.cleanup();
  }
});
