/**
 * The Studio page — minimal shell over the SVG canvas + the WS client:
 * an embedded boot snapshot (window.__STUDIO__), a reconnecting WebSocket
 * that applies snapshot frames, logs event frames and re-seeks to "now" on
 * each push, plus a slider driving the same seek op for time travel.
 */
import type { DAGGraph } from '../types.js';
import { renderSvgCanvas } from './svg-canvas.js';
import { AUI_CSS, AUI_TICKER_JS } from './design-system.js';

// ---------------------------------------------------------------------------
// The studio page — minimal shell over the SVG canvas + the WS client
// ---------------------------------------------------------------------------

export interface StudioPageOptions {
  /** WS path the page connects to (default `/ws`). */
  wsPath?: string;
  pagePath?: string;
}

/** Escape a JSON payload for <script> embedding (the `$`-safe function form). */
function escapeJsonForScript(payload: string): string {
  return payload
    .replace(/</g, () => '\\u003c')
    .replace(/\u2028/g, () => '\\u2028')
    .replace(/\u2029/g, () => '\\u2029');
}

/**
 * Render the Studio SVG-canvas page: an embedded boot snapshot (`window.
 * __STUDIO__` = `{graph, svg, ordinal}`), a WS client that replaces the canvas
 * on `snapshot` frames, logs `event` frames into a feed and re-seeks to "now"
 * on each push, plus a slider driving the same seek op for time travel.
 */
export function renderStudioPage(graph: DAGGraph, ordinal: number, opts: StudioPageOptions = {}): string {
  const wsPath = opts.wsPath ?? '/ws';
  const boot = escapeJsonForScript(
    JSON.stringify({ graph, svg: renderSvgCanvas(graph), ordinal, wsPath }),
  );
  const title = `AI-Workflow Studio — ${graph.runId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<style>${AUI_CSS}
  * { box-sizing: border-box; }
  body { margin:0; background:var(--aui-bg); color:var(--aui-ink); font:13px/1.45 var(--aui-sans); height:100vh; display:grid; grid-template-rows:52px 1fr 44px; }
  header { position:relative; z-index:10; display:flex; align-items:center; gap:14px; padding:0 16px; border-bottom:1px solid var(--aui-border); background:linear-gradient(180deg, rgba(0,0,0,.015), rgba(0,0,0,0)), var(--aui-bg-raised); }
  .brand { font-weight:700; color:var(--aui-ink); }
  .brand .logo { color:var(--aui-blue); margin-right:6px; }
  .mono { font-family:var(--aui-mono); font-size:12px; color:var(--aui-muted); }
  #ordinal { font-family:var(--aui-mono); font-size:12px; color:var(--aui-blue); font-variant-numeric:tabular-nums; }
  main { position:relative; z-index:1; display:grid; grid-template-columns:minmax(0,1fr) clamp(280px,26vw,420px); min-height:0; }
  #canvas { overflow:auto; padding:10px; }
  #canvas svg { max-width:none; width:100%; height:auto; }
  #feed { border-left:1px solid var(--aui-border); overflow-y:auto; font-family:var(--aui-mono); font-size:11.5px; padding:6px 0; background:var(--aui-bg-raised); }
  .line { padding:1.5px 12px; white-space:pre-wrap; word-break:break-word; color:var(--aui-muted); }
  footer { display:flex; align-items:center; gap:12px; padding:0 16px; border-top:1px solid var(--aui-border); background:var(--aui-bg-raised); }
  #seek { flex:1; accent-color:var(--aui-blue); }
</style>
</head>
<body>
<div class="aui-backdrop"></div>
<div class="aui-grid"></div>
<header><span class="brand"><span class="logo">◆</span>Studio</span><span class="mono" id="runid"></span><span id="ordinal"></span></header>
<main><section id="canvas"></section><aside id="feed"></aside></main>
<footer><span class="mono" id="seek-label"></span><input id="seek" type="range" min="0" value="0"></footer>
<script>window.__STUDIO__ = ${boot};</script>
<script>${AUI_TICKER_JS}</script>
<script>
(function () {
  'use strict';
  var st = window.__STUDIO__;
  var total = st.ordinal;
  var ws = null;
  document.getElementById('runid').textContent = st.graph.runId;
  var canvas = document.getElementById('canvas');
  var feed = document.getElementById('feed');
  var seekInput = document.getElementById('seek');
  var seekLabel = document.getElementById('seek-label');

  function applySnapshot(msg) {
    canvas.innerHTML = msg.svg;
    seekInput.max = String(total);
    seekInput.value = String(msg.ordinal);
    seekLabel.textContent = 'event ' + msg.ordinal + ' / ' + total;
    document.getElementById('ordinal').textContent = 'viewing @' + msg.ordinal;
    if (window.auiScanTickers) {
      auiScanTickers(document.getElementById('seek-label'), 'seek');
      auiScanTickers(document.getElementById('ordinal'), 'ord');
    }
  }
  function feedLine(text) {
    var d = document.createElement('div');
    d.className = 'line';
    d.textContent = text;
    feed.appendChild(d);
    feed.scrollTop = feed.scrollHeight;
  }
  function seekTo(n) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op: 'seek', ordinal: n }));
  }
  var pending = null;
  function scheduleReseek() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; seekTo(total); }, 350);
  }
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + st.wsPath);
    ws.onopen = function () { seekTo(total); };
    ws.onmessage = function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.op === 'snapshot') { applySnapshot(msg); }
      else if (msg.op === 'event') { total += 1; feedLine('▲ ' + msg.event.type + '  ' + (msg.event.timestamp || '')); scheduleReseek(); }
      else if (msg.op === 'error') { feedLine('✖ ' + msg.message); }
    };
    ws.onclose = function () { setTimeout(connect, 2000); };
  }
  seekInput.addEventListener('change', function () { seekTo(Number(seekInput.value)); });
  feedLine('journal head @' + total);
  applySnapshot({ svg: st.svg, ordinal: st.ordinal });
  connect();
})();
</script>
</body>
</html>`;
}
