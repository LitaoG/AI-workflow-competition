/**
 * NDJSON frame-boundary tests against the REAL parent runner (Issue #98
 * Phase 2, blueprint step 8 — locks the audit-2 gap list as an automatically
 * gated suite; the adversarial PoCs predate it but only run via
 * test:adversarial, while this file is picked up by build + test:unit through
 * the tsconfig include of tests/unit/**).
 *
 * Probe child: tests/unit/dwf/fixtures/ndjson-probe-child.mjs (a .mjs DATA
 * file, referenced through the source tree because compiled tests run from
 * dist/), wired via RunFacadeOptions.childEntryPath — the protocol frame pump
 * itself (src/dwf/protocol.ts, runner.ts stdout pump) is NOT modified: this
 * suite only observes it.
 *
 * Budget map (runner.ts): MAX_CHILD_FRAME_CHARS = 16 MiB chars (single line,
 * strictly-greater trip), MAX_CHILD_FRAME_BUFFER_CHARS = 32 MiB chars
 * (unterminated backlog, strictly-greater trip), CHILD_FRAME_LINES_PER_TICK =
 * 512 (yield granularity).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../../src/dwf/runner.js';

const PROBE_CHILD = fileURLToPath(new URL('../../../../tests/unit/dwf/fixtures/ndjson-probe-child.mjs', import.meta.url));

import { fileURLToPath } from 'node:url';

const VICTIM_SCRIPT = 'phase("P1");\nreturn { victim: "real" };\n';

interface RunOutcome {
  status: string;
  error?: string;
  value?: unknown;
  logs: string[];
  eventTypes: string[];
  wallMs: number;
}

async function runProbe(scenario: string, runTimeoutMs = 45_000): Promise<RunOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-boundary-'));
  const logs: string[] = [];
  const eventTypes: string[] = [];
  const t0 = Date.now();
  try {
    const scriptPath = path.join(dir, 'victim.facade.ts');
    fs.writeFileSync(scriptPath, VICTIM_SCRIPT);
    const result = await runFacadeScript({
      scriptPath,
      cwd: dir,
      dbPath: path.join(dir, 'journal.sqlite'),
      args: { scenario },
      runTimeoutMs,
      childEntryPath: PROBE_CHILD,
      onEvent: (e) => {
        eventTypes.push(e.type);
        if (e.type === 'dwf_log') logs.push(String((e.data as { message?: unknown }).message ?? ''));
      },
    });
    return { status: result.status, error: result.error, value: result.value, logs, eventTypes, wallMs: Date.now() - t0 };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
  }
}

test('① a single frame of exactly 16 MiB chars passes the budget and arrives verbatim (strictly-greater budget)', { timeout: 60_000 }, async () => {
  const r = await runProbe('frame-exact');
  assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
  assert.deepEqual(r.value, { ok: 'frame-exact-done' });
  assert.equal(r.logs.length, 1, `exactly one log frame expected, got ${r.logs.length}`);
  assert.equal(r.logs[0]!.length, 16 * 1024 * 1024 - JSON.stringify({ t: 'call', id: 8, op: 'log', siteId: 'probe', payload: [''] }).length, 'message length must be the calibrated frame budget minus JSON overhead');
  assert.ok(/^A+$/.test(r.logs[0]!), 'the 16MB message must arrive verbatim');
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), 'no malformed frame may be counted');
});

test('② a single frame one char over 16 MiB is named-rejected (ChildFrameLimitExceeded / single-frame budget)', { timeout: 60_000 }, async () => {
  const r = await runProbe('frame-over');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /single-frame budget/);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms`);
});

test('③ an unterminated backlog of exactly 32 MiB chars must NOT trip the frame gate (non-strict direction)', { timeout: 60_000 }, async () => {
  const r = await runProbe('backlog-exact');
  assert.equal(r.status, 'failed');
  // No newline ever arrives: the run ends via child exit, NOT via the gate.
  assert.match(r.error ?? '', /exited before finishing/);
  assert.ok(!/ChildFrameLimitExceeded/.test(r.error ?? ''), `the exact-budget backlog must not be name-rejected: ${r.error ?? ''}`);
});

test('④ an unterminated backlog one char over 32 MiB is named-rejected (ChildFrameLimitExceeded / backlog)', { timeout: 60_000 }, async () => {
  const r = await runProbe('backlog-over');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /ChildFrameLimitExceeded/);
  assert.match(r.error ?? '', /backlog/);
  assert.ok(r.wallMs < 45_000, `wall=${r.wallMs}ms`);
});

test('⑤ a 3-byte UTF-8 character torn mid-codepoint across 7-byte writes reassembles byte-exact', { timeout: 60_000 }, async () => {
  const r = await runProbe('utf8-torn');
  assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
  assert.deepEqual(r.value, { ok: 'utf8-torn-done' });
  const expected = '中'.repeat(30);
  assert.ok(r.logs.includes(expected), `the torn CJK frame must reassemble verbatim (got ${r.logs.length} logs)`);
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), 'torn-but-valid bytes are not malformed');
});

test('⑥ CRLF line endings: trailing \\r is JSON whitespace — every frame parses, malformed stays 0', { timeout: 60_000 }, async () => {
  const r = await runProbe('crlf');
  assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
  assert.deepEqual(r.logs, ['crlf-0', 'crlf-1', 'crlf-2', 'crlf-3', 'crlf-4']);
  assert.deepEqual(r.value, { ok: 'crlf-done' });
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), `CRLF frames must not count as malformed: ${JSON.stringify(r.eventTypes)}`);
});

test('⑦ EOF with a half-frame residue: run fails with exited-before-finishing and malformed stays 0', { timeout: 60_000 }, async () => {
  const r = await runProbe('eof-half');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /exited before finishing/);
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), 'an unparsed residue is never counted as a malformed frame');
});

test('⑧ a 2000-frame burst stays strictly ordered across the 512-per-tick yield', { timeout: 60_000 }, async () => {
  const r = await runProbe('burst');
  assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
  assert.deepEqual(r.value, { ok: 'burst-done' });
  assert.equal(r.logs.length, 2000, `all 2000 frames must be processed (got ${r.logs.length})`);
  for (let i = 0; i < 2000; i++) {
    if (r.logs[i] !== `log-${i}`) {
      assert.fail(`log order broken at index ${i}: expected "log-${i}", got ${JSON.stringify(r.logs[i])}`);
    }
  }
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), 'no malformed frames in the burst');
});

test('⑨ #99: a done frame buffered behind 2000 frames still completes when the child exits right after writing', { timeout: 60_000 }, async () => {
  const r = await runProbe('burst-exit');
  assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);
  assert.deepEqual(r.value, { ok: 'burst-exit-done' });
  assert.equal(r.logs.length, 2000, `every frame received before child close must be processed (got ${r.logs.length})`);
  for (let i = 0; i < 2000; i++) {
    if (r.logs[i] !== `log-${i}`) {
      assert.fail(`log order broken at index ${i}: expected "log-${i}", got ${JSON.stringify(r.logs[i])}`);
    }
  }
  assert.ok(!r.eventTypes.includes('dwf_frame_malformed'), 'no malformed frames in the burst');
});
