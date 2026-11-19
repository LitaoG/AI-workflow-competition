import { DAGGraph } from '../types.js';

/**
 * Issue #146: phase/node names come from scripts, agent output and journal
 * events — a raw `"` closes the mermaid string label and everything after it
 * becomes executable mermaid statement structure (e.g. `"]; click A
 * "javascript:alert(1)`). Escape the quote; brackets/semicolons are inert
 * inside a quoted label. (The HTML renderer escapes the same payloads —
 * this face had no escaping at all.)
 */
function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, '&quot;');
}

/**
 * Issue #146: ids interpolate UNQUOTED into mermaid statements
 * (`${node.id}${shape}`, `${edge.fromNodeId} --> …`) and can carry arbitrary
 * text from journal projections (e.g. `gate:<command>`). Clamp them to a
 * mermaid-safe identifier charset; ids are structural, not display text.
 */
function escapeMermaidId(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export class MermaidRenderer {
  public render(graph: DAGGraph, direction: 'LR' | 'TD' = 'LR'): string {
    const lines: string[] = [`flowchart ${direction}`];

    // Subgraphs for phases
    for (const phase of graph.phases) {
      lines.push(`  subgraph ${escapeMermaidId(phase.id)}["${escapeMermaidLabel(phase.name)}"]`);
      const phaseNodes = graph.nodes.filter((n) => n.phaseId === phase.id);
      for (const node of phaseNodes) {
        const shape = node.role === 'gate' ? `{{${escapeMermaidLabel(node.name)}}}` : `["${escapeMermaidLabel(node.name)}"]`;
        lines.push(`    ${escapeMermaidId(node.id)}${shape}:::${node.status}`);
      }
      lines.push('  end');
    }

    // Edges
    for (const edge of graph.edges) {
      lines.push(`  ${escapeMermaidId(edge.fromNodeId)} --> ${escapeMermaidId(edge.toNodeId)}`);
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
