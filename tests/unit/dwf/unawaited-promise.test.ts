import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { runFacadeScript } from '../../../src/dwf/runner.js';
import { BOOTSTRAP } from '../../../src/dwf/child-bootstrap.js';

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-unawaited-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file lock tolerance */
      }
    },
  };
}

test('deliver.getPending()/getUnawaited() expose in-flight and dropped calls; the dead inbound sentinel protocol is gone (Issue #279 F4)', () => {
  const sentFrames: unknown[] = [];
  const sandbox = Object.create(null);
  sandbox.__argsJson = '{}';
  sandbox.__budgetTotal = null;
  sandbox.__send = (line: string) => {
    sentFrames.push(JSON.parse(line));
  };
  sandbox.__timer = {
    start: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliver = vm.runInContext(BOOTSTRAP, context) as any;
  assert.equal(typeof deliver, 'function');
  assert.equal(typeof deliver.getPending, 'function');
  assert.equal(typeof deliver.getUnawaited, 'function');
  assert.equal(typeof deliver.getActorUsage, 'function');

  // Trigger an agent creation and ask inside the realm
  vm.runInContext(`
    globalThis.__worker = __host.createActor('actor#1', 'worker');
    globalThis.__probe = __host.ask('ask#1', __worker, 'hello', null);
  `, context);

  // Actor usage should show worker created and used
  const usage = deliver.getActorUsage();
  assert.deepEqual([...usage.created], ['actor#1']);
  assert.deepEqual([...usage.used], ['actor#1']);

  // getPending should report the unsettled ask
  const pending = deliver.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].siteId, 'ask#1');
  assert.equal(pending[0].op, 'ask');

  // Issue #279 F4: the dead inbound sentinel protocol is gone — a parent never
  // sent those frames, and the array return violated the DeliverFunction
  // string contract. Malformed lines and unknown shapes fall through to ''.
  assert.equal(deliver('__get_pending__'), '');
  assert.equal(deliver(JSON.stringify({ t: '__get_pending__' })), '');
  assert.equal(deliver(JSON.stringify({ op: 'getPending' })), '');

  // When deliver resolves the frame with an ok frame, getPending becomes empty…
  deliver(JSON.stringify({ t: 'ok', id: 1, value: 'done' }));
  assert.equal(deliver.getPending().length, 0);
  // …but the call was never CONSUMED, so the consumption net still holds it —
  // settled-but-dropped results are exactly what Issue #279 F1 mandates we catch.
  const unawaited = deliver.getUnawaited();
  assert.equal(unawaited.length, 1);
  assert.equal(unawaited[0].siteId, 'ask#1');
  assert.equal(unawaited[0].op, 'ask');

  // Consuming the promise (then/catch/finally — await lowers to then) is the
  // only thing that clears the sentinel.
  vm.runInContext('__probe.then(function () { });', context);
  assert.equal(deliver.getUnawaited().length, 0);

  // A cancelled turn is a sanctioned abandonment (sessions.cancel race loser):
  // cancellation must exempt it from the unawaited-consumption sentinel.
  vm.runInContext(`
    globalThis.__loser = __host.ask('ask#2', __worker, 'second question');
    __sessions.cancel(__loser);
  `, context);
  assert.equal(deliver.getUnawaited().length, 0, 'cancelled turns must not count as dropped results');
});

test('unawaited facade promise sentry: agent("worker").ask("test") without await is rejected rather than silently exiting with done', async () => {
  const ws = makeWorkspace();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  try {
    const scriptPath = path.join(ws.dir, 'unawaited.facade.ts');
    fs.writeFileSync(
      scriptPath,
      `
phase("Test");
agent("worker").ask("test");
return { ok: true };
`,
    );

    const result = await runFacadeScript({ scriptPath, cwd: ws.dir, onEvent: (e) => events.push(e as { type: string; data: Record<string, unknown> }) });
    assert.equal(result.status, 'failed', `expected run to fail due to unawaited call, got status: ${result.status}`);
    assert.match(
      result.error ?? '',
      /workflow execution failed: unawaited facade call \(site ask#\d+, op ask\) was never awaited/,
      `expected unawaited error message, got: ${result.error}`,
    );
    // Issue #279 F2: the sentinel raises the named algebra member, not a raw
    // AgentError fallback — the tag rides the dwf_failed event's taggedError.
    const failed = events.find((e) => e.type === 'dwf_failed');
    assert.ok(failed, 'a failed run must emit dwf_failed');
    const tagged = failed.data.taggedError as { tag?: string; details?: Record<string, unknown> } | undefined;
    assert.equal(tagged?.tag, 'WorkflowUnawaitedPromiseError');
    assert.ok(tagged?.details && 'fixSuggestion' in tagged.details, 'details must carry the fix suggestion (CAP-007 doc contract)');
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    ws.cleanup();
  }
});

test('Issue #279 F1 script B: a dropped ask that settles while a later call is awaited still fails the run (completed → failed)', async () => {
  const ws = makeWorkspace();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  try {
    const scriptPath = path.join(ws.dir, 'dropped-then-awaited.facade.ts');
    fs.writeFileSync(
      scriptPath,
      `
phase("Test");
agent("worker").ask("first-dropped");
const second = await agent("worker").ask("second-awaited");
return { second };
`,
    );

    const result = await runFacadeScript({ scriptPath, cwd: ws.dir, onEvent: (e) => events.push(e as { type: string; data: Record<string, unknown> }) });
    // The old in-flight-only sentinel passed this script: the dropped ask's ok
    // frame arrived while the script awaited the second call, erasing it from
    // __pending before the done-time scan. The consumption net holds it now.
    assert.equal(result.status, 'failed', `expected the dropped call to fail the run, got status: ${result.status} error: ${result.error}`);
    assert.match(
      result.error ?? '',
      /unawaited facade call \(site ask#\d+, op ask\) was never awaited/,
      `expected the dropped call to be named, got: ${result.error}`,
    );
    const failed = events.find((e) => e.type === 'dwf_failed');
    assert.ok(failed, 'a failed run must emit dwf_failed');
    const tagged = failed.data.taggedError as { tag?: string } | undefined;
    assert.equal(tagged?.tag, 'WorkflowUnawaitedPromiseError');
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    ws.cleanup();
  }
});

test('fire-and-forget whitelist boundary: dropped log/report/declareArtifact calls keep today\'s semantics (Issue #279 documented boundary)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'fire-and-forget.facade.ts');
    fs.writeFileSync(
      scriptPath,
      `
phase("Test");
log("side-effect note");
return { ok: true };
`,
    );

    const result = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(result.status, 'completed', `fire-and-forget logging must stay legal, got error: ${result.error}`);
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    ws.cleanup();
  }
});

test('awaited facade call completes normally without triggering the unawaited promise sentry', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'awaited.facade.ts');
    fs.writeFileSync(
      scriptPath,
      `
phase("Test");
const answer = await agent("worker").ask("test");
return { answer };
`,
    );

    const result = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(result.status, 'completed', `expected run to complete, got error: ${result.error}`);
    assert.ok(result.value !== null && typeof result.value === 'object');
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    ws.cleanup();
  }
});
