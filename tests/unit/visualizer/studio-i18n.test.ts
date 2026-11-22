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

// ---------------------------------------------------------------------------
// Issue #257: the en inspector read "Type  Agent agent" / "Role  Gate gate" —
// localizedValue compared `loc !== raw` and the en words differ from the raw
// engine values by CASE alone, so the faint raw suffix was always appended.
// The fix compares case-insensitively; zh must KEEP the suffix.
//
// The inspector renders client-side, so the behavior lock evaluates the
// localizedValue function EXTRACTED FROM the rendered page source against the
// real shipped dictionaries — not a hand-copied stub.
// ---------------------------------------------------------------------------
const TYPE_KEY: Record<string, string> = { agent: 'typeAgent', action: 'typeAction', gate: 'typeGate', probe: 'typeProbe', fanout: 'typeFanout' };
const ROLE_KEY: Record<string, string> = { worker: 'roleWorker', inspector: 'roleInspector', reviewer: 'roleReviewer', gate: 'roleGate', coordinator: 'roleCoordinator' };

function extractLocalizedValue(html: string, dict: Record<string, string>): (map: Record<string, string>, raw: string) => string {
  const fnSrc = html.match(/function localizedValue\(map, raw\) \{[\s\S]*?\}/);
  assert.ok(fnSrc, 'localizedValue must ship in the rendered page source');
  assert.ok(fnSrc[0].includes('toLowerCase()'), 'the loc/raw comparison must be case-insensitive (Issue #257)');
  assert.ok(!/loc !== raw/.test(fnSrc[0]), 'the buggy bare `loc !== raw` comparison must be gone');
  // eslint-disable-next-line no-new-func -- deliberate: evaluates the SHIPPED source
  return new Function('esc', 'T', `{ ${fnSrc[0]}; return localizedValue; }`)(
    (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    dict,
  ) as (map: Record<string, string>, raw: string) => string;
}

test('issue #257 (en): every localized type/role value renders exactly once — no "Agent agent" duplication', () => {
  const html = renderStudioHtml(snap(), { live: false, lang: 'en' });
  const localizedValue = extractLocalizedValue(html, STUDIO_I18N.en);
  for (const [raw, key] of Object.entries(TYPE_KEY)) {
    assert.equal(localizedValue(TYPE_KEY, raw), STUDIO_I18N.en[key], `type "${raw}" must render as the bare en word`);
  }
  for (const [raw, key] of Object.entries(ROLE_KEY)) {
    assert.equal(localizedValue(ROLE_KEY, raw), STUDIO_I18N.en[key], `role "${raw}" must render as the bare en word`);
  }
  // values unknown to the map pass through untouched, with no tail
  assert.equal(localizedValue(TYPE_KEY, 'custom'), 'custom');
});

test('issue #257 (zh): the raw engine value stays as the faint CLI-correlation suffix', () => {
  const html = renderStudioHtml(snap(), { live: false, lang: 'zh' });
  const localizedValue = extractLocalizedValue(html, STUDIO_I18N.zh);
  assert.equal(localizedValue(TYPE_KEY, 'agent'), `智能体 <span class="mv-raw">agent</span>`);
  assert.equal(localizedValue(ROLE_KEY, 'gate'), `关卡 <span class="mv-raw">gate</span>`);
});

// ---------------------------------------------------------------------------
// Issue #277: Zero-Chinese guarantee for English runs — when lang: 'en',
// the rendered HTML shell, template strings, action buttons, and duration
// labels must NOT leak any Chinese characters into the user-facing surface.
// ---------------------------------------------------------------------------
test('issue #277 (en): no Chinese characters leak in English mode outside the injected i18n JSON payload', () => {
  const html = renderStudioHtml(snap(), { live: false, lang: 'en' });

  // Verify the buttons and duration labels in the template
  assert.ok(!html.includes('下载 download'), 'old mixed "下载 download" button must be gone');
  assert.ok(!html.includes('提交继续 Submit & Resume'), 'old mixed "提交继续 Submit & Resume" button must be gone');
  assert.ok(!html.includes('提交继续 Fill & Resume'), 'old mixed "提交继续 Fill & Resume" button must be gone');
  assert.ok(!html.includes("parts.push('耗时 ' + d)"), 'hardcoded "耗时 " push must be gone');

  // Strip the injected window.__STUDIO_I18N__ JSON island and verify the rest has zero CJK characters
  const withoutI18nPayload = html.replace(/window\.__STUDIO_I18N__\s*=\s*\{[\s\S]*?\};/, '');
  const cjkMatch = withoutI18nPayload.match(/[\u4e00-\u9fa5]/);
  assert.equal(cjkMatch, null, `English page must not contain any Chinese characters outside the injected JSON dictionary, found: ${cjkMatch?.[0]}`);
});

test('issue #277: button labels in STUDIO_I18N are properly localized and separated', () => {
  assert.equal(STUDIO_I18N.en.btnDownload, 'Download');
  assert.equal(STUDIO_I18N.en.btnSubmitResume, 'Submit & Resume');
  assert.equal(STUDIO_I18N.en.btnFillResume, 'Fill & Resume');

  assert.equal(STUDIO_I18N.zh.btnDownload, '下载');
  assert.equal(STUDIO_I18N.zh.btnSubmitResume, '提交并继续');
  assert.equal(STUDIO_I18N.zh.btnFillResume, '填充并继续');
});
