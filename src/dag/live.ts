/**
 * LiveGraph — a real-time execution view fed by the engine's event stream (P2).
 * Writes two artifacts next to each other: `state.json` (the current DAG/phase/ask
 * state) and an HTML page that fetches it every 500ms — so a run watched in a browser
 * and the journal tell the same story, and a cold replay of the same events renders
 * byte-identically (live view and cold replay share this one projection).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowEventType } from '../types.js';

interface LiveAsk {
  siteId: string;
  actor: string;
  status: 'running' | 'done' | 'failed' | 'replayed';
  phase: string;
}
interface LivePhase {
  name: string;
  order: number;
}

export interface LiveEvent {
  type: WorkflowEventType;
  data: Record<string, unknown>;
}

export class LiveGraph {
  private readonly htmlPath: string;
  private readonly jsonPath: string;
  private readonly runId: string;
  private readonly phases = new Map<string, LivePhase>();
  private currentPhase = '(start)';
  private readonly asks = new Map<string, LiveAsk>();
  private readonly logs: string[] = [];
  private result: { status: string; value?: unknown; error?: string } | { status: 'running' } = { status: 'running' };
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(outputPath: string, runId: string) {
    const abs = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.htmlPath = abs;
    this.jsonPath = abs.replace(/\.html$/, '.state.json');
    this.runId = runId;
    this.flush(); // write the initial frame so the page opens live
  }

  /** Feed one engine event; coalesces disk writes to ~2Hz. */
  handle(type: WorkflowEventType, data: Record<string, unknown>): void {
    switch (type) {
      case 'dwf_phase':
        this.currentPhase = String(data.phase ?? '');
        if (!this.phases.has(this.currentPhase)) {
          this.phases.set(this.currentPhase, { name: this.currentPhase, order: this.phases.size });
        }
        break;
      case 'dwf_ask_start': {
        const siteId = String(data.siteId);
        this.asks.set(siteId, { siteId, actor: String(data.actor ?? '?'), status: 'running', phase: this.currentPhase });
        break;
      }
      case 'dwf_ask_complete': {
        const a = this.asks.get(String(data.siteId));
        if (a && a.status === 'running') a.status = 'done';
        break;
      }
      case 'dwf_replay_hit':
      case 'dwf_amend_hit': {
        const a = this.asks.get(String(data.siteId));
        if (a) a.status = 'replayed';
        break;
      }
      case 'dwf_call_error':
      case 'dwf_node_failed': {
        const a = this.asks.get(String(data.siteId ?? ''));
        if (a && a.status === 'running') a.status = 'failed';
        break;
      }
      case 'dwf_log':
        this.logs.push(String(data.message ?? ''));
        if (this.logs.length > 50) this.logs.shift();
        break;
      case 'dwf_hole_open':
        this.logs.push(`⏸ parked at hole "${String(data.name)}"`);
        break;
      case 'dwf_escalation_open':
        this.logs.push(`❓ escalation ${String(data.questionId)}: ${String(data.question ?? '')}`);
        break;
      case 'dwf_completed':
        this.result = { status: 'completed', value: data.value };
        break;
      case 'dwf_failed':
        this.result = { status: 'failed', error: String(data.error ?? '') };
        break;
      default:
        break;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Final flush with the terminal state. */
  finish(result: { status: string; value?: unknown; error?: string }): void {
    this.result = result;
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return; // ~2Hz coalescing; the interval keeps the page fresh
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.dirty) this.flush();
    }, 500);
  }

  private flush(): void {
    const state = {
      runId: this.runId,
      result: this.result,
      currentPhase: this.currentPhase,
      phases: [...this.phases.values()],
      asks: [...this.asks.values()],
      logs: [...this.logs],
    };
    try {
      fs.writeFileSync(this.jsonPath, JSON.stringify(state), 'utf8');
      if (!fs.existsSync(this.htmlPath)) {
        fs.writeFileSync(this.htmlPath, renderHtml(path.basename(this.jsonPath)), 'utf8');
      }
      this.dirty = false;
    } catch {
      /* the run must not die because a watcher file cannot be written */
    }
  }
}

function renderHtml(stateFile: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI-Workflow live run</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 24px; }
  h1 { font-size: 16px; color: #58a6ff; }
  .phase { border-left: 3px solid #1f6feb; padding: 4px 12px; margin: 12px 0 4px; color: #79c0ff; }
  .ask { padding: 2px 12px 2px 24px; }
  .done { color: #3fb950; } .running { color: #d29922; } .replayed { color: #8b949e; } .failed { color: #f85149; }
  .log { color: #8b949e; white-space: pre-wrap; }
  #banner { font-weight: bold; }
</style></head><body>
<h1 id="banner">run loading…</h1>
<div id="phases"></div>
<h1>ask timeline</h1>
<div id="asks"></div>
<h1>log</h1>
<div id="log" class="log"></div>
<script>
const STATE = ${JSON.stringify(stateFile)};
async function tick() {
  try {
    const s = await (await fetch(STATE + '?t=' + Date.now())).json();
    document.getElementById('banner').textContent =
      'run ' + s.runId + ' — ' + (s.result && s.result.status !== 'running' ? '✔ ' + s.result.status : '▶ running @ ' + s.currentPhase);
    const seen = new Set();
    let ph = '', asks = '';
    for (const a of s.asks) {
      if (!seen.has(a.phase)) { seen.add(a.phase); ph += '<div class="phase">' + esc(a.phase) + '</div>'; }
      const cls = a.status === 'done' ? 'done' : a.status === 'running' ? 'running' : a.status === 'replayed' ? 'replayed' : 'failed';
      const mark = a.status === 'done' ? '✔' : a.status === 'running' ? '▶' : a.status === 'replayed' ? '⚡' : '✖';
      asks += '<div class="ask ' + cls + '">' + mark + ' ' + esc(a.actor) + ' (' + esc(a.siteId) + ')</div>';
    }
    document.getElementById('phases').innerHTML = ph;
    document.getElementById('asks').innerHTML = asks;
    document.getElementById('log').textContent = s.logs.join('\\n');
  } catch (e) { /* transient */ }
}
setInterval(tick, 500); tick();
</script></body></html>`;
}
