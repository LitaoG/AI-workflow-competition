/**
 * Issue #112: the builder engine's persistence boundary masks credential
 * shapes before they hit disk. The store IS the serialization boundary —
 * checkpoints (input/output/error) and events (data) land in SQLite already
 * redacted, the same rule the dwf journal enforces at its own boundary.
 * Raw rows are asserted through a second connection on the same file, exactly
 * the repro the issue prescribed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { WorkflowEvent } from '../../../src/types.js';

const TOKEN = `ghp_${'a'.repeat(36)}`;

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'redact-store-')), 'state.sqlite');
}

function rawCheckpointJson(dbPath: string, runId: string): { input: unknown; output: unknown; error: unknown } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT input_json, output_json, error_text FROM checkpoints WHERE run_id = ?').get(runId) as
      | { input_json: string | null; output_json: string | null; error_text: string | null }
      | undefined;
    assert.ok(row, 'the checkpoint row exists');
    return {
      input: row.input_json ? JSON.parse(row.input_json) : null,
      output: row.output_json ? JSON.parse(row.output_json) : null,
      error: row.error_text,
    };
  } finally {
    db.close();
  }
}

function rawEventDataJson(dbPath: string, runId: string, type: string): unknown {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT data_json FROM events WHERE run_id = ? AND type = ?').get(runId, type) as
      | { data_json: string }
      | undefined;
    assert.ok(row, `the ${type} event row exists`);
    return JSON.parse(row.data_json);
  } finally {
    db.close();
  }
}

test('saveCheckpoint masks credential shapes in input, output and error before disk', async () => {
  const dbPath = tempDbPath();
  const store = new SQLiteStateStore(dbPath);
  try {
    const runId = 'run-redact-checkpoint';
    await store.saveCheckpoint(runId, {
      stepId: 'leak-step',
      phaseId: 'p1',
      status: 'completed',
      input: { prompt: `token ${TOKEN}` },
      output: { note: TOKEN },
      error: `boom with ${TOKEN}`,
      durationMs: 5,
    } as never);

    const raw = rawCheckpointJson(dbPath, runId);
    assert.equal(JSON.stringify(raw.output).includes(TOKEN), false, 'the output json on disk never holds the raw token');
    assert.match(String((raw.output as { note?: string }).note), /\*\*\*REDACTED\*\*\*/);
    assert.equal(JSON.stringify(raw.input).includes(TOKEN), false, 'the input json on disk is masked too');
    assert.match(String(raw.error), /\*\*\*REDACTED\*\*\*/);
  } finally {
    store.close?.();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('recordEvent masks credential shapes in the event payload before disk', async () => {
  const dbPath = tempDbPath();
  const store = new SQLiteStateStore(dbPath);
  try {
    const runId = 'run-redact-event';
    const event: WorkflowEvent = {
      id: `${runId}-evt-1`,
      runId,
      workflowId: 'wf-redact',
      stepId: 'leak-step',
      phaseId: 'p1',
      type: 'step_complete',
      sequence: 1,
      timestamp: new Date().toISOString(),
      data: { output: { note: TOKEN }, durationMs: 5 },
    } as never;
    await store.recordEvent(event);

    const raw = rawEventDataJson(dbPath, runId, 'step_complete');
    assert.equal(JSON.stringify(raw).includes(TOKEN), false, 'the event data on disk never holds the raw token');
    assert.match(JSON.stringify(raw), /\*\*\*REDACTED\*\*\*/);
  } finally {
    store.close?.();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
