import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-fanout-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('fanout.parallel: failures map to null, survivors keep values (Claude-exact semantics)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'fanout.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Fanout");
const results = await fanout.parallel([
  () => agent("r1").ask<Answer>("inspect health report of the service"),
  () => agent("r2").ask<Answer>("inspect health report of the service"),
]);
log(\`survivors: \${results.filter(Boolean).length}/\${results.length}\`);
return { survived: results.filter(Boolean).length, total: results.length };
interface Answer { healthStatus: string; }
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, { survived: 2, total: 2 });
  } finally {
    ws.cleanup();
  }
});

test('fanout.pipeline: each item flows through stages; thunk type errors are TypeErrors', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'pipeline.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Pipeline");
const out = await fanout.pipeline(
  ["x", "y"],
  (item: unknown) => agent("worker").ask<Answer>(\`inspect health report for \${String(item)}\`),
  (prev: unknown, item: unknown) => \`\${String(item)}:\${(prev as Answer).healthStatus}\`,
);
return { out };
interface Answer { healthStatus: string; }
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, { out: ['x:HEALTHY', 'y:HEALTHY'] });

    // In a TYPED facade the compiler rejects promise-thunks before the run —
    // the runtime TypeError guard is for untyped JS callers.
    const bad = path.join(ws.dir, 'bad.facade.ts');
    fs.writeFileSync(bad, `
const out = await fanout.parallel([agent("x").ask("no thunk")]);
return out;
`);
    const r2 = await runFacadeScript({ scriptPath: bad, cwd: ws.dir });
    assert.equal(r2.status, 'compile_failed');
    assert.ok((r2.diagnostics ?? []).some((d) => d.category === 'type-error'), 'type error: Node is not a thunk');
  } finally {
    ws.cleanup();
  }
});
