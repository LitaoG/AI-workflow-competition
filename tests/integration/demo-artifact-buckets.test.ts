import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

test('the two Builder demos bucket their cwd artifacts — both kanban.json survive sequential runs (Issue #149)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-demo-buckets-'));
  try {
    // Exactly the two README commands, run sequentially from ONE cwd — the
    // pre-fix shape: the second run overwrote the first run's kanban.json.
    const incident = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'bin', 'workflow.js'), 'run', path.join(REPO_ROOT, 'apps', 'incident-triage-remediation', 'workflow.ts'), '--mock'],
      { cwd, encoding: 'utf8', timeout: 180_000 },
    );
    assert.equal(incident.status, 0, `incident demo failed: ${incident.stderr.slice(-400)}`);
    const migration = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'bin', 'workflow.js'), 'run', path.join(REPO_ROOT, 'apps', 'repo-migration-engine', 'workflow.ts'), '--mock'],
      { cwd, encoding: 'utf8', timeout: 180_000 },
    );
    assert.equal(migration.status, 0, `migration demo failed: ${migration.stderr.slice(-400)}`);

    const incidentKanban = JSON.parse(
      fs.readFileSync(path.join(cwd, 'artifacts', 'incident-triage', 'kanban.json'), 'utf-8'),
    ) as { workflow: string };
    const migrationKanban = JSON.parse(
      fs.readFileSync(path.join(cwd, 'artifacts', 'repo-migration', 'kanban.json'), 'utf-8'),
    ) as { workflow: string };

    assert.equal(incidentKanban.workflow, 'incident-triage-remediation', 'the incident bucket keeps its own kanban');
    assert.equal(migrationKanban.workflow, 'repo-migration-engine', 'the migration bucket keeps its own kanban');
    assert.ok(
      !fs.existsSync(path.join(cwd, 'artifacts', 'kanban.json')),
      'no un-bucketed kanban.json may leak into the shared artifacts root',
    );
  } finally {
    rmTempDir(cwd);
  }
});
