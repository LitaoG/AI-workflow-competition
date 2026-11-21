import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Issue #72: the PRAGMA existence guard on schema migrations only serializes
// them within one process. `node --test` runs test files in parallel workers,
// and several of them open the shared global `.workflow/runs.db` at once —
// two openers both see the column missing, race their ALTERs, and the loser
// dies with `duplicate column name: …` (CI runs 43895214141 / 43899305221).
// The fix tolerates exactly that error; this test pins the invariant by
// racing real concurrent openers against a pre-migration (old-schema) db.

test('SQLite schema migration tolerates concurrent openers (issue #72)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwf-migration-race-'));
  const dbPath = path.join(dir, 'runs.db');

  // Seed a pre-migration database: the dwf tables WITHOUT the later-added
  // columns, so every opener must run the ALTER path.
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE dwf_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT,
      status TEXT
    );
    CREATE TABLE dwf_nodes (
      run_id TEXT,
      site_id TEXT,
      ordinal INTEGER,
      kind TEXT,
      input_hash TEXT,
      status TEXT,
      result_json TEXT,
      error_text TEXT,
      duration_ms INTEGER,
      completed_at TEXT,
      PRIMARY KEY (run_id, site_id, ordinal)
    );
    CREATE TABLE checkpoints (
      run_id TEXT,
      step_id TEXT,
      status TEXT,
      PRIMARY KEY (run_id, step_id)
    );
  `);
  seed.close();

  // Concurrent openers: four processes open the same pre-migration db at the
  // same time. Before the fix, the losing migration died with
  // `duplicate column name: …` and the opener exited non-zero.
  const storeModule = pathToFileURL(path.resolve(process.cwd(), 'dist/src/state/sqlite-store.js')).href;
  const openerPath = path.join(dir, 'opener.mjs');
  fs.writeFileSync(
    openerPath,
    [
      "const { SQLiteStateStore } = await import(process.argv[2]);",
      "const store = new SQLiteStateStore(process.argv[3]);",
      "store.close();",
    ].join('\n'),
  );

  const children = ['a', 'b', 'c', 'd'].map(() =>
    spawn(process.execPath, [openerPath, storeModule, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const exits = await Promise.all(
    children.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          let stderr = '';
          child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
          child.on('close', (code) => resolve({ code, stderr }));
          // Guard against a hung opener: the store open/close is sync work.
          setTimeout(() => {
            if (!child.killed) child.kill();
            resolve({ code: child.exitCode ?? -1, stderr: stderr + '[killed after timeout]' });
          }, 30000).unref();
        }),
    ),
  );

  for (const [idx, exit] of exits.entries()) {
    assert.equal(exit.code, 0, `opener ${idx} must exit 0; stderr: ${exit.stderr}`);
  }

  // Every migration column must exist exactly once after the race.
  const db = new DatabaseSync(dbPath);
  const runCols = (db.prepare('PRAGMA table_info(dwf_runs)').all() as Array<{ name: string }>).map((c) => c.name);
  const nodeCols = (db.prepare('PRAGMA table_info(dwf_nodes)').all() as Array<{ name: string }>).map((c) => c.name);
  const cpCols = (db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{ name: string }>).map((c) => c.name);
  db.close();
  for (const col of ['runner_pid', 'output_tokens_spent', 'budget_total']) {
    assert.equal(runCols.filter((c) => c === col).length, 1, `dwf_runs.${col} must exist exactly once`);
  }
  for (const col of ['actor_name', 'actor_seq', 'content_hash', 'persona_json']) {
    assert.equal(nodeCols.filter((c) => c === col).length, 1, `dwf_nodes.${col} must exist exactly once`);
  }
  assert.ok(cpCols.includes('input_hash'), 'checkpoints.input_hash must exist');

  fs.rmSync(dir, { recursive: true, force: true });
});
