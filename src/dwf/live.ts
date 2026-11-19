/**
 * Live execution server — serves the AI-Workflow Studio (single-file SPA,
 * `src/visualizer/studio-renderer.ts`) for a journalled run and streams journal
 * events to it over Server-Sent Events (GOAL.md 阶段 7 + Mission D 支柱二).
 *
 * `GET  /`             — the Studio shell (live mode: SSE client + A2UI forms).
 * `GET  /state`        — the full StudioSnapshot JSON (bootstrap; polling fallback).
 * `GET  /events`       — SSE: a `state` frame (full snapshot) then `event` frames
 *                        (raw journal events) as the journal grows.
 * `GET  /api/artifact` — `?id=` full artifact content JSON for the Inspector.
 * `POST /api/answer`   — `{questionId, text}` → journal an escalation answer + resume
 *                        (Human-in-the-Loop A2UI; wired by the serve command).
 * `POST /api/fill`     — `{holeName, body}` → fill a hole + amend-fork resume.
 *
 * Every route accepts `?run=<runId>` to override the bound run: a hole fill
 * forks the continuation under a NEW run id, and the Studio redirects so the
 * watcher follows the live lineage without losing the page.
 *
 * The journal is the single source of truth: the same projection renders a run
 * that is parked, running, or settled — attach it to a running script and
 * watch nodes land in real time (`workflow serve <runId>`).
 */

import { escapeHtml } from '../utils/escape-html.js';
import * as http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { DwfJournalStore, DwfNode, WorkflowEvent } from '../types.js';
import { projectEventsToGraph } from '../dag/journal-projection.js';
import { renderStudioHtml } from '../visualizer/studio-renderer.js';
import type { StudioSnapshot, StudioArtifact } from '../visualizer/studio-renderer.js';
import { renderStudioPage, attachStudioWebSocket } from '../visualizer/studio-server.js';
import type { StudioWebSocketHub } from '../visualizer/studio-server.js';

const KIND_ICON: Record<DwfNode['kind'], string> = {
  ask: '◆ ask',
  worldRead: '◇ read',
  worldRun: '▣ gate',
  artifact: '■ artifact',
  hole: '⌘ hole',
  report: '📣 report',
  escalation: '❓ escalate',
};


// ---------------------------------------------------------------------------
// Studio snapshot — the ONE projection the SPA renders (static embed + /state
// + SSE `state` frames all share it).
// ---------------------------------------------------------------------------

/** Per-artifact content cap for embedding (bigger artifacts stay metadata-only). */
const MAX_EMBEDDED_ARTIFACT_BYTES = 48_000;
/** Terminal keeps the latest slice of the raw event stream. */
const MAX_EMBEDDED_EVENTS = 400;

/**
 * The Studio SPA is the only view now, so a parked run's open escalation /
 * hole is derived here (`openQuestion` / `openHole`) and drives the A2UI form.
 * A parked run never records a completed node for the site it parked at, and
 * a fill forks the continuation under a new run id — so "no completed row for
 * this site in THIS run's journal" is exactly the open condition.
 */
function deriveOpenParks(nodes: DwfNode[], events: WorkflowEvent[]): {
  openQuestion: StudioSnapshot['openQuestion'];
  openHole: StudioSnapshot['openHole'];
} {
  const completedKinds = new Map<string, Set<DwfNode['kind']>>();
  for (const n of nodes) {
    if (n.status !== 'completed') continue;
    const set = completedKinds.get(n.siteId) ?? new Set<DwfNode['kind']>();
    set.add(n.kind);
    completedKinds.set(n.siteId, set);
  }
  let openQuestion: StudioSnapshot['openQuestion'] = null;
  let openHole: StudioSnapshot['openHole'] = null;
  for (const ev of events) {
    const d = ev.data as { siteId?: string; questionId?: string; question?: string; name?: string; prompt?: string };
    if (!d.siteId) continue;
    const done = completedKinds.get(d.siteId);
    if (ev.type === 'dwf_escalation_open' && !done?.has('escalation')) {
      openQuestion = { questionId: String(d.questionId ?? ''), siteId: d.siteId, question: String(d.question ?? '') };
    }
    if (ev.type === 'dwf_hole_open' && !done?.has('hole')) {
      openHole = { siteId: d.siteId, name: String(d.name ?? d.siteId), prompt: String(d.prompt ?? '') };
    }
  }
  return { openQuestion, openHole };
}

export async function buildStudioSnapshot(
  store: SQLiteStateStore & DwfJournalStore,
  runId: string,
  opts?: { live?: boolean },
): Promise<StudioSnapshot> {
  const run = await store.getDwfRun(runId);
  if (!run) throw new Error(`run "${runId}" not found in the journal`);
  const nodes = await store.getDwfNodes(runId);
  const events = await store.getEvents(runId);

  const graph = projectEventsToGraph(events);
  // Enrich graph nodes with the journal's typed results (the Inspector's
  // OUTPUT face): ask/escalation/hole nodes are keyed by their siteId, so the
  // latest journal row for that site carries resultJson / errorText.
  const resultBySite = new Map<string, DwfNode>();
  for (const n of nodes) {
    const prev = resultBySite.get(n.siteId);
    if (!prev || n.ordinal >= prev.ordinal) resultBySite.set(n.siteId, n);
  }
  for (const gn of graph.nodes) {
    const row = resultBySite.get(gn.id);
    if (!row) continue;
    if (row.resultJson) {
      try {
        gn.outputs = JSON.parse(row.resultJson);
      } catch {
        gn.outputs = row.resultJson;
      }
      if (typeof gn.outputs === 'string' && gn.outputs.length > 4000) {
        gn.outputs = gn.outputs.slice(0, 4000) + '…';
      }
    }
    if (row.errorText) gn.errorMessage = row.errorText.slice(0, 800);
  }
  const replayHits = events.filter((e) => e.type === 'dwf_replay_hit').length;
  const amendHits = events.filter((e) => e.type === 'dwf_amend_hit').length;
  const { openQuestion, openHole } = deriveOpenParks(nodes, events);

  const artifacts: StudioArtifact[] = [];
  const storeArtifacts = store.getArtifacts ? await store.getArtifacts(runId) : [];
  for (const a of storeArtifacts.slice(-20)) {
    artifacts.push({
      id: a.artifactId,
      name: a.name,
      type: a.artifactType,
      bytes: typeof a.content === 'string' ? a.content.length : 0,
      ...(typeof a.content === 'string' && a.content.length <= MAX_EMBEDDED_ARTIFACT_BYTES
        ? { content: a.content }
        : {}),
    });
  }

  return {
    mode: opts?.live ? 'live' : 'static',
    generatedAt: new Date().toISOString(),
    graph,
    run: {
      runId,
      status: run.status,
      scriptPath: run.scriptPath,
      parentRunId: run.parentRunId,
      argsJson: run.argsJson,
      scriptHash: run.scriptHash,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    stats: { nodeCount: nodes.length, replayHits, amendHits, eventCount: events.length },
    openQuestion,
    openHole,
    events: events.slice(-MAX_EMBEDDED_EVENTS).map((e) => ({
      type: e.type as string,
      data: e.data,
      timestamp: e.timestamp,
    })),
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/** A2UI resume actions, wired by the CLI layer (keeps dwf free of cli imports). */
export interface LiveServerActions {
  answer?: (runId: string, questionId: string, text: string) => Promise<{ ok: boolean; message: string; childRunId?: string }>;
  fill?: (runId: string, holeName: string, body: string) => Promise<{ ok: boolean; message: string; childRunId?: string }>;
}

export interface LiveServer {
  server: Server;
  /** The actual bound port (useful when requesting port 0). */
  port: number;
  close: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c.toString();
      if (raw.length > 1_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Issue #143 loopback guard
// ---------------------------------------------------------------------------
//
// Binding 127.0.0.1 stops off-machine clients but not the operator's own
// browser: any web page they visit can fire no-cors cross-origin POSTs at the
// parked run (`/api/fill` body = arbitrary compilable TS that a forked amend
// executes) and read the snapshot/WS broadcast. Browsers cannot forge Origin
// or Host, so the guard is two header checks:
//  - every request must carry a loopback Host header (DNS-rebinding shield);
//  - state-changing POSTs and `/ws` upgrades must carry no Origin at all
//    (operator tooling, curl, tests) or an Origin equal to this loopback
//    server (same-origin browser page) — anything else is a drive-by.

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function hostHeaderIsLoopback(hostHeader: string): boolean {
  try {
    return isLoopbackHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function originIsLoopbackSelf(origin: string, localPort: number): boolean {
  try {
    const parsed = new URL(origin);
    const port = parsed.port === '' ? '80' : parsed.port;
    return isLoopbackHostname(parsed.hostname) && port === String(localPort);
  } catch {
    return false;
  }
}

/** Issue #156 studio mode: SVG canvas page + zero-dep WebSocket push/time travel. */
export interface StartLiveServerOptions {
  /** Serve the SVG-canvas Studio page and attach the `/ws` WebSocket hub. */
  studio?: boolean;
  /** Issue #128: UI language for the legacy SSE studio page (default 'en'). */
  lang?: 'en' | 'zh';
  /**
   * The run's append-only `events.jsonl` — the time-travel seek data source
   * (falls back to the SQLite journal via the store when the mirror is absent).
   */
  eventsJsonlPath?: string;
}

export function startLiveServer(
  store: SQLiteStateStore & DwfJournalStore,
  runId: string,
  port = 4649,
  host = '127.0.0.1',
  actions?: LiveServerActions,
  opts?: StartLiveServerOptions,
): Promise<LiveServer> {
  const studio = opts?.studio === true;
  const liveLang: 'en' | 'zh' = opts?.lang === 'zh' ? 'zh' : 'en';
  const server = http.createServer((req, res) => {
    void handleRequest(store, runId, actions, req, res, studio, liveLang).catch((err: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  let studioHub: StudioWebSocketHub | undefined;
  let studioPoll: NodeJS.Timeout | undefined;
  if (studio) {
    studioHub = attachStudioWebSocket(server, {
      path: '/ws',
      eventsJsonlPath: opts?.eventsJsonlPath,
      loadEvents: () => store.getEvents(runId),
      // Issue #143: the /ws hub broadcasts raw journal events — a cross-origin
      // browser page must not read them. Same rule as the POST guard: no
      // Origin (non-browser client) or this loopback server's own origin.
      verifyRequest: (req) => {
        const origin = req.headers.origin;
        if (origin === undefined) return null;
        return originIsLoopbackSelf(String(origin), req.socket.localPort ?? 0)
          ? null
          : 'refused: cross-origin websocket handshake (Issue #143 loopback guard)';
      },
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      if (studioHub) {
        // Real-time push: poll the authoritative journal on the SSE cadence and
        // broadcast only the events that landed since the last tick. The
        // cursor starts at the current head so a freshly attached page is not
        // re-fed history (its boot snapshot already folds the whole stream).
        let cursor = 0;
        void store
          .getEvents(runId)
          .then((events) => {
            cursor = Math.max(0, ...events.map((e) => e.sequence ?? 0));
          })
          .catch(() => {});
        studioPoll = setInterval(() => {
          void (async () => {
            try {
              const events = await store.getEvents(runId);
              const fresh = events.filter((e) => (e.sequence ?? 0) > cursor);
              if (fresh.length === 0) return;
              cursor = Math.max(...fresh.map((e) => e.sequence ?? 0));
              for (const ev of fresh.slice(-300)) studioHub!.broadcastEvent(ev);
            } catch {
              /* journal hiccup — keep the poll alive */
            }
          })();
        }, 700);
      }
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            void (async () => {
              if (studioPoll) clearInterval(studioPoll);
              if (studioHub) await studioHub.close();
              server.close(() => resolveClose());
            })();
          }),
      });
    });
  });
}

async function handleRequest(
  store: SQLiteStateStore & DwfJournalStore,
  boundRunId: string,
  actions: LiveServerActions | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  studio = false,
  lang: 'en' | 'zh' = 'en',
): Promise<void> {
  const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = parsed.pathname;
  // `?run=` override: hole fills fork an amend under a new run id and the
  // Studio follows the lineage by reloading with the child id.
  const runId = parsed.searchParams.get('run') || boundRunId;
  const method = req.method ?? 'GET';

  // Issue #143: refuse any non-loopback Host before touching the journal —
  // browsers send Host verbatim, so a rebound name never reaches the data.
  if (!hostHeaderIsLoopback(String(req.headers.host ?? ''))) {
    sendJson(res, 403, { error: 'refused: non-loopback Host header (Issue #143 loopback guard)' });
    return;
  }

  if (method === 'GET' && path === '/state') {
    try {
      const snap = await buildStudioSnapshot(store, runId, { live: true });
      sendJson(res, 200, snap);
    } catch (err) {
      sendJson(res, 404, { error: (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    let cursor = 0;
    let closed = false;
    const send = (event: string, data: unknown): void => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const events = await store.getEvents(runId);
        const fresh = events.filter((e) => (e.sequence ?? 0) > cursor);
        if (fresh.length === 0) return;
        cursor = Math.max(...fresh.map((e) => e.sequence ?? 0));
        for (const ev of fresh.slice(-300)) {
          send('event', { type: ev.type, data: ev.data, timestamp: ev.timestamp });
          if (ev.type === 'dwf_thinking_delta') {
            send('thinking', { type: ev.type, data: ev.data, timestamp: ev.timestamp });
          }
        }
        send('state', await buildStudioSnapshot(store, runId, { live: true }));
      } catch {
        /* journal hiccup (e.g. run just pruned) — keep the stream alive */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 700);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    return;
  }

  if (method === 'GET' && path === '/api/artifact') {
    const id = parsed.searchParams.get('id') ?? '';
    const artifacts = store.getArtifacts ? await store.getArtifacts(runId) : [];
    const hit = artifacts.find((a) => a.artifactId === id);
    if (!hit) {
      sendJson(res, 404, { error: `artifact "${id}" not found on run "${runId}"` });
      return;
    }
    sendJson(res, 200, hit);
    return;
  }

  if (method === 'POST' && (path === '/api/answer' || path === '/api/fill')) {
    // Issue #143: a cross-origin browser POST is a drive-by — the Origin
    // header cannot be forged by a browser, so anything that is not this
    // loopback server (or absent, i.e. non-browser tooling) is refused
    // before the body is even read.
    const origin = req.headers.origin;
    const localPort = req.socket.localPort ?? 0;
    if (origin !== undefined && !originIsLoopbackSelf(String(origin), localPort)) {
      sendJson(res, 403, { ok: false, message: 'refused: cross-origin request (Issue #143 loopback guard)' });
      return;
    }
    const action = path === '/api/answer' ? actions?.answer : actions?.fill;
    if (!action) {
      sendJson(res, 501, { ok: false, message: 'A2UI resume actions are not wired for this server (start it via `workflow serve` or `run --ui`)' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: (err as Error).message });
      return;
    }
    try {
      if (path === '/api/answer') {
        const questionId = String(body.questionId ?? '').trim();
        const text = String(body.text ?? '');
        if (!questionId || !text.trim()) {
          sendJson(res, 400, { ok: false, message: 'questionId and text are required' });
          return;
        }
        sendJson(res, 200, await action(runId, questionId, text));
      } else {
        const holeName = String(body.holeName ?? '').trim();
        const fillBody = String(body.body ?? '');
        if (!holeName || !fillBody.trim()) {
          sendJson(res, 400, { ok: false, message: 'holeName and body are required' });
          return;
        }
        sendJson(res, 200, await action(runId, holeName, fillBody));
      }
    } catch (err) {
      sendJson(res, 200, { ok: false, message: (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/') {
    try {
      const snap = await buildStudioSnapshot(store, runId, { live: true });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (studio) {
        // Issue #156 studio mode: server-rendered SVG canvas + WebSocket push /
        // time travel (the `/ws` hub attached by startLiveServer).
        res.end(renderStudioPage(snap.graph, snap.events.length, { wsPath: '/ws' }));
      } else {
        res.end(renderStudioHtml(snap, { live: true, lang }));
      }
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`not found: ${escapeHtml((err as Error).message)}`);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
