/**
 * Structured progress channel for harness agents (`--progress`, facade runs).
 *
 * The default run printer teaches humans; this one teaches AGENTS: every line
 * carries a stable `[wf]` prefix and an UPPERCASE event kind, so a coding
 * agent streaming the run's stdout can mechanically mirror the workflow into
 * its native todo list / chat updates (the "progress lives in the harness"
 * channel — no external dashboard needed while the run is live).
 *
 * Output contract (grep-able, one line per event):
 *   [wf] PHASE 2 · Triage & Root Cause Analysis
 *   [wf] AGENT + inspector
 *   [wf] ASK ▶ coordinator (ask#27)
 *   [wf] ASK ✓ ask#27
 *   [wf] REPLAY ⚡ ask#27#1 (0 provider calls)
 *   [wf] AMEND ♻ ask#27#1
 *   [wf] GATE $ npm test (exit 0)
 *   [wf] ARTIFACT ■ postmortem (569 bytes)
 *   [wf] FAIL ✖ ask#27: model timeout
 *   [wf] QUESTION ❓ should we roll back?
 *   [wf] HOLE ⌘ retry-budget
 *   [wf] DONE ✔ run completed
 *
 * `formatProgressEvent` is pure (phase counting lives in an explicit counter
 * object) so tests lock the exact lines; `createProgressPrinter` only wires it
 * to a stream. Unknown event types return `null` and print nothing — the
 * channel must stay quiet rather than guessy when the journal grows new kinds.
 */

export interface ProgressCounters {
  /** 1-based index of the last dwf_phase event seen. */
  phase: number;
}

export type ProgressEvent = {
  type: string;
  data: Record<string, unknown>;
};

/** Render one journal event as a `[wf]` progress line, or `null` to stay quiet. */
export function formatProgressEvent(e: ProgressEvent, counters: ProgressCounters): string | null {
  const d = e.data || {};
  const str = (k: string): string => (d[k] === undefined || d[k] === null ? '' : String(d[k]));
  switch (e.type) {
    case 'dwf_phase':
      counters.phase += 1;
      return `[wf] PHASE ${counters.phase} · ${str('phase')}`;
    case 'dwf_actor_created':
      return `[wf] AGENT + ${str('name')}`;
    case 'dwf_ask_start':
      return `[wf] ASK ▶ ${str('actor')} (${str('siteId')})`;
    case 'dwf_ask_complete':
      return `[wf] ASK ✓ ${str('siteId')}`;
    case 'dwf_replay_hit':
      return `[wf] REPLAY ⚡ ${str('siteId')}#${str('ordinal')} (0 provider calls)`;
    case 'dwf_amend_hit':
      return `[wf] AMEND ♻ ${str('siteId')}#${str('ordinal')}`;
    case 'dwf_world_run':
      return `[wf] GATE $ ${str('cmd')} ${(Array.isArray(d.args) ? (d.args as unknown[]).join(' ') : str('args')).trim()}`.trimEnd();
    case 'dwf_artifact':
      return `[wf] ARTIFACT ■ ${str('id')} (${str('bytes')} bytes)`;
    case 'dwf_call_error':
    case 'dwf_node_failed':
      return `[wf] FAIL ✖ ${str('siteId') || str('op')}: ${str('error')}`;
    case 'dwf_escalation_open':
      return `[wf] QUESTION ❓ ${str('question')}`;
    case 'dwf_hole_open':
      return `[wf] HOLE ⌘ ${str('name')}`;
    case 'dwf_completed':
      return '[wf] DONE ✔ run completed';
    case 'dwf_failed':
      return '[wf] DONE ✖ run failed';
    case 'dwf_parked':
      return '[wf] PARKED ⏸ waiting for you';
    default:
      return null;
  }
}

/** Create a printer that writes each rendered line to `out` (default stdout). */
export function createProgressPrinter(out: NodeJS.WritableStream = process.stdout): (e: ProgressEvent) => void {
  const counters: ProgressCounters = { phase: 0 };
  return (e) => {
    const line = formatProgressEvent(e, counters);
    if (line !== null) out.write(line + '\n');
  };
}
