/**
 * Phase 4 (F.md §六, Issue #126 §2.2): a facade script that throws at runtime
 * fails with the AUTHOR's row/column appended, and the on-disk source map never
 * carries the script's text (F5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-sourcemap-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('a top-level throw reports the author line and column', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'boom.facade.ts');
    fs.writeFileSync(scriptPath, [
      'phase("Boom");',              // author line 1
      'throw new Error("kaboom");',  // author line 2
    ].join('\n'));
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'failed');
    assert.match(r.error!, /kaboom/, 'the message stays authoritative');
    assert.match(r.error!, /\(script line 2, column \d+\)$/, 'the author position rides at the end');
  } finally {
    ws.cleanup();
  }
});

test('a throw after an await, inside a nested function, still maps to the author row', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'boom-nested.facade.ts');
    fs.writeFileSync(scriptPath, [
      'phase("Boom");',                 // author line 1
      'const marker = "sk-live-DO-NOT-LEAK-123";', // author line 2 (F5 probe)
      'async function inner(): Promise<void> {',
      '  throw new Error("deep kaboom");',          // author line 4
      '}',
      'await inner();',
      'return null;',
    ].join('\n'));
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'failed');
    assert.match(r.error!, /deep kaboom/);
    assert.match(r.error!, /\(script line 4, column \d+\)$/, 'the nested throw frame maps back through the await boundary');

    // F5: the map lands next to script.js but never carries the script text.
    const mapPath = path.join(ws.dir, '.workflow', 'runs', r.runId, 'script.js.map');
    assert.ok(fs.existsSync(mapPath), 'script.js.map is written next to script.js');
    const mapText = fs.readFileSync(mapPath, 'utf8');
    assert.ok(!/sourcesContent/.test(mapText), 'no sourcesContent in the map');
    assert.ok(!mapText.includes('sk-live-DO-NOT-LEAK-123'), 'script literals never reach the map');
  } finally {
    ws.cleanup();
  }
});
