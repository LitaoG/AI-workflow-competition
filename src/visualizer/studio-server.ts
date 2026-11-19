/**
 * AI-Workflow Studio — WebSocket live push + time travel (Issue #156).
 *
 * Two capabilities, one RFC 6455 endpoint (default path `/ws`), ZERO npm
 * dependencies (P0 supply-chain red line — the protocol is implemented here on
 * top of a node:http server's `upgrade` event):
 *
 * a. REAL-TIME PUSH — `broadcastEvent(ev)` frames a new journal event as one
 *    JSON text frame (`{"op":"event","event":…}`) to every open connection.
 *    The caller (dwf/live.ts in studio mode) feeds it from its journal.
 *
 * b. TIME TRAVEL — a client sends `{"op":"seek","ordinal":N}`; the server
 *    folds the FIRST N events of the run's append-only `events.jsonl` (read
 *    through the {@link EventLogReader} face of src/state/event-log.ts; the
 *    SQLite journal is the fallback source when the mirror is absent) into a
 *    state snapshot and replies `{"op":"snapshot","ordinal":N,"graph":…,"svg":…}`.
 *    The fold REUSES the one canonical projector (`projectEventsToGraph`,
 *    src/dag/journal-projection.ts) via {@link foldEvents} — no second state
 *    machine can drift from the runner's own view. New connections are greeted
 *    with the fold of the whole stream, so the canvas boots at "now".
 *
 * The studio page (`renderStudioPage`) is a minimal self-contained shell: it
 * embeds the boot snapshot, replaces the SVG on every `snapshot` frame, logs
 * `event` frames into a feed, and drives both the live follow and the
 * time-travel slider through the same seek op.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';
import { EventLogReader } from '../state/event-log.js';
import { WorkflowEvent, DAGGraph } from '../types.js';
import { projectEventsToGraph } from '../dag/journal-projection.js';
import { renderSvgCanvas } from './svg-canvas.js';
import { attachWebSocketEndpoint, CLOSE_NORMAL, WebSocketConnection } from './ws-endpoint.js';

// The RFC 6455 core and the page shell keep their historical import surface
// (tests and tooling resolve the protocol primitives from this module).
export {
  OP_CONTINUATION,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_BIG,
  computeSecWebSocketAccept,
  encodeFrame,
  decodeFrames,
  WebSocketConnection,
  attachWebSocketEndpoint,
} from './ws-endpoint.js';
export type {
  FrameEncodeOptions,
  DecodedFrame,
  DecodeResult,
  WebSocketEndpointOptions,
  WebSocketEndpoint,
} from './ws-endpoint.js';
export { renderStudioPage } from './studio-page.js';
export type { StudioPageOptions } from './studio-page.js';

// ---------------------------------------------------------------------------
// Time travel — the fold
// ---------------------------------------------------------------------------

/**
 * Fold the first `uptoOrdinal` events of the stream into the state snapshot at
 * that point of the run. PURE and deterministic: `ordinal` is the 1-based
 * stream position (the count of leading events to apply); 0 yields the empty
 * graph; a value beyond the stream length folds everything. The fold itself is
 * the canonical `projectEventsToGraph` — the SAME projector the live watch,
 * the cold replay and the Studio snapshot already share.
 */
export function foldEvents(events: readonly WorkflowEvent[], uptoOrdinal: number): DAGGraph {
  const n = Number.isFinite(uptoOrdinal) ? Math.max(0, Math.floor(uptoOrdinal)) : 0;
  return projectEventsToGraph(events.slice(0, n));
}


export interface StudioWebSocketOptions {
  /** Required upgrade path (default `/ws`). */
  path?: string;
  /** The run's append-only `events.jsonl` — the time-travel data source. */
  eventsJsonlPath?: string;
  /** Fallback event source when the mirror is absent (e.g. SQLite journal). */
  loadEvents?: () => Promise<WorkflowEvent[]>;
  /** Issue #143: extra handshake gate — return an error message to reject with 403, null to accept. */
  verifyRequest?: (req: IncomingMessage) => string | null;
}

export interface StudioWebSocketHub {
  /** Broadcast one journal event as `{"op":"event","event":…}` to all connections. */
  broadcastEvent(event: WorkflowEvent): void;
  /** Currently open connections. */
  connectionCount(): number;
  /** Close every connection and detach the upgrade listener. */
  close(): Promise<void>;
}

/**
 * The Studio protocol on top of the generic endpoint:
 * - greet every new connection with the full-stream fold (`snapshot`),
 * - answer `{"op":"seek","ordinal":N}` with the prefix-fold snapshot,
 * - expose {@link StudioWebSocketHub.broadcastEvent} for real-time push.
 */
export function attachStudioWebSocket(server: Server, opts: StudioWebSocketOptions = {}): StudioWebSocketHub {
  const connections = new Set<WebSocketConnection>();

  const loadEvents = async (): Promise<WorkflowEvent[]> => {
    if (opts.eventsJsonlPath && fs.existsSync(opts.eventsJsonlPath)) {
      return EventLogReader.readAll(opts.eventsJsonlPath);
    }
    if (opts.loadEvents) return opts.loadEvents();
    return [];
  };

  const sendSnapshot = async (conn: WebSocketConnection, ordinal: number): Promise<void> => {
    const events = await loadEvents();
    const n = Number.isFinite(ordinal)
      ? Math.max(0, Math.min(Math.floor(ordinal), events.length))
      : events.length;
    const graph = foldEvents(events, n);
    conn.sendText(JSON.stringify({ op: 'snapshot', ordinal: n, graph, svg: renderSvgCanvas(graph) }));
  };

  const handleClientMessage = async (conn: WebSocketConnection, text: string): Promise<void> => {
    let msg: { op?: unknown; ordinal?: unknown };
    try {
      msg = JSON.parse(text) as { op?: unknown; ordinal?: unknown };
    } catch {
      conn.sendText(JSON.stringify({ op: 'error', message: 'frames must be JSON' }));
      return;
    }
    if (msg && msg.op === 'seek') {
      const ordinal = typeof msg.ordinal === 'number' ? msg.ordinal : Number(msg.ordinal);
      if (!Number.isFinite(ordinal)) {
        conn.sendText(JSON.stringify({ op: 'error', message: 'seek requires a numeric "ordinal"' }));
        return;
      }
      try {
        await sendSnapshot(conn, ordinal);
      } catch (err) {
        conn.sendText(JSON.stringify({ op: 'error', message: `seek failed: ${(err as Error).message}` }));
      }
      return;
    }
    conn.sendText(JSON.stringify({ op: 'error', message: `unknown op ${String(msg && msg.op)}` }));
  };

  const endpoint = attachWebSocketEndpoint(server, {
    path: opts.path ?? '/ws',
    verifyRequest: opts.verifyRequest,
    onText: (conn, text) => void handleClientMessage(conn, text),
    onConnection: (conn) => {
      connections.add(conn);
      conn.onClose = (c) => connections.delete(c);
      void sendSnapshot(conn, Number.POSITIVE_INFINITY).catch(() => {
        /* journal hiccup — the client can still seek explicitly */
      });
    },
  });

  return {
    broadcastEvent(event: WorkflowEvent): void {
      const frame = JSON.stringify({ op: 'event', event });
      for (const conn of connections) conn.sendText(frame);
    },
    connectionCount(): number {
      return connections.size;
    },
    async close(): Promise<void> {
      endpoint.detach();
      const sockets = [...connections];
      connections.clear();
      for (const conn of sockets) conn.sendClose(CLOSE_NORMAL);
      await new Promise<void>((resolve) => {
        if (sockets.length === 0) return resolve();
        let left = sockets.length;
        const done = (): void => {
          if (--left <= 0) resolve();
        };
        for (const conn of sockets) {
          conn.socket.end(() => done());
          const t = setTimeout(done, 250);
          t.unref?.();
        }
      });
    },
  };
}
