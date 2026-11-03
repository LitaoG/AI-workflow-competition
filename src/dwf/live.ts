/**
 * Live execution view — a zero-dependency HTTP server that serves a
 * self-refreshing HTML view of a journalled run (引擎交互式画布,
 * live half).
 *
 * `GET /`     — the shell: dark-theme page whose script polls /state and
 *               re-renders phases/nodes/escalations as the journal grows.
 * `GET /state`— the projection: run row + nodes + derived badges as JSON.
 *
 * The journal is the single source of truth: the same projection renders a
 * run that is parked, running, or settled — attach it to a running script and
 * watch nodes land in real time (`workflow serve <runId>`).
 */

import * as http from 'node:http';
import type { Server } from 'node:http';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { DwfJournalStore, DwfNode, WorkflowEvent } from '../types.js';
import { groupNodesByPhase } from './view.js';

const KIND_ICON: Record<DwfNode['kind'], string> = {
  ask: '◆ ask',
  worldRead: '◇ read',
  worldRun: '▣ gate',
  artifact: '■ artifact',
  hole: '⌘ hole',
  report: '📣 report',
  escalation: '❓ escalate',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface LiveProjection {
  runId: string;
  status: string;
  scriptPath?: string;
  parentRunId?: string;
  argsJson?: string;
  updatedAt?: string;
  nodeCount: number;
  replayHits: number;
  amendHits: number;
  phases: Array<{ title: string; nodes: Array<{ siteId: string; ordinal: number; kind: string; status: string; durationMs?: number; resultJson?: string; errorText?: string }> }>;
  escalations: Array<{ siteId: string; status: string; question?: string; answer?: string }>;
  eventCount: number;
}

export async function projectRun(store: SQLiteStateStore & DwfJournalStore, runId: string): Promise<LiveProjection> {
  const run = await store.getDwfRun(runId);
  if (!run) throw new Error(`run "${runId}" not found in the journal`);
  const nodes = await store.getDwfNodes(runId);
  const events: WorkflowEvent[] = await store.getEvents(runId);

  const questionOf = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === 'dwf_escalation_open') {
      const d = ev.data as { siteId?: string; question?: string };
      if (d.siteId && d.question) questionOf.set(d.siteId, d.question);
    }
  }
  const replayHits = events.filter((e) => e.type === 'dwf_replay_hit').length;
  const amendHits = events.filter((e) => e.type === 'dwf_amend_hit').length;

  return {
    runId,
    status: run.status,
    scriptPath: run.scriptPath,
    parentRunId: run.parentRunId,
    argsJson: run.argsJson,
    updatedAt: run.updatedAt,
    nodeCount: nodes.length,
    replayHits,
    amendHits,
    phases: groupNodesByPhase(nodes, events).map((g) => ({
      title: g.title,
      nodes: g.nodes.map((n) => ({
        siteId: n.siteId,
        ordinal: n.ordinal,
        kind: n.kind,
        status: n.status,
        durationMs: n.durationMs,
        resultJson: n.resultJson ? n.resultJson.slice(0, 1200) : undefined,
        errorText: n.errorText ? n.errorText.slice(0, 600) : undefined,
      })),
    })),
    escalations: nodes
      .filter((n) => n.kind === 'escalation')
      .map((n) => ({
        siteId: n.siteId,
        status: n.status,
        question: questionOf.get(n.siteId),
        answer: n.resultJson ? JSON.parse(n.resultJson) : undefined,
      })),
    eventCount: events.length,
  };
}

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AI-Workflow live</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; border-bottom: 1px solid #21262d; padding-bottom: .3rem; margin-top: 1.4rem; }
  .meta, .dim { color: #8b949e; font-size: .85rem; }
  .ok { color: #3fb950; } .bad { color: #f85149; } .warn { color: #d29922; }
  .node { padding: .45rem .6rem; border: 1px solid #21262d; border-radius: 6px; margin: .35rem 0; }
  .q { color: #d29922; margin-top: .25rem; } .a { color: #3fb950; }
  pre { background: #161b22; padding: .5rem; border-radius: 6px; overflow-x: auto; font-size: .8rem; white-space: pre-wrap; }
  .err { color: #f85149; }
  .badges span { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: .1rem .55rem; margin-right: .4rem; font-size: .8rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%%; background: #3fb950; margin-right: 6px; animation: pulse 1.2s infinite; }
  @keyframes pulse { 50%% { opacity: .3; } }
</style></head><body>
<h1><span class="dot"></span>AI-Workflow live — <span id="runid"></span></h1>
<p class="badges" id="badges"></p>
<p class="meta" id="meta"></p>
<div id="content"></div>
<p class="dim">polling the journal every 1.2s — same projection for parked, running and settled runs</p>
<script>
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ICONS = { ask:'◆ ask', worldRead:'◇ read', worldRun:'▣ gate', artifact:'■ artifact', hole:'⌘ hole', escalation:'❓ escalate' };
async function tick() {
  try {
    const s = await (await fetch('/state')).json();
    document.getElementById('runid').textContent = s.runId;
    document.getElementById('badges').innerHTML =
      '<span>status: ' + esc(s.status) + '</span><span>' + s.nodeCount + ' nodes</span>' +
      '<span>' + s.replayHits + ' replay hits ⚡</span>' + (s.amendHits ? '<span>' + s.amendHits + ' amend hits</span>' : '');
    document.getElementById('meta').textContent =
      (s.scriptPath || '') + (s.parentRunId ? '  (amend of ' + s.parentRunId + ')' : '') + '  updated ' + (s.updatedAt || '');
    const html = s.phases.map((p) =>
      '<h2>' + esc(p.title) + '</h2>' + p.nodes.map((n) => {
        const mark = n.status === 'completed' ? '<span class="ok">✔</span>' : '<span class="bad">✖</span>';
        const q = n.kind === 'escalation' && s.escalations.find((e) => e.siteId === n.siteId && e.question)
          ? '<div class="q">❓ ' + esc(s.escalations.find((e) => e.siteId === n.siteId).question) + '</div>' : '';
        const detail = n.errorText ? '<pre class="err">' + esc(n.errorText) + '</pre>'
          : n.resultJson ? '<details><summary>result</summary><pre>' + esc(n.resultJson) + '</pre></details>' : '';
        return '<div class="node">' + mark + ' <b>' + esc(ICONS[n.kind] || n.kind) + '</b> <span class="meta">' +
          esc(n.siteId + '#' + n.ordinal + (n.durationMs !== undefined ? ' · ' + n.durationMs + 'ms' : '')) + '</span>' + q + detail + '</div>';
      }).join('')).join('');
    document.getElementById('content').innerHTML = html || '<p class="dim">no journalled nodes yet…</p>';
  } catch (e) { /* keep polling */ }
}
tick();
setInterval(tick, 1200);
</script></body></html>`;

export interface LiveServer {
  server: Server;
  /** The actual bound port (useful when requesting port 0). */
  port: number;
  close: () => Promise<void>;
}

export function startLiveServer(store: SQLiteStateStore & DwfJournalStore, runId: string, port = 4649, host = '127.0.0.1'): Promise<LiveServer> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/state') {
      void projectRun(store, runId)
        .then((projection) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(projection));
        })
        .catch((err: Error) => {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHELL);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
