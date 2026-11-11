/**
 * Issue #169: the event-persistence boundary (Issue #112's wholesale
 * redactValue) must keep the STRUCTURAL `inputHash` replay key verbatim —
 * the answer/hole-fill CLI reads it from the open event to journal a reply
 * the resume pool matches against; a masked hash made every answer→resume
 * re-open the question and park forever, with no gate going red.
 *
 * Pins BOTH directions: the hash survives, and everything credential-shaped
 * next to it is still masked — the exemption must stay as narrow as its
 * rationale.
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
const INPUT_HASH = 'a'.repeat(64); // sha256-shaped — trips the anchored hex rule

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'event-hash-')), 'state.sqlite');
}

function rawEventDataJson(dbPath: string, runId: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT data_json FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(runId) as
      | { data_json: string }
      | undefined;
    return row?.data_json;
  } finally {
    db.close();
  }
}

function record(dbPath: string, data: unknown): string {
  const store = new SQLiteStateStore(dbPath);
  const event: WorkflowEvent = {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    runId: 'run-169',
    workflowId: 'wf-169',
    type: 'dwf_escalation_open',
    timestamp: new Date().toISOString(),
    sequence: 1,
    data,
  } as WorkflowEvent;
  // recordEvent is fire-and-forget synchronous under node:sqlite
  void store.recordEvent(event);
  return rawEventDataJson(dbPath, 'run-169')!;
}

test('#169: a top-level inputHash survives event redaction verbatim', () => {
  const dbPath = tempDbPath();
  const json = record(dbPath, { inputHash: INPUT_HASH, question: 'Approve?', token: TOKEN });
  const data = JSON.parse(json) as Record<string, unknown>;
  assert.equal(data.inputHash, INPUT_HASH, 'the structural replay key must survive verbatim');
  assert.equal(data.question, 'Approve?', 'plain prose passes through');
  assert.equal(data.token, '***REDACTED***', 'credential-shaped siblings are still masked');
});

test('#169: events without inputHash are masked exactly as before (narrow exemption)', () => {
  const dbPath = tempDbPath();
  const json = record(dbPath, { token: TOKEN, note: `${'a'.repeat(64)}` });
  const data = JSON.parse(json) as Record<string, unknown>;
  assert.equal(data.token, '***REDACTED***');
  assert.equal(data.note, '***REDACTED***', 'a bare 64-hex value without the structural key stays masked');
});

test('#169: a NON-string inputHash is not restored (no type confusion)', () => {
  const dbPath = tempDbPath();
  const json = record(dbPath, { inputHash: { nested: TOKEN } });
  const data = JSON.parse(json) as Record<string, unknown>;
  const nested = (data.inputHash as Record<string, unknown>).nested;
  assert.equal(nested, '***REDACTED***', 'objects under inputHash keep the wholesale rule');
});
