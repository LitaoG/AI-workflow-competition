/**
 * Journal projection (引擎的图投影规则): the pure `projectEventsToGraph` fold
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
const FAKE_TOKEN = 'gho_0123456789abcdefghij0123456789abcd';

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
