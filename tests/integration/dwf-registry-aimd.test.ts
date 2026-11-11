import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AimdGovernor, retryAfterFromError } from '../../src/dwf/governor.js';
import { listSavedWorkflows, parseSavedMeta, validateSavedArgs } from '../../src/dwf/saved.js';
import { executeWorkflowsRun } from '../../src/cli/commands/workflows.js';

// ---------------------------------------------------------------- AIMD governor

test('AIMD: multiplicative decrease on failure, additive increase after successes, retry-after cooldown', async () => {
  const g = new AimdGovernor({ maxPerProvider: 8, increaseAfter: 2, decreaseFactor: 0.5 });
  await g.acquire('p1');
  g.release('p1', 'failure', 0);
  let snap = g.snapshot().find((s) => s.providerId === 'p1')!;
  assert.equal(snap.limit, 4, '8 × 0.5 = 4 after one failure');

  // official semantics: the additive increase needs demand — fill the bucket and
  // park waiters first. drain() wakes every waiter at once (one admits, the rest
  // re-park on the next microtask), so settle one tick before the streak-completing
  // release to have a waiter back in the queue; otherwise the streak only records
  // lastGood
  for (let i = 0; i < 4; i++) await g.acquire('p1');
  const parked1 = g.acquire('p1');
  const parked2 = g.acquire('p1');
  g.release('p1', 'success');
  await Promise.resolve();
  g.release('p1', 'success');
  await parked1;
  await parked2;
  snap = g.snapshot().find((s) => s.providerId === 'p1')!;
  assert.equal(snap.limit, 5, 'two consecutive successes with demand → +1 (increaseAfter=2)');

  await g.acquire('p1');
  g.release('p1', 'failure', 100);
  snap = g.snapshot().find((s) => s.providerId === 'p1')!;
  assert.ok(snap.cooldownUntil > Date.now(), 'retry-after sets a cooldown');
});

test('AIMD: cooldown blocks acquisition until it elapses', async () => {
  const g = new AimdGovernor({ maxPerProvider: 1 });
  await g.acquire('p2');
  g.release('p2', 'failure', 50); // 50ms cooldown
  const start = Date.now();
  await g.acquire('p2');
  g.release('p2', 'success');
  assert.ok(Date.now() - start >= 40, 'acquire waited out the cooldown');
});

test('retryAfterFromError parses Retry-After hints', () => {
  assert.equal(retryAfterFromError(new Error('rate limited; Retry-After: 250ms')), 250);
  assert.equal(retryAfterFromError(new Error('plain failure')), undefined);
});

// ---------------------------------------------------------- saved workflows

const SAVED_SCRIPT = `/* workflow
name: saved-demo
description: Demo saved workflow with typed args
whenToUse: demonstrating the registry
args:
  who:
    type: string
    description: Who to greet
    default: "world"
*/
phase("Greet");
const reply = await agent("greeter").ask<Reply>(\`Greet \${String(args.who)} — inspect health report of the service\`);
return { greeting: String(args.who), status: reply.healthStatus };
interface Reply { healthStatus: string; }
`;

function makeProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-saved-'));
  const wfDir = path.join(dir, '.workflow', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'saved-demo.facade.ts'), SAVED_SCRIPT);
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('saved workflows: frontmatter parse, discovery, defaults, run-by-name', async () => {
  const meta = parseSavedMeta(SAVED_SCRIPT);
  assert.equal(meta.name, 'saved-demo');
  assert.equal(meta.description, 'Demo saved workflow with typed args');
  assert.equal(meta.args.who?.type, 'string');
  assert.equal(meta.args.who?.default, 'world');

  const project = makeProject();
  try {
    const list = listSavedWorkflows(project.dir);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'saved-demo');
    assert.equal(list[0]!.scope, 'project');

    const validated = validateSavedArgs(list[0]!, {});
    assert.ok(validated.ok);
    assert.deepEqual(validated.args, { who: 'world' }, 'default filled');

    const missingRequired = validateSavedArgs(
      { ...list[0]!, args: { who: { type: 'string', required: true } } },
      {},
    );
    assert.ok(!missingRequired.ok && /missing required arg "who"/.test(missingRequired.error));

    // run-by-name end to end (mock provider)
    const exit = await executeWorkflowsRun('saved-demo', { dbPath: path.join(project.dir, '.workflow', 'dwf.sqlite'), cwd: project.dir });
    assert.equal(exit, 0, 'saved workflow runs end to end');

    const exitMissing = await executeWorkflowsRun('no-such-workflow', {});
    assert.equal(exitMissing, 1, 'unknown name refuses');
  } finally {
    project.cleanup();
  }
});
