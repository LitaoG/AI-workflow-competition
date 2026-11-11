import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Engine-owned zero-orphan guarantee (GOAL.md 铁律 3 / 差距矩阵 D7): stdin is the
 * parent→child NDJSON channel — EOF (parent crashed / force-killed without a tree
 * kill) must terminate the child promptly. The script below parks on a host log
 * call that is never answered — exactly the orphan shape: the child waits on a
 * reply that can no longer arrive, with its stdin read handle the only thing
 * keeping the process alive.
 *
 * Driver style mirrors tests/integration/dwf-run.test.ts: child-main.js is
 * spawned directly (no compiler in the loop). This test spawns real OS child
 * processes, so per Issue #198 (node --test per-file isolation × sandbox/
 * jobhelper subprocess-tree drain) it lives in the serial integration suite —
 * the unit suite keeps pure isolation semantics (no async child-process trees).
 */
test('child-main exits on stdin EOF while the script is still parked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-main-eof-'));
  try {
    const scriptPath = path.join(dir, 'parked.js');
    // Parked on an unanswered host call — no reply will ever come (the "parent"
    // here never writes an ok/err frame back).
    fs.writeFileSync(scriptPath, 'async function __workflowScript__() {\n  await __host.log("eof-test", "parked forever");\n}\n');

    const childEntry = fileURLToPath(new URL('../../src/dwf/child-main.js', import.meta.url));
    const child = spawn(process.execPath, [childEntry, scriptPath, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });

    let exitedEarly: number | null | undefined;
    child.on('close', (code) => { exitedEarly = code; });

    // Prove the NDJSON channel is up and the child STAYS ALIVE while stdin is
    // open (the parked ask keeps it waiting — it must not exit on its own).
    child.stdin.write(JSON.stringify({ t: 'notify', op: 'runInfo', runId: 'eof-test' }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(exitedEarly, undefined, `child must stay alive while stdin is open (exited early with ${exitedEarly})`);

    // EOF: the parent channel is gone — the child must terminate promptly.
    const t0 = Date.now();
    const [code, wall] = await new Promise<[number | null, number]>((resolve) => {
      child.once('close', (c) => resolve([c, Date.now() - t0]));
      child.stdin.end();
    });
    assert.ok(wall < 5_000, `child must exit promptly on stdin EOF, took ${wall}ms`);
    assert.equal(code, 0, `child must exit cleanly on stdin EOF, got code ${code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
