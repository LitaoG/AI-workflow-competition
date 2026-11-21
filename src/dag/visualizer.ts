import {
  DAGGraph,
  DAGNode,
  LayoutDimensions,
  PositionedNode,
  PositionedEdge,
  DAGVisualizer,
} from '../types.js';
import { HTMLRenderer } from './html-renderer.js';
import { MermaidRenderer } from './mermaid-renderer.js';
import { ASCIIRenderer } from './ascii-renderer.js';

export class DAGVisualizerCoordinator implements DAGVisualizer {
  private defaultDims: LayoutDimensions = {
    phaseWidth: 260,
    phaseGap: 60,
    nodeWidth: 220,
    nodeHeight: 85,
    nodeGap: 30,
    headerHeight: 90,
    padding: 40,
  };

  private htmlRenderer = new HTMLRenderer();
  private mermaidRenderer = new MermaidRenderer();
  private asciiRenderer = new ASCIIRenderer();

  public computeLayout(graph: DAGGraph, dims = this.defaultDims): {
    totalWidth: number;
    totalHeight: number;
    phases: Array<{ id: string; name: string; x: number; width: number }>;
    nodes: PositionedNode[];
    edges: PositionedEdge[];
  } {
    const positionedNodes: PositionedNode[] = [];
    const nodeMap = new Map<string, PositionedNode>();

    // 1. Group nodes by phase
    const phaseNodesMap = new Map<string, DAGNode[]>();
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

    // 2. Position nodes per phase
    graph.phases.forEach((phase, pIndex) => {
      const phaseX = dims.padding + pIndex * (dims.phaseWidth + dims.phaseGap);
      computedPhases.push({
        id: phase.id,
        name: phase.name,
        x: phaseX,
        width: dims.phaseWidth,
      });

      const nodes = phaseNodesMap.get(phase.id) || [];
      if (nodes.length > maxNodesInAnyPhase) {
        maxNodesInAnyPhase = nodes.length;
      }

      nodes.forEach((node, nIndex) => {
        const nodeX = phaseX + (dims.phaseWidth - dims.nodeWidth) / 2;
        const nodeY = dims.headerHeight + nIndex * (dims.nodeHeight + dims.nodeGap);

        const posNode: PositionedNode = {
          ...node,
          x: nodeX,
          y: nodeY,
          width: dims.nodeWidth,
          height: dims.nodeHeight,
        };
        positionedNodes.push(posNode);
        nodeMap.set(node.id, posNode);
      });
    });

    // 3. Compute curved Bézier edges
    const positionedEdges: PositionedEdge[] = [];
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

    const totalWidth = dims.padding * 2 + Math.max(1, graph.phases.length) * (dims.phaseWidth + dims.phaseGap);
    const totalHeight = dims.headerHeight + maxNodesInAnyPhase * (dims.nodeHeight + dims.nodeGap) + dims.padding;

    return {
      totalWidth,
      totalHeight,
      phases: computedPhases,
      nodes: positionedNodes,
      edges: positionedEdges,
    };
  }

  public renderHTML(graph: DAGGraph, lang: 'en' | 'zh' = 'en'): string {
    return this.htmlRenderer.render(graph, lang);
  }

  public renderMermaid(graph: DAGGraph, direction: 'LR' | 'TD' = 'LR'): string {
    return this.mermaidRenderer.render(graph, direction);
  }

  public renderASCII(graph: DAGGraph): string {
    return this.asciiRenderer.render(graph);
  }
}
