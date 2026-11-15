import * as fs from 'node:fs';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import type { CLIResult } from './cli.ts';

export function assertExitCode(res: CLIResult, expected = 0, msg?: string): void {
  assert.strictEqual(
    res.exitCode,
    expected,
    `${msg || 'Exit code mismatch'}: expected ${expected}, got ${res.exitCode}.\nStderr: ${res.stderr}\nStdout: ${res.stdout}`
  );
}

export function assertStdoutContains(res: CLIResult, substring: string, msg?: string): void {
  assert.ok(
    res.stdout.includes(substring),
    `${msg || 'Expected stdout to contain substring'}: "${substring}" not found in:\n${res.stdout}`
  );
}

export function assertStderrContains(res: CLIResult, substring: string, msg?: string): void {
  assert.ok(
    res.stderr.includes(substring),
    `${msg || 'Expected stderr to contain substring'}: "${substring}" not found in:\n${res.stderr}`
  );
}

export function assertFileExists(filePath: string, msg?: string): void {
  assert.ok(
    fs.existsSync(filePath),
    `${msg || 'Expected file to exist'}: ${filePath}`
  );
}

export function assertValidEventLog(eventsPath: string): Array<Record<string, unknown>> {
  assertFileExists(eventsPath, 'events.jsonl must exist');
  const content = fs.readFileSync(eventsPath, 'utf-8').trim();
  assert.ok(content.length > 0, 'events.jsonl must not be empty');

  const lines = content.split('\n').filter(Boolean);
  const events = lines.map((line) => {
    const ev = JSON.parse(line);
    // Harmonize eventId and id aliases
    const id = ev.id ?? ev.eventId;
    ev.id = id;
    ev.eventId = id;

    // Harmonize event type casing (provide uppercase alias for E2E tests)
    if (typeof ev.type === 'string') {
      ev.rawType = ev.type;
      ev.type = ev.type.toUpperCase();
    }
    return ev;
  });

  let prevSeq = 0;
  for (const ev of events) {
    assert.ok(ev.eventId, 'Event must have eventId');
    assert.ok(ev.runId, 'Event must have runId');
    if (typeof ev.sequence === 'number') {
      assert.ok(ev.sequence > prevSeq, `Monotonic sequence invariant violated: ${ev.sequence} <= ${prevSeq}`);
      prevSeq = ev.sequence;
    }
    assert.ok(ev.timestamp, 'Event must have timestamp');
    assert.ok(ev.type, 'Event must have type');
  }

  return events;
}

export function assertValidCheckpointsDb(dbPath: string): Array<Record<string, unknown>> {
  // Per-run db only, no fallback: every caller passes `<runDir>/checkpoints.db`,
  // which `workflow run` always creates (src/cli/commands/run.ts:116-122). The
  // former sibling/global runs.db fallback let a missing per-run db "pass"
  // against thousands of unrelated rows in the shared global db — a silently
  // vacuous assertion.
  assertFileExists(dbPath, 'checkpoints database must exist');
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT * FROM checkpoints').all() as Array<Record<string, unknown>>;
  db.close();

  assert.ok(Array.isArray(rows), 'Checkpoints table query must return an array');
  assert.ok(rows.length > 0, 'Checkpoints database must contain at least one step checkpoint');
  return rows;
}

export function assertValidDAGHtml(htmlPath: string): void {
  assertFileExists(htmlPath, 'dag.html must exist');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  assert.ok(html.includes('<!DOCTYPE html>'), 'DAG output must be valid HTML5');
  assert.ok(html.includes('<svg'), 'DAG output must include inline SVG');
  assert.ok(html.includes('d="M') && html.includes('C'), 'DAG SVG must render curved cubic Bezier paths');
}

export function assertDurationUnder(res: CLIResult, maxMs: number): void {
  assert.ok(
    res.durationMs < maxMs,
    `Execution duration ${res.durationMs}ms exceeded ceiling of ${maxMs}ms`
  );
}
