import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWindowsSpawnCommand } from '../../src/process-supervision.js';

// Windows: npm/npx/tsc ship as .cmd shims; a shell:false spawn cannot exec
// them (world.run('npm', …) failed with ENOENT — 2026-11-14 self-review,
// process-supervision spawnSupervised, confirmed live during the demo run).
// The resolver routes shim lookups through cmd.exe; everything else passes
// through untouched.
//
// Placed in tests/integration (not tests/unit) per Issue #198: tests/unit
// keeps pure isolation semantics and must not import src/process-supervision.js.
test('resolveWindowsSpawnCommand: .cmd shims route through COMSPEC, misses and explicit paths pass through', () => {
  if (process.platform !== 'win32') {
    // The resolver is a win32 no-op elsewhere; the routing branch is covered
    // on Windows machines only (this repo has no remote CI).
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-res-'));
  try {
    fs.writeFileSync(path.join(tmp, 'npm.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(tmp, 'real.exe'), 'MZ');
    const env = { PATH: tmp, PATHEXT: '.COM;.EXE;.BAT;.CMD', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' };

    assert.equal(resolveWindowsSpawnCommand('npm', env), 'C:\\Windows\\system32\\cmd.exe', 'a .cmd shim must route through cmd.exe');
    assert.equal(resolveWindowsSpawnCommand('real', env), 'real', 'a real .exe must spawn directly');
    assert.equal(resolveWindowsSpawnCommand('not-installed-xyz', env), 'not-installed-xyz', 'a miss must keep the original ENOENT behavior');
    assert.equal(resolveWindowsSpawnCommand('C:\\tools\\npm.cmd', env), 'C:\\tools\\npm.cmd', 'an explicit path is the caller\'s responsibility');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
