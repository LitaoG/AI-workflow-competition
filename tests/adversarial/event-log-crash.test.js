import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventLogWriter, EventLogReader } from '../../dist/src/state/event-log.js';

const TEST_RUNS_DIR = path.join(process.cwd(), 'tests', 'adversarial', 'fixtures', 'crash-test');

function setupCleanDir(subDir) {
  const dir = path.join(TEST_RUNS_DIR, subDir);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Crash Recovery 1: Appending after partial corrupted JSON without trailing newline', async () => {
  const runDir = setupCleanDir('partial-no-newline');
  const logFile = path.join(runDir, 'events.jsonl');

  // Pre-seed file with 2 valid events followed by an unclosed corrupt line WITHOUT \n
  const validEvent1 = JSON.stringify({ id: 'evt-1', sequence: 1, type: 'workflow_start', runId: 'test-run-1' }) + '\n';
  const validEvent2 = JSON.stringify({ id: 'evt-2', sequence: 2, type: 'step_start', runId: 'test-run-1' }) + '\n';
  const corruptPartialLine = '{"id": "evt-crash-truncated", "sequence": 3, "data": {"status": "incomp'; // NO \n

  fs.writeFileSync(logFile, validEvent1 + validEvent2 + corruptPartialLine, 'utf-8');

  // Verify file does NOT end with newline
  const initialContent = fs.readFileSync(logFile, 'utf-8');
  assert.ok(!initialContent.endsWith('\n'), 'Pre-condition: file must not end with newline');

  // Instantiate EventLogWriter - crash recovery should trigger
  const writer = new EventLogWriter(runDir);

  // Record next event
  const newEvent = writer.record({
    workflowId: 'test-wf',
    runId: 'test-run-1',
    type: 'step_complete',
    data: { recovered: true },
  });
  writer.close();

  // Read raw file content to verify non-concatenation
  const finalContent = fs.readFileSync(logFile, 'utf-8');
  const lines = finalContent.split('\n');

  // Ensure corrupt partial line was NOT concatenated with new event
  const corruptLineFound = lines.find((l) => l.includes('evt-crash-truncated'));
  assert.ok(corruptLineFound, 'Corrupt line must still exist in file');
  assert.ok(!corruptLineFound.includes(newEvent.id), 'CRITICAL: New event was concatenated onto corrupt line!');
  assert.equal(corruptLineFound, corruptPartialLine, 'Corrupt line must remain untouched on its own line');

  // The new event must be on its own line and valid JSON
  const newEventLine = lines.find((l) => l.includes(newEvent.id));
  assert.ok(newEventLine, 'New event must exist on its own distinct line');
  const parsedNewEvent = JSON.parse(newEventLine);
  assert.equal(parsedNewEvent.id, newEvent.id);
  assert.equal(parsedNewEvent.type, 'step_complete');
  assert.equal(parsedNewEvent.sequence, 3, 'Sequence should continue from last valid sequence (2 -> 3)');

  // Verify EventLogReader can parse the file, discarding corrupt line and retaining valid lines
  const readerEvents = await EventLogReader.readAll(logFile);
  assert.equal(readerEvents.length, 3, 'Should recover 2 previous valid events + 1 newly appended event');
  assert.equal(readerEvents[0].id, 'evt-1');
  assert.equal(readerEvents[1].id, 'evt-2');
  assert.equal(readerEvents[2].id, newEvent.id);
});

test('Crash Recovery 2: Empty or zero-byte file without newline', async () => {
  const runDir = setupCleanDir('zero-byte');
  const logFile = path.join(runDir, 'events.jsonl');
  fs.writeFileSync(logFile, '', 'utf-8');

  const writer = new EventLogWriter(runDir);
  const event = writer.record({
    workflowId: 'wf-empty',
    runId: 'run-empty',
    type: 'workflow_start',
  });
  writer.close();

  const content = fs.readFileSync(logFile, 'utf-8');
  assert.ok(content.endsWith('\n'));
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).sequence, 1);
});

test('Crash Recovery 3: Multi-line file where only corrupt fragment exists (no prior valid events)', async () => {
  const runDir = setupCleanDir('corrupt-only');
  const logFile = path.join(runDir, 'events.jsonl');

  // Corrupt string with non-JSON junk and no newline
  fs.writeFileSync(logFile, 'FATAL_KERNEL_PANIC_DUMP_0xDEADBEEF', 'utf-8');

  const writer = new EventLogWriter(runDir);
  const ev1 = writer.record({
    workflowId: 'wf-corrupt-only',
    runId: 'run-co',
    type: 'workflow_start',
  });
  writer.close();

  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n');
  assert.equal(lines[0], 'FATAL_KERNEL_PANIC_DUMP_0xDEADBEEF', 'Corrupt line must not be merged');
  const parsed = JSON.parse(lines[1]);
  assert.equal(parsed.id, ev1.id);
  assert.equal(parsed.sequence, 1);
});

test('Crash Recovery 4: Async unbuffered (flushSync=false) crash recovery', async () => {
  const runDir = setupCleanDir('unbuffered');
  const logFile = path.join(runDir, 'events.jsonl');

  // Pre-seed with partial line without newline
  fs.writeFileSync(logFile, '{"id":"evt-old","sequence":10}\n{"unclosed": "json', 'utf-8');

  const writer = new EventLogWriter(runDir, false);
  const ev1 = writer.record({
    workflowId: 'wf-unbuffered',
    runId: 'run-unb',
    type: 'step_complete',
  });
  writer.close();

  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n');
  assert.equal(lines[1], '{"unclosed": "json');
  const parsed = JSON.parse(lines[2]);
  assert.equal(parsed.id, ev1.id);
  assert.equal(parsed.sequence, 11);
});
