/**
 * Issue #39: per-actor named amend cache — cache hits survive site RENUMBERING.
 *
 * The site-keyed import pool misses whenever an amend inserts a site upstream
 * (every downstream siteId shifts); the per-actor path matches by (effective
 * name + canonical persona) and consumes prior asks 1:1 by position + a
 * site-independent content hash. Old journals without the identity fields
 * replay through the site-keyed pool exactly as before (DoD ②).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';
import { providerRegistry } from '../../src/agent/provider.js';

const V1 = `
phase("P");
const alpha = agent('alpha', { provider: 'tap39' });
const beta = agent('beta', { provider: 'tap39' });
const r1 = await alpha.ask('q1');
const r2 = await alpha.ask('q2');
const r3 = await beta.ask('q3');
return { r1, r2, r3 };
`;

// v2 inserts a NEW actor before alpha — alpha/beta siteIds renumber.
const V2_RENUMBER = `
phase("P");
const gamma = agent('gamma', { provider: 'tap39' });
const alpha = agent('alpha', { provider: 'tap39' });
const beta = agent('beta', { provider: 'tap39' });
const g = await gamma.ask('g-new');
const r1 = await alpha.ask('q1');
const r2 = await alpha.ask('q2');
const r3 = await beta.ask('q3');
return { g, r1, r2, r3 };
`;

function tap(id: string): LLMProvider & { hits: number } {
  return {
    id,
    name: id,
    hits: 0,
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      this.hits += 1;
      return {
        content: `answer-${this.hits}`,
        model: id,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 0,
      };
    },
  };
}

function makeProject(): { dir: string; write: (body: string) => string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-actor-cache-'));
  return {
    dir,
    write: (body: string) => {
      const p = path.join(dir, `script-${fs.readdirSync(dir).length}.facade.ts`);
      fs.writeFileSync(p, body);
      return p;
    },
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows lock lag */
      }
    },
  };
}

test('#39 DoD①: amend cache hits survive site renumbering (per-actor named matching)', { timeout: 120_000 }, async () => {
  providerRegistry.register(tap('tap39'));
  const tap39 = providerRegistry.get('tap39') as LLMProvider & { hits: number };
  const project = makeProject();
  try {
    const v1 = await runFacadeScript({ scriptPath: project.write(V1), cwd: project.dir });
    assert.equal(v1.status, 'completed', v1.error);
    assert.equal(tap39.hits, 3, 'v1 runs every ask live');
    const hitsAfterV1 = tap39.hits;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const v2 = await runFacadeScript({
      scriptPath: project.write(V2_RENUMBER),
      cwd: project.dir,
      amendRunId: v1.runId,
      onEvent: (e) => events.push(e as { type: string; data: Record<string, unknown> }),
    });
    assert.equal(v2.status, 'completed', v2.error);

    // only the NEW actor's ask runs live — alpha/beta replay from the lineage
    assert.equal(tap39.hits - hitsAfterV1, 1, `renumbered amends must not re-ask alpha/beta, got ${tap39.hits - hitsAfterV1} new calls`);
    const actorHits = events.filter((e) => e.type === 'dwf_amend_hit' && e.data.via === 'actor');
    assert.equal(actorHits.length, 3, JSON.stringify(events.filter((e) => e.type === 'dwf_amend_hit')));
    assert.deepEqual(
      actorHits.map((e) => e.data.actor).sort(),
      ['alpha', 'alpha', 'beta'],
      'the hits attach by actor name, not by siteId',
    );
    // and the replayed answers are the lineage's own
    assert.deepEqual(v2.value, { g: 'answer-4', r1: 'answer-1', r2: 'answer-2', r3: 'answer-3' });
  } finally {
    project.cleanup();
  }
});

test('#39 persona change detaches the actor (identity guard), same-name asks run live', { timeout: 120_000 }, async () => {
  providerRegistry.register(tap('tap39b'));
  const tapB = providerRegistry.get('tap39b') as LLMProvider & { hits: number };
  providerRegistry.register(tap('tap39c'));
  const tapC = providerRegistry.get('tap39c') as LLMProvider & { hits: number };
  const project = makeProject();
  try {
    const v1 = await runFacadeScript({ scriptPath: project.write(V1.replaceAll('tap39', 'tap39b')), cwd: project.dir });
    assert.equal(v1.status, 'completed', v1.error);

    // alpha switches provider → persona mismatch → alpha re-runs on the new provider;
    // beta's persona is unchanged → still hits.
    const v2 = `
phase("P");
const alpha = agent('alpha', { provider: 'tap39c' });
const beta = agent('beta', { provider: 'tap39b' });
const r1 = await alpha.ask('q1');
const r2 = await alpha.ask('q2');
const r3 = await beta.ask('q3');
return { r1, r2, r3 };
`;
    const v2r = await runFacadeScript({ scriptPath: project.write(v2), cwd: project.dir, amendRunId: v1.runId });
    assert.equal(v2r.status, 'completed', v2r.error);
    assert.equal(tapC.hits, 2, 'the persona-changed actor re-runs on its new provider');
    assert.equal(tapB.hits, 3, 'the unchanged actor keeps its cache (no new calls)');
    assert.deepEqual(v2r.value, { r1: 'answer-1', r2: 'answer-2', r3: 'answer-3' });
  } finally {
    project.cleanup();
  }
});

test('#39 content change diverges the actor monotonically (downstream identical asks re-run too)', { timeout: 120_000 }, async () => {
  providerRegistry.register(tap('tap39d'));
  const tap39 = providerRegistry.get('tap39d') as LLMProvider & { hits: number };
  const project = makeProject();
  try {
    const v1 = await runFacadeScript({ scriptPath: project.write(V1.replaceAll('tap39', 'tap39d')), cwd: project.dir });
    assert.equal(v1.status, 'completed', v1.error);

    // alpha's FIRST ask changes — alpha diverges at seq 0, so its SECOND ask
    // (identical content) also runs live: the conversation is no longer the
    // lineage's (monotonic divergence, official parity). beta is untouched.
    const v2 = `
phase("P");
const alpha = agent('alpha', { provider: 'tap39d' });
const beta = agent('beta', { provider: 'tap39d' });
const r1 = await alpha.ask('q1-CHANGED');
const r2 = await alpha.ask('q2');
const r3 = await beta.ask('q3');
return { r1, r2, r3 };
`;
    const before = tap39.hits;
    const v2r = await runFacadeScript({ scriptPath: project.write(v2), cwd: project.dir, amendRunId: v1.runId });
    assert.equal(v2r.status, 'completed', v2r.error);
    assert.equal(tap39.hits - before, 2, 'alpha diverged wholly (2 live); beta still hits the cache');
    assert.deepEqual(v2r.value, { r1: 'answer-4', r2: 'answer-5', r3: 'answer-3' });
  } finally {
    project.cleanup();
  }
});

test('#39 DoD②: old journals without the identity fields replay through the site-keyed pool', { timeout: 120_000 }, async () => {
  providerRegistry.register(tap('tap39e'));
  const tap39 = providerRegistry.get('tap39e') as LLMProvider & { hits: number };
  const project = makeProject();
  try {
    const v1 = await runFacadeScript({ scriptPath: project.write(V1.replaceAll('tap39', 'tap39e')), cwd: project.dir });
    assert.equal(v1.status, 'completed', v1.error);

    // Simulate a PRE-#39 journal: strip the per-actor identity columns.
    const Database = (await import('node:sqlite')).DatabaseSync;
    const db = new Database(path.join(project.dir, '.workflow', 'dwf.sqlite'));
    db.exec(`UPDATE dwf_nodes SET actor_name = NULL, actor_seq = NULL, content_hash = NULL, persona_json = NULL`);
    db.close();

    // same-script resume: site-keyed replay is untouched by the stripping.
    const before = tap39.hits;
    const resumed = await runFacadeScript({ scriptPath: project.write(V1.replaceAll('tap39', 'tap39e')), cwd: project.dir, resumeRunId: v1.runId });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(tap39.hits - before, 0, 'the old journal replays at zero provider cost');

    // amend with a RENUMBERED script over a stripped journal: no identity
    // fields → the actor-keyed path stays inert AND the site keys shifted →
    // every ask re-runs live (the documented boundary for pre-#39 journals).
    const v2 = V2_RENUMBER.replaceAll('tap39', 'tap39e');
    const amended = await runFacadeScript({ scriptPath: project.write(v2), cwd: project.dir, amendRunId: v1.runId });
    assert.equal(amended.status, 'completed', amended.error);
    assert.equal(tap39.hits - before, 4, 'no identity fields + renumbering → no hits at all (documented boundary)');
  } finally {
    project.cleanup();
  }
});
