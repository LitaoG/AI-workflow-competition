import { DAGGraph } from '../types.js';
import { AUI_CSS, AUI_TICKER_JS } from '../visualizer/design-system.js';
import { escapeHtml } from '../utils/escape-html.js';

// ---------------------------------------------------------------------------
// Width-aware truncation (Issue #256). SVG <text> never clips, and this
// renderer runs in Node (no canvas measureText), so a CJK-heavy task line
// truncated by UTF-16 count painted 400px across a 220px card. Units are
// half-width columns: 1 unit ≈ 0.5em — a CJK glyph is 2 units, ASCII 1.
// ---------------------------------------------------------------------------
const WIDE_CHAR =
  /[\u1100-\u115F\u2329-\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FBFF}\u{20000}-\u{2FFFD}]/u;

/** Display width of one code point, in half-width column units. */
function charUnits(ch: string): number {
  return WIDE_CHAR.test(ch) ? 2 : 1;
}

export function displayColumns(text: string): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return units;
}

/**
 * Truncate to `maxUnits` half-width columns, appending an ellipsis (2 units
 * reserved) when cut. Iterates code points, so surrogate pairs (emoji) are
 * never split the way String.prototype.slice could.
 */
export function truncateToColumns(text: string, maxUnits: number): string {
  if (displayColumns(text) <= maxUnits) return text;
  let units = 0;
  let out = '';
  for (const ch of text) {
    const w = charUnits(ch);
    if (units + w > maxUnits - 2) return out + '…';
    units += w;
    out += ch;
  }
  return out;
}

export class HTMLRenderer {
  public render(graph: DAGGraph, lang: 'en' | 'zh' = 'en'): string {
    const isZh = lang === 'zh';

    const defaultDims = {
      phaseWidth: 260,
      phaseGap: 60,
      nodeWidth: 220,
      nodeHeight: 104,
      nodeGap: 30,
      headerHeight: 90,
      padding: 40,
    };

    /** The node's ACTUAL task line: journalled prompt / gate cmd / parked question (Issue #252). */
    const taskTextOf = (n: { inputs?: Record<string, string> }): string =>
      n.inputs?.prompt || n.inputs?.cmd || n.inputs?.question || '';

    // 1. Group nodes by phase
    const phaseNodesMap = new Map<string, typeof graph.nodes>();
    for (const phase of graph.phases) {
      phaseNodesMap.set(phase.id, []);
    }
    for (const node of graph.nodes) {
      const list = phaseNodesMap.get(node.phaseId) || [];
      list.push(node);
      phaseNodesMap.set(node.phaseId, list);
    }

    let maxNodesInAnyPhase = 1;
    const computedPhases: Array<{ id: string; name: string; x: number; width: number; height: number }> = [];
    const positionedNodes: any[] = [];
    const nodeMap = new Map<string, any>();

    graph.phases.forEach((phase, pIndex) => {
      const phaseX = defaultDims.padding + pIndex * (defaultDims.phaseWidth + defaultDims.phaseGap);
      const count = (phaseNodesMap.get(phase.id) || []).length;
      // Column rect hugs its own node stack (no more uniform full-height lanes).
      const phaseHeight = 52 + Math.max(count, 1) * (defaultDims.nodeHeight + defaultDims.nodeGap);
      computedPhases.push({
        id: phase.id,
        name: phase.name,
        x: phaseX,
        width: defaultDims.phaseWidth,
        height: phaseHeight,
      });

      const nodes = phaseNodesMap.get(phase.id) || [];
      if (nodes.length > maxNodesInAnyPhase) {
        maxNodesInAnyPhase = nodes.length;
      }

      nodes.forEach((node, nIndex) => {
        const nodeX = phaseX + (defaultDims.phaseWidth - defaultDims.nodeWidth) / 2;
        const nodeY = defaultDims.headerHeight + nIndex * (defaultDims.nodeHeight + defaultDims.nodeGap);

        const posNode = {
          ...node,
          x: nodeX,
          y: nodeY,
          width: defaultDims.nodeWidth,
          height: defaultDims.nodeHeight,
        };
        positionedNodes.push(posNode);
        nodeMap.set(node.id, posNode);
      });
    });

    const positionedEdges: any[] = [];
    for (const edge of graph.edges) {
      const src = nodeMap.get(edge.fromNodeId);
      const dst = nodeMap.get(edge.toNodeId);
      if (!src || !dst) continue;

      // 连线物理算法（Mission D P0-4）：四分支全锚定卡片边缘，杜绝同列节点
      // 「向右伸出→倒扣向左穿透」的飞线回绕。
      let x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number;
      const sameColumn = Math.abs(src.x - dst.x) < 1;
      if (sameColumn && dst.y > src.y && dst.y - (src.y + src.height) <= defaultDims.nodeGap + 2) {
        // 同列直接相邻：垂直直线脊柱（底缘中点 → 顶缘中点）
        x1 = src.x + src.width / 2;
        y1 = src.y + src.height;
        x2 = dst.x + dst.width / 2;
        y2 = dst.y;
        const midY = (y1 + y2) / 2;
        cx1 = x1; cy1 = midY; cx2 = x2; cy2 = midY;
      } else if (sameColumn) {
        // 同列非相邻/向上：卡片右侧弧形旁路（Side-Bypass），右缘出、右缘入
        x1 = src.x + src.width;
        y1 = src.y + src.height / 2;
        x2 = dst.x + dst.width;
        y2 = dst.y + dst.height / 2;
        const mx = Math.max(x1, x2) + 34;
        cx1 = mx; cy1 = y1; cx2 = mx; cy2 = y2;
      } else if (dst.x > src.x) {
        // 跨 Phase 前向：标准水平三次贝塞尔（右缘出、左缘入）
        x1 = src.x + src.width;
        y1 = src.y + src.height / 2;
        x2 = dst.x;
        y2 = dst.y + dst.height / 2;
        const dx = Math.min(Math.max((x2 - x1) * 0.45, 30), 92);
        cx1 = x1 + dx; cy1 = y1; cx2 = x2 - dx; cy2 = y2;
      } else {
        // 回边（跨列向左）：左向平滑 S 曲线（左缘出、右缘入），无倒扣
        x1 = src.x;
        y1 = src.y + src.height / 2;
        x2 = dst.x + dst.width;
        y2 = dst.y + dst.height / 2;
        const dx = Math.min(Math.max((x1 - x2) * 0.45, 30), 92);
        cx1 = x1 - dx; cy1 = y1; cx2 = x2 + dx; cy2 = y2;
      }

      const edgeStatus =
        dst.status === 'completed'
          ? 'completed'
          : dst.status === 'running'
          ? 'active'
          : dst.status === 'failed'
          ? 'failed'
          : 'pending';

      positionedEdges.push({
        ...edge,
        x1,
        y1,
        cx1,
        cy1,
        cx2,
        cy2,
        x2,
        y2,
        status: edgeStatus,
      });
    }

    const totalWidth = defaultDims.padding * 2 + Math.max(1, graph.phases.length) * (defaultDims.phaseWidth + defaultDims.phaseGap);
    const totalHeight = 52 + maxNodesInAnyPhase * (defaultDims.nodeHeight + defaultDims.nodeGap) + defaultDims.padding;

    // The JSON rides inside a <script> island: any literal `</script>` (or
    // `<!--`) in task text would close the block early and turn the rest of
    // the page into markup (Issue #269 C). Escaping `<` as `\u003c` keeps the
    // JSON semantics identical — JS string literals decode `\u003c` back.
    const nodesJson = JSON.stringify(positionedNodes).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>AI-Workflow Visualizer — ${escapeHtml(graph.workflowName)}</title>
  <style>${AUI_CSS}
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: var(--aui-sans); }
    body { background: var(--aui-bg); color: var(--aui-ink); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
    header {
      position: relative; height: 56px;
      display: flex; align-items: center; justify-content: space-between; padding: 0 20px; z-index: 10;
      background: linear-gradient(180deg, rgba(0,0,0,.015), rgba(0,0,0,0)), var(--aui-bg-raised);
      border-bottom: 1px solid var(--aui-border);
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .title { font-size: 14px; font-weight: 700; letter-spacing: .2px; color: var(--aui-ink); }
    .title .logo { color: var(--aui-blue); margin-right: 6px; }
    .metrics {
      font-size: 11px; font-weight: 600; color: var(--aui-muted);
      background: var(--aui-surface); padding: 5px 12px; border-radius: 999px;
      box-shadow: 0 0 0 1px var(--aui-border), 0 1px 2px rgba(0,0,0,.05);
      font-variant-numeric: tabular-nums;
    }
    .header-right { display: flex; align-items: center; gap: 10px; }
    button {
      font: 600 12px/1 var(--aui-sans); color: var(--aui-ink);
      background: linear-gradient(180deg, #33323a, #222028); border: 0;
      padding: 7px 14px; border-radius: var(--aui-radius-sm); cursor: pointer;
      box-shadow: 0 0 0 1px #0d0d0d, 0 2px 4px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08);
      transition: transform .16s var(--aui-ease), filter .16s var(--aui-ease);
    }
    button:hover { filter: brightness(1.12); transform: translateY(-1px); }
    button:active { transform: translateY(0); filter: brightness(.9); }
    #canvas-container { flex: 1; position: relative; overflow: hidden; cursor: grab; z-index: 1; }
    #canvas-container:active { cursor: grabbing; }
    svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    .phase-column { fill: url(#aui-phase-fill); stroke: var(--aui-border); rx: 16; }
    .phase-label { font-size: 13px; font-weight: 700; letter-spacing: .5px; fill: var(--aui-muted); text-anchor: middle; text-transform: uppercase; }
    .node-card { fill: url(#aui-node-fill); stroke: var(--aui-border); stroke-width: 1; rx: 10; cursor: pointer; transition: stroke .2s var(--aui-ease); }
    .node-card:hover { stroke: var(--aui-border-strong); }
    .node-card.completed { stroke: rgba(30,138,79,.5); }
    .node-card.running { stroke: var(--aui-blue); stroke-width: 1.6; animation: aui-pulse-blue 2s var(--aui-ease-2) infinite; }
    .node-card.failed { stroke: rgba(196,50,10,.6); }
    .node-card.gate { stroke: rgba(124,58,237,.5); }
    .node-title { font-size: 12px; font-weight: 600; fill: var(--aui-ink); }
    .node-task { font-size: 10px; fill: var(--aui-muted); }
    .node-error { font-size: 10px; fill: var(--aui-red); font-family: var(--aui-mono); }
    .node-role { font-size: 10px; fill: var(--aui-muted); font-family: var(--aui-mono); }
    .node-badge { font-size: 10px; font-weight: bold; }
    .bezier-edge { fill: none; stroke: #d4d4d8; stroke-width: 1.8; transition: stroke .2s var(--aui-ease); }
    .bezier-edge.active { stroke: var(--aui-blue); stroke-dasharray: 7 6; animation: aui-dash .9s linear infinite; }
    .bezier-edge.completed { stroke: rgba(30,138,79,.55); stroke-width: 2.2; }
    .bezier-edge.failed { stroke: rgba(196,50,10,.65); }
    #drawer {
      position: fixed; top: 56px; right: -430px; width: 430px; height: calc(100vh - 56px);
      background: linear-gradient(180deg, #ffffff, #fafafa);
      border-left: 1px solid var(--aui-border); box-shadow: -24px 0 60px rgba(0,0,0,.1);
      transition: right .3s var(--aui-ease); padding: 24px; overflow-y: auto; z-index: 20;
    }
    #drawer.open { right: 0; }
    .drawer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .drawer-header h3 { font-size: 15px; font-weight: 700; }
    pre { background: #f7f7f8; border: 1px solid var(--aui-border); border-radius: 8px; padding: 12px; font-size: 11px; font-family: var(--aui-mono); color: #4338ca; overflow-x: auto; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="aui-backdrop"></div>
  <div class="aui-grid"></div>
  <header>
    <div class="header-left">
      <div class="title"><span class="logo">◆</span>AI-Workflow Visualizer</div>
      <div class="metrics status-bar" id="metrics-label">
        ${graph.totalPhases} ${isZh ? '个阶段' : 'phases'} · ${graph.activeSubagents} ${isZh ? '个智能体并行执行中' : 'subagents active'}
      </div>
    </div>
    <div class="header-right">
      <button id="btn-reset" onclick="resetZoom()">${isZh ? '重置缩放' : 'Reset Zoom'}</button>
      <button id="btn-lang" onclick="toggleLang()">${isZh ? 'English' : '中文'}</button>
    </div>
  </header>

  <div id="canvas-container">
    <svg id="svg-canvas" viewBox="0 0 ${totalWidth} ${totalHeight}">
      <defs>
        <linearGradient id="aui-node-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#fafafa" />
        </linearGradient>
        <linearGradient id="aui-phase-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(23,23,23,0.02)" />
          <stop offset="1" stop-color="rgba(23,23,23,0.005)" />
        </linearGradient>
        <marker id="arrow-completed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#1e8a4f" />
        </marker>
        <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#2a8ce0" />
        </marker>
        <marker id="arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#d4d4d8" />
        </marker>
        <marker id="arrow-failed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#c4320a" />
        </marker>
      </defs>

      <g id="transform-group">
        <!-- Phase Columns -->
        ${computedPhases.map((p) => `
          <rect x="${p.x}" y="30" width="${p.width}" height="${p.height}" class="phase-column" />
          <title>${escapeHtml(p.name)}</title>
          <text x="${p.x + p.width / 2}" y="60" class="phase-label">${escapeHtml(truncateToColumns(p.name, Math.max(8, Math.floor(((p.width - 24) / 13) * 2))))}</text>
        `).join('')}

        <!-- Curved Bézier Edges -->
        ${positionedEdges.map((e) => `
          <path d="M ${e.x1} ${e.y1} C ${e.cx1} ${e.cy1}, ${e.cx2} ${e.cy2}, ${e.x2} ${e.y2}"
                class="bezier-edge ${e.status}"
                marker-end="url(#arrow-${e.status})" />
        `).join('')}

        <!-- Nodes -->
        ${positionedNodes.map((n, i) => {
          const task = taskTextOf(n);
          // Width-aware budgets (Issue #256): the card leaves 206px for the
          // task line (x+14 → right edge) at a 10px font → ~41 half-width
          // units, minus 2 for the ellipsis; never a bare UTF-16 count.
          const taskLine = truncateToColumns(task, Math.max(8, Math.floor(((n.width - 14) / 10) * 2) - 2));
          const errorLine = truncateToColumns(n.errorMessage ?? '', Math.max(8, Math.floor(((n.width - 14) / 10) * 2) - 2));
          // Core-builder steps may carry no `name` — the id is the honest fallback
          // (an undefined name here would crash escapeHtml's .replace, Issue #252).
          const nodeName = n.name || n.id;
          // Title shares the y+26 line with the status badge (x+width−24):
          // usable width = width − 38 at a 12px font (Issue #269 E-class).
          const titleLine = truncateToColumns(nodeName, Math.max(8, Math.floor(((n.width - 38) / 12) * 2) - 2));
          return `
          <g style="animation: aui-fade-up .5s var(--aui-ease) both; animation-delay: ${i * 30}ms" data-node-id="${escapeHtml(n.id)}">
            <title>${escapeHtml(nodeName)}${task ? '\n' + escapeHtml(task) : ''}${n.errorMessage ? '\n✖ ' + escapeHtml(n.errorMessage) : ''}</title>
            <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}"
                  class="node-card ${n.status} ${n.role === 'gate' ? 'gate' : ''}" />
            <text x="${n.x + 14}" y="${n.y + 26}" class="node-title">${escapeHtml(titleLine)}</text>
            ${n.errorMessage
              ? `<text x="${n.x + 14}" y="${n.y + 46}" class="node-error">✖ ${escapeHtml(errorLine)}</text>`
              : taskLine
              ? `<text x="${n.x + 14}" y="${n.y + 46}" class="node-task">${escapeHtml(taskLine)}</text>`
              : ''}
            <text x="${n.x + 14}" y="${n.y + 66}" class="node-role">
              [${escapeHtml(String(n.role).toUpperCase())}] ${n.durationMs ? '· ' + n.durationMs + 'ms' : ''}
            </text>
            <text x="${n.x + n.width - 24}" y="${n.y + 26}" class="node-badge" fill="${n.status === 'completed' ? '#1e8a4f' : n.status === 'running' ? '#2a8ce0' : '#a3a3a3'}">
              ${n.status === 'completed' ? '✔' : n.status === 'running' ? '●' : '○'}
            </text>
          </g>
        `;
        }).join('')}
      </g>
    </svg>
  </div>

  <div id="drawer">
    <div class="drawer-header">
      <h3 id="drawer-title">Node Inspector</h3>
      <button onclick="closeDrawer()">✕</button>
    </div>
    <div id="drawer-content"></div>
  </div>

  <script>${AUI_TICKER_JS}</script>
  <script>
    const nodes = ${nodesJson};
    let scale = 1, panX = 0, panY = 0, isDragging = false, startX, startY;
    const group = document.getElementById('transform-group');
    const container = document.getElementById('canvas-container');

    // Issue #269 B: node cards carry an escaped data-node-id attribute and
    // clicks are delegated here — the old inline handler built a JS string
    // out of the raw id, so an id containing a quote broke both the JS and
    // the attribute. getAttribute returns the DECODED value, which compares
    // equal to the id inside the JSON island.
    document.querySelectorAll('[data-node-id]').forEach(el => {
      el.addEventListener('click', () => inspectNode(el.getAttribute('data-node-id')));
    });

    // Issue #269 D: everything handed to drawer innerHTML passes through
    // auiEsc — JSON.stringify only escapes quotes, so an <img onerror=…>
    // payload would ride straight into an HTML-parsed string.
    function auiEsc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    container.addEventListener('mousedown', e => {
      if (e.target.tagName === 'button' || e.target.closest('#drawer')) return;
      isDragging = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
    });

    window.addEventListener('mousemove', e => {
      if (!isDragging) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      updateTransform();
    });

    window.addEventListener('mouseup', () => isDragging = false);

    container.addEventListener('wheel', e => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      scale = Math.min(Math.max(scale * zoomFactor, 0.2), 3.0);
      updateTransform();
    });

    function updateTransform() {
      group.setAttribute('transform', \`translate(\${panX}, \${panY}) scale(\${scale})\`);
    }

    function resetZoom() {
      scale = 1; panX = 0; panY = 0;
      updateTransform();
    }

    // 客户端 i18n：本地 file:// 页面刷新无法改变服务端烘焙的语言，改用双词典
    // 就地切换（修复 ?lang=zh 死按钮 Bug）。
    const I18N = {
      en: {
        metrics: '${graph.totalPhases} phases · ${graph.activeSubagents} subagents active',
        reset: 'Reset Zoom', toggle: '中文', inspector: 'Node Inspector',
        role: 'Role', status: 'Status', phase: 'Phase', duration: 'Duration',
        inputs: 'Inputs', outputs: 'Outputs',
      },
      zh: {
        metrics: '${graph.totalPhases} 个阶段 · ${graph.activeSubagents} 个智能体并行执行中',
        reset: '重置缩放', toggle: 'English', inspector: '节点检查器',
        role: '角色', status: '状态', phase: '阶段', duration: '耗时',
        inputs: '输入', outputs: '输出',
      },
    };
    let uiLang = '${lang}';
    let openNodeId = null;
    function t() { return I18N[uiLang]; }
    function applyLang() {
      document.getElementById('metrics-label').innerText = t().metrics;
      document.getElementById('btn-reset').innerText = t().reset;
      document.getElementById('btn-lang').innerText = t().toggle;
      if (!openNodeId) document.getElementById('drawer-title').innerText = t().inspector;
      if (openNodeId) inspectNode(openNodeId, true);
      if (window.auiScanTickers) auiScanTickers(document.getElementById('metrics-label'), 'metrics');
    }
    function toggleLang() {
      uiLang = uiLang === 'zh' ? 'en' : 'zh';
      applyLang();
    }
    applyLang();

    function inspectNode(id, keepOpen) {
      const node = nodes.find(n => n.id === id);
      if (!node) return;
      openNodeId = keepOpen ? openNodeId : id;
      document.getElementById('drawer-title').innerText = keepOpen ? t().inspector : node.name;
      document.getElementById('drawer-content').innerHTML = \`
        <p><strong>\${t().role}:</strong> \${auiEsc(node.role)}</p>
        <p><strong>\${t().status}:</strong> \${auiEsc(node.status)}</p>
        <p><strong>\${t().phase}:</strong> \${auiEsc(node.phaseName)}</p>
        <p><strong>\${t().duration}:</strong> \${node.durationMs || 0}ms</p>
        <h4 style="margin-top:16px;">\${t().inputs}</h4>
        <pre>\${auiEsc(JSON.stringify(node.inputs || {}, null, 2))}</pre>
        <h4 style="margin-top:16px;">\${t().outputs}</h4>
        <pre>\${auiEsc(JSON.stringify(node.outputs || {}, null, 2))}</pre>
      \`;
      document.getElementById('drawer').classList.add('open');
    }

    function closeDrawer() {
      document.getElementById('drawer').classList.remove('open');
      openNodeId = null;
      document.getElementById('drawer-title').innerText = t().inspector;
    }
  </script>
</body>
</html>`;
  }
}
