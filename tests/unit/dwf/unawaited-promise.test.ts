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

test('deliver.getPending() and deliver sentinel expose unsettled calls and actor usage', () => {
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
  assert.equal(typeof deliver.getActorUsage, 'function');

  // Trigger an agent creation and ask inside the realm
  vm.runInContext(`
    const worker = __host.createActor('actor#1', 'worker');
    __host.ask('ask#1', worker, 'hello', null);
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

  // deliver with sentinel string '__get_pending__' also returns the pending list
  const sentinelPending = deliver('__get_pending__');
  assert.equal(sentinelPending.length, 1);
  assert.equal(sentinelPending[0].siteId, 'ask#1');
  assert.equal(sentinelPending[0].op, 'ask');

  // When deliver resolves the frame with an ok frame, getPending becomes empty
  deliver(JSON.stringify({ t: 'ok', id: 1, value: 'done' }));
  assert.equal(deliver.getPending().length, 0);
});

test('unawaited facade promise sentry: agent("worker").ask("test") without await is rejected rather than silently exiting with done', async () => {
  const ws = makeWorkspace();
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

    const result = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(result.status, 'failed', `expected run to fail due to unawaited call, got status: ${result.status}`);
    assert.match(
      result.error ?? '',
      /workflow execution failed: unawaited facade call \(site ask#\d+, op ask\) was never awaited/,
      `expected unawaited error message, got: ${result.error}`,
    );
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
