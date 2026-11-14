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

    // Class styles — the shared design-system light palette
    // (src/visualizer/design-system.ts), tuned to read on light surfaces.
    lines.push('  classDef completed fill:#e7f6ee,stroke:#1e8a4f,stroke-width:2px,color:#14532d;');
    lines.push('  classDef running fill:#e8f1fd,stroke:#2a8ce0,stroke-width:2px,color:#0c4a8e;');
    lines.push('  classDef failed fill:#fdeae4,stroke:#c4320a,stroke-width:2px,color:#7c2d12;');
    lines.push('  classDef pending fill:#ffffff,stroke:#d4d4d8,stroke-width:1px,color:#737373;');
    lines.push('  classDef replayed fill:#e3f4fa,stroke:#0891b2,stroke-width:1.5px,color:#155e75;');
    lines.push('  classDef skipped fill:#fdf1e3,stroke:#b45309,stroke-width:1px,color:#7c2d12;');

    return lines.join('\n');
  }
}
