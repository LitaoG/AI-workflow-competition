export interface KanbanColumn {
  id: string;
  title: string;
  cards: KanbanCard[];
}

export interface KanbanCard {
  id: string;
  stepId: string;
  title: string;
  type: 'probe' | 'patch' | 'gate' | 'deliverable';
  status: 'pending' | 'active' | 'done' | 'failed';
  contentSnippet: string;
  timestamp: string;
}

export class KanbanDashboard {
  public buildColumns(
    artifacts: Array<{
      artifactId: string;
      stepId: string;
      name: string;
      artifactType: string;
      content: string;
      createdAt: string;
    }>
  ): KanbanColumn[] {
    const cols: Record<string, KanbanColumn> = {
      probe: { id: 'probe', title: '🔍 Probe Context', cards: [] },
      patch: { id: 'patch', title: '🤖 Agent Patches & AST', cards: [] },
      gate: { id: 'gate', title: '⚡ Gate & Test Logs', cards: [] },
      deliverable: { id: 'deliverable', title: '📦 Deliverables', cards: [] },
    };

    for (const art of artifacts) {
      const typeKey =
        art.artifactType === 'probe_json'
          ? 'probe'
          : art.artifactType === 'ast_patch' || art.artifactType === 'diff'
          ? 'patch'
          : art.artifactType === 'test_log'
          ? 'gate'
          : 'deliverable';

      cols[typeKey]?.cards.push({
        id: art.artifactId,
        stepId: art.stepId,
        title: art.name,
        type: typeKey as any,
        status: 'done',
        contentSnippet: art.content.slice(0, 160) + (art.content.length > 160 ? '...' : ''),
        timestamp: art.createdAt,
      });
    }

    return Object.values(cols);
  }

  public renderSummary(columns: KanbanColumn[]): string {
    const lines: string[] = ['=== Kanban Artifact Dashboard ==='];
    for (const col of columns) {
      lines.push(`\n[${col.title}] (${col.cards.length} items)`);
      for (const card of col.cards) {
        lines.push(`  - ${card.title} (${card.stepId}): ${card.contentSnippet}`);
      }
    }
    return lines.join('\n');
  }
}
