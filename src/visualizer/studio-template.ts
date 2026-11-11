/**
 * Studio page shell — the HTML template constant and the bilingual string
 * table, moved verbatim from studio-renderer so the renderer logic reads in
 * one screen. Placeholders (__STUDIO_*) are substituted by renderStudioHtml.
 */
/**
 * The Studio's fixed UI strings, en/zh (Issue #128, bilingual-presentation
 * steering rule 2). The server template picks its strings by `lang`; the
 * client-side strings (top-bar chips, column counts) drive off the injected
 * `window.__STUDIO_LANG__` + `window.__STUDIO_I18N__` pair.
 */
export const STUDIO_I18N: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    fit: 'Fit',
    logs: 'Logs',
    canvasHint: 'scroll = zoom · drag = pan · click a node = inspect',
    eventStream: 'Live Event Stream',
    filter: 'filter…',
    inspector: 'Inspector',
    inspectorEmpty: 'Click a node on the canvas to inspect its input, output and artifacts.',
    amendOf: ' ⑂ amend of ',
    replay: 'replay ⚡',
    amend: 'amend ♻',
    events: 'events',
  },
  zh: {
    fit: '适配',
    logs: '日志',
    canvasHint: '滚轮缩放 · 拖拽平移 · 点击节点查看详情',
    eventStream: '实时事件流',
    filter: '过滤…',
    inspector: '检查器',
    inspectorEmpty: '点击画布中的节点，查看其输入、输出与产物。',
    amendOf: ' ⑂ 修订自 ',
    replay: '重放 ⚡',
    amend: '修订 ♻',
    events: '事件',
  },
};

export const STUDIO_TEMPLATE = `<!doctype html>
<html lang="__STUDIO_LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #090d16; --panel: #0d1322; --card: #131b2e; --border: #1e293b;
    --text: #e2e8f0; --dim: #64748b; --faint: #334155;
    --running: #f59e0b; --ok: #10b981; --bad: #ef4444; --replay: #38bdf8;
    --accent: #8b5cf6; --mono: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-sans-serif, system-ui, 'Segoe UI', sans-serif;
    display: grid; grid-template-rows: 46px 1fr; overflow: hidden;
  }
  /* ---------- top bar ---------- */
  #topbar {
    display: flex; align-items: center; gap: 14px; padding: 0 16px;
    border-bottom: 1px solid var(--border); background: linear-gradient(180deg, #0c1220, #090d16);
  }
  .brand { font-weight: 700; letter-spacing: .2px; white-space: nowrap; }
  .brand .logo { color: var(--accent); margin-right: 6px; }
  .brand .studio { color: var(--accent); font-weight: 600; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .pill {
    font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 999px;
    border: 1px solid var(--faint); color: var(--dim); text-transform: uppercase; letter-spacing: .6px;
  }
  .pill.running { color: var(--running); border-color: var(--running); animation: pillpulse 1.6s ease-in-out infinite; }
  .pill.completed { color: var(--ok); border-color: var(--ok); }
  .pill.failed, .pill.aborted { color: var(--bad); border-color: var(--bad); }
  .pill.parked { color: var(--running); border-color: var(--running); }
  @keyframes pillpulse { 50% { opacity: .45; } }
  #chips { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; min-width: 0; }
  .chip {
    font-size: 11px; color: var(--dim); border: 1px solid var(--border); background: var(--card);
    border-radius: 999px; padding: 2px 10px; white-space: nowrap;
  }
  .chip b { color: var(--text); font-weight: 600; }
  .chip.replay b { color: var(--replay); }
  #topbar .actions { display: flex; gap: 6px; }
  button {
    background: var(--card); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  /* ---------- main grid ---------- */
  #grid { display: grid; grid-template-columns: minmax(0, 1fr) clamp(360px, 34vw, 520px); min-height: 0; }
  body.focus-logs #grid { grid-template-columns: minmax(0, 1fr); }
  body.focus-logs #canvas-pane { display: none; }
  #canvas-pane { position: relative; min-width: 0; background:
    radial-gradient(1200px 700px at 70% -10%, rgba(139,92,246,.07), transparent 60%), var(--bg); }
  #dag { width: 100%; height: 100%; display: block; cursor: grab; }
  #dag.dragging { cursor: grabbing; }
  #canvas-hint {
    position: absolute; bottom: 10px; left: 12px; color: var(--faint); font-size: 11px;
    pointer-events: none; font-family: var(--mono);
  }
  #right { display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 42%); min-width: 0; border-left: 1px solid var(--border); }
  body.focus-logs #right { grid-template-rows: minmax(0, 1fr); }
  body.focus-logs #inspector-pane { display: none; }
  .pane { display: flex; flex-direction: column; min-height: 0; }
  .pane + .pane { border-top: 1px solid var(--border); }
  .pane-head {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); color: var(--dim); font-size: 11px;
    font-weight: 700; text-transform: uppercase; letter-spacing: .8px; background: var(--panel);
  }
  .pane-head .spacer { flex: 1; }
  .pane-head input {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 3px 8px; font: 12px var(--mono); width: 40%;
  }
  .pane-head input:focus { outline: none; border-color: var(--accent); }
  #term { overflow-y: auto; padding: 8px 0; font-family: var(--mono); font-size: 11.5px; flex: 1; }
  .tline { padding: 1.5px 12px; white-space: pre-wrap; word-break: break-word; color: #94a3b8; }
  .tline .tt { color: var(--faint); margin-right: 8px; }
  .tline.lv-phase { color: var(--accent); font-weight: 700; margin-top: 6px; }
  .tline.lv-ok { color: var(--ok); }
  .tline.lv-bad { color: var(--bad); }
  .tline.lv-warn { color: var(--running); }
  .tline.lv-replay { color: var(--replay); }
  .empty { color: var(--faint); padding: 18px 14px; }
  /* ---------- inspector ---------- */
  #inspector { overflow-y: auto; padding: 12px 14px; flex: 1; }
  #inspector h3 { margin: 0 0 4px; font-size: 14px; }
  #inspector .sub { color: var(--dim); font-size: 11px; margin-bottom: 10px; font-family: var(--mono); }
  #inspector table { border-collapse: collapse; margin-bottom: 10px; }
  #inspector td { padding: 2px 14px 2px 0; font-size: 12px; color: var(--dim); vertical-align: top; }
  #inspector td.v { color: var(--text); font-family: var(--mono); font-size: 11.5px; }
  .st-completed { color: var(--ok); } .st-running { color: var(--running); }
  .st-failed { color: var(--bad); } .st-replayed { color: var(--replay); }
  .st-pending, .st-skipped { color: var(--dim); }
  .box {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; margin: 8px 0; font-family: var(--mono); font-size: 11.5px;
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
  }
  .box.err { border-color: rgba(239,68,68,.45); background: rgba(239,68,68,.06); color: #fca5a5; }
  .box.md { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12.5px; }
  .box.md h1, .box.md h2, .box.md h3 { margin: .6em 0 .3em; line-height: 1.3; }
  .box.md h1 { font-size: 1.25em; } .box.md h2 { font-size: 1.12em; } .box.md h3 { font-size: 1em; }
  .box.md code { background: #0b1120; border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: .92em; }
  .box.md pre { background: #0b1120; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; overflow-x: auto; }
  .box.md pre code { border: 0; background: none; padding: 0; }
  .box.md ul { margin: .4em 0; padding-left: 1.3em; }
  .box.md a { color: var(--replay); }
  .dl-row { display: flex; gap: 8px; margin: 8px 0; }
  /* ---------- A2UI inline form ---------- */
  #a2ui {
    position: fixed; right: 18px; bottom: 18px; width: min(420px, calc(100vw - 36px));
    background: var(--card); border: 1px solid var(--running); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(245,158,11,.15), 0 0 24px rgba(245,158,11,.12);
    padding: 14px 16px; z-index: 50;
  }
  #a2ui .a2ui-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--running); margin-bottom: 6px; }
  #a2ui .a2ui-q { color: var(--text); margin-bottom: 10px; white-space: pre-wrap; }
  #a2ui textarea, #a2ui input[type=text] {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font: 12.5px var(--mono); padding: 8px 10px; resize: vertical;
  }
  #a2ui textarea { min-height: 88px; }
  #a2ui textarea:focus, #a2ui input:focus { outline: none; border-color: var(--running); }
  #a2ui .a2ui-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  #a2ui .msg { color: var(--dim); font-size: 11.5px; flex: 1; }
  #a2ui .msg.ok { color: var(--ok); } #a2ui .msg.bad { color: var(--bad); }
  #a2ui .hint { color: var(--dim); font-size: 11px; font-family: var(--mono); margin-top: 8px; word-break: break-all; }
  /* ---------- SVG topology ---------- */
  .col-bg { fill: rgba(19,27,46,.38); stroke: var(--border); stroke-width: 1; rx: 14; }
  .col-title { fill: #94a3b8; font: 700 12px ui-sans-serif, system-ui, sans-serif; letter-spacing: .4px; }
  .col-count { fill: var(--faint); font: 11px var(--mono); }
  .edge { fill: none; stroke-width: 1.6; }
  .edge.st-completed { stroke: rgba(16,185,129,.5); }
  .edge.st-running { stroke: var(--running); stroke-dasharray: 6 5; animation: flow 1s linear infinite; }
  .edge.st-failed { stroke: rgba(239,68,68,.65); }
  .edge.st-replayed { stroke: rgba(56,189,248,.55); }
  .edge.st-pending, .edge.st-skipped { stroke: rgba(51,65,85,.9); }
  @keyframes flow { to { stroke-dashoffset: -11; } }
  .node { cursor: pointer; }
  .node > .card { fill: var(--card); stroke: var(--border); stroke-width: 1; rx: 11; transition: stroke .15s; }
  .node:hover > .card { stroke: #475569; }
  .node.selected > .card { stroke: var(--accent); stroke-width: 1.6; }
  .node.st-running > .card { stroke: var(--running); animation: nodepulse 1.6s ease-in-out infinite; }
  .node.st-failed > .card { stroke: rgba(239,68,68,.7); }
  .node.st-replayed > .card { stroke: rgba(56,189,248,.55); }
  @keyframes nodepulse {
    0%, 100% { filter: drop-shadow(0 0 2px rgba(245,158,11,.2)); }
    50% { filter: drop-shadow(0 0 11px rgba(245,158,11,.8)); }
  }
  .node .sbar { rx: 2; }
  .node .ntitle { fill: var(--text); font: 600 12px ui-sans-serif, system-ui, sans-serif; }
  .node .nmeta { fill: var(--dim); font: 10.5px var(--mono); }
  .node .nicon { font: 12px var(--mono); }
  .node.st-completed .nicon { fill: var(--ok); }
  .node.st-running .nicon { fill: var(--running); }
  .node.st-failed .nicon { fill: var(--bad); }
  .node.st-replayed .nicon { fill: var(--replay); }
  .node.st-pending .nicon, .node.st-skipped .nicon { fill: var(--faint); }
  .rbadge-rect { fill: rgba(56,189,248,.12); stroke: rgba(56,189,248,.55); rx: 7; }
  .rbadge-text { fill: var(--replay); font: 700 9px ui-sans-serif, sans-serif; letter-spacing: .4px; }
</style>
</head>
<body>
<header id="topbar">
  <div class="brand"><span class="logo">◆</span>AI-Workflow <span class="studio">Studio</span></div>
  <span class="mono" id="runid"></span>
  <span class="pill" id="statuspill"></span>
  <div id="chips"></div>
  <div class="actions">
    <button id="btn-fit" title="Fit graph to view">__STUDIO_FIT__</button>
    <button id="btn-reset" title="Reset zoom">100%</button>
    <button id="btn-logs" title="Toggle fullscreen event stream">__STUDIO_LOGS__</button>
  </div>
</header>
<main id="grid">
  <section id="canvas-pane" class="pane">
    <svg id="dag"><g id="viewport"></g></svg>
    <div id="canvas-hint">__STUDIO_CANVAS_HINT__</div>
  </section>
  <section id="right">
    <div class="pane" id="term-pane">
      <div class="pane-head">__STUDIO_EVENT_STREAM__ <span class="spacer"></span><input id="term-filter" placeholder="__STUDIO_FILTER__"></div>
      <div id="term"></div>
    </div>
    <div class="pane" id="inspector-pane">
      <div class="pane-head">__STUDIO_INSPECTOR__ <span class="spacer"></span><span id="insp-tag" class="mono" style="text-transform:none"></span></div>
      <div id="inspector"><div class="empty">__STUDIO_INSPECTOR_EMPTY__</div></div>
    </div>
  </section>
</main>
<div id="a2ui" hidden></div>
<script>window.__STUDIO_LANG__ = '__STUDIO_LANG__'; window.__STUDIO_I18N__ = __STUDIO_I18N_JSON__;</script>
<script>window.__STUDIO__ = __STUDIO_SNAPSHOT__;</script>
<script>
(function () {
  'use strict';
  var live = window.__STUDIO__.mode === 'live';
  var state = window.__STUDIO__;
  var QS = window.location.search || '';
  var selectedId = null;
  var view = { k: 1, x: 0, y: 0 };
  // Issue #128: the client-side fixed strings come from the injected
  // STUDIO_I18N table; the node-count label keeps one口径 with the canvas
  // (Issue #96 follow-up) and pluralizes.
  var LANG = window.__STUDIO_LANG__ === 'zh' ? 'zh' : 'en';
  var T = (window.__STUDIO_I18N__ || {})[LANG] || {};
  function nodesLabel(n) { return LANG === 'zh' ? n + ' 个节点' : (n === 1 ? '1 node' : n + ' nodes'); }

  // ---------- tiny dom utils ----------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d; }
  function svg(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  }
  function fmtDur(ms) { if (ms === undefined || ms === null) return ''; if (ms < 1000) return ms + 'ms'; return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's'; }
  function nowStamp() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }

  var KIND_GLYPH = { ask: '◆', worldRead: '◇', worldRun: '▣', gate: '▣', artifact: '■', hole: '⌘', report: '📣', escalation: '❓', agent: '◆', probe: '◇', action: '▸', fanout: '⑂' };
  function glyphOf(node) {
    var t = node.type || '';
    if (KIND_GLYPH[t]) return KIND_GLYPH[t];
    if (String(node.id).indexOf('gate:') === 0) return '▣';
    if (String(node.id).indexOf('artifact:') === 0) return '■';
    return '▸';
  }
  function nodeTitle(n) {
    var id = String(n.id);
    if (id.indexOf('artifact:') === 0) return 'artifact ' + id.slice(9);
    if (id.indexOf('gate:') === 0) return 'gate ' + id.slice(5);
    return n.name || id;
  }

  // ---------- top bar ----------
  function renderTopbar() {
    document.getElementById('runid').textContent = state.run.runId + (state.run.parentRunId ? T.amendOf + state.run.parentRunId : '');
    var pill = document.getElementById('statuspill');
    pill.textContent = state.run.status;
    pill.className = 'pill ' + state.run.status;
    var chips = document.getElementById('chips');
    chips.innerHTML = '';
    function chip(html, cls) { var c = el('span', 'chip' + (cls ? ' ' + cls : ''), html); chips.appendChild(c); }
    // Issue #96 follow-up (F3): the pill and the canvas must agree — count
    // the SAME nodes the canvas draws, not the run's recorded step count.
    var canvasNodeCount = state.graph && state.graph.nodes ? state.graph.nodes.length : state.stats.nodeCount;
    chip('<b>' + canvasNodeCount + '</b> ' + nodesLabel(canvasNodeCount));
    chip('<b>' + state.stats.replayHits + '</b> ' + (T.replay || 'replay ⚡'), 'replay');
    if (state.stats.amendHits) chip('<b>' + state.stats.amendHits + '</b> ' + (T.amend || 'amend ♻'));
    chip('<b>' + state.stats.eventCount + '</b> ' + (T.events || 'events'));
    if (state.run.scriptPath) chip('<b>' + esc(state.run.scriptPath.length > 46 ? '…' + state.run.scriptPath.slice(-45) : state.run.scriptPath) + '</b>');
  }

  // ---------- topology layout + edge routing ----------
  var LAYOUT = null; // { pos, cols, width, height }
  function computeLayout() {
    var W = 234, H = 64, VGAP = 18, COLGAP = 66, TOP = 58, PAD = 30;
    var g = state.graph;
    var cols = (g.phases || []).slice().sort(function (a, b) { return a.order - b.order; })
      .map(function (p) { return { id: p.id, name: p.name, nodes: [] }; });
    var colById = {}; cols.forEach(function (c, i) { colById[c.id] = i; });
    var pos = {};
    g.nodes.forEach(function (n) {
      var ci = colById[n.phaseId];
      if (ci === undefined) { ci = cols.length; cols.push({ id: n.phaseId || '(ungrouped)', name: n.phaseName || '(ungrouped)', nodes: [] }); colById[n.phaseId] = ci; }
      cols[ci].nodes.push(n);
    });
    cols.forEach(function (c) {
      c.nodes.forEach(function (n, i) {
        pos[n.id] = { x: PAD + ci0(c) * (W + COLGAP), y: TOP + i * (H + VGAP), w: W, h: H, col: colIndexOf(c) };
      });
    });
    function ci0(c) { return cols.indexOf(c); }
    function colIndexOf(c) { return cols.indexOf(c); }
    var width = PAD * 2 + Math.max(0, cols.length - 1) * (W + COLGAP) + W + 44;
    var maxBottom = TOP;
    cols.forEach(function (c) { maxBottom = Math.max(maxBottom, TOP + c.nodes.length * (H + VGAP)); });
    var height = maxBottom + PAD;
    LAYOUT = { pos: pos, cols: cols, width: width, height: height, W: W, H: H };
  }

  /* 拓扑连线物理算法 —— 见模块 TSDoc 军规。所有分支都锚定卡片边缘，无倒扣。 */
  function edgePath(a, b) {
    var sameCol = a.col === b.col;
    if (sameCol) {
      if (b.y > a.y && (b.y - (a.y + a.h)) <= 26) {
        var x = a.x + a.w / 2;                       // 相邻上下：垂直直线脊柱
        return 'M' + x + ' ' + (a.y + a.h) + ' L' + x + ' ' + b.y;
      }
      var rx1 = a.x + a.w, ry1 = a.y + a.h / 2, rx2 = b.x + b.w, ry2 = b.y + b.h / 2;
      var mx = Math.max(rx1, rx2) + 34;              // 同列非相邻/向上：右侧弧形旁路
      return 'M' + rx1 + ' ' + ry1 + ' C' + mx + ' ' + ry1 + ', ' + mx + ' ' + ry2 + ', ' + rx2 + ' ' + ry2;
    }
    if (b.x > a.x) {                                  // 跨 Phase 前向：标准水平贝塞尔
      var fx1 = a.x + a.w, fy1 = a.y + a.h / 2, fx2 = b.x, fy2 = b.y + b.h / 2;
      var dx = Math.min(Math.max((fx2 - fx1) * 0.45, 30), 92);
      return 'M' + fx1 + ' ' + fy1 + ' C' + (fx1 + dx) + ' ' + fy1 + ', ' + (fx2 - dx) + ' ' + fy2 + ', ' + fx2 + ' ' + fy2;
    }
    var bx1 = a.x, by1 = a.y + a.h / 2, bx2 = b.x + b.w, by2 = b.y + b.h / 2;   // 回边：左向平滑 S 曲线
    var bdx = Math.min(Math.max((bx1 - bx2) * 0.45, 30), 92);
    return 'M' + bx1 + ' ' + by1 + ' C' + (bx1 - bdx) + ' ' + by1 + ', ' + (bx2 + bdx) + ' ' + by2 + ', ' + bx2 + ' ' + by2;
  }

  function renderDag() {
    computeLayout();
    var vp = document.getElementById('viewport');
    vp.innerHTML = '';
    var g = state.graph;
    // column backgrounds + headers
    LAYOUT.cols.forEach(function (c, i) {
      var x = LAYOUT.pos[c.nodes.length ? c.nodes[0].id : ''] ? LAYOUT.pos[c.nodes[0].id].x : (30 + i * (LAYOUT.W + 66));
      var rows = Math.max(c.nodes.length, 1);
      var h = 58 + rows * (LAYOUT.H + 18) + 6;
      vp.appendChild(svg('rect', { x: x - 12, y: 12, width: LAYOUT.W + 24, height: h, rx: 14, 'class': 'col-bg' }));
      var t = svg('text', { x: x, y: 36, 'class': 'col-title' }); t.textContent = c.name; vp.appendChild(t);
      var cnt = svg('text', { x: x, y: 52, 'class': 'col-count' }); cnt.textContent = nodesLabel(c.nodes.length); vp.appendChild(cnt);
    });
    // edges first (under cards)
    (g.edges || []).forEach(function (e) {
      var a = LAYOUT.pos[e.fromNodeId], b = LAYOUT.pos[e.toNodeId];
      if (!a || !b) return;
      var st = b.status || 'pending';
      var p = svg('path', { d: edgePath(a, b), 'class': 'edge st-' + st });
      if (e.label) {
        var tt = svg('title'); tt.textContent = e.label; p.appendChild(tt);
      }
      vp.appendChild(p);
    });
    // node cards
    g.nodes.forEach(function (n) {
      var p = LAYOUT.pos[n.id]; if (!p) return;
      var grp = svg('g', { 'class': 'node st-' + (n.status || 'pending'), 'data-id': n.id });
      grp.appendChild(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 11, 'class': 'card' }));
      var barColor = { completed: '#10b981', running: '#f59e0b', failed: '#ef4444', replayed: '#38bdf8' }[n.status] || '#334155';
      grp.appendChild(svg('rect', { x: p.x, y: p.y + 10, width: 3, height: p.h - 20, rx: 2, fill: barColor, 'class': 'sbar' }));
      var icon = svg('text', { x: p.x + 14, y: p.y + 24, 'class': 'nicon' }); icon.textContent = glyphOf(n); grp.appendChild(icon);
      var title = svg('text', { x: p.x + 30, y: p.y + 24, 'class': 'ntitle' });
      title.textContent = nodeTitle(n).length > 24 ? nodeTitle(n).slice(0, 23) + '…' : nodeTitle(n);
      grp.appendChild(title);
      var metaBits = [n.status || 'pending'];
      if (n.durationMs !== undefined) metaBits.push(fmtDur(n.durationMs));
      if (n.role && n.role !== 'coordinator') metaBits.push(n.role);
      var meta = svg('text', { x: p.x + 30, y: p.y + 42, 'class': 'nmeta' });
      meta.textContent = metaBits.join(' · ');
      grp.appendChild(meta);
      var err = n.errorMessage ? n.errorMessage.slice(0, 60) : '';
      if (err) {
        var eline = svg('text', { x: p.x + 14, y: p.y + 56, 'class': 'nmeta', fill: '#f87171' });
        eline.textContent = '✖ ' + err; grp.appendChild(eline);
      }
      if (n.status === 'replayed') {
        var bw = 62;
        grp.appendChild(svg('rect', { x: p.x + p.w - bw - 10, y: p.y - 8, width: bw, height: 16, rx: 7, 'class': 'rbadge-rect' }));
        var bt = svg('text', { x: p.x + p.w - bw - 4, y: p.y + 3.5, 'class': 'rbadge-text' });
        bt.textContent = '⚡ Replay'; grp.appendChild(bt);
      }
      grp.addEventListener('click', function () { selectNode(n.id); });
      vp.appendChild(grp);
    });
    applyView();
    if (!selectedId && state.graph.nodes.length) { /* nothing selected yet */ }
    if (selectedId) markSelected();
  }

  // ---------- pan / zoom ----------
  function applyView() {
    var vp = document.getElementById('viewport');
    vp.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
  }
  function fitView() {
    var svgEl = document.getElementById('dag');
    var r = svgEl.getBoundingClientRect();
    if (!LAYOUT || !LAYOUT.width) return;
    var k = Math.min(r.width / (LAYOUT.width + 40), r.height / (LAYOUT.height + 40), 1.6);
    view.k = Math.max(k, 0.2);
    view.x = (r.width - LAYOUT.width * view.k) / 2;
    view.y = Math.max(8, (r.height - LAYOUT.height * view.k) / 2);
    applyView();
  }
  (function initPanZoom() {
    var svgEl = document.getElementById('dag');
    var drag = null;
    svgEl.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svgEl.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      var k2 = Math.min(Math.max(view.k * factor, 0.12), 4);
      view.x = mx - (mx - view.x) * (k2 / view.k);
      view.y = my - (my - view.y) * (k2 / view.k);
      view.k = k2; applyView();
    }, { passive: false });
    svgEl.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; svgEl.classList.add('dragging'); });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      view.x = drag.vx + (e.clientX - drag.x); view.y = drag.vy + (e.clientY - drag.y); applyView();
    });
    window.addEventListener('mouseup', function () { drag = null; svgEl.classList.remove('dragging'); });
    document.getElementById('btn-fit').addEventListener('click', fitView);
    document.getElementById('btn-reset').addEventListener('click', function () { view = { k: 1, x: 24, y: 12 }; applyView(); });
    document.getElementById('btn-logs').addEventListener('click', function () { document.body.classList.toggle('focus-logs'); });
  })();

  // ---------- inspector ----------
  function markSelected() {
    var nodes = document.querySelectorAll('#viewport .node');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('selected', nodes[i].getAttribute('data-id') === selectedId);
    }
  }
  function selectNode(id) {
    selectedId = id; markSelected(); renderInspector();
  }
  function nodeById(id) {
    var list = state.graph.nodes || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function miniMarkdown(src) {
    var s = esc(src);
    var out = [], inCode = false, codeBuf = [];
    var lines = s.split(/\\r?\\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\\\`\\\`\\\`/.test(line)) {
        if (inCode) { out.push('<pre><code>' + codeBuf.join('\\n') + '</code></pre>'); codeBuf = []; inCode = false; }
        else inCode = true;
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      var h = line.match(/^(#{1,3})\\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (/^\\s*[-*]\\s+/.test(line)) { out.push('<ul><li>' + inline(line.replace(/^\\s*[-*]\\s+/, '')) + '</li></ul>'); continue; }
      if (line.trim() === '') { out.push('<div style="height:.45em"></div>'); continue; }
      out.push('<div>' + inline(line) + '</div>');
    }
    if (codeBuf.length) out.push('<pre><code>' + codeBuf.join('\\n') + '</code></pre>');
    function inline(t) {
      return t
        .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
        .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }
    return out.join('');
  }
  function artifactFor(node) {
    var id = String(node.id);
    if (id.indexOf('artifact:') !== 0) return null;
    var aid = id.slice(9);
    var list = state.artifacts || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === aid) return list[i];
    return null;
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 300);
  }
  function renderInspector() {
    var box = document.getElementById('inspector');
    document.getElementById('insp-tag').textContent = selectedId || '';
    var n = selectedId ? nodeById(selectedId) : null;
    if (!n) { box.innerHTML = '<div class="empty">' + (T.inspectorEmpty || '') + '</div>'; return; }
    var rows = '';
    function row(k, v) { rows += '<tr><td>' + k + '</td><td class="v">' + v + '</td></tr>'; }
    row('status', '<span class="st-' + n.status + '">' + n.status + '</span>');
    row('phase', esc(n.phaseName || n.phaseId || ''));
    if (n.role) row('role', esc(n.role));
    if (n.type) row('type', esc(n.type));
    if (n.durationMs !== undefined) row('duration', fmtDur(n.durationMs));
    if (n.dependsOn && n.dependsOn.length) row('depends on', esc(n.dependsOn.join(', ')));
    var html = '<h3>' + esc(nodeTitle(n)) + '</h3><div class="sub">' + esc(n.id) + '</div><table>' + rows + '</table>';
    var art = artifactFor(n);
    if (n.inputs && Object.keys(n.inputs).length) {
      html += '<div class="pane-head" style="border:0;padding:6px 0 2px;background:none">INPUT</div><div class="box">' + esc(JSON.stringify(n.inputs, null, 2)) + '</div>';
    }
    if (n.outputs !== undefined && n.outputs !== null) {
      var text = typeof n.outputs === 'string' ? n.outputs : JSON.stringify(n.outputs, null, 2);
      html += '<div class="pane-head" style="border:0;padding:6px 0 2px;background:none">OUTPUT</div><div class="box">' + esc(text) + '</div>';
    }
    if (art && art.content) {
      var isMd = (art.type || '').indexOf('markdown') >= 0 || /\\.(md|markdown)$/i.test(art.name || '');
      html += '<div class="pane-head" style="border:0;padding:6px 0 2px;background:none">ARTIFACT · ' + esc(art.name) + '</div>' +
        '<div class="dl-row"><button id="btn-dl">下载 download</button>' + (isMd ? '<button id="btn-raw">raw</button>' : '') + '</div>' +
        '<div class="box' + (isMd ? ' md' : '') + '" id="art-body">' + (isMd ? miniMarkdown(art.content) : esc(art.content)) + '</div>';
    }
    if (n.errorMessage) {
      html += '<div class="pane-head" style="border:0;padding:6px 0 2px;background:none">ERROR</div><div class="box err">' + esc(n.errorMessage) + '</div>';
    }
    box.innerHTML = html;
    var dl = document.getElementById('btn-dl');
    if (dl && art) dl.addEventListener('click', function () { download((art.name || art.id) + '.txt', art.content || '', 'text/plain'); });
    var raw = document.getElementById('btn-raw');
    if (raw && art) raw.addEventListener('click', function () {
      var body = document.getElementById('art-body');
      var isMd = body.className.indexOf('md') >= 0;
      body.className = 'box' + (isMd ? '' : ' md');
      body.innerHTML = isMd ? esc(art.content || '') : miniMarkdown(art.content || '');
    });
  }

  // ---------- event terminal ----------
  function classifyEvent(ev) {
    switch (ev.type) {
      case 'dwf_phase': return { cls: 'lv-phase', text: '—— ' + (ev.data && ev.data.phase ? ev.data.phase : 'phase') + ' ——' };
      case 'dwf_log': return { cls: '', text: (ev.data && ev.data.message) || '' };
      case 'dwf_ask_start': return { cls: '', text: 'ask → ' + (ev.data && ev.data.actor) + ' (' + (ev.data && ev.data.siteId) + ')' };
      case 'dwf_ask_complete': return { cls: 'lv-ok', text: '✔ ask done (' + (ev.data && ev.data.siteId) + ')' };
      case 'dwf_world_run': return { cls: 'lv-warn', text: '$ ' + (ev.data && ev.data.cmd) + ' ' + ((ev.data && ev.data.args) || []).join(' ') };
      case 'dwf_replay_hit': return { cls: 'lv-replay', text: '⚡ replayed ' + (ev.data && ev.data.siteId) + '#' + (ev.data && ev.data.ordinal) + ' (0 provider calls)' };
      case 'dwf_amend_hit': return { cls: 'lv-replay', text: '♻ amended run reused ' + (ev.data && ev.data.siteId) + '#' + (ev.data && ev.data.ordinal) };
      case 'dwf_amend_diverged': return { cls: 'lv-warn', text: '⑂ diverged ' + (ev.data && ev.data.siteId) };
      case 'dwf_call_error': case 'dwf_node_failed': return { cls: 'lv-bad', text: '✖ ' + ((ev.data && (ev.data.siteId || ev.data.op)) || '') + ': ' + ((ev.data && ev.data.error) || '') };
      case 'dwf_escalation_open': return { cls: 'lv-warn', text: '❓ escalation open: ' + (ev.data && ev.data.question) };
      case 'dwf_hole_open': return { cls: 'lv-warn', text: '⌘ hole open: ' + (ev.data && ev.data.name) };
      case 'dwf_artifact': return { cls: 'lv-ok', text: '📄 artifact ' + (ev.data && ev.data.id) + ' (' + (ev.data && ev.data.bytes) + ' bytes)' };
      case 'dwf_report': return { cls: '', text: 'report: ' + JSON.stringify(ev.data && ev.data.item) };
      case 'dwf_completed': return { cls: 'lv-ok', text: '✔ run completed' };
      case 'dwf_failed': return { cls: 'lv-bad', text: '✖ run failed' };
      case 'dwf_parked': return { cls: 'lv-warn', text: '⏸ run parked — waiting for you' };
      default: return null;
    }
  }
  var termEl = document.getElementById('term');
  var termCount = 0;
  function stampOf(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return nowStamp();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function appendLog(text, cls, stamp) {
    var line = el('div', 'tline' + (cls ? ' ' + cls : ''));
    line.innerHTML = '<span class="tt">' + (stamp || nowStamp()) + '</span>' + esc(text);
    termEl.appendChild(line);
    termCount++;
    if (termCount > 800) { termEl.removeChild(termEl.firstChild); termCount--; }
    var nearBottom = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 40;
    if (nearBottom) termEl.scrollTop = termEl.scrollHeight;
    applyTermFilter();
  }
  function applyTermFilter() {
    var q = (document.getElementById('term-filter').value || '').toLowerCase();
    var kids = termEl.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.display = !q || kids[i].textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    }
  }
  document.getElementById('term-filter').addEventListener('input', applyTermFilter);
  function renderLogs() {
    termEl.innerHTML = ''; termCount = 0;
    (state.events || []).forEach(function (ev) {
      var c = classifyEvent(ev);
      if (c) appendLog(c.text, c.cls, stampOf(ev.timestamp));
    });
  }

  // ---------- A2UI inline form (Human-in-the-Loop) ----------
  function renderA2ui() {
    var box = document.getElementById('a2ui');
    var q = state.openQuestion, h = state.openHole;
    if (!live || (!q && !h)) { box.hidden = true; return; }
    box.hidden = false;
    if (q) {
      box.innerHTML =
        '<div class="a2ui-head">❓ Workflow needs your answer (escalation)</div>' +
        '<div class="a2ui-q">' + esc(q.question) + '</div>' +
        '<textarea id="a2ui-text" placeholder="Type your answer…"></textarea>' +
        '<div class="a2ui-foot"><span class="msg" id="a2ui-msg"></span><button class="primary" id="a2ui-send">提交继续 Submit & Resume</button></div>' +
        '<div class="hint">site ' + esc(q.siteId) + ' · questionId ' + esc(q.questionId) + ' · CLI: workflow answer ' + esc(state.run.runId) + ' ' + esc(q.questionId) + ' "&lt;text&gt;"</div>';
      document.getElementById('a2ui-send').addEventListener('click', function () {
        submitA2ui('/api/answer', { questionId: q.questionId, text: document.getElementById('a2ui-text').value });
      });
    } else if (h) {
      box.innerHTML =
        '<div class="a2ui-head">⌘ Fill the hole: ' + esc(h.name) + '</div>' +
        '<div class="a2ui-q">' + esc(h.prompt) + '</div>' +
        '<textarea id="a2ui-text" placeholder="// JS statements using facade globals (agent(), phase(), …)"></textarea>' +
        '<div class="a2ui-foot"><span class="msg" id="a2ui-msg"></span><button class="primary" id="a2ui-send">提交继续 Fill & Resume</button></div>' +
        '<div class="hint">site ' + esc(h.siteId) + ' · CLI: workflow fill ' + esc(state.run.runId) + ' ' + esc(h.name) + ' &lt;bodyFile&gt;</div>';
      document.getElementById('a2ui-send').addEventListener('click', function () {
        submitA2ui('/api/fill', { holeName: h.name, body: document.getElementById('a2ui-text').value });
      });
    }
  }
  function submitA2ui(url, payload) {
    var msg = document.getElementById('a2ui-msg');
    var btn = document.getElementById('a2ui-send');
    msg.className = 'msg'; msg.textContent = 'submitting…';
    btn.disabled = true;
    fetch(url + QS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btn.disabled = false;
        if (res && res.ok) {
          msg.className = 'msg ok'; msg.textContent = res.message || 'submitted — run resuming, streaming…';
          // A hole fill forks the continuation under a NEW run id — follow it.
          if (res.childRunId) setTimeout(function () { window.location.replace('/?run=' + encodeURIComponent(res.childRunId)); }, 900);
        } else { msg.className = 'msg bad'; msg.textContent = (res && res.message) || 'submit failed'; }
      })
      .catch(function (err) { btn.disabled = false; msg.className = 'msg bad'; msg.textContent = 'network error: ' + err; });
  }

  // ---------- boot + live wiring ----------
  // The terminal is rebuilt from the authoritative snapshot: boot in static
  // mode, and every SSE state frame in live mode. Raw event frames are
  // pushed too but only serve as transport; rebuilding from state guarantees
  // a duplicate-free terminal across SSE reconnects.
  function renderAll() {
    renderTopbar(); renderDag(); renderLogs(); renderA2ui();
    if (selectedId) renderInspector();
  }
  renderAll();
  requestAnimationFrame(function () { fitView(); });

  if (live && window.EventSource) {
    var es = new EventSource('/events' + QS);
    es.addEventListener('state', function (e) {
      try {
        var next = JSON.parse(e.data);
        next.mode = 'live';
        state = next;
        renderAll();
      } catch (err) { /* ignore malformed frame */ }
    });
    es.onerror = function () { /* EventSource auto-reconnects; the pill keeps pulsing */ };
  }
})();
</script>
</body>
</html>`;
