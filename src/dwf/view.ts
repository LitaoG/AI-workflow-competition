/**
 * Run viewer — render a journalled facade-script run as a standalone HTML
 * report (交互式运行视图).
 *
 * Reads ONLY the journal (run row + nodes + events), so it works for live
 * runs, resumed runs, amended runs (lineage shown) and parked runs alike —
 * the journal is the single source of truth, and the same projection serves
 * audit and demo.
 */

import { DwfJournalStore, DwfNode, WorkflowEvent } from '../types.js';
import { SQLiteStateStore } from '../state/sqlite-store.js';

const KIND_ICON: Record<DwfNode['kind'], string> = {
  ask: '◆ ask',
  worldRead: '◇ read',
  worldRun: '▣ gate',
  artifact: '■ artifact',
  hole: '⌘ hole',
  report: '📣 report',
  escalation: '❓ escalate',
};

const KIND_LABEL: Record<DwfNode['kind'], string> = {
  ask: 'Agent ask',
  worldRead: 'World read',
  worldRun: 'Shell gate',
  artifact: 'Artifact',
  hole: 'Hole',
  report: 'Report item',
  escalation: 'Escalation',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, max = 800): string {
  return s.length > max ? s.slice(0, max) + ` … (+${s.length - max} chars)` : s;
}

interface PhaseGroup {
  title: string;
  nodes: DwfNode[];
}

/** Group nodes into phases by completion time vs the dwf_phase event timeline. */
export function groupNodesByPhase(nodes: DwfNode[], events: WorkflowEvent[]): PhaseGroup[] {
  const phaseTimes = events
    .filter((e) => e.type === 'dwf_phase')
    .map((e) => ({ title: String((e.data as { phase?: string }).phase ?? 'Phase'), time: Date.parse(e.timestamp) }));

  const grouped = new Map<string, DwfNode[]>();
  const unphased: DwfNode[] = [];
  for (const node of nodes) {
    const t = node.completedAt ? Date.parse(node.completedAt) : 0;
    let best: { title: string; time: number } | undefined;
    for (const p of phaseTimes) {
      if (p.time <= t && (!best || p.time > best.time)) best = p;
    }
    if (best) {
      const arr = grouped.get(best.title) ?? [];
      arr.push(node);
      grouped.set(best.title, arr);
    } else {
      unphased.push(node);
    }
  }

  const out: PhaseGroup[] = phaseTimes
    .filter((p) => grouped.has(p.title))
    .map((p) => ({ title: p.title, nodes: grouped.get(p.title)! }));
  if (unphased.length > 0) out.unshift({ title: 'Ungrouped', nodes: unphased });
  return out;
}

export async function renderRunViewHtml(store: SQLiteStateStore & DwfJournalStore, runId: string): Promise<string> {
  const run = await store.getDwfRun(runId);
  if (!run) throw new Error(`run "${runId}" not found in the journal`);
  const nodes = await store.getDwfNodes(runId);
  const events = await store.getEvents(runId);

  const escalations = nodes.filter((n) => n.kind === 'escalation');
  const openEscalations = events.filter((e) => e.type === 'dwf_escalation_open');
  const questionOf = new Map<string, string>(); // siteId -> question text
  for (const ev of openEscalations) {
    const d = ev.data as { siteId?: string; question?: string };
    if (d.siteId && d.question) questionOf.set(d.siteId, d.question);
  }
  const replayHits = events.filter((e) => e.type === 'dwf_replay_hit').length;
  const amendHits = events.filter((e) => e.type === 'dwf_amend_hit').length;

  const groups = groupNodesByPhase(nodes, events);

  const nodeRow = (n: DwfNode): string => {
    const status = n.status === 'completed' ? '<span class="ok">✔</span>' : '<span class="bad">✖</span>';
    const meta: string[] = [`${n.siteId}#${n.ordinal}`, KIND_LABEL[n.kind]];
    if (n.durationMs !== undefined) meta.push(`${n.durationMs}ms`);
    let detail = '';
    if (n.errorText) detail = `<pre class="err">${escapeHtml(truncate(n.errorText))}</pre>`;
    else if (n.resultJson) detail = `<details><summary>result</summary><pre>${escapeHtml(truncate(n.resultJson))}</pre></details>`;
    const question = n.kind === 'escalation' ? questionOf.get(n.siteId) : undefined;
    const q = question ? `<div class="q">❓ ${escapeHtml(question)}</div>` : '';
    return `<div class="node">${status} <b>${KIND_ICON[n.kind]}</b> <span class="meta">${escapeHtml(meta.join(' · '))}</span>${q}${detail}</div>`;
  };

  const phaseHtml = groups
    .map(
      (g) =>
        `<section><h2>${escapeHtml(g.title)}</h2>${g.nodes.map(nodeRow).join('\n')}${g.nodes.length === 0 ? '<p class="dim">no journalled nodes</p>' : ''}</section>`,
    )
    .join('\n');

  const escHtml =
    escalations.length > 0
      ? `<section><h2>Escalations</h2>${escalations
          .map((n) => {
            const q = questionOf.get(n.siteId) ?? '(question not recorded)';
            const a = n.resultJson ? JSON.parse(n.resultJson) : '(unanswered)';
            return `<div class="node">${n.status === 'completed' ? '<span class="ok">✔ answered</span>' : '<span class="warn">⏸ open</span>'} <div class="q">❓ ${escapeHtml(q)}</div><div class="a">→ ${escapeHtml(truncate(typeof a === 'string' ? a : JSON.stringify(a)))}</div></div>`;
          })
          .join('\n')}</section>`
      : '';

  const eventsHtml = `<details><summary>Raw event journal (${events.length} events)</summary><pre>${escapeHtml(
    events.map((e) => `${e.timestamp} [${e.sequence ?? '-'}] ${e.type} ${truncate(JSON.stringify(e.data), 220)}`).join('\n'),
  )}</pre></details>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AI-Workflow run ${escapeHtml(runId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; border-bottom: 1px solid #21262d; padding-bottom: .3rem; margin-top: 1.6rem; }
  .meta, .dim { color: #8b949e; font-size: .85rem; }
  .ok { color: #3fb950; } .bad { color: #f85149; } .warn { color: #d29922; }
  .node { padding: .45rem .6rem; border: 1px solid #21262d; border-radius: 6px; margin: .35rem 0; }
  .q { color: #d29922; margin-top: .25rem; } .a { color: #3fb950; }
  pre { background: #161b22; padding: .5rem; border-radius: 6px; overflow-x: auto; font-size: .8rem; }
  .err { color: #f85149; }
  details summary { cursor: pointer; color: #58a6ff; }
  .badges span { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: .1rem .55rem; margin-right: .4rem; font-size: .8rem; }
  table { border-collapse: collapse; } td { padding: .15rem .8rem .15rem 0; color: #8b949e; }
</style></head><body>
<h1>AI-Workflow run ${escapeHtml(runId)}</h1>
<table>
<tr><td>status</td><td><b>${escapeHtml(run.status)}</b></td></tr>
<tr><td>script</td><td>${escapeHtml(run.scriptPath ?? '(inline)')} <span class="meta">hash ${escapeHtml(run.scriptHash.slice(0, 12))}…</span></td></tr>
${run.parentRunId ? `<tr><td>amend of</td><td>${escapeHtml(run.parentRunId)}</td></tr>` : ''}
${run.argsJson ? `<tr><td>args</td><td>${escapeHtml(truncate(run.argsJson))}</td></tr>` : ''}
<tr><td>created</td><td>${escapeHtml(run.createdAt ?? '')} → ${escapeHtml(run.updatedAt ?? '')}</td></tr>
</table>
<p class="badges"><span>${nodes.length} nodes</span><span>${replayHits} replay hits ⚡</span>${amendHits > 0 ? `<span>${amendHits} amend hits</span>` : ''}</p>
${phaseHtml}
${escHtml}
${eventsHtml}
<p class="dim">rendered from the journal — same projection for live, resumed and amended runs</p>
</body></html>`;
}
