/**
 * SVG topology canvas — the server-side, pure-function SVG generator for the
 * Studio (Issue #156).
 *
 * Input is the {@link DAGGraph} data contract the journal projection emits
 * (`projectEventsToGraph`, src/dag/journal-projection.ts) — the same shape the
 * dag/ renderer family and dwf/view.ts already consume, so no second data
 * model can drift apart. Output is one self-contained SVG string. The function
 * is PURE: no DOM, no I/O, no wall clock — the same graph always renders the
 * byte-identical SVG, which is what lets tests lock the geometry.
 *
 * Node status coloring — the vocabulary is `StepStatus`
 * (src/domain/workflow-types.ts): `pending | running | completed | failed |
 * skipped | replayed`. "Pending/Running/Succeeded/Failed/Cancelled"
 * maps onto it as: pending → gray, running → blue, completed ("Succeeded") →
 * green, failed → red, skipped (the cancellation-adjacent terminal — a step
 * whose dependency failed or was replayed away; there is NO `cancelled` wire
 * value in the canonical vocabulary) → yellow, and the projection's extra
 * zero-cost-reuse terminal `replayed` → cyan.
 *
 * Bézier edges (the "curve-misalignment" fix): every edge is a cubic Bézier
 * whose two endpoints are anchored EXACTLY on the node boundary — the source
 * anchor is the midpoint of the source node's BOTTOM edge, the target anchor
 * the midpoint of the target node's TOP edge (nodes are laid out phase-band by
 * phase-band, top to bottom, so the flow reads downward). The first point of
 * the `d` attribute is therefore `(x + w/2, y + h)` of the source and the last
 * point `(x + w/2, y)` of the target — a property the snapshot tests assert
 * numerically, so an anchor can never silently drift off the card again.
 */

import type { DAGGraph, DAGNode, StepStatus } from '../types.js';

/** Status → color mapping. Vocabulary: `StepStatus` (src/domain/workflow-types.ts). */
export const STATUS_COLORS: Record<StepStatus, string> = {
  pending: '#64748b', // gray
  running: '#3b82f6', // blue
  completed: '#10b981', // green — "Succeeded"
  failed: '#ef4444', // red
  skipped: '#eab308', // yellow — "Cancelled" (no such wire value; skipped is the cancellation-adjacent terminal)
  replayed: '#38bdf8', // cyan — zero-cost journal/warm-cache reuse (projection-specific)
};

/** Fallback color for a status outside the canonical vocabulary (vocabulary drift must not crash the render). */
const UNKNOWN_STATUS_COLOR = '#334155';

/** Layout constants (px). Phase bands stack top → bottom; nodes sit in a row inside each band. */
const NODE_WIDTH = 190;
const NODE_HEIGHT = 56;
const NODE_GAP_X = 36;
const BAND_HEIGHT = NODE_HEIGHT + 52;
const BAND_TITLE_BASE = 20;
const CANVAS_PADDING = 24;

/** Format a node duration for the title line (deterministic, no wall clock). */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

/** Escape text for XML text/attribute content (& first, then < > "). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface PlacedNode {
  node: DAGNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasLayout {
  width: number;
  height: number;
  bands: Array<{ id: string; name: string; y: number }>;
  nodes: PlacedNode[];
}

/**
 * Deterministic layout: one horizontal band per phase (in `phases` order),
 * nodes left-to-right inside the band in stream (creation) order. A node whose
 * phase is unknown to `graph.phases` lands in an appended `(ungrouped)` band,
 * mirroring the SPA's fallback column.
 */
function computeLayout(graph: DAGGraph): CanvasLayout {
  const bands: Array<{ id: string; name: string; y: number }> = graph.phases.map((p, i) => ({
    id: p.id,
    name: p.name,
    y: CANVAS_PADDING + BAND_TITLE_BASE + i * BAND_HEIGHT,
  }));

  const bandIndexByPhase = new Map<string, number>(graph.phases.map((p, i) => [p.id, i]));
  const byNode = new Map<string, PlacedNode>();
  const buckets: DAGNode[][] = graph.phases.map(() => []);
  const ungrouped: DAGNode[] = [];
  for (const node of graph.nodes) {
    const idx = bandIndexByPhase.get(node.phaseId);
    if (idx === undefined) ungrouped.push(node);
    else buckets[idx].push(node);
  }
  if (ungrouped.length > 0) {
    buckets.push(ungrouped);
    bands.push({ id: '(ungrouped)', name: '(ungrouped)', y: CANVAS_PADDING + BAND_TITLE_BASE + graph.phases.length * BAND_HEIGHT });
  }

  const maxRow = Math.max(1, ...buckets.map((b) => b.length));
  buckets.forEach((row, bandIdx) => {
    row.forEach((node, i) => {
      byNode.set(node.id, {
        node,
        x: CANVAS_PADDING + 8 + i * (NODE_WIDTH + NODE_GAP_X),
        y: bands[bandIdx]!.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });

  const width = CANVAS_PADDING * 2 + 8 + maxRow * (NODE_WIDTH + NODE_GAP_X);
  const height = CANVAS_PADDING + BAND_TITLE_BASE + buckets.length * BAND_HEIGHT + CANVAS_PADDING;
  return { width, height, bands, nodes: [...byNode.values()] };
}

/**
 * The cubic Bézier `d` attribute for one edge, anchored bottom-mid → top-mid:
 * starts at the midpoint of the source's bottom edge, ends at the midpoint of
 * the target's top edge, control points on the vertical midline between them.
 */
function edgePath(src: PlacedNode, dst: PlacedNode): string {
  const x1 = src.x + src.width / 2;
  const y1 = src.y + src.height; // bottom-edge midpoint of the source
  const x2 = dst.x + dst.width / 2;
  const y2 = dst.y; // top-edge midpoint of the target
  const k = (y2 - y1) / 2;
  return `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(y1 + k)}, ${r(x2)} ${r(y2 - k)}, ${r(x2)} ${r(y2)}`;
}

/** Round to 2 decimals so the SVG carries no float noise. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function colorOf(status: string | undefined): string {
  return (status && STATUS_COLORS[status as StepStatus]) || UNKNOWN_STATUS_COLOR;
}

/**
 * Render the topology canvas as one SVG string.
 *
 * Pure and total: an empty graph yields a valid (empty) SVG, unknown statuses
 * degrade to the fallback gray, edges naming unknown nodes are dropped, and
 * every embedded text is XML-escaped.
 */
export function renderSvgCanvas(graph: DAGGraph): string {
  const layout = computeLayout(graph);
  const placed = new Map(layout.nodes.map((p) => [p.node.id, p]));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" class="studio-canvas">`,
  );

  for (const band of layout.bands) {
    parts.push(
      `<g class="band"><rect x="${CANVAS_PADDING}" y="${band.y - BAND_TITLE_BASE}" width="${layout.width - CANVAS_PADDING * 2}" height="${BAND_HEIGHT - 16}" rx="10" class="band-bg"/>` +
        `<text x="${CANVAS_PADDING + 10}" y="${band.y - 6}" class="band-title">${escapeXml(band.name)}</text></g>`,
    );
  }

  for (const p of layout.nodes) {
    const status = p.node.status || 'pending';
    const color = colorOf(status);
    const dur = formatDuration(p.node.durationMs);
    const title = p.node.name || p.node.id;
    const titleText = dur ? `${title} · ${dur}` : title;
    const err = p.node.errorMessage ? p.node.errorMessage.slice(0, 60) : '';
    parts.push(
      `<g class="node st-${escapeXml(status)}" data-id="${escapeXml(p.node.id)}" data-status="${escapeXml(status)}">` +
        `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="9" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1.6" class="node-card"/>` +
        `<circle cx="${p.x + 16}" cy="${p.y + p.height / 2}" r="5" fill="${color}" class="node-dot"/>` +
        `<text x="${p.x + 30}" y="${p.y + 24}" fill="#e2e8f0" class="ntitle">${escapeXml(clip(titleText))}</text>` +
        `<text x="${p.x + 30}" y="${p.y + 42}" fill="${color}" class="nmeta">${escapeXml(status)}</text>` +
        (err ? `<text x="${p.x + 30}" y="${p.y + 52}" fill="#f87171" class="nerror">${escapeXml('✖ ' + err)}</text>` : '') +
        `</g>`,
    );
  }

  // Edges after bands but before nodes would hide the anchors; emit edges
  // FIRST so cards sit on top, matching the SPA's paint order.
  const edgeParts: string[] = [];
  for (const edge of graph.edges) {
    const src = placed.get(edge.fromNodeId);
    const dst = placed.get(edge.toNodeId);
    if (!src || !dst) continue;
    const color = colorOf(dst.node.status);
    edgeParts.push(
      `<path d="${edgePath(src, dst)}" class="edge st-${escapeXml(dst.node.status || 'pending')}" stroke="${color}" stroke-opacity="0.55" fill="none" stroke-width="1.6"${edge.label ? `><title>${escapeXml(edge.label)}</title></path>` : '/>'}`,
    );
  }
  parts.splice(1 + layout.bands.length, 0, ...edgeParts);

  parts.push('</svg>');
  return parts.join('');
}

/** Clip a title to keep the SVG width-bounded (same budget as the SPA cards). */
function clip(s: string): string {
  return s.length > 32 ? `${s.slice(0, 31)}…` : s;
}
