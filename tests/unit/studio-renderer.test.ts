import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStudioHtml, type StudioSnapshot } from '../../src/visualizer/studio-renderer.js';
import type { DAGGraph } from '../../src/domain/workflow-types.js';

function minimalGraph(): DAGGraph {
  return {
    workflowName: 'renderer-test',
    runId: 'run-renderer',
    status: 'completed',
    phases: [{ id: 'phase-1', name: 'Inspect', order: 1 }],
    nodes: [],
    edges: [],
    activeSubagents: 0,
    totalPhases: 1,
    currentPhaseIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function snapshot(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return {
    mode: 'static',
    generatedAt: '2026-01-01T00:00:00.000Z',
    graph: minimalGraph(),
    run: { runId: 'run-renderer', status: 'completed' },
    stats: { nodeCount: 0, replayHits: 0, amendHits: 0, eventCount: 0 },
    openQuestion: null,
    openHole: null,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

test('embeds the snapshot JSON with no placeholder residue and sane script count', () => {
  const html = renderStudioHtml(snapshot());
  assert.ok(!html.includes('__STUDIO_SNAPSHOT__'), 'snapshot placeholder must be replaced');
  assert.ok(!html.includes('__TITLE__'), 'title placeholder must be replaced');
  assert.ok(html.includes('window.__STUDIO__'), 'snapshot must be embedded for the SPA');
  assert.ok(html.includes('AI-Workflow Studio'));
});

test('issue #96: focus-logs fullscreen keeps the logs pane on a single full-width track', () => {
  const html = renderStudioHtml(snapshot());
  assert.ok(
    html.includes('body.focus-logs #grid { grid-template-columns: minmax(0, 1fr); }'),
    'focus-logs must collapse #grid to one full-width track so #right auto-places into it',
  );
  assert.ok(
    !html.includes('grid-template-columns: 0 minmax(0, 1fr)'),
    'the two-track 0/1fr form auto-places #right into the 0-width track once #canvas-pane is display:none',
  );
});

test('review HIGH: `$` sequences in the payload must not splice the template', () => {
  // `$&` in a string replacement splices the MATCHED placeholder back in;
  // `$'` splices the template TAIL (including `;</script>` and the SPA source)
  // into the embedded JSON — the browser then ends the <script> early and the
  // whole page dies. Real-world source: bash error text like
  // `bash: $'\r': command not found` from CRLF shell gates.
  const hostile = renderStudioHtml(
    snapshot({
      run: { runId: 'run-$$ $& $` $\'', status: 'failed' },
      events: [{ type: 'dwf_error', data: "bash: $'TAIL': command not found", timestamp: '2026-01-01T00:00:00.000Z' }],
      artifacts: [
        {
          id: 'art-1',
          name: 'log.md',
          type: 'text/markdown',
          bytes: 1,
          content: "gate output: echo $'TAIL'\n$& $` $'",
        },
      ],
    }),
  );
  assert.ok(!hostile.includes('__STUDIO_SNAPSHOT__'), 'placeholder must be fully replaced');
  // Issue #128: the template legitimately grew a third script (the i18n
  // dictionary injection); 2026-11-14 visual system: a fourth (the shared
  // number-ticker bootstrap from design-system.ts) — the count tracks the
  // template's own tags, so a payload splice that adds tags still fails.
  assert.equal(hostile.split('</script>').length - 1, 4, 'template must keep exactly its own four </script> tags');
  assert.ok(hostile.includes("bash: $'TAIL': command not found"), 'hostile payload must survive verbatim');
});

test('review MEDIUM: the artifact markdown regexes reach the browser as real whitespace classes', () => {
  // The markdown renderer is client-side JS inside STUDIO_TEMPLATE. The
  // template source previously wrote `\\\\s` (4 backslashes) which the TS
  // template literal collapses to a two-backslash regex — matching a literal
  // backslash followed by `s` instead of whitespace, so `# Heading` and
  // `- list` fell through to the plain-div fallback forever.
  const html = renderStudioHtml(snapshot());
  assert.ok(html.includes('match(/^(#{1,3})\\s+(.*)$/)'), 'heading regex must carry a single-backslash \\s');
  assert.ok(html.includes('/^\\s*[-*]\\s+/'), 'list regex must carry single-backslash \\s classes');
  assert.ok(html.includes('[^)\\s]+'), 'link-URL class must exclude whitespace, not the letter s');
  assert.ok(!html.includes('(#{1,3})\\\\s'), 'the broken two-backslash variant must be gone');
});

test('runId with HTML metacharacters is escaped in the title', () => {
  const html = renderStudioHtml(snapshot({ run: { runId: 'run-<img src=x onerror=alert(1)>', status: 'completed' } }));
  assert.ok(!html.includes('<img src=x'), 'raw HTML must not reach the title');
  assert.ok(html.includes('&lt;img'), 'title must be escaped');
});
