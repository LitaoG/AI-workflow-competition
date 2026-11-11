import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { executeAnswer } from '../../src/cli/commands/answer.js';
import { executeDoctor } from '../../src/cli/commands/doctor.js';
import { FacadeEngine } from '../../src/dwf/engine.js';
import { createSQLiteStore } from '../../src/state/store.js';
import type { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import type { DwfJournalStore, LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { MockProvider } from '../../src/agent/mock-provider.js';

const PARKED_SCRIPT = `
phase("Survey");
const survey = await agent("inspector").ask<Survey>("inspect health report of the service");
phase("Approve");
const approval = await escalate(\`Service is \${survey.healthStatus}. Approve auto-remediation? (yes/no + reason)\`);
log(\`owner said: \${approval}\`);
return { survey, approval };

interface Survey {
  healthStatus: string;
}
`;

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-escalation-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* transient Windows lock */ } } };
}

test('escalation parks the run with a question id; answering resumes at zero cost', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir, onEvent: (e) => events.push({ type: e.type, data: e.data }) });
    assert.equal(parked.status, 'parked', parked.error);
    assert.equal(parked.parkedAt?.kind, 'escalation');
    assert.match(parked.parkedAt?.name ?? '', /^dwfq-/, 'the open event carries a dwfq- question id');
    assert.match(parked.parkedAt?.prompt ?? '', /Approve auto-remediation/);
    assert.equal(parked.stats.asks, 1, 'the survey ask ran before the escalation');
    // Issue #35: the park terminal is dwf_parked — a dwf_failed terminal made
    // event-type statistics count every park as a failure.
    assert.ok(events.some((e) => e.type === 'dwf_parked'), 'the park terminal emits dwf_parked');
    assert.ok(!events.some((e) => e.type === 'dwf_failed'), 'a parked run emits no dwf_failed event');
    const questionId = parked.parkedAt!.name;

    // Answer: the reply is journalled and the run resumes — the survey ask replays
    // from the journal and escalate() resolves to the answer text.
    const exitCode = await executeAnswer(parked.runId, questionId, ['yes', '- hotfix verified'], { dbPath: path.join(ws.dir, '.workflow', 'dwf.sqlite') });
    assert.equal(exitCode, 0, 'answer must drive the run to completion');

    // The journal now records the final value through the resumed run row.
    const store = createSQLiteStore(path.join(ws.dir, '.workflow', 'dwf.sqlite')) as SQLiteStateStore & DwfJournalStore;
    const row = await store.getDwfRun(parked.runId);
    assert.equal(row?.status, 'completed');
    store.close();
  } finally {
    ws.cleanup();
  }
});

test('answering an unknown question id is refused', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked');

    const exitCode = await executeAnswer(parked.runId, 'dwfq-does-not-exist', ['yes'], { dbPath: path.join(ws.dir, '.workflow', 'dwf.sqlite') });
    assert.equal(exitCode, 1, 'unknown question id must refuse');
  } finally {
    ws.cleanup();
  }
});

test('answering a run that is no longer parked is refused with no journal side effects (Issue #35)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, PARKED_SCRIPT);
    const dbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');
    const parked = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(parked.status, 'parked');
    const questionId = parked.parkedAt!.name;

    // First answer drives the run to completion…
    const first = await executeAnswer(parked.runId, questionId, ['yes'], { dbPath });
    assert.equal(first, 0, 'the first answer completes the run');

    const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
    try {
      const before = (await store.getDwfNodes(parked.runId)).filter((n) => n.kind === 'escalation');

      // …answering the same question again hits the non-parked refusal (the run is
      // completed): exit 1 and NO second escalation row journalled.
      const captured: string[] = [];
      const originalError = console.error;
      console.error = (line: unknown) => captured.push(String(line));
      let again: number;
      try {
        again = await executeAnswer(parked.runId, questionId, ['yes again'], { dbPath });
      } finally {
        console.error = originalError;
      }
      assert.equal(again, 1, 'a completed (non-parked) run must refuse an answer');
      assert.ok(captured.join('\n').includes('only a parked run can be answered'), 'the refusal names the non-parked guard');
      const after = (await store.getDwfNodes(parked.runId)).filter((n) => n.kind === 'escalation');
      assert.equal(after.length, before.length, 'the refused answer journals no new escalation row');
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('per-actor provider routing: the actor ask goes to the selected provider; unknown provider fails loudly', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  const calls: string[] = [];
  const spy: LLMProvider = {
    id: 'dwf-spy-provider',
    name: 'Spy provider',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls.push(request.messages.find((m) => m.role === 'system')?.content ?? '');
      return new MockProvider().generate(request);
    },
  };
  providerRegistry.register(spy);
  const engine = new FacadeEngine({
    runId: 'dwfrun-provider-routing',
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
  });

  // actor routed to the spy provider
  const routed = await engine.handleCall({ t: 'call', id: 1, op: 'createActor', siteId: 'actor#1', payload: ['routed-agent', 'dwf-spy-provider'] });
  await engine.handleCall({ t: 'call', id: 2, op: 'ask', siteId: 'ask#1', payload: [routed, 'inspect health report of the service', null] });
  assert.match(calls[0] ?? '', /routed-agent/, 'the ask hit the spy provider (actor name in system prompt)');

  // default-route actor does NOT hit the spy
  const before = calls.length;
  const unrouted = await engine.handleCall({ t: 'call', id: 3, op: 'createActor', siteId: 'actor#2', payload: ['plain-agent', null] });
  await engine.handleCall({ t: 'call', id: 4, op: 'ask', siteId: 'ask#2', payload: [unrouted, 'inspect health report of the service', null] });
  assert.equal(calls.length, before, 'the unrouted ask went to the registry default, not the spy');

  // unknown provider fails loudly at creation
  await assert.rejects(
    () => engine.handleCall({ t: 'call', id: 5, op: 'createActor', siteId: 'actor#3', payload: ['bad-agent', 'no-such-provider'] }),
    // Tagged errors are plain objects — match the message, not String(err).
    { message: /unknown provider "no-such-provider"/ },
  );
  store.close();
});

test('doctor passes on a built tree', async () => {
  const exit = await executeDoctor({ json: true });
  assert.equal(exit, 0, 'a built tree with mock registered must be doctor-clean');
});
