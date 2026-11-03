import { DAGGraph } from '../types.js';

export class MermaidRenderer {
  public render(graph: DAGGraph, direction: 'LR' | 'TD' = 'LR'): string {
    const lines: string[] = [`flowchart ${direction}`];

    // Subgraphs for phases
    for (const phase of graph.phases) {
      lines.push(`  subgraph ${phase.id}["${phase.name}"]`);
      const phaseNodes = graph.nodes.filter((n) => n.phaseId === phase.id);
      for (const node of phaseNodes) {
        const shape = node.role === 'gate' ? `{{${node.name}}}` : `["${node.name}"]`;
        lines.push(`    ${node.id}${shape}:::${node.status}`);
      }
      lines.push('  end');
    }

    // Edges
    for (const edge of graph.edges) {
      lines.push(`  ${edge.fromNodeId} --> ${edge.toNodeId}`);
    }

    // Class styles
    lines.push('  classDef completed fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff;');
    lines.push('  classDef running fill:#78350f,stroke:#f59e0b,stroke-width:2px,color:#fff;');
    lines.push('  classDef failed fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fff;');
    lines.push('  classDef pending fill:#1e293b,stroke:#475569,stroke-width:1px,color:#94a3b8;');

    return lines.join('\n');
  }
}
