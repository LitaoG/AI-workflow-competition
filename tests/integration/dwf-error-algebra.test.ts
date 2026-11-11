/**
 * Item 5 『dwf 错误代数迁移』 — the Tagged Error Algebra across the dwf boundaries:
 *
 * 1. engine throws only tagged errors (src/domain/errors.ts vocabulary);
 * 2. err / scriptError protocol frames carry the optional `error` field and a
 *    SandboxTimeout survives the full NDJSON round trip (host → realm → host);
 * 3. the journal (dwf_nodes.error_text) stores the tagged serialization and reads
 *    back via tryParseStoredError, while legacy plain-text rows stay readable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FacadeEngine } from '../../src/dwf/engine.js';
import { encodeFrame } from '../../src/dwf/protocol.js';
import type { HostReplyErr } from '../../src/dwf/protocol.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { createSQLiteStore } from '../../src/state/store.js';
import type { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../src/types.js';
import {
  domainError,
  fromSerializableError,
  isSandboxTimeout,
  isSchemaValidationError,
  toDomainError,
  toSerializableError,
  tryParseStoredError,
} from '../../src/domain/errors.js';
import type { DomainError } from '../../src/domain/errors.js';

function makeEngine(runId: string, store: SQLiteStateStore & DwfJournalStore, overrides: Partial<ConstructorParameters<typeof FacadeEngine>[0]> = {}): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [{ name: 'node', source: 'explicit' as const }],
    onEvent: () => {},
    ...overrides,
  });
}

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-error-algebra-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

/** Spawn the real child-main entry with a script body and return its raw NDJSON stdout. */
async function runChildScript(script: string): Promise<string> {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.js');
    fs.writeFileSync(scriptPath, script);
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // compiled test lives at dist/tests/unit/dwf/ → the child entry at dist/src/dwf/
    const childEntry = fileURLToPath(new URL('../../src/dwf/child-main.js', import.meta.url));
    const child = spawn(process.execPath, [childEntry, scriptPath, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    return await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (c: Buffer) => (buf += c.toString()));
      child.on('close', () => resolve(buf));
    });
  } finally {
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 1. NDJSON protocol frames carry the tagged error (wire round trip)
// ---------------------------------------------------------------------------

test('protocol: a SandboxTimeout tag + details survive an err frame encode/decode round trip', () => {
  const timeout = domainError('SandboxTimeout', 'world.run "node" timed out after 400ms (process tree killed)', {
    details: { cmd: 'node', timeoutMs: 400 },
  });
  const frame: HostReplyErr = {
    t: 'err',
    id: 7,
    message: timeout.message,
    name: 'SandboxTimeout',
    error: toSerializableError(timeout),
  };

  const wire = JSON.parse(encodeFrame(frame)) as { error?: unknown }; // single-line NDJSON frame
  assert.ok(wire.error && typeof wire.error === 'object', 'error field survives JSON.stringify');

  const rebuilt = fromSerializableError(wire.error);
  assert.ok(isSandboxTimeout(rebuilt), 'the host dispatches on the tag');
  assert.equal(rebuilt.message, 'world.run "node" timed out after 400ms (process tree killed)');
  assert.deepEqual(rebuilt.details, { cmd: 'node', timeoutMs: 400 });
});

test('protocol: a legacy err frame without the error field is unchanged (backward compatible)', () => {
  const legacy = JSON.parse(encodeFrame({ t: 'err', id: 8, message: 'boom', name: 'Error' })) as { error?: unknown };
  assert.equal(legacy.error, undefined, 'old frames gain no field — the message/name rebuild path is untouched');
});

// ---------------------------------------------------------------------------
// 2. toDomainError — the total boundary conversion
// ---------------------------------------------------------------------------

test('toDomainError: tagged values pass through; Errors keep message + legacy name', () => {
  const sentinel = domainError('StorageError', 'disk full', { details: { path: 'x' } });
  assert.equal(toDomainError(sentinel), sentinel, 'already-tagged values are returned as-is');

  const e = new Error('boom');
  e.name = 'WorkflowBudgetExceededError';
  const wrapped = toDomainError(e);
  assert.equal(wrapped.tag, 'AgentError');
  assert.equal(wrapped.message, 'boom', 'message text is preserved verbatim');
  assert.equal((wrapped.details as { errorName?: string }).errorName, 'WorkflowBudgetExceededError', 'legacy error name rides in details');

  assert.equal(toDomainError('a thrown string').message, 'a thrown string');
  assert.equal(toDomainError(undefined).message, 'thrown undefined');
  assert.equal(toDomainError(null).message, 'thrown null');
  const obj = toDomainError({ code: 42 });
  assert.equal(obj.tag, 'AgentError');
  assert.equal(obj.message, '{"code":42}');
});

// ---------------------------------------------------------------------------
// 3. engine throws tagged errors; failed journal nodes store the tagged JSON
// ---------------------------------------------------------------------------

test('engine: worldRead validation failures reject tagged and persist a failed node with parseable error_text', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const engine = makeEngine('dwfrun-tagged-journal', store);

  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 1, op: 'worldRead', siteId: 'worldread#1', payload: ['files.read', ['..\\..\\secret.txt']] }),
    (err: unknown) => {
      assert.ok(isSchemaValidationError(err as DomainError), 'escape violations are SchemaValidationError');
      const schema = err as { message: string; details?: { path?: string } };
      assert.match(schema.message, /escapes the workspace/, 'message text unchanged');
      assert.equal(schema.details?.path, '..\\..\\secret.txt', 'structured context rides in details');
      return true;
    },
  );

  const node = await store.getDwfNode('dwfrun-tagged-journal', 'worldread#1', 1);
  assert.ok(node, 'the failed node is journalled');
  assert.equal(node.status, 'failed');
  assert.ok(node.errorText, 'error_text carries the tagged serialization');
  const parsed = tryParseStoredError(node.errorText!);
  assert.ok(parsed && isSchemaValidationError(parsed), 'new format parses back to the tagged structure');
  assert.equal((parsed!.details as { path?: string }).path, '..\\..\\secret.txt', 'details survive the journal round trip');

  // Resume safety: the failed row carries the SAME inputHash, so a new engine on
  // the same journal re-executes the node instead of failing with a mismatch.
  const engine2 = makeEngine('dwfrun-tagged-journal', store);
  await assert.rejects(
    () => engine2.handleCall({ t: 'call', id: 2, op: 'worldRead', siteId: 'worldread#1', payload: ['files.read', ['..\\..\\secret.txt']] }),
    { message: /escapes the workspace/ },
  );
  store.close();
});

test('journal: legacy plain-text errorText reads back untouched and parses to undefined (no crash)', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;

  await store.saveDwfNode({ runId: 'dwfrun-legacy', siteId: 's', ordinal: 1, kind: 'ask', inputHash: 'h1', status: 'failed', errorText: 'plain text boom', completedAt: '2026-01-01T00:00:00.000Z' });
  const legacy = await store.getDwfNode('dwfrun-legacy', 's', 1);
  assert.equal(legacy?.errorText, 'plain text boom', 'legacy rows round-trip byte-identical');
  assert.equal(tryParseStoredError(legacy!.errorText!), undefined, 'shape sniffing: plain text is not a tagged error');

  // Malformed JSON and valid JSON without a known tag also stay legacy.
  assert.equal(tryParseStoredError('{"tag":"AgentError"'), undefined, 'malformed JSON → undefined');
  assert.equal(tryParseStoredError('{"tag":"NotATag","message":"x"}'), undefined, 'unknown tag → undefined');
  assert.equal(tryParseStoredError('42'), undefined, 'non-object JSON → undefined');

  await store.saveDwfNode({ runId: 'dwfrun-legacy', siteId: 's', ordinal: 2, kind: 'ask', inputHash: 'h2', status: 'failed', errorText: '{"tag":"SandboxTimeout","message":"late","details":{"timeoutMs":5}}', completedAt: '2026-01-01T00:00:01.000Z' });
  const modern = await store.getDwfNode('dwfrun-legacy', 's', 2);
  const parsed = tryParseStoredError(modern!.errorText!);
  assert.ok(parsed && isSandboxTimeout(parsed), 'new format parses back to the structure');
  assert.equal((parsed!.details as { timeoutMs?: number }).timeoutMs, 5);
  store.close();
});

// ---------------------------------------------------------------------------
// 4. Full NDJSON round trip: SandboxTimeout host → realm → scriptError → events
// ---------------------------------------------------------------------------

test('round trip: a SandboxTimeout crosses the NDJSON protocol with tag and details intact', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'timeout.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Timeout");
const r = await world.run("node", ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 400 });
return { exitCode: r.exitCode };
`);
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath, approvedCommands: ['node'], onEvent: (e) => events.push(e) });

    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /timed out after 400ms/, 'the run error text is unchanged');

    // Host side (err frame → dwf_call_error event): tag dispatch works.
    const callError = events.find((e) => e.type === 'dwf_call_error');
    assert.ok(callError, 'expected a dwf_call_error event');
    const hostTagged = callError.data.taggedError as { tag: string; message: string; details?: { cmd?: string; timeoutMs?: number } };
    assert.equal(hostTagged.tag, 'SandboxTimeout');
    assert.match(hostTagged.message, /timed out after 400ms/);
    assert.equal(hostTagged.details?.cmd, 'node');
    assert.equal(hostTagged.details?.timeoutMs, 400);

    // Full round trip: the child realm re-raised the host error and the
    // scriptError frame came back tagged — the dwf_failed event carries it.
    const failed = events.find((e) => e.type === 'dwf_failed');
    assert.ok(failed, 'expected a dwf_failed event');
    const roundTripped = failed.data.taggedError as { tag: string; details?: { timeoutMs?: number } } | undefined;
    assert.ok(roundTripped, 'dwf_failed carries the tagged structure');
    assert.equal(roundTripped.tag, 'SandboxTimeout', 'tag survives the realm round trip');
    assert.equal(roundTripped.details?.timeoutMs, 400, 'details survive the realm round trip');

    // Journal: the failed worldRun node stores the tagged JSON.
    const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const nodes = await store.getDwfNodes(r.runId);
      const failedNode = nodes.find((n) => n.status === 'failed' && n.kind === 'worldRun');
      assert.ok(failedNode?.errorText, 'the failed worldRun node is journalled with error_text');
      const parsed = tryParseStoredError(failedNode.errorText!);
      assert.ok(parsed && isSandboxTimeout(parsed), 'journal error_text parses back to SandboxTimeout');
      assert.equal((parsed!.details as { timeoutMs?: number }).timeoutMs, 400);
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. child-main boundary conversion: unknown thrown values get a fallback tag
// ---------------------------------------------------------------------------

test('child-main: realm purity violations surface as CompileError on the scriptError frame', async () => {
  const out = await runChildScript('async function __workflowScript__() { return String(Math.random()); }');
  const line = out.trim().split('\n').find((l) => l.includes('scriptError'));
  assert.ok(line, `expected a scriptError frame, got: ${out}`);
  const frame = JSON.parse(line!) as { message: string; error?: { tag: string; details?: { construct?: string } } };
  assert.match(frame.message, /Purity violation: Math\.random/, 'message text unchanged');
  assert.equal(frame.error?.tag, 'CompileError', 'the compile-ban backstop maps to CompileError');
  assert.equal(frame.error?.details?.construct, 'Math.random');
});

test('child-main: Date purity seal removes both constructor-chain bypasses (Issue #55)', async () => {
  // Structural seal: no path from the Date shim back to the native constructor.
  const structural = await runChildScript(
    'async function __workflowScript__() { return { protoNow: typeof Object.getPrototypeOf(Date).now, instanceCtorIsDate: new Date(0)["con" + "structor"] === Date }; }'
  );
  const doneLine = structural.trim().split('\n').find((l) => l.includes('"t":"done"'));
  assert.ok(doneLine, `expected a done frame, got: ${structural}`);
  const done = JSON.parse(doneLine!) as { value: { protoNow: string; instanceCtorIsDate: boolean } };
  assert.equal(done.value.protoNow, 'undefined', 'Object.getPrototypeOf(Date) must not expose the native constructor');
  assert.equal(done.value.instanceCtorIsDate, true, 'Date instances must resolve .constructor to the shim');

  // Runtime backstop: the instance-constructor path still reaches the Date.now ban.
  const backdoor = await runChildScript(
    'async function __workflowScript__() { return String(new Date(0)["con" + "structor"].now()); }'
  );
  const errLine = backdoor.trim().split('\n').find((l) => l.includes('scriptError'));
  assert.ok(errLine, `expected a scriptError frame, got: ${backdoor}`);
  const frame = JSON.parse(errLine!) as { message: string; error?: { tag: string; details?: { construct?: string } } };
  assert.match(frame.message, /Purity violation: Date\.now/, 'the instance constructor path must hit the Date.now ban');
  assert.equal(frame.error?.tag, 'CompileError');
  assert.equal(frame.error?.details?.construct, 'Date.now');
});

test('child-main: Intl no-arg date formatting is sealed (Issue #55)', async () => {
  // format() with no date falls back to %Date.now% and survives the Date seal.
  const noArg = await runChildScript(
    'async function __workflowScript__() { const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit" }); return f.format(); }'
  );
  const errLine = noArg.trim().split('\n').find((l) => l.includes('scriptError'));
  assert.ok(errLine, `expected a scriptError frame, got: ${noArg}`);
  const frame = JSON.parse(errLine!) as { message: string; error?: { tag: string; details?: { construct?: string } } };
  assert.match(frame.message, /Purity violation: Intl\.DateTimeFormat\.format/);
  assert.equal(frame.error?.tag, 'CompileError');
  assert.equal(frame.error?.details?.construct, 'Intl.DateTimeFormat.format');

  // formatToParts() has the same default-date fallback.
  const partsNoArg = await runChildScript(
    'async function __workflowScript__() { const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit" }); return f.formatToParts(); }'
  );
  const partsErrLine = partsNoArg.trim().split('\n').find((l) => l.includes('scriptError'));
  assert.ok(partsErrLine, `expected a scriptError frame, got: ${partsNoArg}`);
  const partsFrame = JSON.parse(partsErrLine!) as { message: string; error?: { tag: string; details?: { construct?: string } } };
  assert.match(partsFrame.message, /Purity violation: Intl\.DateTimeFormat\.formatToParts/);
  assert.equal(partsFrame.error?.tag, 'CompileError');
  assert.equal(partsFrame.error?.details?.construct, 'Intl.DateTimeFormat.formatToParts');

  // Explicit dates remain deterministic and usable.
  const explicit = await runChildScript(
    'async function __workflowScript__() { const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }); const first = f.format(0); const second = f.format(0); const parts = f.formatToParts(0); return { first, second, year: parts.find((p) => p.type === "year").value }; }'
  );
  const doneLine = explicit.trim().split('\n').find((l) => l.includes('"t":"done"'));
  assert.ok(doneLine, `expected a done frame, got: ${explicit}`);
  const done = JSON.parse(doneLine!) as { value: { first: string; second: string; year: string } };
  assert.equal(done.value.year, '1970', 'explicit epoch formatting still works');
  assert.equal(done.value.first, done.value.second, 'explicit-date formatting is deterministic');
});

test('child-main: non-Error thrown values take the AgentError fallback with their text', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.js');
    fs.writeFileSync(scriptPath, 'async function __workflowScript__() { throw "boom-string"; }');

    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const childEntry = fileURLToPath(new URL('../../src/dwf/child-main.js', import.meta.url));
    const child = spawn(process.execPath, [childEntry, scriptPath, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (c: Buffer) => (buf += c.toString()));
      child.on('close', () => resolve(buf));
    });
    const line = out.trim().split('\n').find((l) => l.includes('scriptError'));
    assert.ok(line, `expected a scriptError frame, got: ${out}`);
    const frame = JSON.parse(line!) as { message: string; error?: { tag: string; message: string; details?: { thrownType?: string } } };
    assert.equal(frame.message, 'boom-string', 'message text unchanged');
    assert.equal(frame.error?.tag, 'AgentError', 'unknown thrown values take the sanctioned fallback tag');
    assert.equal(frame.error?.message, 'boom-string');
    assert.equal(frame.error?.details?.thrownType, 'string');
  } finally {
    ws.cleanup();
  }
});
