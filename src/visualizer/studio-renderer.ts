/**
 * AI-Workflow Studio — the single-file, zero-CDN, self-contained SPA renderer
 * (Mission D 支柱二：现代一体化看板).
 *
 * One HTML template, two run modes:
 * - `static` — the full snapshot is embedded (`window.__STUDIO__`); works from
 *   any `file://` URL, forever offline. Used by `workflow view`
 *   and `run --ui` after the run settles.
 * - `live` — same shell, plus an SSE client on `/events` (`state` + `event`
 *   messages) and A2UI inline forms POSTing `/api/answer` // `/api/fill`, so a
 *   parked run resumes straight from the browser.
 *
 * 拓扑连线物理算法（军规 D P0-4）:
 * - 同列（同一 Phase）相邻节点 → 垂直直线脊柱；
 * - 同列非相邻/向上 → 卡片右侧弧形旁路（Side-Bypass），严禁向左倒扣穿透卡片；
 * - 跨 Phase 前向 → 标准水平三次贝塞尔（右缘出、左缘入）；
 * - 跨 Phase 回边 → 左向平滑 S 曲线（左缘出、右缘入），无倒扣。
 * 所有端点都锚定在卡片边缘锚点上。
 */

import type { DAGGraph } from '../domain/workflow-types.js';
import { STUDIO_I18N, STUDIO_TEMPLATE } from './studio-template.js';
import { escapeHtml } from '../utils/escape-html.js';

// Re-exported: existing importers (tests, MCP surfaces) resolve the string
// table from the renderer module.
export { STUDIO_I18N };

export interface StudioArtifact {
  id: string;
  name: string;
  type: string;
  bytes: number;
  /** Full content when small enough to embed (markdown/text/json). */
  content?: string;
}

export interface StudioSnapshot {
  mode: 'static' | 'live';
  generatedAt: string;
  graph: DAGGraph;
  run: {
    runId: string;
    status: string;
    scriptPath?: string;
    parentRunId?: string;
    argsJson?: string;
    scriptHash?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  stats: { nodeCount: number; replayHits: number; amendHits: number; eventCount: number };
  /** Unanswered escalation (run parked) — drives the A2UI answer form. */
  openQuestion: { questionId: string; siteId: string; question: string } | null;
  /** Unfilled hole (run parked) — drives the A2UI fill form. */
  openHole: { siteId: string; name: string; prompt: string } | null;
  /** Latest raw journal events — the client classifies them into the terminal. */
  events: Array<{ type: string; data: unknown; timestamp: string }>;
  artifacts: StudioArtifact[];
}

export function renderStudioHtml(snap: StudioSnapshot, opts?: { live?: boolean; lang?: 'en' | 'zh' }): string {
  const live = opts?.live ?? snap.mode === 'live';
  const lang: 'en' | 'zh' = opts?.lang === 'zh' ? 'zh' : 'en';
  const T = STUDIO_I18N[lang];
  const payload = JSON.stringify({ ...snap, mode: live ? 'live' : 'static' })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const title = `AI-Workflow Studio — ${snap.run.runId}`;
  // Replacement MUST be a function: String.replace interprets `$` sequences
  // ($&, $', $`, $$) inside a string replacement, so a payload/title carrying
  // `$&` (e.g. shell error text with CRLF bash quoting) would splice template
  // chunks — including `</script>` — into the embedded JSON and kill the whole
  // SPA script (review round 1, HIGH).
  return STUDIO_TEMPLATE.replace('__TITLE__', () => escapeHtml(title))
    .replace('__STUDIO_SNAPSHOT__', () => payload)
    // Issue #128 bilingual surface: language attribute, server-template
    // strings, and the client-side dictionary — all from the same STUDIO_I18N
    // table for the chosen lang.
    .replace('lang="__STUDIO_LANG__"', () => `lang="${lang}"`)
    .replace("window.__STUDIO_LANG__ = '__STUDIO_LANG__'", () => `window.__STUDIO_LANG__ = '${lang}'`)
    .replace('__STUDIO_FIT__', () => T.fit)
    .replace('__STUDIO_LOGS__', () => T.logs)
    .replace('__STUDIO_CANVAS_HINT__', () => T.canvasHint)
    .replace('__STUDIO_EVENT_STREAM__', () => T.eventStream)
    .replace('__STUDIO_FILTER__', () => T.filter)
    .replace(/__STUDIO_INSPECTOR__/g, () => T.inspector)
    .replace('__STUDIO_INSPECTOR_EMPTY__', () => T.inspectorEmpty)
    .replace('__STUDIO_I18N_JSON__', () => JSON.stringify(STUDIO_I18N).replace(/</g, '\\u003c'));
}

