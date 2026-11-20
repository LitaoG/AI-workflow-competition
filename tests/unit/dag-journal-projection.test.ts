/**
 * Journal projection (GOAL.md 阶段 7.3): the pure `projectEventsToGraph` fold
 * and the "活跑与冷回放同一投影" contract — a watched run (`--watch-graph`
 * re-folding the prefix after every emit) and a cold replay (`workflow graph`
 * folding the whole journal) must produce deeply-equal graphs and
 * byte-identical renders; dwf targets cold-replay through the graph command
 * from `events.jsonl` with the SQLite journal as fallback.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { projectEventsToGraph } from '../../src/dag/journal-projection.js';
import { HTMLRenderer } from '../../src/dag/html-renderer.js';
import { executeGraph } from '../../src/cli/commands/graph.js';
import { EventLogWriter, EventLogReader } from '../../src/state/event-log.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { runFacadeScript } from '../../src/dwf/runner.js';
import type { WorkflowEvent } from '../../src/domain/events.js';

/** Fake, self-made token shape — nothing here is a real credential. */
const FAKE_TOKEN = 'ghp_0123456789abcdefghij0123456789abcd';

let seq = 0;
function ev(type: WorkflowEvent['type'], data: unknown, timestamp: string, runId = 'dwfrun-proj'): WorkflowEvent {
  seq += 1;
  return { id: `e${seq}`, workflowId: 'facade-script', runId, type, timestamp, data };
}

/** A representative run stream: two phases, asks, a gate, an artifact, a failure. */
function sampleStream(): WorkflowEvent[] {
  return [
    ev('dwf_phase', { phase: 'research' }, '2026-11-01T10:00:00.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#1', actor: 'scout', prompt: 'scan the api_key=super-secret-1 service' }, '2026-11-01T10:00:01.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#1', actor: 'scout' }, '2026-11-01T10:00:02.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#2', actor: 'scout', prompt: 'second probe' }, '2026-11-01T10:00:03.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#2', actor: 'scout' }, '2026-11-01T10:00:04.000Z'),
    ev('dwf_phase', { phase: 'verify' }, '2026-11-01T10:00:05.000Z'),
    ev('dwf_world_run', { cmd: 'node', args: ['-e', 'smoke'] }, '2026-11-01T10:00:06.000Z'),
    ev('dwf_artifact', { id: 'report', version: 1, bytes: 12 }, '2026-11-01T10:00:07.000Z'),
    ev('dwf_node_failed', { kind: 'ask', siteId: 'ask#3', error: `boom ${FAKE_TOKEN}` }, '2026-11-01T10:00:08.000Z'),
    ev('dwf_completed', { status: 'completed' }, '2026-11-01T10:00:09.000Z'),
  ];
}

test('projection: incremental prefix folds and the one-shot cold fold are deeply equal and render byte-identically', () => {
  const full = sampleStream();

  const oneShot = projectEventsToGraph(full);
  // The live watch re-folds the accumulated PREFIX after every emit — the last
  // prefix fold is the whole stream, so it must equal the one-shot fold.
  let last = projectEventsToGraph(full.slice(0, 1));
  for (let end = 2; end <= full.length; end += 1) {
    last = projectEventsToGraph(full.slice(0, end));
  }
  assert.deepEqual(last, oneShot);
  assert.equal(new HTMLRenderer().render(last), new HTMLRenderer().render(oneShot));
});

test('projection: failure state lands on the node, dependency edges survive, free text is redacted', () => {
  const graph = projectEventsToGraph(sampleStream());

  const failed = graph.nodes.find((n) => n.id === 'ask#3');
  assert.ok(failed, 'the failed ask becomes a node');
  assert.equal(failed!.status, 'failed');
  assert.ok(failed!.errorMessage, 'failure reason is attached');
  assert.ok(!failed!.errorMessage!.includes(FAKE_TOKEN), 'the error text is redacted before the render boundary');

  // Per-phase creation-order chain: ask#2 depends on ask#1 inside phase 1, and
  // a failed node keeps its edges — failure highlights, it never amputates.
  assert.ok(graph.edges.length >= 1, 'dependency edges are kept');
  const ask2 = graph.nodes.find((n) => n.id === 'ask#2');
  assert.deepEqual(ask2!.dependsOn, ['ask#1']);

  // Site-less events key by what they carry; resume takeover is meta, no node.
  assert.ok(graph.nodes.some((n) => n.id === 'gate:node'), 'world.run gates project by command');
  assert.ok(graph.nodes.some((n) => n.id === 'artifact:report'), 'artifacts project by id');
});

test('projection: an empty stream yields an empty pending graph without throwing', () => {
  const graph = projectEventsToGraph([]);
  assert.equal(graph.status, 'pending');
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.phases.length, 0);
});

test('projection: dwf_parked lands as paused and is never counted as a failure (Issue #35)', () => {
  // A parked run's open escalation gate: the site stays running (the run resumes
  // there), the graph pauses — and the stream carries NO failed event to count.
  const stream = [
    ev('dwf_phase', { phase: 'approve' }, '2026-11-01T10:00:00.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#1', actor: 'inspector', prompt: 'inspect the service' }, '2026-11-01T10:00:01.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#1', actor: 'inspector' }, '2026-11-01T10:00:02.000Z'),
    ev('dwf_escalation_open', { siteId: 'escalation#1', questionId: 'dwfq-probe', question: 'approve?', inputHash: 'h' }, '2026-11-01T10:00:03.000Z'),
    ev('dwf_parked', { status: 'parked' }, '2026-11-01T10:00:04.000Z'),
  ];
  const graph = projectEventsToGraph(stream);
  assert.equal(graph.status, 'paused', 'a parked run projects as paused');
  assert.ok(!stream.some((e) => e.type === 'dwf_failed'), 'the parked stream must not contain a dwf_failed event for statistics to miscount');
  const gate = graph.nodes.find((n) => n.id === 'escalation#1');
  assert.ok(gate, 'the open escalation gate projects as a node');
  assert.equal(gate!.status, 'running', 'the site the run resumes at stays running');

  // The pre-#35 wire shape (dwf_failed carrying data.status "parked") still
  // projects as paused — journals persisted by older runners replay correctly.
  const legacy = projectEventsToGraph([
    ...stream.slice(0, -1),
    ev('dwf_failed', { status: 'parked' }, '2026-11-01T10:00:04.000Z'),
  ]);
  assert.equal(legacy.status, 'paused', 'legacy dwf_failed{status:"parked"} journals still project as paused');
});

test('graph command: a dwf run dir cold-replays through the same projection (events.jsonl preferred)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-graph-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runDir = path.join(root, '.workflow', 'runs', 'dwfrun-proj');
  fs.mkdirSync(runDir, { recursive: true });
  const writer = new EventLogWriter(runDir);
  for (const event of sampleStream()) writer.appendEvent(event);

  const outPath = path.join(root, 'graph.html');
  const code = await executeGraph(runDir, { format: 'html', output: outPath });
  assert.equal(code, 0, 'the dwf journal target renders via the graph command');
  const html = fs.readFileSync(outPath, 'utf-8');
  assert.ok(html.includes('<svg'), 'the exported graph is the HTML/SVG canvas');
  assert.ok(!html.includes(FAKE_TOKEN), 'redaction holds at the rendered artifact');
});

test('graph command: without the events.jsonl mirror the SQLite journal rebuilds the stream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-graph-db-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runDir = path.join(root, '.workflow', 'runs', 'dwfrun-proj');
  fs.mkdirSync(runDir, { recursive: true });
  const store = new SQLiteStateStore(path.join(root, '.workflow', 'dwf.sqlite'));
  try {
    for (const event of sampleStream()) await store.recordEvent(event);
  } finally {
    store.close();
  }
  // No events.jsonl in the run dir — the authoritative SQLite journal is the fallback source.

  const outPath = path.join(root, 'graph.html');
  const code = await executeGraph(runDir, { format: 'html', output: outPath });
  assert.equal(code, 0, 'the SQLite fallback rebuilds the stream');
  const html = fs.readFileSync(outPath, 'utf-8');
  assert.ok(html.includes('<svg'), 'the rebuilt stream renders the canvas');
  // The SQLite-rebuilt stream is the same events — the render must equal the
  // in-process projection of the sample stream byte-for-byte.
  const fromMirror = new HTMLRenderer().render(projectEventsToGraph(sampleStream()));
  assert.equal(html, fromMirror);
});

const WATCH_SCRIPT = `
phase("Inspect");
const health = await agent("inspector").ask<Health>("inspect the service");
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('watch-graph: a live run rewrites runs/<runId>/graph.html byte-identically to the cold replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-watch-'));
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the sandbox child may briefly hold the dir on Windows */
    }
  });
  const scriptPath = path.join(dir, 'script.facade.ts');
  fs.writeFileSync(scriptPath, WATCH_SCRIPT);

  const result = await runFacadeScript({ scriptPath, cwd: dir, watchGraph: true });
  assert.equal(result.status, 'completed', `run failed: ${result.error ?? JSON.stringify(result.diagnostics)}`);

  const runDir = path.join(dir, '.workflow', 'runs', result.runId);
  const watched = fs.readFileSync(path.join(runDir, 'graph.html'), 'utf-8');
  assert.ok(watched.includes('<svg'), 'the watched view is the HTML/SVG canvas');

  // THE contract: the live view of the stream equals the cold replay of the
  // same stream, byte for byte — one projection serves both.
  const cold = new HTMLRenderer().render(
    projectEventsToGraph(await EventLogReader.readAll(path.join(runDir, 'events.jsonl'))),
  );
  assert.equal(watched, cold);
});

test('projection: dwf_plan seeds the full pending skeleton; runtime events flip the same nodes in place (Issue #168)', () => {
  const plan = ev('dwf_plan', {
    phases: ['inspect', 'verify'],
    sites: [
      { siteId: 'ask#1', kind: 'ask', name: 'inspector', phase: 'inspect' },
      { siteId: 'hole#1', kind: 'hole', name: 'retry-budget', phase: 'inspect' },
      { siteId: 'ask#2', kind: 'ask', name: 'ask#2', phase: 'verify' },
    ],
  }, '2026-11-01T10:00:00.000Z');

  const graph = projectEventsToGraph([plan]);
  assert.deepEqual(graph.phases.map((p) => p.name), ['inspect', 'verify'], 'plan phase columns land in declaration order');
  assert.deepEqual(
    graph.nodes.map((n) => `${n.id}:${n.status}`),
    ['ask#1:pending', 'hole#1:pending', 'ask#2:pending'],
    'every planned site starts pending',
  );
  assert.deepEqual(graph.nodes[2].dependsOn, ['hole#1'], 'declaration order is the causal chain, across phases too');

  // Runtime events flip the SAME nodes — the plan is a skeleton, not a
  // parallel state machine: no duplicates, no dead second copy.
  const live = projectEventsToGraph([
    plan,
    ev('dwf_ask_start', { siteId: 'ask#1', actor: 'inspector', prompt: 'go' }, '2026-11-01T10:00:01.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#1', actor: 'inspector' }, '2026-11-01T10:00:02.000Z'),
  ]);
  assert.equal(live.nodes.length, 3, 'the fold reuses plan nodes — no duplicates');
  assert.equal(live.nodes.find((n) => n.id === 'ask#1')!.status, 'completed', 'the executed plan node flips in place');
  assert.equal(live.nodes.find((n) => n.id === 'ask#2')!.status, 'pending', 'a planned-but-never-executed node stays pending');

  // Prefix folds stay deep-equal to the one-shot fold (the byte-identity
  // contract of the live watch vs the cold replay holds with plans in stream).
  const stream = [plan, ...sampleStream()];
  const oneShot = projectEventsToGraph(stream);
  let last = projectEventsToGraph(stream.slice(0, 2));
  for (let end = 3; end <= stream.length; end += 1) {
    last = projectEventsToGraph(stream.slice(0, end));
  }
  assert.deepEqual(last, oneShot);
});

const PLAN_BRANCH_SCRIPT = `
phase("Inspect");
const health = await agent("inspector").ask<Health>("inspect the service");
if (health.healthStatus === "impossible-verdict") {
  const extra = await agent("inspector").ask<Health>("extra probe");
}
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('plan-first: a fresh run journals the plan skeleton and graph.html exists with never-executed branches pending (Issue #168)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-plan-'));
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the sandbox child may briefly hold the dir on Windows */
    }
  });
  const scriptPath = path.join(dir, 'script.facade.ts');
  fs.writeFileSync(scriptPath, PLAN_BRANCH_SCRIPT);

  // No watchGraph option — the watch view is the DEFAULT now; the result
  // surfaces the live graph path so hosts can point the user at it.
  const result = await runFacadeScript({ scriptPath, cwd: dir });
  assert.equal(result.status, 'completed', `run failed: ${result.error ?? JSON.stringify(result.diagnostics)}`);
  const runDir = path.join(dir, '.workflow', 'runs', result.runId);
  assert.ok(result.graphPath, 'the result carries the live graph path by default');
  assert.equal(result.graphPath, path.join(runDir, 'graph.html'));

  const events = await EventLogReader.readAll(path.join(runDir, 'events.jsonl'));
  const plans = events.filter((e) => e.type === 'dwf_plan');
  assert.equal(plans.length, 1, 'exactly one plan event per fresh run');
  const firstAskIndex = events.findIndex((e) => e.type === 'dwf_ask_start');
  assert.ok(firstAskIndex > events.findIndex((e) => e.type === 'dwf_plan'), 'the plan precedes every runtime node event');
  const planData = plans[0]!.data as { phases: string[]; sites: Array<{ siteId: string; kind: string; name: string; phase: string }> };
  assert.deepEqual(planData.phases, ['Inspect']);
  // Site ids share one compile counter, and the .ask() call is visited before
  // its receiver agent() declaration: phase#1, ask#2, actor#3, ask#4, actor#5…
  assert.ok(planData.sites.some((s) => s.siteId === 'ask#2'), 'the executed ask is planned');
  const branchAsk = planData.sites.find((s) => s.siteId === 'ask#4');
  assert.ok(branchAsk, 'the conditional-branch ask is planned even though it never runs');

  // The live graph shows the whole plan: the branch body stays pending.
  const graph = projectEventsToGraph(events);
  const pendingBranch = graph.nodes.find((n) => n.id === 'ask#4');
  assert.ok(pendingBranch, 'the never-executed plan node exists in the graph');
  assert.equal(pendingBranch!.status, 'pending');
  const watched = fs.readFileSync(result.graphPath, 'utf-8');
  assert.ok(watched.includes('ask#4'), 'the rendered graph.html carries the pending plan node');
});

test('projection: dwf_plan_update grows the plan mid-run — boxes, lines, idempotence, dangling-edge skip (Issue #171)', () => {
  const stream = [
    ev('dwf_phase', { phase: 'Triage' }, '2026-11-01T10:00:00.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#2', actor: 'scout', prompt: 'triage' }, '2026-11-01T10:00:01.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#2', actor: 'scout' }, '2026-11-01T10:00:02.000Z'),
    // The script adjusts the plan mid-run: one node in a NEW phase column, one in the
    // current (default) column, a genuine back edge, and junk edges that must not ghost.
    ev('dwf_plan_update', {
      siteId: 'plan#1',
      nodes: [
        { id: 'deep-dive', name: 'Deep-dive root cause', phase: 'Deep-dive' },
        { id: 'follow-up', name: 'Follow-up' },
      ],
      edges: [
        { from: 'follow-up', to: 'ask#2' },
        { from: 'ask#2', to: 'deep-dive' },   // duplicates the creation-order chain edge
        { from: 'deep-dive', to: 'follow-up' }, // duplicates the chain edge too
        { from: 'deep-dive', to: 'future-ask' }, // dangling: endpoint never declared → skipped
        { from: 'follow-up', to: 'follow-up' }, // self-loop → skipped
        { from: 'follow-up', to: 'ask#2' }, // exact duplicate of the first → skipped
      ],
    }, '2026-11-01T10:00:03.000Z'),
    ev('dwf_completed', { status: 'completed' }, '2026-11-01T10:00:04.000Z'),
  ];
  const graph = projectEventsToGraph(stream);

  assert.deepEqual(graph.phases.map((p) => p.name), ['Triage', 'Deep-dive'], 'a new phase column is created on declaration');
  const deep = graph.nodes.find((n) => n.id === 'deep-dive');
  const follow = graph.nodes.find((n) => n.id === 'follow-up');
  assert.ok(deep && follow, 'both declared boxes exist');
  assert.equal(deep!.status, 'pending', 'declared plan nodes start pending — settle never flips pending');
  assert.equal(deep!.phaseName, 'Deep-dive');
  assert.equal(follow!.phaseName, 'Triage', 'default column is the fold’s current phase');
  assert.ok(graph.edges.some((e) => e.fromNodeId === 'follow-up' && e.toNodeId === 'ask#2'), 'the declared back edge renders');
  const dupCount = graph.edges.filter((e) => e.fromNodeId === 'ask#2' && e.toNodeId === 'deep-dive').length;
  assert.equal(dupCount, 1, 'a declared edge duplicating the chain edge stays single');
  assert.ok(!graph.edges.some((e) => e.toNodeId === 'future-ask' || e.fromNodeId === 'future-ask'), 'dangling endpoints never enter the fold');
  assert.equal(graph.edges.filter((e) => e.fromNodeId === 'follow-up' && e.toNodeId === 'ask#2').length, 1, 'exact duplicate declarations are idempotent');

  // An edge to a LATER real site renders once the node appears.
  const later = projectEventsToGraph([
    ...stream.slice(0, -1),
    ev('dwf_ask_start', { siteId: 'future-ask', actor: 'scout', prompt: 'now exists' }, '2026-11-01T10:00:03.500Z'),
    ev('dwf_completed', { status: 'completed' }, '2026-11-01T10:00:04.000Z'),
  ]);
  assert.ok(later.edges.some((e) => e.fromNodeId === 'deep-dive' && e.toNodeId === 'future-ask'), 'the declared edge renders once the endpoint exists');
  assert.equal(later.nodes.find((n) => n.id === 'future-ask')!.status, 'completed', 'the real site still runs its own lifecycle');

  // Prefix folds stay deep-equal to the one-shot fold.
  const oneShot = projectEventsToGraph(stream);
  let last = projectEventsToGraph(stream.slice(0, 2));
  for (let end = 3; end <= stream.length; end += 1) last = projectEventsToGraph(stream.slice(0, end));
  assert.deepEqual(last, oneShot);
});

const PLAN_UPDATE_SCRIPT = `
phase("Inspect");
const health = await agent("inspector").ask<Health>("inspect the service");
// Mid-run plan adjustment: the script decides the follow-up structure at runtime.
const focus = health.healthStatus.split(" ")[0] || "root-cause";
plan({
  nodes: [
    { id: "deep-dive", name: "Deep-dive " + focus, phase: "Deep-dive" },
    { id: "writeup", name: "Write the note" },
  ],
  edges: [
    { from: "deep-dive", to: "writeup" },
    { from: "writeup", to: "ask#2" },
  ],
});
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus, focus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('plan-update: plan() mid-run journals the adjustment and graph.html grows boxes/lines (Issue #171)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-plan-update-'));
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the sandbox child may briefly hold the dir on Windows */
    }
  });
  const scriptPath = path.join(dir, 'script.facade.ts');
  fs.writeFileSync(scriptPath, PLAN_UPDATE_SCRIPT);

  const result = await runFacadeScript({ scriptPath, cwd: dir });
  assert.equal(result.status, 'completed', `run failed: ${result.error ?? JSON.stringify(result.diagnostics)}`);
  const runDir = path.join(dir, '.workflow', 'runs', result.runId);
  assert.ok(result.graphPath, 'the default-on watch view surfaces the graph path');

  const events = await EventLogReader.readAll(path.join(runDir, 'events.jsonl'));
  const updates = events.filter((e) => e.type === 'dwf_plan_update');
  assert.equal(updates.length, 1, 'exactly one plan_update event per plan() call');
  assert.ok(
    events.findIndex((e) => e.type === 'dwf_plan_update') > events.findIndex((e) => e.type === 'dwf_ask_start'),
    'the adjustment lands after the ask that informed it',
  );

  const graph = projectEventsToGraph(events);
  const deep = graph.nodes.find((n) => n.id === 'deep-dive');
  assert.ok(deep, 'the declared box exists in the graph');
  assert.equal(deep!.status, 'pending', 'the declared box stays pending — nothing executed it');
  assert.equal(deep!.phaseName, 'Deep-dive', 'the declared phase column was created');
  assert.ok(graph.edges.some((e) => e.fromNodeId === 'writeup' && e.toNodeId === 'ask#2'), 'the declared line to the real site renders');
  const watched = fs.readFileSync(result.graphPath!, 'utf-8');
  assert.ok(watched.includes('deep-dive'), 'the rendered graph.html carries the declared box');
});
