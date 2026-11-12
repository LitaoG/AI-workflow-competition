/**
 * SVG topology canvas tests (Issue #156): the status→color mapping (vocabulary:
 * StepStatus, src/domain/workflow-types.ts), the Bézier anchor contract — every
 * edge endpoint sits EXACTLY on the source's bottom-edge midpoint and the
 * target's top-edge midpoint (the curve-misalignment fix) — plus
 * duration-in-title, empty/single-node boundaries and XML escaping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSvgCanvas, formatDuration, STATUS_COLORS } from '../../../src/visualizer/svg-canvas.js';
import type { DAGEdge, DAGGraph, DAGNode, StepStatus } from '../../../src/types.js';

function makeNode(id: string, status: StepStatus, overrides: Partial<DAGNode> = {}): DAGNode {
  return {
    id,
    name: `node ${id}`,
    phaseId: 'p1',
    phaseName: 'Phase 1',
    role: 'worker',
    type: 'agent',
    status,
    dependsOn: [],
    ...overrides,
  };
}

function makeGraph(
  nodes: DAGNode[],
  edges: DAGEdge[] = [],
  phases: DAGGraph['phases'] = [{ id: 'p1', name: 'Phase 1', order: 1 }],
): DAGGraph {
  return {
    workflowName: 'svg-canvas-test',
    runId: 'run-svg',
    status: 'running',
    phases,
    nodes,
    edges,
    activeSubagents: 0,
    totalPhases: phases.length,
    currentPhaseIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeRect(svg: string, id: string): Rect {
  const m = svg.match(new RegExp(`<g class="node st-[^"]*" data-id="${id}"[^>]*><rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`));
  if (!m) throw new Error(`no node rect found for "${id}" in the SVG`);
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

interface PathPoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  raw: string;
}

function edgePaths(svg: string): PathPoints[] {
  const out: PathPoints[] = [];
  const re = /<path d="M ([\d.]+) ([\d.]+) C ([\d.]+) ([\d.]+), ([\d.]+) ([\d.]+), ([\d.]+) ([\d.]+)" class="edge st-[a-z]+"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    out.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[7]), y2: Number(m[8]), raw: m[0] });
  }
  return out;
}

test('status→color mapping covers the whole canonical StepStatus vocabulary', () => {
  const statuses: StepStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped', 'replayed'];
  const nodes = statuses.map((s, i) => makeNode(`n-${s}`, s, { name: `n${i}` }));
  const svg = renderSvgCanvas(makeGraph(nodes));
  for (const status of statuses) {
    const group = new RegExp(`<g class="node st-${status}" data-id="n-${status}"`).test(svg);
    assert.ok(group, `node with status ${status} must carry the st-${status} class`);
    const rect = new RegExp(`data-id="n-${status}"[\\s\\S]{0,200}?stroke="${STATUS_COLORS[status]}"`).test(svg);
    assert.ok(rect, `node with status ${status} must be stroked ${STATUS_COLORS[status]}`);
  }
});

test('cross-phase edge anchors bottom-edge-mid → top-edge-mid exactly', () => {
  const graph = makeGraph(
    [
      makeNode('a', 'completed', { phaseId: 'p1', phaseName: 'A' }),
      makeNode('b', 'running', { phaseId: 'p2', phaseName: 'B' }),
    ],
    [{ fromNodeId: 'a', toNodeId: 'b' }],
    [
      { id: 'p1', name: 'A', order: 1 },
      { id: 'p2', name: 'B', order: 2 },
    ],
  );
  const svg = renderSvgCanvas(graph);
  const paths = edgePaths(svg);
  assert.equal(paths.length, 1, 'exactly one Bézier path');
  const path = paths[0]!;
  const a = nodeRect(svg, 'a');
  const b = nodeRect(svg, 'b');
  // Source anchor: midpoint of a's BOTTOM edge. Target anchor: midpoint of b's TOP edge.
  assert.equal(path.x1, a.x + a.width / 2, 'start x = source bottom-edge midpoint x');
  assert.equal(path.y1, a.y + a.height, 'start y = source bottom edge');
  assert.equal(path.x2, b.x + b.width / 2, 'end x = target top-edge midpoint x');
  assert.equal(path.y2, b.y, 'end y = target top edge');
  assert.match(path.raw, / C /, 'the path is a cubic Bézier');
});

test('same-band chain edges keep the same bottom→top anchor contract', () => {
  const graph = makeGraph(
    [makeNode('a', 'completed'), makeNode('b', 'completed')],
    [{ fromNodeId: 'a', toNodeId: 'b' }],
  );
  const svg = renderSvgCanvas(graph);
  const paths = edgePaths(svg);
  assert.equal(paths.length, 1);
  const path = paths[0]!;
  const a = nodeRect(svg, 'a');
  const b = nodeRect(svg, 'b');
  assert.equal(path.y1, a.y + a.height, 'source bottom edge');
  assert.equal(path.y2, b.y, 'target top edge');
});

test('node title carries the formatted duration; nodes without one do not', () => {
  const svg = renderSvgCanvas(
    makeGraph([
      makeNode('timed', 'completed', { durationMs: 1250 }),
      makeNode('fast', 'completed', { durationMs: 800 }),
      makeNode('untimed', 'pending'),
    ]),
  );
  assert.ok(svg.includes('node timed · 1.25s'), '1.25s duration rendered into the title');
  assert.ok(svg.includes('node fast · 800ms'), 'sub-second duration rendered in ms');
  assert.ok(!svg.includes('node untimed ·'), 'no phantom duration');
});

test('formatDuration covers the ms / s formatting buckets deterministically', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1000), '1.00s');
  assert.equal(formatDuration(1250), '1.25s');
  assert.equal(formatDuration(25000), '25.0s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-5), '');
});

test('empty graph renders a valid empty SVG', () => {
  const svg = renderSvgCanvas(makeGraph([]));
  assert.ok(svg.startsWith('<svg'), 'valid SVG root');
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(!svg.includes('class="node'), 'no node cards');
  assert.ok(!svg.includes('<path'), 'no edges');
  assert.ok(svg.includes('viewBox'), 'canvas geometry present');
});

test('single node: one card, zero paths', () => {
  const svg = renderSvgCanvas(makeGraph([makeNode('only', 'running')]));
  assert.equal(svg.match(/class="node /g)?.length, 1);
  assert.equal(edgePaths(svg).length, 0);
});

test('edges naming unknown nodes are dropped, never crash', () => {
  const svg = renderSvgCanvas(
    makeGraph([makeNode('a', 'pending')], [
      { fromNodeId: 'a', toNodeId: 'ghost' },
      { fromNodeId: 'ghost', toNodeId: 'a' },
    ]),
  );
  assert.equal(edgePaths(svg).length, 0);
});

test('node names are XML-escaped (no injection into the SVG markup)', () => {
  const svg = renderSvgCanvas(makeGraph([makeNode('evil', 'pending', { name: '<b>&"x"' })]));
  assert.ok(!svg.includes('<b>'), 'raw markup must not survive');
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x&quot;'), 'escaped name rendered');
});

test('unknown status vocabulary drift degrades to the fallback color instead of crashing', () => {
  const svg = renderSvgCanvas(makeGraph([makeNode('drift', 'bogus' as StepStatus)]));
  assert.ok(svg.includes('st-bogus'), 'status rendered verbatim in the class');
  assert.ok(svg.includes('stroke="#334155"'), 'fallback gray stroke');
});

test('edge status rides the TARGET node status and edge labels survive as titles', () => {
  const svg = renderSvgCanvas(
    makeGraph(
      [makeNode('a', 'completed'), makeNode('b', 'failed')],
      [{ fromNodeId: 'a', toNodeId: 'b', label: 'handoff' }],
    ),
  );
  assert.ok(svg.includes('class="edge st-failed"'), 'edge classed by the target status');
  assert.ok(svg.includes('<title>handoff</title>'), 'edge label embedded as a title');
});
