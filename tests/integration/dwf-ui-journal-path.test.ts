import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Windows-tolerant temp-dir removal: retries briefly on the EBUSY file-lock
 * window (helper, never a `finally` body — P-TEST-7).
 */
function rmTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

function getState(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/state' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

test('run --cwd <ws> --ui serves the run from the --cwd journal (Issue #146)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-ui-path-'));
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-ui-caller-'));
  try {
    const scriptPath = path.join(ws, 'park.facade.ts');
    fs.writeFileSync(
      scriptPath,
      `phase('Wait');\nconst approval = await hole<string>('approval', 'approve the change?');\nreturn { approval };\n`,
    );

    // Deliberately launch from `caller` with --cwd pointing at `ws`: the run
    // journals under ws/.workflow/ while the CLI process cwd is caller/.
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'bin', 'workflow.js'), 'run', scriptPath, '--cwd', ws, '--mock', '--ui'],
      { cwd: caller, env: { ...process.env, AI_WORKFLOW_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout!.on('data', (c) => (stdout += c.toString()));
    child.stderr!.on('data', (c) => (stdout += c.toString()));

    // Poll the Studio until it answers or the deadline passes.
    const deadline = Date.now() + 30_000;
    let status = 0;
    let body = '';
    while (Date.now() < deadline) {
      try {
        const res = await getState(4649);
        status = res.status;
        body = res.body;
        if (status === 200) break;
      } catch {
        /* server not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 500));

    const banner = /run (dwfrun-[a-z0-9-]+) parked/.exec(stdout)?.[1];
    assert.ok(banner, `the parked banner must carry the run id; tail: ${stdout.slice(-400)}`);
    assert.equal(
      status,
      200,
      `the Studio must serve from the --cwd journal (pre-fix it opened caller/.workflow and 404'd); tail: ${stdout.slice(-400)}`,
    );
    const parsed = JSON.parse(body) as { run: { runId: string } };
    assert.equal(parsed.run.runId, banner, 'the served snapshot must be the run the CLI just parked');
  } finally {
    rmTempDir(ws);
    rmTempDir(caller);
  }
});
