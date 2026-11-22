/**
 * Issue #256 regression suite: the DAG page's task line and phase label must
 * not overflow their geometry (SVG <text> never clips; 40 CJK chars at 10px
 * painted 400px across a 220px card), and the phase label must be escaped
 * (a raw `<` in a phase name swallowed the rest of the text as an unknown tag).
 *
 * Geometry assertions use the same column model the renderer truncates with:
 * a half-width unit ≈ 5px on the 10px task line, ≈ 6.5px on the 13px phase
 * label.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTMLRenderer, displayColumns, truncateToColumns } from '../../src/dag/html-renderer.js';
import type { DAGGraph, DAGNode } from '../../src/domain/workflow-types.js';

function graphWith(phaseName: string, nodes: Array<Partial<DAGNode>>): DAGGraph {
  return {
    workflowName: 'issue-256',
    runId: 'run-256',
    status: 'completed',
    phases: [{ id: 'p1', name: phaseName, order: 1 }],
    nodes: nodes as DAGNode[],
    edges: [],
    activeSubagents: 0,
    totalPhases: 1,
    currentPhaseIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function baseNode(overrides: Partial<DAGNode>): Partial<DAGNode> {
  return {
    id: 'n1',
    name: 'Step One',
    phaseId: 'p1',
    phaseName: '阶段',
    role: 'worker',
    type: 'action',
    status: 'completed',
    dependsOn: [],
    ...overrides,
  };
}

test('(g-1) 40-CJK task line is width-truncated into the card geometry, not a 400px bleed', () => {
  const prompt = '完'.repeat(40);
  const html = new HTMLRenderer().render(graphWith('阶段', [baseNode({ inputs: { prompt } })]));
  const m = html.match(/class="node-task">([^<]*)</);
  assert.ok(m, 'the node-task line must render');
  const taskText = m[1];
  assert.ok(taskText.endsWith('…'), 'an over-budget task line must be ellipsized');
  assert.ok(!taskText.includes(prompt), 'the full 40-char run must not reach the page');
  // geometry: 19 CJK + ellipsis ≈ 200px ≤ the 206px usable card width at 10px
  assert.ok(displayColumns(taskText) <= 41, `task line must fit 41 half-width units, got ${displayColumns(taskText)}`);
  assert.ok(displayColumns(taskText) * 5 <= 206, `task line must fit the 206px budget, got ${displayColumns(taskText) * 5}px`);
  // the hover title keeps the FULL prompt (escaped) — truncation is visual only
  assert.ok(html.includes(escapeInclude(prompt)), 'the tooltip must retain the full prompt');
});

function escapeInclude(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('(g-2) 30-CJK phase name is width-truncated into its 260px lane', () => {
  const phaseName = '阶'.repeat(30);
  const html = new HTMLRenderer().render(graphWith(phaseName, [baseNode({})]));
  const m = html.match(/class="phase-label">([^<]*)</);
  assert.ok(m, 'the phase label must render');
  const label = m[1];
  assert.ok(label.endsWith('…'), 'an over-budget phase name must be ellipsized');
  assert.ok(!label.includes(phaseName), 'the full 30-char run must not reach the page');
  // geometry: 17 CJK + ellipsis ≈ 234px ≤ the 244px usable lane width at 13px
  assert.ok(displayColumns(label) * 6.5 <= 244, `phase label must fit the lane, got ${displayColumns(label) * 6.5}px`);
});

test('(g-3) phase names with <, &, > are escaped — no markup injection, text intact', () => {
  const html = new HTMLRenderer().render(graphWith('扫描 <注入> & 分诊', [baseNode({})]));
  assert.ok(html.includes('扫描 &lt;注入&gt; &amp; 分诊'), 'the phase label must carry escaped entities');
  assert.ok(!html.includes('扫描 <注入'), 'a raw `<` must never reach the phase label or title');
  assert.ok(html.includes('<title>扫描 &lt;注入&gt; &amp; 分诊</title>'), 'the phase tooltip must be escaped too');
});

test('(g-4) truncation never splits surrogate pairs and short ASCII stays untouched', () => {
  const emojiRun = '😀'.repeat(30);
  const cut = truncateToColumns(emojiRun, 38);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'no lone surrogate may survive truncation');
  // 18 emoji (36 units) + the 1-unit ellipsis = 37, within the 38-unit budget
  assert.equal(displayColumns(cut), 37);
  assert.equal(truncateToColumns('npm run build', 38), 'npm run build', 'within-budget ASCII must pass through');
  assert.equal(truncateToColumns('', 38), '');
});

test('(g-5) long phase name with colon splits into two <tspan> lines to avoid truncation (Issue #270)', () => {
  const phaseName = 'Phase 2: Architecture & Quality Review';
  const html = new HTMLRenderer().render(graphWith(phaseName, [baseNode({})]));
  assert.ok(html.includes('<tspan x="170" dy="0">Phase 2:</tspan>'), 'line 1 with Phase 2: must render in tspan');
  assert.ok(html.includes('<tspan x="170" dy="16">Architecture &amp; Quality Review</tspan>'), 'line 2 with full title must render without ellipsis');
  assert.ok(!html.includes('Quality Re…'), 'the phase title must not be cut with an ellipsis');
});

// ---------------------------------------------------------------------------
// Issue #269: four MORE user-text surfaces on the same page stayed raw after
// #256 (which covered only the phase name). Each fix targets its own parse
// context, and the assertions are STRUCTURAL (script-block balance, decoded
// attribute round-trip, JSON island parseability) rather than string-contains.
// ---------------------------------------------------------------------------

function scriptOpenCount(html: string): number {
  return (html.match(/<script/g) || []).length;
}
function scriptCloseCount(html: string): number {
  return (html.match(/<\/script>/g) || []).length;
}
/** Extract and parse the `const nodes = …;` JSON island the client reads. */
function parseNodesIsland(html: string): Array<Record<string, unknown>> {
  const m = html.match(/const nodes = ([\s\S]*?);\n\s*let scale/);
  assert.ok(m, 'the nodes JSON island must be present');
  return JSON.parse(m[1]) as Array<Record<string, unknown>>;
}

test('(s-1) A: workflowName with & and <b> tags is escaped in the document title', () => {
  const g = graphWith('P', [baseNode({})]);
  g.workflowName = 'wf & <b>name</b>';
  const html = new HTMLRenderer().render(g, 'en');
  assert.ok(html.includes('<title>AI-Workflow Visualizer — wf &amp; &lt;b&gt;name&lt;/b&gt;</title>'), 'document title must carry escaped entities');
  assert.ok(!html.includes('<title>AI-Workflow Visualizer — wf & <b>'), 'a raw tag must never reach the document title');
});

test('(s-2) B: node ids with quotes ride an escaped data attribute + delegation, not an inline JS string', () => {
  const weirdId = `owner's-"x"review`;
  const g = graphWith('P', [baseNode({ id: weirdId })]);
  const html = new HTMLRenderer().render(g, 'en');
  // the inline onclick with a JS-string id is gone entirely
  assert.ok(!html.includes('onclick="inspectNode('), 'inline onclick with a raw id must be gone');
  // the escaped attribute is present and decodes back to the exact id
  const attr = html.match(/data-node-id="([^"]*)"/);
  assert.ok(attr, 'every node card must carry data-node-id');
  const decoded = attr[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  assert.equal(decoded, weirdId, 'the decoded attribute must round-trip to the exact id');
  // structural: the delegated handler would find the node — the JSON island
  // holds the RAW id, and getAttribute returns the DECODED attribute
  const nodes = parseNodesIsland(html);
  assert.ok(nodes.some((n) => n['id'] === decoded), 'the delegated handler must resolve the node by the decoded id');
});

test('(s-3) C: `</script>` in task text cannot close the JSON island — script blocks stay balanced and parseable', () => {
  const poison = 'x </script><img src=x onerror=alert(1)>';
  const g = graphWith('P', [baseNode({ inputs: { prompt: poison } })]);
  const html = new HTMLRenderer().render(g, 'en');
  assert.equal(scriptOpenCount(html), scriptCloseCount(html), `script open/close must balance (got ${scriptOpenCount(html)}/${scriptCloseCount(html)})`);
  // the island is still valid JSON carrying the RAW payload (round-trip)
  const nodes = parseNodesIsland(html);
  assert.equal((nodes[0] as { inputs: { prompt: string } }).inputs.prompt, poison, 'the payload must round-trip byte-faithfully');
  // and no raw </script> may sit inside the island text itself
  const island = html.match(/const nodes = ([\s\S]*?);\n\s*let scale/)![1];
  assert.ok(!island.includes('</script>'), 'the island must not contain a literal closing tag');
});

test('(s-4) D: drawer innerHTML paths are wrapped in auiEsc, and auiEsc itself strips markup', () => {
  const html = new HTMLRenderer().render(graphWith('P', [baseNode({})]), 'en');
  const drawerTemplate = html.match(/drawer-content'\).innerHTML = `([\s\S]*?)`;/);
  assert.ok(drawerTemplate, 'the drawer template must ship');
  for (const field of ['node.role', 'node.status', 'node.phaseName', 'JSON.stringify(node.inputs || {}, null, 2)', 'JSON.stringify(node.outputs || {}, null, 2)']) {
    assert.ok(drawerTemplate[1].includes(`auiEsc(${field})`), `drawer field must be escaped: ${field}`);
  }
  // behavioral: evaluate the SHIPPED auiEsc against an injection payload
  const fnSrc = html.match(/function auiEsc\(s\) \{[\s\S]*?\}/);
  assert.ok(fnSrc, 'auiEsc must ship in the client script');
  const auiEsc = new Function(`{ ${fnSrc[0]}; return auiEsc; }`)() as (s: unknown) => string;
  const out = auiEsc('<img src=x onerror=alert(1)>');
  assert.ok(!/[<>]/.test(out), 'auiEsc output must contain no raw < or >');
  assert.equal(out, '&lt;img src=x onerror=alert(1)&gt;');
});

test('(s-5) E-class: node-title is width-truncated into its badge-shared line', () => {
  const longName = '节'.repeat(40);
  const html = new HTMLRenderer().render(graphWith('P', [baseNode({ name: longName })]));
  const m = html.match(/class="node-title">([^<]*)</);
  assert.ok(m, 'the node title must render');
  assert.ok(m[1].endsWith('…'), 'an over-budget title must be ellipsized');
  assert.ok(!m[1].includes(longName), 'the full 40-char name must not reach the title line');
  // geometry: (220−38)/12 → 30 units − 2 ellipsis = 28 units = 168px ≤ 182px
  assert.ok(displayColumns(m[1]) * 6 <= 182, `title must fit the 182px budget, got ${displayColumns(m[1]) * 6}px`);
  // the tooltip keeps the FULL name
  assert.ok(html.includes(escapeInclude(longName)), 'the tooltip must retain the full name');
  // family convergence: the SVG node-role text is escaped too
  const g2 = graphWith('P', [baseNode({ role: 'worker<b>' })]);
  const html2 = new HTMLRenderer().render(g2, 'en');
  assert.ok(html2.includes('[WORKER&lt;B&gt;]'), 'the SVG node-role text must be escaped');
  assert.ok(!html2.includes('[WORKER<B>]'), 'a raw tag must never reach the node-role line');
});
