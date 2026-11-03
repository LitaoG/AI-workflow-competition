import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow } from '../../dist/src/core/workflow.js';
import { actionStep, gateStep } from '../../dist/src/core/step.js';
import { DAGVisualizerCoordinator } from '../../dist/src/dag/visualizer.js';

test('DAG Visualizer Stress: 50-Phase Deep Sequential Pipeline layout and Bézier curves', () => {
  const wf = new Workflow({ name: 'Deep50PhaseWorkflow' });
  const NUM_PHASES = 50;

  for (let i = 1; i <= NUM_PHASES; i++) {
    const phaseId = `phase-${String(i).padStart(2, '0')}`;
    wf.addPhase({ id: phaseId, name: `Phase ${i}` });

    const stepId = `step-${String(i).padStart(2, '0')}`;
    const deps = i > 1 ? [`step-${String(i - 1).padStart(2, '0')}`] : [];

    wf.addStep(
      actionStep({
        id: stepId,
        name: `Sequential Action ${i}`,
        phaseId,
        dependsOn: deps,
        action: async () => ({ phase: i }),
      })
    );
  }

  assert.equal(wf.phases.length, 50);
  assert.equal(wf.getAllSteps().length, 50);

  const visualizer = new DAGVisualizerCoordinator();
  const graph = wf.exportGraph('deep-run-1');

  // Compute layout
  const layout = visualizer.computeLayout(graph);

  // 1. Verify layout dimensions
  assert.ok(layout.totalWidth > 50 * 260, `Width must accommodate 50 phases (was ${layout.totalWidth})`);
  assert.ok(layout.totalHeight > 100, `Height must be positive`);
  assert.equal(layout.phases.length, 50);
  assert.equal(layout.nodes.length, 50);
  assert.equal(layout.edges.length, 49);

  // 2. Verify Bézier curve parameters
  for (let i = 0; i < layout.edges.length; i++) {
    const edge = layout.edges[i];
    // Source node is to the left of Destination node
    assert.ok(edge.x1 < edge.x2, `Edge ${edge.fromNodeId} -> ${edge.toNodeId} must go left to right`);
    assert.ok(!Number.isNaN(edge.cx1) && !Number.isNaN(edge.cy1), 'Control point 1 must not be NaN');
    assert.ok(!Number.isNaN(edge.cx2) && !Number.isNaN(edge.cy2), 'Control point 2 must not be NaN');
    assert.ok(edge.cx1 >= edge.x1, `cx1 (${edge.cx1}) must be >= x1 (${edge.x1})`);
    assert.ok(edge.cx2 <= edge.x2, `cx2 (${edge.cx2}) must be <= x2 (${edge.x2})`);
  }

  // 3. Render HTML and verify zero CDN links
  const html = visualizer.renderHTML(graph, 'en');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('AI-Workflow Visualizer'));
  assert.ok(html.includes('50 phases'));
  assert.ok(!/https?:\/\//i.test(html), 'HTML visualizer MUST NOT contain external HTTP/HTTPS CDN references');

  // 4. Render Mermaid and ASCII
  const mermaid = visualizer.renderMermaid(graph, 'LR');
  assert.ok(mermaid.startsWith('flowchart LR'));
  assert.ok(mermaid.includes('subgraph phase-01'));

  const ascii = visualizer.renderASCII(graph);
  assert.ok(ascii.includes('Sequential Action 1'));
  assert.ok(ascii.includes('Sequential Action 50'));
});

test('DAG Visualizer Stress: 100-Worker Wide Fan-Out SVG Layout and Cubic Bézier Splines', () => {
  const wf = new Workflow({ name: 'WideFanoutVisualizerWorkflow' });
  wf.addPhase({ id: 'p-in', name: 'Input Phase' });
  wf.addPhase({ id: 'p-workers', name: 'Parallel Workers Phase' });
  wf.addPhase({ id: 'p-out', name: 'Aggregation Phase' });

  wf.addStep(actionStep({ id: 'root', name: 'Root Dispatcher', phaseId: 'p-in', action: async () => ({}) }));

  const WORKER_COUNT = 100;
  const workerIds = [];
  for (let i = 1; i <= WORKER_COUNT; i++) {
    const id = `worker-${String(i).padStart(3, '0')}`;
    workerIds.push(id);
    wf.addStep(
      actionStep({
        id,
        name: `Worker Agent ${i}`,
        phaseId: 'p-workers',
        dependsOn: ['root'],
        action: async () => ({}),
      })
    );
  }

  wf.addStep(
    actionStep({
      id: 'aggregator',
      name: 'Final Aggregator',
      phaseId: 'p-out',
      dependsOn: workerIds,
      action: async () => ({}),
    })
  );

  const graph = wf.exportGraph('wide-run-1');
  const visualizer = new DAGVisualizerCoordinator();
  const layout = visualizer.computeLayout(graph);

  // 100 workers stacked vertically in p-workers: height must scale gracefully
  assert.equal(layout.phases.length, 3);
  assert.equal(layout.nodes.length, 102);
  assert.equal(layout.edges.length, 200); // 100 fan-out + 100 fan-in

  // Height must be proportional to 100 nodes * (nodeHeight + gap)
  assert.ok(layout.totalHeight > 100 * 85, `Total height must accommodate 100 vertical cards (was ${layout.totalHeight})`);

  // Verify all 200 Bézier edges have valid coordinates
  const rootNode = layout.nodes.find((n) => n.id === 'root');
  const aggNode = layout.nodes.find((n) => n.id === 'aggregator');

  for (const edge of layout.edges) {
    assert.ok(Number.isFinite(edge.x1));
    assert.ok(Number.isFinite(edge.y1));
    assert.ok(Number.isFinite(edge.cx1));
    assert.ok(Number.isFinite(edge.cy1));
    assert.ok(Number.isFinite(edge.cx2));
    assert.ok(Number.isFinite(edge.cy2));
    assert.ok(Number.isFinite(edge.x2));
    assert.ok(Number.isFinite(edge.y2));

    if (edge.fromNodeId === 'root') {
      assert.equal(edge.x1, rootNode.x + rootNode.width);
      assert.equal(edge.y1, rootNode.y + rootNode.height / 2);
    }
    if (edge.toNodeId === 'aggregator') {
      assert.equal(edge.x2, aggNode.x);
      assert.equal(edge.y2, aggNode.y + aggNode.height / 2);
    }
  }

  // HTML rendering performance test
  const startHtml = Date.now();
  const html = visualizer.renderHTML(graph);
  const elapsedHtml = Date.now() - startHtml;
  assert.ok(elapsedHtml < 150, `100-worker HTML render must finish in <150ms (took ${elapsedHtml}ms)`);
  assert.ok(html.includes('3 phases'));
});

test('DAG Visualizer Stress: Full 14-Phase ZCode "夜班清扫看板" Workflow Architecture Replication', () => {
  const wf = new Workflow({ name: 'NightShiftSweepWorkflow' });

  // 14 distinct phases per ZCode Dynamic Workflow specification
  const phases = [
    { id: 'p01', name: '1. 触发与环境基线 (Trigger & Baseline)' },
    { id: 'p02', name: '2. 代码全量检出 (Checkout)' },
    { id: 'p03', name: '3. 主仓基线门禁 (Mainline Test Gate)' },
    { id: 'p04', name: '4. 缺陷聚类分析 (Defect Clustering)' },
    { id: 'p05', name: '5. 并行分诊员 (Parallel Triage 1..5)' },
    { id: 'p06', name: '6. 分诊结果汇总 (Triage Aggregation)' },
    { id: 'p07', name: '7. 修复与评审智能体对 (Fixer & Reviewer Pairs)' },
    { id: 'p08', name: '8. 单元回归测试门 (Unit Regression Gate)' },
    { id: 'p09', name: '9. 集成验证 (Integration Verification)' },
    { id: 'p10', name: '10. 合入库管理员 (Merge Coordinator)' },
    { id: 'p11', name: '11. 合入后全量测试门 (Post-Merge Full Test Gate)' },
    { id: 'p12', name: '12. 部署预热 (Deployment Staging)' },
    { id: 'p13', name: '13. 线上探针验证 (Production Canary Probing)' },
    { id: 'p14', name: '14. 看板生成与通报 (Kanban Dashboard Broadcast)' },
  ];

  phases.forEach((p) => wf.addPhase(p));

  // Step 1: Inspector agent
  wf.addStep(
    actionStep({
      id: 'step-01-inspector',
      name: '盘点员 / Inspector Agent',
      phaseId: 'p01',
      role: 'inspector',
      action: async () => ({ status: 'HEALTHY' }),
    })
  );

  // Step 2: Checkout
  wf.addStep(
    actionStep({
      id: 'step-02-checkout',
      name: 'Git Full Checkout',
      phaseId: 'p02',
      dependsOn: ['step-01-inspector'],
      action: async () => ({ commit: 'c0ffee12' }),
    })
  );

  // Step 3: Shell gate (Deterministic Gate Node)
  wf.addStep(
    gateStep({
      id: 'step-03-baseline-gate',
      name: '主仓全量测试基线门',
      phaseId: 'p03',
      command: 'echo Baseline Gate PASSED',
      dependsOn: ['step-02-checkout'],
    })
  );

  // Step 4: Defect clustering
  wf.addStep(
    actionStep({
      id: 'step-04-clusterer',
      name: 'Defect Clusterer',
      phaseId: 'p04',
      role: 'worker',
      dependsOn: ['step-03-baseline-gate'],
      action: async () => ({ clusters: [1, 2, 3, 4, 5] }),
    })
  );

  // Step 5: Parallel fan-out: Triage Agents 1..5
  const triageIds = [];
  for (let i = 1; i <= 5; i++) {
    const id = `step-05-triage-${i}`;
    triageIds.push(id);
    wf.addStep(
      actionStep({
        id,
        name: `分诊员-${i} / Triage Agent ${i}`,
        phaseId: 'p05',
        role: 'worker',
        dependsOn: ['step-04-clusterer'],
        action: async () => ({ batch: i, triaged: true }),
      })
    );
  }

  // Step 6: Triage Aggregator
  wf.addStep(
    actionStep({
      id: 'step-06-triage-summary',
      name: 'Triage Aggregator',
      phaseId: 'p06',
      dependsOn: triageIds,
      action: async () => ({ totalTriaged: 5 }),
    })
  );

  // Step 7: Paired agents: Fixer + Reviewer pair
  wf.addStep(
    actionStep({
      id: 'step-07-fixer',
      name: '代码修复员 / Fixer Agent',
      phaseId: 'p07',
      role: 'fixer',
      dependsOn: ['step-06-triage-summary'],
      action: async () => ({ patch: 'diff --git' }),
    })
  );
  wf.addStep(
    actionStep({
      id: 'step-07-reviewer',
      name: '安全评审员 / Reviewer Agent',
      phaseId: 'p07',
      role: 'reviewer',
      dependsOn: ['step-07-fixer'],
      action: async () => ({ approved: true }),
    })
  );

  // Step 8: Unit test gate
  wf.addStep(
    gateStep({
      id: 'step-08-unit-gate',
      name: '单元回归测试门',
      phaseId: 'p08',
      command: 'echo Unit Gate PASSED',
      dependsOn: ['step-07-reviewer'],
    })
  );

  // Step 9: Integration
  wf.addStep(
    actionStep({
      id: 'step-09-integ',
      name: 'Integration Test Runner',
      phaseId: 'p09',
      dependsOn: ['step-08-unit-gate'],
      action: async () => ({ integPassed: true }),
    })
  );

  // Step 10: Merge Coordinator
  wf.addStep(
    actionStep({
      id: 'step-10-merge-coord',
      name: '合入库管理员 / Merge Coordinator',
      phaseId: 'p10',
      role: 'coordinator',
      dependsOn: ['step-09-integ'],
      action: async () => ({ merged: true }),
    })
  );

  // Step 11: Post-merge gate
  wf.addStep(
    gateStep({
      id: 'step-11-post-merge-gate',
      name: '合入后全量测试门',
      phaseId: 'p11',
      command: 'echo Post-Merge Gate PASSED',
      dependsOn: ['step-10-merge-coord'],
    })
  );

  // Step 12: Deployment staging
  wf.addStep(
    actionStep({
      id: 'step-12-staging',
      name: 'Deployment Staging Pre-warm',
      phaseId: 'p12',
      dependsOn: ['step-11-post-merge-gate'],
      action: async () => ({ warmed: true }),
    })
  );

  // Step 13: Canary probing
  wf.addStep(
    actionStep({
      id: 'step-13-canary',
      name: 'Production Canary Probing',
      phaseId: 'p13',
      dependsOn: ['step-12-staging'],
      action: async () => ({ healthy: true }),
    })
  );

  // Step 14: Kanban dashboard
  wf.addStep(
    actionStep({
      id: 'step-14-kanban',
      name: '夜班清扫看板 / Kanban Dashboard Broadcast',
      phaseId: 'p14',
      dependsOn: ['step-13-canary'],
      action: async () => ({ broadcast: true }),
    })
  );

  assert.equal(wf.phases.length, 14);
  assert.equal(wf.getAllSteps().length, 19);

  const graph = wf.exportGraph('night-shift-run-001');
  const visualizer = new DAGVisualizerCoordinator();
  const layout = visualizer.computeLayout(graph);

  // 1. Verify 14 phase columns computed with sequential X offsets
  assert.equal(layout.phases.length, 14);
  for (let i = 1; i < layout.phases.length; i++) {
    assert.ok(layout.phases[i].x > layout.phases[i - 1].x, `Phase ${i} X must be strictly greater than Phase ${i-1} X`);
  }

  // 2. English Standalone HTML verification
  const htmlEn = visualizer.renderHTML(graph, 'en');
  assert.ok(htmlEn.includes('14 phases'));
  assert.ok(htmlEn.includes('subagents active'));
  assert.ok(htmlEn.includes('Reset Zoom'));
  assert.ok(!/https?:\/\//i.test(htmlEn), 'Zero external HTTP/HTTPS CDN references permitted');

  // 3. Chinese Bilingual HTML verification
  const htmlZh = visualizer.renderHTML(graph, 'zh');
  assert.ok(htmlZh.includes('14 个阶段'));
  assert.ok(htmlZh.includes('重置缩放'));
  assert.ok(htmlZh.includes('智能体并行执行中'));
  assert.ok(htmlZh.includes('合入库管理员'));
  assert.ok(htmlZh.includes('主仓全量测试基线门'));
  assert.ok(!/https?:\/\//i.test(htmlZh));

  // 4. Verify gate nodes have distinct styling in HTML
  assert.ok(htmlEn.includes('gate'));

  // 5. Verify Mermaid flowchart syntax with 14 subgraphs
  const mermaid = visualizer.renderMermaid(graph, 'LR');
  assert.ok(mermaid.startsWith('flowchart LR'));
  for (let i = 1; i <= 14; i++) {
    const pStr = `p${String(i).padStart(2, '0')}`;
    assert.ok(mermaid.includes(`subgraph ${pStr}`));
  }
  assert.ok(mermaid.includes('step-01-inspector'));
  assert.ok(mermaid.includes('step-14-kanban'));

  // 6. Verify UTF-8 ASCII diagram
  const ascii = visualizer.renderASCII(graph);
  assert.ok(ascii.includes('夜班清扫看板'));
  assert.ok(ascii.includes('主仓全量测试基线门'));
  assert.ok(ascii.includes('合入后全量测试门'));
});

test('DAG Visualizer Stress: Edge case and pathological graph handling', () => {
  const visualizer = new DAGVisualizerCoordinator();

  // 1. Empty Graph
  const emptyGraph = {
    workflowName: 'EmptyWorkflow',
    runId: 'empty-run',
    totalPhases: 0,
    totalSteps: 0,
    activeSubagents: 0,
    phases: [],
    nodes: [],
    edges: [],
  };

  const emptyLayout = visualizer.computeLayout(emptyGraph);
  assert.ok(emptyLayout.totalWidth > 0);
  assert.ok(emptyLayout.totalHeight > 0);
  assert.equal(emptyLayout.nodes.length, 0);
  assert.equal(emptyLayout.edges.length, 0);

  const emptyHtml = visualizer.renderHTML(emptyGraph);
  assert.ok(emptyHtml.includes('<!DOCTYPE html>'));
  assert.ok(emptyHtml.includes('0 phases'));

  const emptyMermaid = visualizer.renderMermaid(emptyGraph);
  assert.ok(emptyMermaid.startsWith('flowchart'));

  const emptyAscii = visualizer.renderASCII(emptyGraph);
  assert.equal(typeof emptyAscii, 'string');

  // 2. Single isolated node without edges
  const singleGraph = {
    workflowName: 'SingleNodeWorkflow',
    runId: 'single-run',
    totalPhases: 1,
    totalSteps: 1,
    activeSubagents: 1,
    phases: [{ id: 'p1', name: 'Phase One' }],
    nodes: [
      {
        id: 'isolated-node',
        name: 'Isolated Node',
        role: 'action',
        status: 'completed',
        phaseId: 'p1',
        phaseName: 'Phase One',
        inputs: {},
        outputs: { done: true },
        durationMs: 5,
      },
    ],
    edges: [],
  };

  const singleLayout = visualizer.computeLayout(singleGraph);
  assert.equal(singleLayout.nodes.length, 1);
  assert.equal(singleLayout.edges.length, 0);

  const singleHtml = visualizer.renderHTML(singleGraph);
  assert.ok(singleHtml.includes('Isolated Node'));
  assert.ok(singleHtml.includes('✔'));
});
