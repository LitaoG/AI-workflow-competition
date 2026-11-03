import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow } from '../../src/core/workflow.js';
import { actionStep, gateStep } from '../../src/core/step.js';
import { DAGVisualizerCoordinator } from '../../src/dag/visualizer.js';

function createSampleWorkflow(): Workflow {
  const wf = new Workflow({ name: 'VisualizerSampleWorkflow' });
  wf.addPhase({ id: 'p1', name: 'Phase One' });
  wf.addPhase({ id: 'p2', name: 'Phase Two' });

  wf.addStep(
    actionStep({
      id: 'step-1',
      name: 'Step 1',
      phaseId: 'p1',
      role: 'inspector',
      action: async () => {},
    })
  );

  wf.addStep(
    actionStep({
      id: 'step-2',
      name: 'Step 2',
      phaseId: 'p2',
      role: 'worker',
      dependsOn: ['step-1'],
      action: async () => {},
    })
  );

  wf.addStep(
    gateStep({
      id: 'gate-3',
      name: 'Gate 3',
      phaseId: 'p2',
      dependsOn: ['step-2'],
      command: 'echo ok',
    })
  );

  return wf;
}

test('DAG Visualizer: builds graph nodes and edges from workflow definition', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');

  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.phases.length, 2);
  assert.equal(graph.workflowName, 'VisualizerSampleWorkflow');
});

test('DAG Visualizer: computes cubic Bézier SVG curve parameters connecting ports', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');
  const coordinator = new DAGVisualizerCoordinator();
  const layout = coordinator.computeLayout(graph);

  assert.equal(layout.edges.length, 2);
  for (const edge of layout.edges) {
    assert.ok(Number.isFinite(edge.x1));
    assert.ok(Number.isFinite(edge.y1));
    assert.ok(Number.isFinite(edge.cx1));
    assert.ok(Number.isFinite(edge.cy1));
    assert.ok(Number.isFinite(edge.cx2));
    assert.ok(Number.isFinite(edge.cy2));
    assert.ok(Number.isFinite(edge.x2));
    assert.ok(Number.isFinite(edge.y2));
  }
});

test('DAG Visualizer: generates standalone single-file HTML with embedded CSS and zero CDN links', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');
  const coordinator = new DAGVisualizerCoordinator();
  const html = coordinator.renderHTML(graph);

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('<style>'));
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(html.includes('VisualizerSampleWorkflow'));
});

test('DAG Visualizer: generates valid Mermaid flowchart syntax', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');
  const coordinator = new DAGVisualizerCoordinator();
  const mermaid = coordinator.renderMermaid(graph);

  assert.ok(mermaid.startsWith('flowchart LR'));
  assert.ok(mermaid.includes('subgraph p1'));
  assert.ok(mermaid.includes('subgraph p2'));
  assert.ok(mermaid.includes('step-1 --> step-2'));
  assert.ok(mermaid.includes('step-2 --> gate-3'));
});

test('DAG Visualizer: generates clean UTF-8 terminal ASCII tree diagram', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');
  const coordinator = new DAGVisualizerCoordinator();
  const ascii = coordinator.renderASCII(graph);

  assert.ok(ascii.includes('AI-Workflow: VisualizerSampleWorkflow'));
  assert.ok(ascii.includes('┌── Phase 1: Phase One'));
  assert.ok(ascii.includes('┌── Phase 2: Phase Two'));
  assert.ok(ascii.includes('Step 1'));
  assert.ok(ascii.includes('Gate 3'));
});

test('DAG Visualizer: translates labels according to selected language', () => {
  const wf = createSampleWorkflow();
  const graph = wf.exportGraph('run-test-graph');
  const coordinator = new DAGVisualizerCoordinator();

  const enHtml = coordinator.renderHTML(graph, 'en');
  const zhHtml = coordinator.renderHTML(graph, 'zh');

  assert.ok(enHtml.includes('subagents active'));
  assert.ok(zhHtml.includes('个智能体并行执行中'));
});
