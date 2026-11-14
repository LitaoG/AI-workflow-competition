/**
 * Shared visual design system for every HTML view the engine ships (DAG
 * visualizer, Studio, WS studio page). Design tokens are ported from the
 * affectUI free-tier sources (MIT, https://github.com/flohoeller/affectui —
 * kept at AI-workflow-research/affectui for reference): the LIGHT affectui.com
 * look — white surfaces on a gray tray, #f7f7f8 page ground, #171717 ink,
 * #e5e5e5 hairlines, the soft status-tint pairs (info/success/warning/danger/
 * purple SOFT background + STRONG foreground), the #0060e2 focus blue, the
 * 7/16/20px radius scale, cubic-bezier(0.22,1,0.36,1) signature easing and the
 * layered card shadows. All CSS here is original; the token *values* follow
 * the MIT-licensed palette so the views read like the affectui site itself.
 * The Pro-tier patterns (agent-tree connectors, KPI metric strips) were
 * studied from the public demo pages only — clean-room, no Pro source was
 * extracted.
 *
 * Views embed this string at the top of their <style> block and may add
 * view-specific rules after it. Class contract: everything below is namespaced
 * `aui-*` except the shared keyframes.
 */
export const AUI_TOKENS_CSS = `
  :root {
    color-scheme: light;
    --aui-bg: #f7f7f8;
    --aui-bg-raised: #ffffff;
    --aui-surface: #ffffff;
    --aui-surface-2: #fafafa;
    --aui-subtle: #f0f0f0;
    --aui-wash: #f4f4f5;
    --aui-border: #e5e5e5;
    --aui-border-strong: #d4d4d8;
    --aui-ink: #171717;
    --aui-muted: #737373;
    --aui-faint: #a3a3a3;
    --aui-blue: #2a8ce0;
    --aui-blue-deep: #0060e2;
    --aui-info: #2456d6;
    --aui-info-soft: #eaf1ff;
    --aui-cyan: #0891b2;
    --aui-green: #1e8a4f;
    --aui-success-soft: #e6f6ed;
    --aui-amber: #b45309;
    --aui-warning: #b25e00;
    --aui-warning-soft: #fff1e0;
    --aui-red: #c4320a;
    --aui-danger-soft: #fdecea;
    --aui-violet: #7c3aed;
    --aui-purple: #8a35d6;
    --aui-purple-soft: #f4ebfd;
    --aui-radius-sm: 7px;
    --aui-radius-lg: 16px;
    --aui-radius-xl: 20px;
    --aui-ease: cubic-bezier(0.22, 1, 0.36, 1);
    --aui-ease-2: cubic-bezier(0.25, 1, 0.5, 1);
    --aui-ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);
    --aui-focus: rgba(0, 96, 226, 0.7);
    --aui-shadow-card: 0 0 0 1px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);
    --aui-shadow-hover: 0 0 0 1px var(--aui-border-strong), 0 2px 6px -1px rgba(0,0,0,.08);
    --aui-shadow-pop: 0 12px 40px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.06);
    --aui-shadow-float: 0 1px 2px rgba(0,0,0,.03), 0 8px 24px rgba(0,0,0,.035);
    --aui-code-bg: #fafafa;
    --aui-tok-key: #171717;
    --aui-tok-str: #0b8576;
    --aui-tok-num: #b25e00;
    --aui-tok-lit: #8a35d6;
    --aui-sans: 'Inter', ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    --aui-mono: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
  }
`;

export const AUI_SHARED_CSS = `
  /* --- backdrop: gradient floor + drifting grid (generic patterns, original CSS) --- */
  .aui-backdrop {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(1100px 620px at 78% -12%, rgba(0,96,226,.06), transparent 62%),
      radial-gradient(880px 520px at 8% 112%, rgba(124,58,237,.045), transparent 58%);
  }
  .aui-grid {
    position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .6;
    background-image:
      linear-gradient(rgba(23,23,23,.032) 1px, transparent 1px),
      linear-gradient(90deg, rgba(23,23,23,.032) 1px, transparent 1px);
    background-size: 34px 34px;
    -webkit-mask-image: radial-gradient(ellipse 92% 82% at 50% 42%, #000 26%, transparent 100%);
    mask-image: radial-gradient(ellipse 92% 82% at 50% 42%, #000 26%, transparent 100%);
    animation: aui-grid-drift 36s linear infinite;
  }
  @keyframes aui-grid-drift { to { background-position: 34px 34px, 34px 34px; } }

  /* --- motion vocabulary --- */
  @keyframes aui-dash { to { stroke-dashoffset: -26; } }
  @keyframes aui-pulse-blue {
    0%, 100% { filter: drop-shadow(0 0 2px rgba(42,140,224,.22)); }
    50% { filter: drop-shadow(0 0 9px rgba(0,96,226,.55)); }
  }
  @keyframes aui-fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes aui-breath { 50% { opacity: .45; } }
  @keyframes aui-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  @keyframes aui-live {
    0% { transform: scale(1); opacity: .5; }
    70%, 100% { transform: scale(2.6); opacity: 0; }
  }
  @keyframes aui-ray { 0% { opacity: 1; } 100% { opacity: .18; } }
  @keyframes aui-draw { to { stroke-dashoffset: 0; } }
  @keyframes aui-sweep { from { background-position: 100% 0; } to { background-position: 0% 0; } }
  @keyframes aui-pop {
    0% { transform: scale(.9); }
    60% { transform: scale(1.06); }
    100% { transform: scale(1); }
  }
  .aui-shimmer-text {
    background: linear-gradient(90deg, var(--aui-faint) 35%, var(--aui-ink) 50%, var(--aui-faint) 65%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: aui-shimmer 2.4s linear infinite;
  }

  /* --- soft status pill (affectui Badge pattern, original CSS): tint bg + strong
         fg, leading dot with an optional live halo --- */
  .aui-badge {
    display: inline-flex; align-items: center; gap: 5px;
    height: 20px; padding: 0 9px; border-radius: 999px;
    font: 500 11px/16px var(--aui-sans); letter-spacing: 0;
    white-space: nowrap; font-variant-numeric: tabular-nums;
    background: var(--aui-subtle); color: var(--aui-muted);
  }
  .aui-badge .dot { position: relative; flex: none; width: 6px; height: 6px; margin: 0 1px; border-radius: 50%; background: currentColor; }
  .aui-badge .dot.live::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit;
    background: currentColor; animation: aui-live 1.8s var(--aui-ease) infinite;
  }
  .aui-badge.tone-info { background: var(--aui-info-soft); color: var(--aui-info); }
  .aui-badge.tone-success { background: var(--aui-success-soft); color: var(--aui-green); }
  .aui-badge.tone-warning { background: var(--aui-warning-soft); color: var(--aui-warning); }
  .aui-badge.tone-danger { background: var(--aui-danger-soft); color: var(--aui-red); }
  .aui-badge.tone-purple { background: var(--aui-purple-soft); color: var(--aui-purple); }
  .aui-badge.tone-neutral { background: var(--aui-subtle); color: var(--aui-muted); }

  /* --- KPI cell (affectui Trace-Waterfall metric-strip pattern, original CSS):
         tiny letterspaced label over a large tabular value --- */
  .aui-kpi { display: inline-flex; flex-direction: column; gap: 1px; line-height: 1.25; }
  .aui-kpi .k-label {
    font: 600 9px/1.2 var(--aui-sans); letter-spacing: .8px; text-transform: uppercase;
    color: var(--aui-faint);
  }
  .aui-kpi .k-value { font: 600 13px/1.2 var(--aui-sans); color: var(--aui-ink); font-variant-numeric: tabular-nums; }
  .aui-kpi .k-value .k-unit { font: 500 11px/1.2 var(--aui-sans); color: var(--aui-muted); }

  /* --- icon tile (affectui tool-call-card tile pattern, original CSS) --- */
  .aui-tile {
    display: inline-grid; place-items: center; flex: none;
    width: 24px; height: 24px; border-radius: 7px;
    background: var(--aui-wash);
    box-shadow: inset 0 0 0 1px var(--aui-border);
    color: var(--aui-ink);
  }
  .aui-tile > svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }

  /* --- ghost button (affectui secondary-button pattern, original CSS):
         white surface + hairline ring, hover lift --- */
  .aui-btn-ghost {
    font: 600 12px/1 var(--aui-sans); color: var(--aui-ink);
    background: var(--aui-surface); border: 0; border-radius: var(--aui-radius-sm);
    padding: 7px 13px; cursor: pointer;
    box-shadow: 0 0 0 1px var(--aui-border), 0 1px 2px rgba(0,0,0,.04);
    transition: transform .16s var(--aui-ease), box-shadow .16s var(--aui-ease), background-color .16s var(--aui-ease);
  }
  .aui-btn-ghost:hover { background: #f7f7f7; box-shadow: 0 0 0 1px var(--aui-border-strong), 0 2px 6px -1px rgba(0,0,0,.08); }
  .aui-btn-ghost:active { transform: scale(.98); }
  .aui-btn-ghost:focus-visible { outline: 2px solid var(--aui-focus); outline-offset: 2px; }

  /* --- ink button (affectui primary-button pattern, original CSS) --- */
  .aui-btn-ink {
    font: 600 12px/1 var(--aui-sans); color: #fafafa;
    background: linear-gradient(180deg, #323137, #201e25);
    border: 0; border-radius: var(--aui-radius-sm);
    padding: 7px 14px; cursor: pointer;
    box-shadow: 0 0 0 1px #0d0d0d, 0 2px 4px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.14);
    transition: transform .16s var(--aui-ease), box-shadow .16s var(--aui-ease), filter .16s var(--aui-ease);
  }
  .aui-btn-ink:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .aui-btn-ink:active { transform: translateY(0) scale(.98); filter: brightness(.92); }
  .aui-btn-ink:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(0,96,226,.35), 0 0 0 1px #0d0d0d; }

  /* --- 8-ray spinner (affectui Thinking-Loader pattern, original CSS over inline SVG) --- */
  .aui-rays { animation: aui-rays-spin 1s linear infinite; }
  .aui-rays line {
    stroke: currentColor; stroke-width: 1.6; stroke-linecap: round;
    opacity: .18; animation: aui-ray 800ms linear infinite;
  }
  .aui-rays line:nth-child(1) { animation-delay: -700ms; }
  .aui-rays line:nth-child(2) { animation-delay: -600ms; }
  .aui-rays line:nth-child(3) { animation-delay: -500ms; }
  .aui-rays line:nth-child(4) { animation-delay: -400ms; }
  .aui-rays line:nth-child(5) { animation-delay: -300ms; }
  .aui-rays line:nth-child(6) { animation-delay: -200ms; }
  .aui-rays line:nth-child(7) { animation-delay: -100ms; }
  .aui-rays line:nth-child(8) { animation-delay: 0ms; }
  @keyframes aui-rays-spin { to { transform: rotate(360deg); } }

  /* --- drawn check (affectui tool-call-card / Thinking-Loader done state, original CSS) --- */
  .aui-check-draw { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .aui-check-draw path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: aui-draw 360ms var(--aui-ease) 80ms forwards; }

  /* --- shine sweep over a working label (affectui Thinking-Loader pattern, original CSS) --- */
  .aui-shine { position: relative; }
  .aui-shine::after {
    content: attr(data-text);
    position: absolute; inset: 0; white-space: nowrap; color: transparent;
    background: linear-gradient(90deg, transparent 38%, rgba(255,255,255,.82) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
    -webkit-background-clip: text; background-clip: text;
    animation: aui-sweep 1.8s linear infinite; pointer-events: none;
  }

  /* --- JSON token colors (affectui tool-call-card code palette, original CSS) --- */
  .aui-tok-key { color: var(--aui-tok-key); }
  .aui-tok-str { color: var(--aui-tok-str); }
  .aui-tok-num { color: var(--aui-tok-num); }
  .aui-tok-lit { color: var(--aui-tok-lit); }

  .aui-chip {
    font: 600 11px/1.2 var(--aui-sans);
    color: var(--aui-muted);
    background: var(--aui-surface);
    border-radius: 999px; padding: 5px 12px;
    box-shadow: 0 0 0 1px var(--aui-border), 0 1px 2px rgba(0,0,0,.05);
    white-space: nowrap;
  }
  .aui-chip b { color: var(--aui-ink); font-weight: 700; }

  /* --- scrollbars --- */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: #dcdcdf; border-radius: 999px;
    border: 3px solid transparent; background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover { background: #c6c6cb; background-clip: content-box; }

  @media (prefers-reduced-motion: reduce) {
    .aui-badge .dot.live::after, .aui-rays, .aui-rays line, .aui-shine::after, .aui-shimmer-text { animation: none !important; }
    .aui-check-draw path { stroke-dashoffset: 0; animation: none; }
  }
`;

export const AUI_CSS = AUI_TOKENS_CSS + AUI_SHARED_CSS;

/**
 * Number-ticker motion (affectui "Number Ticker" pattern, original vanilla-JS
 * implementation): every numeric text inside the scanned root counts in from
 * zero on first paint and rolls from its previous value to the new one on
 * subsequent updates. Values are keyed by `scopeKey + traversal index`, so
 * wholesale re-renders (Studio chips on every SSE state frame) keep their
 * history and animate old→new instead of re-counting from zero.
 *
 * Embed with `<script>${AUI_TICKER_JS}</script>` and call
 * `auiScanTickers(root, 'scope')` after each (re)render. No CSS required, but
 * pair with `font-variant-numeric: tabular-nums` so digits don't jitter.
 */
export const AUI_TICKER_JS = `
(function () {
  'use strict';
  var last = Object.create(null);
  function animate(node, from, to, finalText, dur) {
    var t0 = performance.now();
    function frame(t) {
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 4);
      var v = Math.round(from + (to - from) * e);
      node.nodeValue = finalText.replace(/[\\d][\\d,]*/, String(v));
      if (p < 1) requestAnimationFrame(frame);
      else node.nodeValue = finalText;
    }
    requestAnimationFrame(frame);
  }
  function scan(root, scope) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n, i = 0;
    while ((n = walker.nextNode())) {
      var m = n.nodeValue && n.nodeValue.match(/[\\d][\\d,]*/);
      if (!m) continue;
      var key = scope + ':' + (i++);
      var target = parseFloat(m[0].replace(/,/g, ''), 10);
      if (isNaN(target)) continue;
      var prev = last[key];
      if (prev === undefined) animate(n, 0, target, n.nodeValue, 900);
      else if (prev !== target) animate(n, prev, target, n.nodeValue, 420);
      last[key] = target;
    }
  }
  window.auiScanTickers = function (root, scope) { scan(root, scope || 'aui'); };
})();
`.trim();
