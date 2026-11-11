/**
 * Studio server end-to-end tests (Issue #156): a real http server on a random
 * port, a raw-socket WS client, the events.jsonl time-travel data source, the
 * seek→fold snapshot contract, real-time broadcast, the loadEvents fallback,
 * and the dwf/live.ts studio wiring (`GET /` serves the SVG canvas page).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { EventLogWriter } from '../../../src/state/event-log.js';
import { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import {
  attachStudioWebSocket,
  foldEvents,
  renderStudioPage,
  type StudioWebSocketHub,
} from '../../../src/visualizer/studio-server.js';
import { startLiveServer } from '../../../src/dwf/live.js';
import type { WorkflowEvent } from '../../../src/types.js';
import { connectWs, type TestWsClient } from './ws-client.js';

/** A four-event stream that exercises the fold: phase → ask running → ask done → run completed. */
function streamEvents(): Array<Omit<WorkflowEvent, 'id' | 'sequence' | 'timestamp'>> {
  return [
    { runId: 'r-studio', workflowId: 'wf-studio', type: 'dwf_phase', data: { phase: 'Build' } },
    { runId: 'r-studio', workflowId: 'wf-studio', type: 'dwf_ask_start', data: { siteId: 's1', actor: 'worker-a', prompt: 'do it' } },
    { runId: 'r-studio', workflowId: 'wf-studio', type: 'dwf_ask_complete', data: { siteId: 's1' } },
    { runId: 'r-studio', workflowId: 'wf-studio', type: 'dwf_completed', data: {} },
  ];
}

/** Write the stream to a fresh temp dir's events.jsonl via the production writer. Returns the dir. */
function writeEventsJsonl(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const writer = new EventLogWriter(dir);
  for (const ev of streamEvents()) writer.record(ev);
  writer.close();
  return dir;
}

interface RunningStudio {
  port: number;
  hub: StudioWebSocketHub;
  server: http.Server;
  close: () => Promise<void>;
}

async function startStudio(opts: { eventsJsonlPath?: string; loadEvents?: () => Promise<WorkflowEvent[]> } = {}): Promise<RunningStudio> {
  const server = http.createServer(() => {});
  const hub = attachStudioWebSocket(server, { path: '/ws', ...opts });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hub,
    server,
    close: async () => {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface SnapshotFrame {
  op: string;
  ordinal: number;
  graph: {
    runId: string;
    status: string;
    nodes: Array<{ id: string; status: string; durationMs?: number }>;
    edges: unknown[];
    phases: Array<{ name: string }>;
  };
  svg: string;
}

test('time travel fold: prefix folds reuse the canonical projector (pure, deterministic)', () => {
  const events = streamEvents().map((e, i) => ({
    id: `evt-${i + 1}`,
    sequence: i + 1,
    timestamp: `2026-01-01T00:00:0${i}.000Z`,
    ...e,
  })) as WorkflowEvent[];
  // ordinal 0 → the empty pending graph; 2 → ask running; 3 → ask completed; beyond → everything.
  assert.equal(foldEvents(events, 0).status, 'pending');
  assert.equal(foldEvents(events, 0).nodes.length, 0);
  const atTwo = foldEvents(events, 2);
  assert.equal(atTwo.nodes.length, 1);
  assert.equal(atTwo.nodes[0]!.status, 'running');
  const atThree = foldEvents(events, 3);
  assert.equal(atThree.nodes[0]!.status, 'completed');
  assert.ok(Number.isFinite(atThree.nodes[0]!.durationMs), 'duration folded from the two timestamps');
  const beyond = foldEvents(events, 999);
  assert.equal(beyond.status, 'completed');
  assert.deepEqual(beyond, foldEvents(events, 4), 'folding beyond the stream length is stable');
});

test('WS connect → greeting snapshot folds the whole events.jsonl stream', async () => {
  const dir = writeEventsJsonl('studio-ws-greet');
  const ep = await startStudio({ eventsJsonlPath: path.join(dir, 'events.jsonl') });
  try {
    const client: TestWsClient = await connectWs(ep.port);
    try {
      const snap = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(snap.op, 'snapshot');
      assert.equal(snap.ordinal, 4, 'greet ordinal = stream length');
      assert.equal(snap.graph.status, 'completed');
      assert.equal(snap.graph.nodes[0]!.status, 'completed');
      assert.ok(snap.svg.startsWith('<svg'), 'the snapshot carries the rendered canvas');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seek to a mid-stream ordinal folds the first N events into a snapshot', async () => {
  const dir = writeEventsJsonl('studio-ws-seek');
  const ep = await startStudio({ eventsJsonlPath: path.join(dir, 'events.jsonl') });
  try {
    const client = await connectWs(ep.port);
    try {
      await client.nextJson(); // greeting
      client.sendText(JSON.stringify({ op: 'seek', ordinal: 2 }));
      const snap = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(snap.op, 'snapshot');
      assert.equal(snap.ordinal, 2);
      assert.equal(snap.graph.status, 'running', 'run still in flight at event 2');
      assert.equal(snap.graph.nodes[0]!.status, 'running', 'ask node in flight at event 2');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seek 0 folds the empty prefix; seek beyond the stream clamps to the head', async () => {
  const dir = writeEventsJsonl('studio-ws-bounds');
  const ep = await startStudio({ eventsJsonlPath: path.join(dir, 'events.jsonl') });
  try {
    const client = await connectWs(ep.port);
    try {
      await client.nextJson(); // greeting
      client.sendText(JSON.stringify({ op: 'seek', ordinal: 0 }));
      const atZero = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(atZero.ordinal, 0);
      assert.equal(atZero.graph.nodes.length, 0);
      assert.equal(atZero.graph.status, 'pending');

      client.sendText(JSON.stringify({ op: 'seek', ordinal: 99 }));
      const clamped = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(clamped.ordinal, 4, 'clamped to the stream length');
      assert.equal(clamped.graph.status, 'completed');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('broadcastEvent frames the raw event JSON to every open connection', async () => {
  const dir = writeEventsJsonl('studio-ws-push');
  const ep = await startStudio({ eventsJsonlPath: path.join(dir, 'events.jsonl') });
  try {
    const c1 = await connectWs(ep.port);
    const c2 = await connectWs(ep.port);
    try {
      await c1.nextJson(); // greetings
      await c2.nextJson();
      assert.equal(ep.hub.connectionCount(), 2);
      const fresh: WorkflowEvent = {
        id: 'evt-5',
        sequence: 5,
        timestamp: '2026-01-01T00:00:05.000Z',
        runId: 'r-studio',
        workflowId: 'wf-studio',
        type: 'dwf_log',
        data: { message: 'live push' },
      };
      ep.hub.broadcastEvent(fresh);
      for (const c of [c1, c2]) {
        const frame = await c.nextJson();
        assert.equal(frame.op, 'event');
        const ev = frame.event as Record<string, unknown>;
        assert.equal(ev.type, 'dwf_log');
        assert.equal(ev.sequence, 5);
      }
    } finally {
      c1.destroy();
      c2.destroy();
    }
  } finally {
    await ep.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without events.jsonl the seek falls back to the injected loadEvents source', async () => {
  const events = streamEvents().map((e, i) => ({
    id: `evt-${i + 1}`,
    sequence: i + 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...e,
  })) as WorkflowEvent[];
  const ep = await startStudio({ loadEvents: async () => events });
  try {
    const client = await connectWs(ep.port);
    try {
      const greet = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(greet.ordinal, 4, 'greeting folds the fallback source');
      client.sendText(JSON.stringify({ op: 'seek', ordinal: 2 }));
      const snap = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(snap.ordinal, 2);
      assert.equal(snap.graph.nodes[0]!.status, 'running');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('non-JSON and unknown ops answer with an error frame, never a crash', async () => {
  const ep = await startStudio({ loadEvents: async () => [] });
  try {
    const client = await connectWs(ep.port);
    try {
      await client.nextJson(); // greeting (empty fold)
      client.sendText('this is not json');
      const e1 = await client.nextJson();
      assert.equal(e1.op, 'error');
      client.sendText(JSON.stringify({ op: 'teleport' }));
      const e2 = await client.nextJson();
      assert.equal(e2.op, 'error');
      assert.match(String(e2.message), /teleport/);
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('hub.close detaches the endpoint and drains every connection', async () => {
  const ep = await startStudio({ loadEvents: async () => [] });
  const client = await connectWs(ep.port);
  await client.nextJson(); // greeting
  assert.equal(ep.hub.connectionCount(), 1);
  // Register the socket-close watcher BEFORE closing (the FIN may land before
  // a post-close registration, which would miss the event and flake).
  const closed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    client.socket.on('close', () => {
      clearTimeout(t);
      resolve(true);
    });
    void ep.hub.close().then(() => {
      assert.equal(ep.hub.connectionCount(), 0);
    });
  });
  assert.ok(closed, 'hub.close tears down open sockets');
  client.destroy();
  await ep.close();
});

test('renderStudioPage embeds the boot snapshot, the SVG canvas and the WS client', () => {
  const graph = foldEvents(
    streamEvents().map((e, i) => ({
      id: `evt-${i + 1}`,
      sequence: i + 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      ...e,
    })) as WorkflowEvent[],
    4,
  );
  const html = renderStudioPage(graph, 4, { wsPath: '/ws' });
  assert.ok(html.includes('window.__STUDIO__'), 'boot snapshot embedded');
  assert.ok(html.includes('\\u003csvg'), 'boot SVG canvas embedded (script-escaped)');
  assert.ok(html.includes('op: \'seek\''), 'the client drives the same seek op for time travel');
  assert.ok(html.includes('/ws'), 'ws path present');
  assert.ok(html.includes('type="range"'), 'time-travel slider present');
  assert.ok(!html.includes('<script>window.__STUDIO__ = {{'), 'no placeholder residue');
});

test('dwf/live.ts studio wiring: GET / serves the SVG page and /ws greets with a fold', async () => {
  const store = new SQLiteStateStore(':memory:');
  await store.saveDwfRun({ runId: 'r-wired', scriptHash: 'hash', status: 'running' });
  // Index-based ids + THIS run's id: streamEvents() carries runId 'r-studio'
  // for the other tests — the spread must override it or the rows land under
  // a run the hub never queries.
  const stream = streamEvents();
  for (let i = 0; i < stream.length; i++) {
    await store.recordEvent({
      ...stream[i],
      runId: 'r-wired',
      id: `evt-${i + 1}`,
      sequence: i + 1,
      timestamp: '2026-01-01T00:00:00.000Z',
    } as WorkflowEvent);
  }
  let live: Awaited<ReturnType<typeof startLiveServer>> | undefined;
  try {
    live = await startLiveServer(store, 'r-wired', 0, '127.0.0.1', undefined, { studio: true });
    const base = `http://127.0.0.1:${live.port}`;
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('window.__STUDIO__'), 'studio page served');
    assert.ok(page.includes('\\u003csvg'), 'server-rendered canvas embedded (script-escaped)');
    const client = await connectWs(live.port, '/ws');
    try {
      const snap = (await client.nextJson()) as unknown as SnapshotFrame;
      assert.equal(snap.op, 'snapshot');
      assert.equal(snap.ordinal, 4, 'SQLite journal fed the greeting fold');
      assert.equal(snap.graph.status, 'completed');
    } finally {
      client.destroy();
    }
  } finally {
    if (live) await live.close();
    store.close();
  }
});
