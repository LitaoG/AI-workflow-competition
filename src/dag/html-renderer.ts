import { DAGGraph } from '../types.js';

export class HTMLRenderer {
  public render(graph: DAGGraph, lang: 'en' | 'zh' = 'en'): string {
    const isZh = lang === 'zh';

    const defaultDims = {
      phaseWidth: 260,
      phaseGap: 60,
      nodeWidth: 220,
      nodeHeight: 85,
      nodeGap: 30,
      headerHeight: 90,
      padding: 40,
    };

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
    const computedPhases: Array<{ id: string; name: string; x: number; width: number }> = [];
    const positionedNodes: any[] = [];
    const nodeMap = new Map<string, any>();

    graph.phases.forEach((phase, pIndex) => {
      const phaseX = defaultDims.padding + pIndex * (defaultDims.phaseWidth + defaultDims.phaseGap);
      computedPhases.push({
        id: phase.id,
        name: phase.name,
        x: phaseX,
        width: defaultDims.phaseWidth,
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

      const x1 = src.x + src.width;
      const y1 = src.y + src.height / 2;
      const x2 = dst.x;
      const y2 = dst.y + dst.height / 2;

      const deltaX = Math.max(Math.abs(x2 - x1) * 0.5, 40);
      const cx1 = x1 + deltaX;
      const cy1 = y1;
      const cx2 = x2 - deltaX;
      const cy2 = y2;

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
    const totalHeight = defaultDims.headerHeight + maxNodesInAnyPhase * (defaultDims.nodeHeight + defaultDims.nodeGap) + defaultDims.padding;

    const nodesJson = JSON.stringify(positionedNodes);

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>AI-Workflow Visualizer — ${graph.workflowName}</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131b2e;
      --border: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --completed: #10b981;
      --running: #f59e0b;
      --failed: #ef4444;
      --gate-color: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; }
    body { background: var(--bg); color: var(--text); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
    header { height: 60px; background: #0f172a; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 24px; z-index: 10; }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .title { font-size: 16px; font-weight: 700; color: var(--accent); }
    .metrics { font-size: 13px; color: var(--text-muted); background: #1e293b; padding: 4px 12px; border-radius: 9999px; }
    .header-right { display: flex; align-items: center; gap: 12px; }
    button { background: #1e293b; border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    button:hover { background: #334155; }
    #canvas-container { flex: 1; position: relative; overflow: hidden; cursor: grab; }
    #canvas-container:active { cursor: grabbing; }
    svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    .phase-column { fill: #0f172a; stroke: var(--border); stroke-dasharray: 4; rx: 8; opacity: 0.6; }
    .phase-label { font-size: 14px; font-weight: 600; fill: var(--text-muted); text-anchor: middle; }
    .node-card { fill: var(--card-bg); stroke: var(--border); rx: 8; cursor: pointer; transition: stroke 0.2s; }
    .node-card:hover { stroke: var(--accent); }
    .node-card.completed { stroke: var(--completed); }
    .node-card.running { stroke: var(--running); stroke-width: 2; }
    .node-card.failed { stroke: var(--failed); }
    .node-card.gate { stroke: var(--gate-color); }
    .node-title { font-size: 12px; font-weight: 600; fill: var(--text); }
    .node-role { font-size: 10px; fill: var(--text-muted); }
    .node-badge { font-size: 10px; font-weight: bold; }
    .bezier-edge { fill: none; stroke: #334155; stroke-width: 2; transition: stroke 0.2s; }
    .bezier-edge.active { stroke: var(--accent); stroke-dasharray: 6; animation: dash 1s linear infinite; }
    .bezier-edge.completed { stroke: var(--completed); stroke-width: 2.5; }
    .bezier-edge.failed { stroke: var(--failed); }
    @keyframes dash { to { stroke-dashoffset: -12; } }
    #drawer { position: fixed; top: 60px; right: -420px; width: 420px; height: calc(100vh - 60px); background: #0f172a; border-left: 1px solid var(--border); transition: right 0.25s ease; padding: 24px; overflow-y: auto; z-index: 20; }
    #drawer.open { right: 0; }
    .drawer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; font-size: 11px; color: #a5b4fc; overflow-x: auto; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="title">AI-Workflow Visualizer</div>
      <div class="metrics status-bar" id="metrics-label">
        ${graph.totalPhases} phases · ${graph.totalPhases} ${isZh ? '个阶段' : 'phases'} · ${graph.activeSubagents} ${isZh ? '个智能体并行执行中' : 'subagents active'}
      </div>
    </div>
    <div class="header-right">
      <button onclick="resetZoom()">${isZh ? '重置缩放' : 'Reset Zoom'}</button>
      <button onclick="toggleLang()">${isZh ? 'English' : '中文'}</button>
    </div>
  </header>

  <div id="canvas-container">
    <svg id="svg-canvas" viewBox="0 0 ${totalWidth} ${totalHeight}">
      <defs>
        <marker id="arrow-completed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#10b981" />
        </marker>
        <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
        </marker>
        <marker id="arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
        </marker>
        <marker id="arrow-failed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#ef4444" />
        </marker>
      </defs>

      <g id="transform-group">
        <!-- Phase Columns -->
        ${computedPhases.map((p) => `
          <rect x="${p.x}" y="30" width="${p.width}" height="${totalHeight - 50}" class="phase-column" />
          <text x="${p.x + p.width / 2}" y="60" class="phase-label">${p.name}</text>
        `).join('')}

        <!-- Curved Bézier Edges -->
        ${positionedEdges.map((e) => `
          <path d="M ${e.x1} ${e.y1} C ${e.cx1} ${e.cy1}, ${e.cx2} ${e.cy2}, ${e.x2} ${e.y2}"
                class="bezier-edge ${e.status}"
                marker-end="url(#arrow-${e.status})" />
        `).join('')}

        <!-- Nodes -->
        ${positionedNodes.map((n) => `
          <g onclick="inspectNode('${n.id}')">
            <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}"
                  class="node-card ${n.status} ${n.role === 'gate' ? 'gate' : ''}" />
            <text x="${n.x + 14}" y="${n.y + 26}" class="node-title">${n.name}</text>
            <text x="${n.x + 14}" y="${n.y + 46}" class="node-role">
              [${String(n.role).toUpperCase()}] ${n.durationMs ? '· ' + n.durationMs + 'ms' : ''}
            </text>
            <text x="${n.x + n.width - 24}" y="${n.y + 26}" class="node-badge" fill="${n.status === 'completed' ? '#10b981' : n.status === 'running' ? '#f59e0b' : '#94a3b8'}">
              ${n.status === 'completed' ? '✔' : n.status === 'running' ? '●' : '⏳'}
            </text>
          </g>
        `).join('')}
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

  <script>
    const nodes = ${nodesJson};
    let scale = 1, panX = 0, panY = 0, isDragging = false, startX, startY;
    const group = document.getElementById('transform-group');
    const container = document.getElementById('canvas-container');

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

    function inspectNode(id) {
      const node = nodes.find(n => n.id === id);
      if (!node) return;
      document.getElementById('drawer-title').innerText = node.name;
      document.getElementById('drawer-content').innerHTML = \`
        <p><strong>Role:</strong> \${node.role}</p>
        <p><strong>Status:</strong> \${node.status}</p>
        <p><strong>Phase:</strong> \${node.phaseName}</p>
        <p><strong>Duration:</strong> \${node.durationMs || 0}ms</p>
        <h4 style="margin-top:16px;">Inputs</h4>
        <pre>\${JSON.stringify(node.inputs || {}, null, 2)}</pre>
        <h4 style="margin-top:16px;">Outputs</h4>
        <pre>\${JSON.stringify(node.outputs || {}, null, 2)}</pre>
      \`;
      document.getElementById('drawer').classList.add('open');
    }

    function closeDrawer() {
      document.getElementById('drawer').classList.remove('open');
    }

    function toggleLang() {
      const url = new URL(window.location);
      url.searchParams.set('lang', '${lang === 'zh' ? 'en' : 'zh'}');
      window.location = url.toString();
    }
  </script>
</body>
</html>`;
  }
}
