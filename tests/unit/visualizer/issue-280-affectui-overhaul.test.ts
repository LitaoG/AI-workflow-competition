/**
 * Issue #280: Visualizer/Studio AffectUI overhaul test suite.
 * Validates:
 * 1. SVG arrowhead markers for flow directions.
 * 2. Canvas-first layout with collapsible sidebar drawer and button controls.
 * 3. Cross-phase edge connectivity in journal projection.
 * 4. Human-readable intent extraction and phase title auto-wrapping in Studio template.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStudioHtml, type StudioSnapshot } from '../../../src/visualizer/studio-renderer.js';
import { projectEventsToGraph } from '../../../src/dag/journal-projection.js';
import type { WorkflowEvent } from '../../../src/domain/events.js';

function snap(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return {
    mode: 'static',
    generatedAt: '2026-11-14T10:00:00.000Z',
    run: { runId: 'r-280', status: 'completed' } as StudioSnapshot['run'],
    graph: {
      workflowName: 'affectui-demo',
      runId: 'r-280',
      status: 'completed',
      phases: [
        { id: 'p1', name: 'Detection & Telemetry Probing', order: 1 },
        { id: 'p2', name: 'Remediation Synthesis & Safety Pair Review', order: 2 },
      ],
      nodes: [
        {
          id: 'ask#1',
          name: 'inspector',
          phaseId: 'p1',
          phaseName: 'Detection & Telemetry Probing',
          role: 'inspector',
          type: 'probe',
          status: 'completed',
          dependsOn: [],
          inputs: { prompt: 'Probe checkout service: {"service":"order-api","severity":"P1"}' },
          durationMs: 42,
        },
        {
          id: 'ask#2',
          name: 'planner',
          phaseId: 'p2',
          phaseName: 'Remediation Synthesis & Safety Pair Review',
          role: 'worker',
          type: 'agent',
          status: 'running',
          dependsOn: ['ask#1'],
          inputs: { prompt: 'Draft a remediation plan for this incident: {"incidentId":"INC-20261031-01","severity":"P1"}' },
        },
      ],
      edges: [{ fromNodeId: 'ask#1', toNodeId: 'ask#2' }],
      activeSubagents: 1,
      totalPhases: 2,
      currentPhaseIndex: 2,
      startedAt: '2026-11-14T10:00:00.000Z',
    },
    stats: { nodeCount: 2, replayHits: 0, amendHits: 0, eventCount: 8 },
    openQuestion: null,
    openHole: null,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

test('issue #280: studio template embeds SVG arrowhead markers in defs', () => {
  const html = renderStudioHtml(snap(), { live: false });
  assert.ok(html.includes('id="aui-arrow-completed"'), 'marker for completed edges must exist');
  assert.ok(html.includes('id="aui-arrow-running"'), 'marker for running edges must exist');
  assert.ok(html.includes('id="aui-arrow-pending"'), 'marker for pending edges must exist');
  assert.ok(html.includes('marker-end'), 'edges must carry marker-end referencing arrows');
});

test('issue #280: studio template ships full-width canvas by default and collapsible sidebar drawer', () => {
  const html = renderStudioHtml(snap(), { live: false });
  assert.ok(html.includes('body.sidebar-open #grid'), 'sidebar-open layout rule must exist');
  assert.ok(html.includes('id="btn-sidebar"'), 'topbar sidebar toggle button must exist');
  assert.ok(html.includes('id="btn-close-sidebar"'), 'inspector close button must exist');
  assert.ok(html.includes('toggleSidebar'), 'toggleSidebar function must be wired in client script');
});

test('issue #280: studio client script includes humanizeTask and wrapPhaseTitle', () => {
  const html = renderStudioHtml(snap(), { live: false });
  assert.ok(html.includes('function humanizeTask('), 'humanizeTask function must ship to client');
  assert.ok(html.includes('function wrapPhaseTitle('), 'wrapPhaseTitle function must ship to client');
  assert.ok(html.includes('function nodeStatusDetail('), 'nodeStatusDetail function must ship to client');
});

test('issue #280: journal projection establishes cross-phase sequential dependencies', () => {
  let seq = 0;
  const ev = (type: WorkflowEvent['type'], data: unknown, timestamp: string): WorkflowEvent => {
    seq += 1;
    return { id: `e${seq}`, workflowId: 'cross-phase-wf', runId: 'r-cp', type, timestamp, data };
  };

  const stream: WorkflowEvent[] = [
    ev('dwf_phase', { phase: 'Phase 1 - Detection' }, '2026-11-14T10:00:00.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#1', actor: 'inspector', prompt: 'inspect' }, '2026-11-14T10:00:01.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#1', actor: 'inspector' }, '2026-11-14T10:00:02.000Z'),
    ev('dwf_phase', { phase: 'Phase 2 - Remediation' }, '2026-11-14T10:00:03.000Z'),
    ev('dwf_ask_start', { siteId: 'ask#2', actor: 'planner', prompt: 'plan' }, '2026-11-14T10:00:04.000Z'),
    ev('dwf_ask_complete', { siteId: 'ask#2', actor: 'planner' }, '2026-11-14T10:00:05.000Z'),
  ];

  const graph = projectEventsToGraph(stream);
  assert.equal(graph.phases.length, 2);
  assert.equal(graph.nodes.length, 2);
  // Cross-phase edge should connect ask#1 -> ask#2
  const crossEdge = graph.edges.find((e) => e.fromNodeId === 'ask#1' && e.toNodeId === 'ask#2');
  assert.ok(crossEdge, 'cross-phase edge from Phase 1 last node to Phase 2 first node must exist');
  const node2 = graph.nodes.find((n) => n.id === 'ask#2');
  assert.ok(node2?.dependsOn.includes('ask#1'), 'ask#2 must depend on ask#1');
});
