/**
 * Studio page shell — the HTML template constant and the bilingual string
 * table, moved verbatim from studio-renderer so the renderer logic reads in
 * one screen. Placeholders (__STUDIO_*) are substituted by renderStudioHtml.
 *
 * Issue #248 visual recast: the affectui design language (MIT free-tier
 * sources + public demo observation, clean-room) applied across every region —
 * soft status pills, KPI metric cells in the top bar, icon-tile node cards
 * with per-type stroke icons, junction-dot edges, card-section inspector with
 * JSON highlighting / copy / capped code blocks, and the decision-inbox tray
 * for the A2UI forms. Test contract preserved verbatim: exactly four
 * `</script>` tags, the STUDIO_I18N strings, and the miniMarkdown regex
 * escaping.
 */
import { AUI_CSS, AUI_TICKER_JS } from './design-system.js';

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
    nodes: 'nodes',
    script: 'script',
    showAll: 'Show all',
    showLess: 'Show less',
    copy: 'Copy',
    copied: 'Copied',
    // Event-stream vocabulary, human phrasing (Issue #254)
    evPhase: '—— Phase {p} ——',
    evAskStart: '▶ Start agent "{actor}"',
    evAskDone: '✓ Agent "{actor}" finished',
    evReplay: '⚡ Replayed "{site}" — reused the cached result, 0 model calls',
    evAmend: '♻ "{site}" reused the amended baseline',
    evDiverged: '⑂ "{site}" diverged — executing live now',
    evEscalation: '❓ Needs your answer: {q}',
    evHole: '⌘ Missing piece "{n}" — waiting for you to fill it',
    evArtifact: '📄 Artifact "{id}" ({b} bytes)',
    evError: '✖ {site}: {err}',
    evCompleted: '✔ Run completed',
    evFailed: '✖ Run failed',
    evParked: '⏸ Run parked — waiting for your input',
    evSite: 'site {s}',
    // Inspector meta labels + localized type/role values (Issue #254)
    lblStatus: 'Status',
    lblPhase: 'Phase',
    lblRole: 'Role',
    lblType: 'Type',
    lblDuration: 'Duration',
    lblDependsOn: 'Depends on',
    typeAgent: 'Agent',
    typeAction: 'Action',
    typeGate: 'Gate',
    typeProbe: 'Probe',
    typeFanout: 'Fanout',
    roleWorker: 'Worker',
    roleInspector: 'Inspector',
    roleReviewer: 'Reviewer',
    roleGate: 'Gate',
    roleCoordinator: 'Coordinator',
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
    nodes: '节点',
    script: '脚本',
    showAll: '展开全部',
    showLess: '收起',
    copy: '复制',
    copied: '已复制',
    evPhase: '—— 阶段 {p} ——',
    evAskStart: '▶ 启动代理「{actor}」',
    evAskDone: '✓ 代理「{actor}」完成',
    evReplay: '⚡ 重放命中「{site}」——直接复用历史结果，0 次模型调用',
    evAmend: '♻ 「{site}」复用修订基线结果',
    evDiverged: '⑂ 「{site}」偏离基线，改为实时执行',
    evEscalation: '❓ 需要你拍板：{q}',
    evHole: '⌘ 待补块「{n}」——等待你补齐',
    evArtifact: '📄 产出「{id}」（{b} 字节）',
    evError: '✖ {site}：{err}',
    evCompleted: '✔ 工作流全部完成',
    evFailed: '✖ 工作流失败',
    evParked: '⏸ 运行暂停——等待你的输入',
    evSite: '站点 {s}',
    lblStatus: '状态',
    lblPhase: '阶段',
    lblRole: '角色',
    lblType: '类型',
    lblDuration: '耗时',
    lblDependsOn: '依赖',
    typeAgent: '智能体',
    typeAction: '动作',
    typeGate: '关卡',
    typeProbe: '探针',
    typeFanout: '分支',
    roleWorker: '执行者',
    roleInspector: '检查员',
    roleReviewer: '评审员',
    roleGate: '关卡',
    roleCoordinator: '协调者',
  },
};

export const STUDIO_TEMPLATE = `<!doctype html>
<html lang="__STUDIO_LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>${AUI_CSS}
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--aui-bg); color: var(--aui-ink);
    font: 13px/1.45 var(--aui-sans);
    display: grid; grid-template-rows: 56px 1fr; overflow: hidden;
  }
  /* ---------- top bar: brand · KPI strip · actions ---------- */
  #topbar {
    position: relative; z-index: 10;
    display: flex; align-items: center; gap: 18px; padding: 0 18px;
    border-bottom: 1px solid var(--aui-border);
    background: linear-gradient(180deg, rgba(0,0,0,.015), rgba(0,0,0,0)), var(--aui-bg-raised);
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; letter-spacing: .2px; white-space: nowrap; }
  .brand .logo { display: block; flex: none; }
  .brand .studio { color: var(--aui-blue-deep); font-weight: 600; }
  .mono { font-family: var(--aui-mono); font-size: 12px; color: var(--aui-muted); }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    height: 22px; padding: 0 11px; border-radius: 999px;
    font: 500 11px/16px var(--aui-sans); letter-spacing: .2px; text-transform: capitalize;
    background: var(--aui-subtle); color: var(--aui-muted); white-space: nowrap;
  }
  .pill::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.running { background: var(--aui-info-soft); color: var(--aui-info); box-shadow: 0 0 14px rgba(0,96,226,.14); }
  .pill.running::before { animation: aui-breath 1.8s ease-in-out infinite; }
  .pill.completed { background: var(--aui-success-soft); color: var(--aui-green); }
  .pill.failed, .pill.aborted { background: var(--aui-danger-soft); color: var(--aui-red); }
  .pill.parked { background: var(--aui-warning-soft); color: var(--aui-warning); }
  #chips { display: flex; gap: 0; flex: 1; min-width: 0; overflow: hidden; }
  #chips .aui-kpi { padding: 0 18px; }
  #chips .aui-kpi:first-child { padding-left: 2px; }
  #chips .aui-kpi + .aui-kpi { border-left: 1px solid var(--aui-border); }
  .aui-kpi.replay .k-value { color: var(--aui-cyan); }
  .k-value .k-mono { font: 500 11px var(--aui-mono); color: var(--aui-muted); }
  #topbar .actions { display: flex; gap: 7px; }
  #topbar .actions button {
    font: 600 12px/1 var(--aui-sans); color: var(--aui-ink);
    background: var(--aui-surface); border: 0;
    border-radius: var(--aui-radius-sm); padding: 7px 13px; cursor: pointer;
    box-shadow: 0 0 0 1px var(--aui-border), 0 1px 2px rgba(0,0,0,.04);
    transition: transform .16s var(--aui-ease), box-shadow .16s var(--aui-ease), background-color .16s var(--aui-ease);
  }
  #topbar .actions button:hover { background: #f7f7f7; box-shadow: 0 0 0 1px var(--aui-border-strong), 0 2px 6px -1px rgba(0,0,0,.08); }
  #topbar .actions button:active { transform: scale(.98); }
  button.primary {
    background: linear-gradient(180deg, #2a8ce0, #0060e2); color: #fff; font-weight: 700;
    box-shadow: 0 0 0 1px rgba(0,96,226,.5), 0 2px 10px rgba(0,96,226,.3);
  }
  button.primary:hover { transform: translateY(-1px); }
  /* ---------- main grid ---------- */
  #grid { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr) clamp(360px, 34vw, 520px); grid-template-rows: minmax(0, 1fr); min-height: 0; }
  body.focus-logs #grid { grid-template-columns: minmax(0, 1fr); }
  body.focus-logs #canvas-pane { display: none; }
  #canvas-pane { position: relative; min-width: 0; min-height: 0; }
  #dag { width: 100%; height: 100%; display: block; cursor: grab; }
  #dag.dragging { cursor: grabbing; }
  #canvas-hint {
    position: absolute; bottom: 12px; left: 14px; color: var(--aui-faint); font-size: 11px;
    pointer-events: none; font-family: var(--aui-mono);
  }
  #right { display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 42%); min-width: 0; min-height: 0; border-left: 1px solid var(--aui-border); background: var(--aui-bg-raised); }
  body.focus-logs #right { grid-template-rows: minmax(0, 1fr); }
  body.focus-logs #inspector-pane { display: none; }
  .pane { display: flex; flex-direction: column; min-height: 0; }
  .pane + .pane { border-top: 1px solid var(--aui-border); }
  .pane-head {
    display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 42px;
    border-bottom: 1px solid var(--aui-border); color: var(--aui-faint); font-size: 10.5px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
    background: var(--aui-bg-raised);
  }
  .pane-head .spacer { flex: 1; }
  .pane-head input {
    background: var(--aui-bg); border: 1px solid var(--aui-border); color: var(--aui-ink);
    border-radius: var(--aui-radius-sm); padding: 5px 10px; font: 12px var(--aui-mono); width: 40%;
    transition: border-color .16s var(--aui-ease), box-shadow .16s var(--aui-ease);
  }
  .pane-head input:focus { outline: none; border-color: var(--aui-blue); box-shadow: 0 0 0 3px rgba(0,96,226,.12); }
  /* ---------- event terminal ---------- */
  #term { overflow-y: auto; padding: 10px 0 14px; font-family: var(--aui-mono); font-size: 11.5px; line-height: 1.55; flex: 1; }
  .tline { padding: 1.5px 14px; white-space: pre-wrap; word-break: break-word; color: var(--aui-muted); }
  .tline .tt { color: var(--aui-faint); font-size: 10px; margin-right: 8px; }
  .tline.lv-phase { color: var(--aui-purple); font-weight: 600; margin-top: 8px; }
  .tline.lv-ok { color: var(--aui-green); }
  .tline.lv-bad { color: var(--aui-red); }
  .tline.lv-warn { color: var(--aui-warning); }
  .tline.lv-replay { color: var(--aui-cyan); }
  .empty { color: var(--aui-faint); padding: 26px 16px; text-align: center; font-size: 12.5px; }
  /* ---------- inspector: card sections + KPI meta rows ---------- */
  #inspector { overflow-y: auto; padding: 14px 16px 20px; flex: 1; }
  .insp-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  #inspector h3 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .idchip { font: 11px var(--aui-mono); color: var(--aui-faint); background: var(--aui-subtle); border-radius: 6px; padding: 2px 7px; }
  .meta-card { background: var(--aui-surface); border-radius: 12px; box-shadow: var(--aui-shadow-card); padding: 2px 12px; margin: 10px 0 4px; }
  .mrow { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 7px 0; }
  .mrow + .mrow { border-top: 1px solid var(--aui-border); }
  .mrow .mk { font: 600 9.5px var(--aui-sans); letter-spacing: .8px; text-transform: uppercase; color: var(--aui-faint); padding-top: 3px; white-space: nowrap; }
  .mrow .mv { font: 500 12.5px/1.4 var(--aui-sans); color: var(--aui-ink); text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .mrow .mv .mv-raw { color: var(--aui-faint); font: 10.5px var(--aui-mono); margin-left: 6px; }
  .isec { margin: 14px 0 0; }
  .isec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; margin-bottom: 6px; }
  .isec-label { font: 600 9.5px var(--aui-sans); letter-spacing: .8px; text-transform: uppercase; color: var(--aui-faint); }
  .aui-code {
    background: var(--aui-code-bg); box-shadow: inset 0 0 0 1px var(--aui-border); border-radius: 8px;
    padding: 10px 12px; font: 11.5px/1.6 var(--aui-mono); color: var(--aui-muted);
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; tab-size: 2;
  }
  .aui-code.capped { max-height: 220px; overflow: hidden; position: relative; }
  .aui-code.capped::after {
    content: ""; position: absolute; left: 1px; right: 1px; bottom: 1px; height: 56px;
    background: linear-gradient(to bottom, transparent, var(--aui-code-bg));
    border-radius: 0 0 8px 8px; pointer-events: none;
  }
  .aui-code.capped.open { max-height: 480px; overflow-y: auto; overscroll-behavior: contain; }
  .aui-code.capped.open::after { display: none; }
  .linkbtn {
    all: unset; justify-self: start; padding: 2px 4px; margin: 6px 0 0 -4px; border-radius: 5px;
    color: var(--aui-muted); font-size: 12px; font-weight: 500; cursor: pointer;
    transition: color .16s ease;
  }
  .linkbtn:hover { color: var(--aui-ink); }
  .copybtn {
    all: unset; position: relative; display: grid; place-items: center;
    width: 24px; height: 24px; border-radius: 6px; color: var(--aui-muted); cursor: pointer;
    transition: background-color .16s ease, color .16s ease;
  }
  .copybtn:hover { background: var(--aui-wash); color: var(--aui-ink); }
  .copybtn svg {
    position: absolute; width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round;
    transition: opacity .2s ease, transform .32s var(--aui-ease), filter .2s ease;
  }
  .copybtn .ic-done { opacity: 0; transform: scale(.6); filter: blur(2px); stroke-width: 1.7; }
  .copybtn.copied { color: var(--aui-green); }
  .copybtn.copied .ic-copy { opacity: 0; transform: scale(.6); filter: blur(2px); }
  .copybtn.copied .ic-done { opacity: 1; transform: none; filter: none; }
  .errbox {
    display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 8px;
    background: var(--aui-danger-soft); box-shadow: inset 0 0 0 1px rgba(196,50,10,.25);
    color: var(--aui-red); font-size: 12.5px; line-height: 1.45; white-space: pre-line; overflow-wrap: anywhere;
  }
  .errbox svg { flex: none; width: 14px; height: 14px; margin-top: 2px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .st-completed { color: var(--aui-green); } .st-running { color: var(--aui-blue); }
  .st-failed { color: var(--aui-red); } .st-replayed { color: var(--aui-cyan); }
  .st-pending, .st-skipped { color: var(--aui-muted); }
  .box {
    background: linear-gradient(180deg, #ffffff, #fcfcfc); border: 1px solid var(--aui-border); border-radius: 10px;
    padding: 10px 12px; margin: 8px 0; font-family: var(--aui-mono); font-size: 11.5px;
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .box.md { font-family: var(--aui-sans); font-size: 12.5px; background: var(--aui-surface); box-shadow: var(--aui-shadow-card); border: 0; }
  .box.md h1, .box.md h2, .box.md h3 { margin: .6em 0 .3em; line-height: 1.3; }
  .box.md h1 { font-size: 1.25em; } .box.md h2 { font-size: 1.12em; } .box.md h3 { font-size: 1em; }
  .box.md code { background: var(--aui-bg); border: 1px solid var(--aui-border); border-radius: 4px; padding: 0 4px; font-size: .92em; }
  .box.md pre { background: var(--aui-bg); border: 1px solid var(--aui-border); border-radius: 8px; padding: 8px 10px; overflow-x: auto; }
  .box.md pre code { border: 0; background: none; padding: 0; }
  .box.md ul { margin: .4em 0; padding-left: 1.3em; }
  .box.md a { color: var(--aui-blue-deep); }
  .dl-row { display: flex; gap: 8px; margin: 8px 0; }
  .dl-row button {
    font: 600 12px/1 var(--aui-sans); color: var(--aui-ink);
    background: var(--aui-surface); border: 0; border-radius: var(--aui-radius-sm);
    padding: 7px 13px; cursor: pointer;
    box-shadow: 0 0 0 1px var(--aui-border), 0 1px 2px rgba(0,0,0,.04);
    transition: transform .16s var(--aui-ease), box-shadow .16s var(--aui-ease), background-color .16s var(--aui-ease);
  }
  .dl-row button:hover { background: #f7f7f7; box-shadow: 0 0 0 1px var(--aui-border-strong), 0 2px 6px -1px rgba(0,0,0,.08); }
  /* ---------- A2UI inline form: the decision-inbox tray ---------- */
  #a2ui {
    position: fixed; right: 18px; bottom: 18px; width: min(440px, calc(100vw - 36px));
    background: var(--aui-subtle); border-radius: 22px; padding: 6px;
    box-shadow: var(--aui-shadow-pop); z-index: 50;
    animation: aui-fade-up .4s var(--aui-ease) both;
  }
  .a2ui-card { background: var(--aui-surface); border: 1px solid var(--aui-border); border-radius: var(--aui-radius-lg); padding: 15px 18px 13px; }
  #a2ui .a2ui-head { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--aui-warning); }
  #a2ui .a2ui-head svg { flex: none; width: 16px; height: 16px; }
  #a2ui .a2ui-q { color: var(--aui-ink); font-size: 13px; line-height: 1.5; margin: 8px 0 10px; white-space: pre-wrap; }
  #a2ui textarea, #a2ui input[type=text] {
    width: 100%; background: var(--aui-surface); border: 1px solid var(--aui-border); border-radius: 8px;
    color: var(--aui-ink); font: 12.5px var(--aui-mono); padding: 8px 10px; resize: vertical;
    transition: border-color .16s var(--aui-ease), box-shadow .16s var(--aui-ease);
  }
  #a2ui textarea { min-height: 88px; }
  #a2ui textarea:focus, #a2ui input:focus { outline: none; border-color: var(--aui-amber); box-shadow: 0 0 0 3px rgba(180,83,9,.14); }
  #a2ui .a2ui-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  #a2ui .a2ui-foot button {
    font: 600 12px/1 var(--aui-sans); color: #fafafa;
    background: linear-gradient(180deg, #323137, #201e25); border: 0;
    border-radius: var(--aui-radius-sm); padding: 8px 14px; cursor: pointer;
    box-shadow: 0 0 0 1px #0d0d0d, 0 2px 4px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.14);
    transition: transform .16s var(--aui-ease), filter .16s var(--aui-ease);
  }
  #a2ui .a2ui-foot button:hover { filter: brightness(1.15); transform: translateY(-1px); }
  #a2ui .a2ui-foot button:disabled { opacity: .55; cursor: default; transform: none; }
  #a2ui .msg { color: var(--aui-muted); font-size: 11.5px; flex: 1; }
  #a2ui .msg.ok { color: var(--aui-green); } #a2ui .msg.bad { color: var(--aui-red); }
  #a2ui .hint { color: var(--aui-faint); font-size: 10.5px; font-family: var(--aui-mono); margin-top: 10px; word-break: break-all; }
  /* ---------- SVG topology ---------- */
  .col-bg { fill: rgba(23,23,23,.014); stroke: var(--aui-border); stroke-width: 1; rx: 16; }
  .col-title { fill: var(--aui-muted); font: 700 12px var(--aui-sans); letter-spacing: .3px; }
  .col-count { fill: var(--aui-faint); font: 10.5px var(--aui-mono); }
  .edge { fill: none; stroke-width: 2; }
  .edge.st-completed { stroke: rgba(30,138,79,.5); }
  .edge.st-running { stroke: var(--aui-blue); stroke-dasharray: 7 5; animation: aui-dash .9s linear infinite; }
  .edge.st-failed { stroke: rgba(196,50,10,.55); }
  .edge.st-replayed { stroke: rgba(8,145,178,.5); }
  .edge.st-pending, .edge.st-skipped { stroke: #dcdcdf; }
  .edge-dot { fill: #ffffff; stroke-width: 1.5; }
  .edge-dot.st-completed { stroke: #1e8a4f; }
  .edge-dot.st-running { stroke: #2a8ce0; }
  .edge-dot.st-failed { stroke: #c4320a; }
  .edge-dot.st-replayed { stroke: #0891b2; }
  .node { cursor: pointer; }
  .node > .card {
    fill: url(#aui-node-fill); stroke: var(--aui-border); stroke-width: 1; rx: 12;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.07));
    transition: stroke .2s var(--aui-ease);
  }
  .node:hover > .card { stroke: var(--aui-border-strong); }
  .node.selected > .card { stroke: var(--aui-blue); stroke-width: 1.6; }
  .node.st-running > .card { stroke: var(--aui-blue); animation: aui-pulse-blue 2s var(--aui-ease-2) infinite; }
  .node.st-failed > .card { stroke: rgba(196,50,10,.5); }
  .node.st-replayed > .card { stroke: rgba(8,145,178,.5); }
  .node .sbar { rx: 2; }
  .node .ntile { fill: #f5f5f6; stroke: var(--aui-border); rx: 6; }
  .node .nicon { fill: none; stroke: var(--aui-ink); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .node.st-completed .nicon { stroke: var(--aui-green); }
  .node.st-running .nicon { stroke: var(--aui-blue); }
  .node.st-failed .nicon { stroke: var(--aui-red); }
  .node.st-replayed .nicon { stroke: var(--aui-cyan); }
  .node.st-pending .nicon, .node.st-skipped .nicon { stroke: var(--aui-faint); }
  .node .ntitle { fill: var(--aui-ink); font: 600 12px var(--aui-sans); }
  .node .ntask { fill: var(--aui-muted); font: 10.5px var(--aui-sans); }
  .node .nmeta { fill: var(--aui-faint); font: 10.5px var(--aui-mono); }
  .node .nerr { fill: var(--aui-red); font: 10.5px var(--aui-mono); }
  .npill-text { font: 600 9px var(--aui-sans); letter-spacing: .2px; }
  .npill-halo { opacity: .35; animation: aui-breath 1.8s ease-in-out infinite; }
  .rbadge-rect { fill: #e0f4f8; stroke: rgba(8,145,178,.45); rx: 8; }
  .rbadge-text { fill: var(--aui-cyan); font: 700 9px var(--aui-sans); letter-spacing: .4px; }
</style>
</head>
<body>
<div class="aui-backdrop"></div>
<div class="aui-grid"></div>
<header id="topbar">
  <div class="brand"><svg class="logo" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="4.7" y="4.7" width="8.6" height="8.6" rx="2.2" transform="rotate(45 9 9)" fill="#0060e2"/><circle cx="9" cy="9" r="2" fill="#ffffff" opacity=".92"/></svg>AI-Workflow <span class="studio">Studio</span></div>
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
    <svg id="dag">
      <defs>
        <linearGradient id="aui-node-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#fafafa" />
        </linearGradient>
      </defs>
      <g id="viewport"></g>
    </svg>
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
<script>${AUI_TICKER_JS}</script>
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
  function fmtDur(ms) {
    if (ms === undefined || ms === null) return '';
    if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
    if (ms < 60000) return (Math.floor(ms / 100) / 10).toFixed(1) + 's';
    var s = Math.floor(ms / 1000);
    if (s < 3600) return Math.floor(s / 60) + 'm ' + ('0' + (s % 60)).slice(-2) + 's';
    var h = Math.floor(s / 3600);
    if (h < 24) return h + 'h ' + ('0' + Math.floor(s / 60) % 60).slice(-2) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function nowStamp() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }

  // ---------- node icons: per-type 16×16 stroke paths (original drawings) ----------
  var KIND_ICON = {
    agent: 'M8 1.6 L9.7 6.3 L14.4 8 L9.7 9.7 L8 14.4 L6.3 9.7 L1.6 8 L6.3 6.3 Z',
    worldRead: 'M8 2 L14 8 L8 14 L2 8 Z M8 5.4 L10.6 8 L8 10.6 L5.4 8 Z',
    worldRun: 'M2.5 3.5 H13.5 V12.5 H2.5 Z M4.7 6.2 L6.9 8 L4.7 9.8 M8.4 9.8 H11.3',
    gate: 'M8 1.6 L13.4 3.6 V7.2 C13.4 10.4 11 12.7 8 14.4 C5 12.7 2.6 10.4 2.6 7.2 V3.6 Z M5.9 7.9 L7.5 9.5 L10.3 6.4',
    artifact: 'M4.5 1.5 H9.5 L12.5 4.5 V14.5 H4.5 Z M9.5 1.5 V4.5 H12.5 M6.3 8 H10.7 M6.3 10.6 H10.7',
    hole: 'M5.5 2.5 H3.5 V13.5 H5.5 M10.5 2.5 H12.5 V13.5 H10.5',
    report: 'M4 2.5 V13.5 M4 3.5 H12.5 L10.3 6.5 L12.5 9.5 H4',
    escalation: 'M8 1.5 A6.5 6.5 0 1 1 7.99 1.5 M8 10.6 V11 M8 5 A1.9 1.9 0 0 1 9.9 6.9 C9.9 8 8 8.3 8 9.4',
    probe: 'M8 2 L14 8 L8 14 L2 8 Z M6.3 8 L8 9.7 L9.7 8',
    action: 'M5.6 3.2 L12.3 8 L5.6 12.8 Z',
    fanout: 'M8 2 V6 M8 6 L4.2 9.8 M8 6 L11.8 9.8 M4.2 9.8 V13.5 M11.8 9.8 V13.5'
  };
  function iconPathOf(node) {
    var t = node.type || '';
    if (KIND_ICON[t]) return KIND_ICON[t];
    if (String(node.id).indexOf('gate:') === 0) return KIND_ICON.gate;
    if (String(node.id).indexOf('artifact:') === 0) return KIND_ICON.artifact;
    return KIND_ICON.action;
  }
  function nodeTitle(n) {
    var id = String(n.id);
    if (id.indexOf('artifact:') === 0) return 'artifact ' + id.slice(9);
    if (id.indexOf('gate:') === 0) return 'gate ' + id.slice(5);
    return n.name || id;
  }

  // ---------- top bar: brand · KPI strip · status ----------
  function renderTopbar() {
    document.getElementById('runid').textContent = state.run.runId + (state.run.parentRunId ? T.amendOf + state.run.parentRunId : '');
    var pill = document.getElementById('statuspill');
    pill.textContent = state.run.status;
    pill.className = 'pill ' + state.run.status;
    var chips = document.getElementById('chips');
    chips.innerHTML = '';
    // KPI cells (Trace-Waterfall metric-strip pattern): tiny label over a
    // tabular value, separated by hairlines instead of pill shadows.
    function kpi(label, valueHtml, cls) {
      var c = el('span', 'aui-kpi' + (cls ? ' ' + cls : ''),
        '<span class="k-label">' + esc(label) + '</span><span class="k-value">' + valueHtml + '</span>');
      chips.appendChild(c);
    }
    // Issue #96 follow-up (F3): the pill and the canvas must agree — count
    // the SAME nodes the canvas draws, not the run's recorded step count.
    var canvasNodeCount = state.graph && state.graph.nodes ? state.graph.nodes.length : state.stats.nodeCount;
    kpi(T.nodes || 'nodes', String(canvasNodeCount));
    kpi(T.replay || 'replay', String(state.stats.replayHits), 'replay');
    if (state.stats.amendHits) kpi(T.amend || 'amend', String(state.stats.amendHits));
    kpi(T.events || 'events', String(state.stats.eventCount));
    if (state.run.scriptPath) {
      var tail = state.run.scriptPath.length > 40 ? '…' + state.run.scriptPath.slice(-39) : state.run.scriptPath;
      kpi(T.script || 'script', '<span class="k-mono">' + esc(tail) + '</span>');
    }
    auiScanTickers(chips, 'chips');
  }

  // ---------- topology layout + edge routing ----------
  var LAYOUT = null; // { pos, cols, width, height }
  // Canvas measureText (offline, zero-CDN): node cards size to their widest
  // title so names never fall back to "…" while a sane cap keeps extreme
  // ids from stretching a whole phase column (Issue #250).
  var measureC2d = null;
  function measureText(text, fontCss) {
    if (!measureC2d) { measureC2d = document.createElement('canvas'); measureC2d.width = 4; measureC2d.height = 4; }
    var ctx = measureC2d.getContext('2d');
    ctx.font = fontCss;
    return ctx.measureText(text).width;
  }
  function bodyFontFamily() { return getComputedStyle(document.body).fontFamily; }
  function monoFontFamily() { return getComputedStyle(document.getElementById('term')).fontFamily; }
  function pillWidth(status) {
    var tone = NPILL[status] || NPILL.pending;
    return 14 + (tone.live ? 10 : 0) + String(status).length * 5.2;
  }
  function cardWidth() {
    var g = state.graph, maxTitle = 0, maxPill = 0;
    var fam = bodyFontFamily();
    (g.nodes || []).forEach(function (n) {
      maxTitle = Math.max(maxTitle, measureText(nodeTitle(n), '600 12px ' + fam));
      maxPill = Math.max(maxPill, pillWidth(n.status || 'pending'));
    });
    return Math.min(460, Math.max(234, Math.ceil(maxTitle + 42 + maxPill + 22)));
  }
  // The ACTUAL work a node does, journalled by the engine: the ask prompt
  // (redacted, capped at 400 chars), a gate's command line, or the parked
  // question — whatever the script really asked this step to do (Issue #252).
  function taskTextOf(n) {
    var inputs = n.inputs || {};
    return inputs.prompt || inputs.cmd || inputs.question || '';
  }
  // Greedy two-line wrap by measured width: word-first (latin), char fallback
  // for CJK/oversized words, ellipsis terminating the second line.
  function wrapTask(text, fontCss, maxW) {
    var words = String(text).split(/\\s+/).filter(Boolean);
    var lines = ['', ''];
    var li = 0;
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      while (measureText(word, fontCss) > maxW) {
        var fit = 1;
        while (fit < word.length && measureText(word.slice(0, fit + 1), fontCss) <= maxW) fit++;
        lines[li] = word.slice(0, fit);
        word = word.slice(fit);
        if (!word) break;
        if (li < 1) { li++; continue; }
        lines[li] = lines[li] + '…';
        return lines;
      }
      if (!word) { if (li < 1) li++; break; }
      var candidate = lines[li] ? lines[li] + ' ' + word : word;
      if (measureText(candidate, fontCss) <= maxW) { lines[li] = candidate; continue; }
      if (li < 1) { li++; lines[li] = word; }
      else {
        var t = lines[li];
        while (t && measureText(t + '…', fontCss) > maxW) t = t.slice(0, -1);
        lines[li] = t + '…';
        return lines;
      }
    }
    return lines;
  }
  function computeLayout() {
    var W = cardWidth(), H = 88, VGAP = 18, COLGAP = 66, TOP = 58, PAD = 30;
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

  /* 拓扑连线物理算法 —— 见模块 TSDoc 军规。所有分支都锚定卡片边缘，无倒扣。
     Returns { d, ax, ay } — (ax, ay) is the source anchor for the junction dot. */
  function edgePath(a, b) {
    var sameCol = a.col === b.col;
    if (sameCol) {
      if (b.y > a.y && (b.y - (a.y + a.h)) <= 26) {
        var x = a.x + a.w / 2;                       // 相邻上下：垂直直线脊柱
        return { d: 'M' + x + ' ' + (a.y + a.h) + ' L' + x + ' ' + b.y, ax: x, ay: a.y + a.h };
      }
      var rx1 = a.x + a.w, ry1 = a.y + a.h / 2, rx2 = b.x + b.w, ry2 = b.y + b.h / 2;
      var mx = Math.max(rx1, rx2) + 34;              // 同列非相邻/向上：右侧弧形旁路
      return { d: 'M' + rx1 + ' ' + ry1 + ' C' + mx + ' ' + ry1 + ', ' + mx + ' ' + ry2 + ', ' + rx2 + ' ' + ry2, ax: rx1, ay: ry1 };
    }
    if (b.x > a.x) {                                  // 跨 Phase 前向：标准水平贝塞尔
      var fx1 = a.x + a.w, fy1 = a.y + a.h / 2, fx2 = b.x, fy2 = b.y + b.h / 2;
      var dx = Math.min(Math.max((fx2 - fx1) * 0.45, 30), 92);
      return { d: 'M' + fx1 + ' ' + fy1 + ' C' + (fx1 + dx) + ' ' + fy1 + ', ' + (fx2 - dx) + ' ' + fy2 + ', ' + fx2 + ' ' + fy2, ax: fx1, ay: fy1 };
    }
    var bx1 = a.x, by1 = a.y + a.h / 2, bx2 = b.x + b.w, by2 = b.y + b.h / 2;   // 回边：左向平滑 S 曲线
    var bdx = Math.min(Math.max((bx1 - bx2) * 0.45, 30), 92);
    return { d: 'M' + bx1 + ' ' + by1 + ' C' + (bx1 - bdx) + ' ' + by1 + ', ' + (bx2 + bdx) + ' ' + by2 + ', ' + bx2 + ' ' + by2, ax: bx1, ay: by1 };
  }

  // Node status → soft-pill palette (the affectui soft-tint pairs).
  var NPILL = {
    running: { bg: '#eaf1ff', fg: '#2456d6', live: true },
    completed: { bg: '#e6f6ed', fg: '#1e8a4f' },
    failed: { bg: '#fdecea', fg: '#c4320a' },
    replayed: { bg: '#e0f4f8', fg: '#0891b2' },
    pending: { bg: '#f0f0f0', fg: '#737373' },
    skipped: { bg: '#f0f0f0', fg: '#a3a3a3' }
  };

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
    // edges first (under cards), with junction dots at the source anchor
    (g.edges || []).forEach(function (e) {
      var a = LAYOUT.pos[e.fromNodeId], b = LAYOUT.pos[e.toNodeId];
      if (!a || !b) return;
      var st = b.status || 'pending';
      var p = edgePath(a, b);
      var path = svg('path', { d: p.d, 'class': 'edge st-' + st });
      if (e.label) {
        var tt = svg('title'); tt.textContent = e.label; path.appendChild(tt);
      }
      vp.appendChild(path);
      if (st !== 'pending' && st !== 'skipped') {
        vp.appendChild(svg('circle', { cx: p.ax, cy: p.ay, r: 3.2, 'class': 'edge-dot st-' + st }));
      }
    });
    // node cards
    g.nodes.forEach(function (n) {
      var p = LAYOUT.pos[n.id]; if (!p) return;
      var st = n.status || 'pending';
      var grp = svg('g', { 'class': 'node st-' + st, 'data-id': n.id });
      // Hover tooltip: FULL title, task and error regardless of on-card caps.
      var tip = svg('title');
      var tipText = nodeTitle(n);
      var taskFull = taskTextOf(n);
      if (taskFull) tipText += '\\n' + taskFull;
      if (n.errorMessage) tipText += '\\n✖ ' + n.errorMessage;
      tip.textContent = tipText;
      grp.appendChild(tip);
      grp.appendChild(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 12, 'class': 'card' }));
      var barColor = { completed: '#1e8a4f', running: '#2a8ce0', failed: '#c4320a', replayed: '#0891b2' }[st] || '#d4d4d8';
      grp.appendChild(svg('rect', { x: p.x, y: p.y + 10, width: 3, height: p.h - 20, rx: 2, fill: barColor, 'class': 'sbar' }));
      // icon tile + per-type stroke icon
      grp.appendChild(svg('rect', { x: p.x + 12, y: p.y + 10, width: 22, height: 22, rx: 6, 'class': 'ntile' }));
      var icon = svg('path', {
        d: iconPathOf(n), 'class': 'nicon',
        transform: 'translate(' + (p.x + 15) + ',' + (p.y + 13) + ')'
      });
      grp.appendChild(icon);
      // status pill (top-right, soft tint)
      var tone = NPILL[st] || NPILL.pending;
      var pw = 14 + (tone.live ? 10 : 0) + String(st).length * 5.2;
      var px = p.x + p.w - pw - 10;
      grp.appendChild(svg('rect', { x: px, y: p.y + 9, width: pw, height: 16, rx: 8, fill: tone.bg }));
      if (tone.live) {
        grp.appendChild(svg('circle', { cx: px + 8, cy: p.y + 17, r: 5, fill: tone.fg, 'class': 'npill-halo' }));
        grp.appendChild(svg('circle', { cx: px + 8, cy: p.y + 17, r: 2.6, fill: tone.fg }));
      }
      var ptxt = svg('text', { x: px + (tone.live ? 14 : 8), y: p.y + 20.5, fill: tone.fg, 'class': 'npill-text' });
      ptxt.textContent = st;
      grp.appendChild(ptxt);
      // title: full text — the card width was measured to fit it (Issue #250);
      // only the 460px cap can still force a proportional fallback cut.
      var fam = bodyFontFamily();
      var avail = p.w - 42 - (pw + 16);
      var tFull = nodeTitle(n);
      var tW = measureText(tFull, '600 12px ' + fam);
      var titleText = tFull;
      if (tW > avail) {
        var cut = Math.max(6, Math.floor(tFull.length * avail / tW) - 1);
        titleText = tFull.slice(0, cut) + '…';
      }
      var title = svg('text', { x: p.x + 42, y: p.y + 25, 'class': 'ntitle' });
      title.textContent = titleText;
      grp.appendChild(title);
      // task line (Issue #252): WHAT this step actually does — the journalled
      // prompt / gate command / parked question, wrapped to two measured
      // lines. On a failed node the error takes the slot (red); the tooltip
      // and the inspector always carry the full text.
      var famTask = bodyFontFamily();
      var taskW = p.w - 42 - 12;
      var task = n.errorMessage ? '' : taskTextOf(n);
      if (task) {
        var tLines = wrapTask(task, '10.5px ' + famTask, taskW);
        if (tLines[0]) {
          var tl1 = svg('text', { x: p.x + 42, y: p.y + 42, 'class': 'ntask' });
          tl1.textContent = tLines[0]; grp.appendChild(tl1);
        }
        if (tLines[1]) {
          var tl2 = svg('text', { x: p.x + 42, y: p.y + 56, 'class': 'ntask' });
          tl2.textContent = tLines[1]; grp.appendChild(tl2);
        }
      } else if (n.errorMessage) {
        var eAvail = taskW;
        var eW = measureText('✖ ' + n.errorMessage, '10.5px ' + monoFontFamily());
        var errText = '✖ ' + n.errorMessage;
        if (eW > eAvail) {
          var ecut = Math.max(8, Math.floor(n.errorMessage.length * eAvail / eW) - 1);
          errText = '✖ ' + n.errorMessage.slice(0, ecut) + '…';
        }
        var eline = svg('text', { x: p.x + 42, y: p.y + 42, 'class': 'nerr' });
        eline.textContent = errText; grp.appendChild(eline);
      }
      // meta row: duration · role (bottom row, fixed rhythm)
      var metaBits = [];
      if (n.durationMs !== undefined) metaBits.push(fmtDur(n.durationMs));
      if (n.role && n.role !== 'coordinator') metaBits.push(n.role);
      if (metaBits.length) {
        var meta = svg('text', { x: p.x + 42, y: p.y + 73, 'class': 'nmeta' });
        meta.textContent = metaBits.join(' · ');
        grp.appendChild(meta);
      }
      if (st === 'replayed') {
        var bw = 62;
        grp.appendChild(svg('rect', { x: p.x + p.w - bw - 10, y: p.y - 8, width: bw, height: 16, rx: 8, 'class': 'rbadge-rect' }));
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
  // JSON syntax highlighting (the affectui tool-call-card token palette):
  // keys in ink, strings teal, numbers amber, literals purple — each token
  // escaped individually so hostile strings stay inert.
  function highlightJson(src) {
    var out = '';
    var re = /("(?:[^"\\\\]|\\\\.)*")(\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g;
    var last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) out += esc(src.slice(last, m.index));
      if (m[1] && m[2]) {
        out += '<span class="aui-tok-key">' + esc(m[1]) + '</span>' + esc(m[2]);
      } else if (m[1]) {
        out += '<span class="aui-tok-str">' + esc(m[1]) + '</span>';
      } else {
        var kind = /^[tfn]/.test(m[0]) ? 'lit' : 'num';
        out += '<span class="aui-tok-' + kind + '">' + esc(m[0]) + '</span>';
      }
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  }
  // Inspector copy registry: buttons reference raw text by index, so huge
  // payloads never travel through DOM attributes.
  var copyTexts = [];
  function copyBtnHtml(idx) {
    if (idx < 0) return '';
    return '<button class="copybtn" data-copy-idx="' + idx + '" title="' + esc(T.copy || 'Copy') + '">' +
      '<svg class="ic-copy" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="2"/><path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-4.5a2 2 0 0 0-2 2v4.5a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>' +
      '<svg class="ic-done" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.3 12.5 4.9"/></svg></button>';
  }
  function codeBlock(text, isJson) {
    var capped = text.length > 2400 || text.split('\\n').length > 24;
    var copyIdx = text.length <= 200000 ? copyTexts.push(text) - 1 : -1;
    var body = '<div class="aui-code' + (capped ? ' capped' : '') + '"><code>' +
      (isJson ? highlightJson(text) : esc(text)) + '</code></div>' +
      (capped ? '<button class="linkbtn" data-more>' + esc(T.showAll || 'Show all') + '</button>' : '');
    return { body: body, copyIdx: copyIdx };
  }
  var ERROR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.4M8 10.9v.1"/></svg>';
  var WARN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 2.3a1.5 1.5 0 0 1 2.6 0l5.4 9.4A1.5 1.5 0 0 1 13.4 14H2.6a1.5 1.5 0 0 1-1.3-2.3Z" fill="currentColor" stroke="none"/><path d="M8 5.6v3.6" stroke="#fff" stroke-width="1.5"/><circle cx="8" cy="11.4" r="0.85" fill="#fff" stroke="none"/></svg>';
  var HOLE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2.5 H3.5 V13.5 H5.5 M10.5 2.5 H12.5 V13.5 H10.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var INSP_TONE = { completed: 'tone-success', running: 'tone-info', failed: 'tone-danger', replayed: 'tone-purple', pending: 'tone-neutral', skipped: 'tone-neutral' };
  function renderInspector() {
    var box = document.getElementById('inspector');
    document.getElementById('insp-tag').textContent = selectedId || '';
    var n = selectedId ? nodeById(selectedId) : null;
    if (!n) { box.innerHTML = '<div class="empty">' + (T.inspectorEmpty || '') + '</div>'; return; }
    copyTexts = [];
    var html = '<div class="insp-head"><h3>' + esc(nodeTitle(n)) + '</h3><span class="idchip">' + esc(n.id) + '</span></div>';
    // KPI-style meta card
    var rows = '';
    function mrow(k, vHtml) { rows += '<div class="mrow"><span class="mk">' + k + '</span><span class="mv">' + vHtml + '</span></div>'; }
    var tone = INSP_TONE[n.status] || 'tone-neutral';
    // Localized labels and human values (Issue #254); the raw engine value
    // stays as a faint mono suffix for CLI correlation.
    var TYPE_KEY = { agent: 'typeAgent', action: 'typeAction', gate: 'typeGate', probe: 'typeProbe', fanout: 'typeFanout' };
    var ROLE_KEY = { worker: 'roleWorker', inspector: 'roleInspector', reviewer: 'roleReviewer', gate: 'roleGate', coordinator: 'roleCoordinator' };
    function localizedValue(map, raw) {
      var loc = (raw && map[raw] && T[map[raw]]) ? T[map[raw]] : raw;
      return esc(loc) + (loc !== raw ? ' <span class="mv-raw">' + esc(raw) + '</span>' : '');
    }
    mrow(T.lblStatus || 'status', '<span class="aui-badge ' + tone + '"><span class="dot' + (n.status === 'running' ? ' live' : '') + '"></span>' + esc(n.status || 'pending') + '</span>');
    if (n.phaseName || n.phaseId) mrow(T.lblPhase || 'phase', esc(n.phaseName || n.phaseId));
    if (n.role) mrow(T.lblRole || 'role', localizedValue(ROLE_KEY, n.role));
    if (n.type) mrow(T.lblType || 'type', localizedValue(TYPE_KEY, n.type));
    if (n.durationMs !== undefined) mrow(T.lblDuration || 'duration', esc(fmtDur(n.durationMs)));
    if (n.dependsOn && n.dependsOn.length) {
      var depNames = n.dependsOn.map(function (id) { var dn = nodeById(id); return dn ? nodeTitle(dn) : id; });
      mrow(T.lblDependsOn || 'depends on', esc(depNames.join(', ')));
    }
    html += '<div class="meta-card">' + rows + '</div>';
    function isec(label, headExtra, bodyHtml) {
      return '<div class="isec"><div class="isec-head"><span class="isec-label">' + label + '</span>' + (headExtra || '') + '</div>' + bodyHtml + '</div>';
    }
    if (n.inputs && Object.keys(n.inputs).length) {
      var cbIn = codeBlock(JSON.stringify(n.inputs, null, 2), true);
      html += isec('INPUT', copyBtnHtml(cbIn.copyIdx), cbIn.body);
    }
    if (n.outputs !== undefined && n.outputs !== null) {
      var text = typeof n.outputs === 'string' ? n.outputs : JSON.stringify(n.outputs, null, 2);
      var cbo = codeBlock(text, typeof n.outputs !== 'string');
      html += isec('OUTPUT', copyBtnHtml(cbo.copyIdx), cbo.body);
    }
    var art = artifactFor(n);
    if (art && art.content) {
      var isMd = (art.type || '').indexOf('markdown') >= 0 || /\\.(md|markdown)$/i.test(art.name || '');
      html += isec('ARTIFACT · ' + esc(art.name), '',
        '<div class="dl-row"><button id="btn-dl">下载 download</button>' + (isMd ? '<button id="btn-raw">raw</button>' : '') + '</div>' +
        '<div class="box' + (isMd ? ' md' : '') + '" id="art-body">' + (isMd ? miniMarkdown(art.content) : esc(art.content)) + '</div>');
    }
    if (n.errorMessage) {
      html += isec('ERROR', '', '<div class="errbox">' + ERROR_ICON + '<span>' + esc(n.errorMessage) + '</span></div>');
    }
    box.innerHTML = html;
    // wire section copy buttons + capped "show all" toggles
    var copyBtns = box.querySelectorAll('.copybtn');
    for (var i = 0; i < copyBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-copy-idx'));
          var text = copyTexts[idx];
          if (text === undefined) return;
          copyToClipboard(text).then(function (ok) {
            if (!ok) return;
            btn.classList.add('copied');
            setTimeout(function () { btn.classList.remove('copied'); }, 1400);
          });
        });
      })(copyBtns[i]);
    }
    var moreBtns = box.querySelectorAll('[data-more]');
    for (var j = 0; j < moreBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var code = btn.parentNode.querySelector('.aui-code');
          if (!code) return;
          var open = code.classList.toggle('open');
          btn.textContent = open ? (T.showLess || 'Show less') : (T.showAll || 'Show all');
        });
      })(moreBtns[j]);
    }
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
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    area.remove();
    return Promise.resolve(ok);
  }

  // ---------- event terminal ----------
  // Placeholder fill that replaces EVERY occurrence (String.replace only
  // handles the first — split/join is the safe form).
  function fmt(tpl, vars) {
    var s = String(tpl == null ? '' : tpl);
    for (var k in vars || {}) s = s.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k]));
    return s;
  }
  // Human phrasing for every journalled event (Issue #254): the engine's
  // internal vocabulary (ask/replay/amend/hole/escalation) becomes bilingual
  // sentences; the raw siteId survives only as a faint correlation tail so
  // the 'workflow answer/fill' CLI lines still match up.
  function classifyEvent(ev) {
    var d = ev.data || {};
    switch (ev.type) {
      case 'dwf_phase': return { cls: 'lv-phase', text: fmt(T.evPhase, { p: d.phase || 'phase' }) };
      case 'dwf_log': return { cls: '', text: d.message || '' };
      case 'dwf_ask_start': return { cls: '', text: fmt(T.evAskStart, { actor: d.actor || d.siteId }) + (d.siteId ? ' · ' + fmt(T.evSite, { s: d.siteId }) : '') };
      case 'dwf_ask_complete': return { cls: 'lv-ok', text: fmt(T.evAskDone, { actor: d.actor || d.siteId }) };
      case 'dwf_world_run': return { cls: 'lv-warn', text: '$ ' + (d.cmd || '') + ' ' + (Array.isArray(d.args) ? d.args.map(String).join(' ') : '') };
      case 'dwf_replay_hit': return { cls: 'lv-replay', text: fmt(T.evReplay, { site: (d.siteId || '') + (d.ordinal !== undefined ? '#' + d.ordinal : '') }) };
      case 'dwf_amend_hit': return { cls: 'lv-replay', text: fmt(T.evAmend, { site: (d.siteId || '') + (d.ordinal !== undefined ? '#' + d.ordinal : '') }) };
      case 'dwf_amend_diverged': return { cls: 'lv-warn', text: fmt(T.evDiverged, { site: d.siteId || '' }) };
      case 'dwf_call_error': case 'dwf_node_failed': return { cls: 'lv-bad', text: fmt(T.evError, { site: d.siteId || d.op || '', err: d.error || '' }) };
      case 'dwf_escalation_open': return { cls: 'lv-warn', text: fmt(T.evEscalation, { q: d.question || '' }) + (d.siteId ? ' · ' + fmt(T.evSite, { s: d.siteId }) : '') };
      case 'dwf_hole_open': return { cls: 'lv-warn', text: fmt(T.evHole, { n: d.name || '' }) + (d.siteId ? ' · ' + fmt(T.evSite, { s: d.siteId }) : '') };
      case 'dwf_artifact': return { cls: 'lv-ok', text: fmt(T.evArtifact, { id: d.id, b: d.bytes }) };
      case 'dwf_report': return { cls: '', text: 'report: ' + JSON.stringify(d.item) };
      case 'dwf_completed': return { cls: 'lv-ok', text: T.evCompleted || '✔ Run completed' };
      case 'dwf_failed': return { cls: 'lv-bad', text: T.evFailed || '✖ Run failed' };
      case 'dwf_parked': return { cls: 'lv-warn', text: T.evParked || '⏸ Run parked' };
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

  // ---------- A2UI inline form (Human-in-the-Loop) — decision-inbox tray ----------
  function renderA2ui() {
    var box = document.getElementById('a2ui');
    var q = state.openQuestion, h = state.openHole;
    if (!live || (!q && !h)) { box.hidden = true; return; }
    box.hidden = false;
    if (q) {
      box.innerHTML =
        '<div class="a2ui-card">' +
        '<div class="a2ui-head">' + WARN_ICON + '<span>❓ Workflow needs your answer (escalation)</span></div>' +
        '<div class="a2ui-q">' + esc(q.question) + '</div>' +
        '<textarea id="a2ui-text" placeholder="Type your answer…"></textarea>' +
        '<div class="a2ui-foot"><span class="msg" id="a2ui-msg"></span><button id="a2ui-send">提交继续 Submit & Resume</button></div>' +
        '<div class="hint">site ' + esc(q.siteId) + ' · questionId ' + esc(q.questionId) + ' · CLI: workflow answer ' + esc(state.run.runId) + ' ' + esc(q.questionId) + ' "&lt;text&gt;"</div>' +
        '</div>';
      document.getElementById('a2ui-send').addEventListener('click', function () {
        submitA2ui('/api/answer', { questionId: q.questionId, text: document.getElementById('a2ui-text').value });
      });
    } else if (h) {
      box.innerHTML =
        '<div class="a2ui-card">' +
        '<div class="a2ui-head">' + HOLE_ICON + '<span>⌘ Fill the hole: ' + esc(h.name) + '</span></div>' +
        '<div class="a2ui-q">' + esc(h.prompt) + '</div>' +
        '<textarea id="a2ui-text" placeholder="// JS statements using facade globals (agent(), phase(), …)"></textarea>' +
        '<div class="a2ui-foot"><span class="msg" id="a2ui-msg"></span><button id="a2ui-send">提交继续 Fill & Resume</button></div>' +
        '<div class="hint">site ' + esc(h.siteId) + ' · CLI: workflow fill ' + esc(state.run.runId) + ' ' + esc(h.name) + ' &lt;bodyFile&gt;</div>' +
        '</div>';
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
