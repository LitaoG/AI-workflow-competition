/**
 * The `[wf]` structured progress channel (src/dwf/progress.ts) — the contract
 * harness agents mirror into their todo lists, so the exact lines are locked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgressEvent, createProgressPrinter, ProgressCounters } from '../../../src/dwf/progress.js';

function line(type: string, data: Record<string, unknown>, counters: ProgressCounters = { phase: 0 }): string | null {
  return formatProgressEvent({ type, data }, counters);
}

test('phase events carry an incrementing 1-based index', () => {
  const counters: ProgressCounters = { phase: 0 };
  assert.equal(formatProgressEvent({ type: 'dwf_phase', data: { phase: 'detect' } }, counters), '[wf] PHASE 1 · detect');
  assert.equal(formatProgressEvent({ type: 'dwf_phase', data: { phase: 'triage' } }, counters), '[wf] PHASE 2 · triage');
  assert.equal(counters.phase, 2);
});

test('ask / replay / amend / agent lines are exact', () => {
  assert.equal(line('dwf_actor_created', { name: 'inspector' }), '[wf] AGENT + inspector');
  assert.equal(line('dwf_ask_start', { actor: 'coordinator', siteId: 'ask#27' }), '[wf] ASK ▶ coordinator (ask#27)');
  assert.equal(line('dwf_ask_complete', { siteId: 'ask#27' }), '[wf] ASK ✓ ask#27');
  assert.equal(line('dwf_replay_hit', { siteId: 'ask#27', ordinal: '1' }), '[wf] REPLAY ⚡ ask#27#1 (0 provider calls)');
  assert.equal(line('dwf_amend_hit', { siteId: 'ask#27', ordinal: '1' }), '[wf] AMEND ♻ ask#27#1');
});

test('gate / artifact / failure / human-in-the-loop lines are exact', () => {
  assert.equal(line('dwf_world_run', { cmd: 'npm', args: ['test', '--silent'] }), '[wf] GATE $ npm test --silent');
  assert.equal(line('dwf_world_run', { cmd: 'npm' }), '[wf] GATE $ npm');
  assert.equal(line('dwf_artifact', { id: 'postmortem', bytes: '569' }), '[wf] ARTIFACT ■ postmortem (569 bytes)');
  assert.equal(line('dwf_node_failed', { siteId: 'ask#27', error: 'model timeout' }), '[wf] FAIL ✖ ask#27: model timeout');
  assert.equal(line('dwf_call_error', { op: 'http', error: '500' }), '[wf] FAIL ✖ http: 500');
  assert.equal(line('dwf_escalation_open', { question: 'should we roll back?' }), '[wf] QUESTION ❓ should we roll back?');
  assert.equal(line('dwf_hole_open', { name: 'retry-budget' }), '[wf] HOLE ⌘ retry-budget');
});

test('the plan skeleton announces its shape up front (Issue #168)', () => {
  assert.equal(
    line('dwf_plan', { phases: ['inspect', 'verify'], sites: [{ siteId: 'ask#2' }, { siteId: 'ask#4' }] }),
    '[wf] PLAN ◇ 2 sites · 2 phases (graph.html live)',
  );
  assert.equal(line('dwf_plan', {}), '[wf] PLAN ◇ 0 sites · 0 phases (graph.html live)');
});

test('plan updates announce the graph growth (Issue #171)', () => {
  assert.equal(
    line('dwf_plan_update', { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }),
    '[wf] PLAN+ ◇ +2 nodes · +1 edges (graph.html live)',
  );
  assert.equal(line('dwf_plan_update', {}), '[wf] PLAN+ ◇ +0 nodes · +0 edges (graph.html live)');
});

test('terminal lines are stable and unknown events stay quiet', () => {
  assert.equal(line('dwf_completed', {}), '[wf] DONE ✔ run completed');
  assert.equal(line('dwf_failed', {}), '[wf] DONE ✖ run failed');
  assert.equal(line('dwf_parked', {}), '[wf] PARKED ⏸ waiting for you');
  assert.equal(line('dwf_log', { message: 'verbose chatter' }), null, 'unknown/unrouted kinds print nothing');
  assert.equal(line('dwf_report', { item: { step: 'gates' } }), null);
});

test('createProgressPrinter writes rendered lines to the stream and skips nulls', () => {
  const chunks: string[] = [];
  const fakeStream = { write: (s: string) => { chunks.push(s); } } as unknown as NodeJS.WritableStream;
  const printer = createProgressPrinter(fakeStream);
  printer({ type: 'dwf_phase', data: { phase: 'detect' } });
  printer({ type: 'dwf_log', data: { message: 'noise' } });
  printer({ type: 'dwf_completed', data: {} });
  assert.deepEqual(chunks, ['[wf] PHASE 1 · detect\n', '[wf] DONE ✔ run completed\n']);
});
