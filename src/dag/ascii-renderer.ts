import { DAGGraph } from '../types.js';

export class ASCIIRenderer {
  public render(graph: DAGGraph): string {
    const out: string[] = [];
    out.push(`========================================================================`);
    out.push(` AI-Workflow: ${graph.workflowName} (Run: ${graph.runId})`);
    out.push(` Status: ${graph.totalPhases} phases · ${graph.activeSubagents} active subagents`);
    out.push(`========================================================================\n`);

    graph.phases.forEach((phase, index) => {
      out.push(`┌── Phase ${index + 1}: ${phase.name} [Phase: ${phase.name}] ${'─'.repeat(Math.max(5, 35 - phase.name.length))}┐`);
      const nodes = graph.nodes.filter((n) => n.phaseId === phase.id);
      nodes.forEach((node, nIdx) => {
        const isLast = nIdx === nodes.length - 1;
        const branch = isLast ? '└──' : '├──';
        const icon =
          node.status === 'completed'
            ? '[✔]'
            : node.status === 'running'
            ? '[●]'
            : node.status === 'failed'
            ? '[✖]'
            : '[ ]';
        const role = node.role === 'gate' ? '⚡ Gate' : `🤖 ${node.role}`;
        const timing = node.durationMs ? `(${node.durationMs}ms)` : '';
        out.push(`│  ${branch} ${icon} ${role}: ${node.name} ${timing}`);
      });
      out.push(`└${'─'.repeat(60)}┘`);
      if (index < graph.phases.length - 1) {
        out.push(`                             │`);
        out.push(`                             ▼`);
      }
    });

    return out.join('\n');
  }
}
