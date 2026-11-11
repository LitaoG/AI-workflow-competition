/**
 * Issue #128: the Studio's bilingual surface — renderStudioHtml takes a lang
 * (default en, steering rule 1), the template + client dictionary switch
 * together, `<html lang>` follows, and the top-bar node pill counts the SAME
 * nodes the canvas draws (the #96 口径 follow-up) with pluralization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStudioHtml, STUDIO_I18N, type StudioSnapshot } from '../../../src/visualizer/studio-renderer.js';

function snap(): StudioSnapshot {
  return {
    mode: 'static',
    run: { runId: 'r-i18n', status: 'completed', scriptPath: 'x.facade.ts' } as StudioSnapshot['run'],
    graph: { phases: [], nodes: [{ id: 'n1' }, { id: 'n2' }] } as unknown as StudioSnapshot['graph'],
    stats: { nodeCount: 13, replayHits: 0, amendHits: 0, eventCount: 4 },
    openQuestion: null,
    openHole: null,
    events: [],
    artifacts: [],
  } as unknown as StudioSnapshot;
}

test('default (no lang) renders the English page: <html lang="en"> and the English template strings', () => {
  const html = renderStudioHtml(snap(), { live: false });
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('Live Event Stream'));
  assert.ok(html.includes('Inspector'));
  assert.ok(html.includes('scroll = zoom · drag = pan · click a node = inspect'));
  // the mixed-language inspector empty state is gone (steering rule 1)
  assert.ok(!html.includes('点击左侧任意节点查看输入、输出与产物 — click a node on the canvas.'));
  assert.ok(html.includes('window.__STUDIO_LANG__ = \'en\''));
});

test('lang: "zh" switches the template strings, <html lang> and the injected dictionary', () => {
  const html = renderStudioHtml(snap(), { live: false, lang: 'zh' });
  assert.ok(html.includes('<html lang="zh">'));
  assert.ok(html.includes('实时事件流'));
  assert.ok(html.includes('检查器'));
  assert.ok(html.includes('滚轮缩放 · 拖拽平移 · 点击节点查看详情'));
  assert.ok(html.includes('window.__STUDIO_LANG__ = \'zh\''));
  // the client dictionary rides along as inline JSON (its strings carry no
  // '<', so no \u003c escaping is needed — asserted by absence of raw markup)
  assert.ok(html.includes('window.__STUDIO_I18N__ = {"en"'), 'the dictionary JSON is injected');
  assert.ok(html.includes('"inspectorEmpty":"点击画布中的节点，查看其输入、输出与产物。"'), 'the zh inspector string ships to the client');
  assert.ok(html.includes('个节点'), 'the zh node-count label template is present');
  // F3: the client pill reads the canvas口径, not stats.nodeCount
  assert.ok(html.includes('state.graph.nodes.length'), 'the pill counts the canvas nodes');
  assert.ok(!html.includes("state.stats.nodeCount + '</b> "), 'the old stats-based pill label is gone');
});

test('the STUDIO_I18N table is complete and symmetric (en/zh same keys)', () => {
  const en = Object.keys(STUDIO_I18N.en).sort();
  const zh = Object.keys(STUDIO_I18N.zh).sort();
  assert.deepEqual(zh, en);
  for (const key of en) {
    assert.ok(String(STUDIO_I18N.en[key]).length > 0, `en.${key} non-empty`);
    assert.ok(String(STUDIO_I18N.zh[key]).length > 0, `zh.${key} non-empty`);
  }
});
