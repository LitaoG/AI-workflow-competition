/**
 * Scripted fake model shared by both cross-engine runners (no API key, no
 * network). ONE deterministic behavior table consumed by:
 *   - run-cross-official.mjs  (official WorkflowDriver: session -> actor name,
 *     startAsk -> schedule -> askStats/askTurnEnded)
 *   - run-cross-ours.mjs      (our LLMProvider: system prompt carries the actor
 *     name, generate() sleeps the scripted latency and returns the scripted text)
 *
 * Determinism contract: the reply is a pure function of (actorName, marker in
 * the instructions), never of wall-clock or call ordering. The latency table is
 * per actor name so both engines observe the same fanout stagger.
 */

export const SCRIPTED_LATENCY_MS = {
  planner: 12,
  'researcher-1': 40,
  'researcher-2': 25,
  'researcher-3': 33,
  'researcher-4': 18,
  verifier: 10,
};

export const SCRIPTED_MODEL = 'scripted-fake-model-v1';

/** Parse `key=value` markers ("step=verify round=2") out of an instruction text. */
export function markersOf(instructions) {
  const out = {};
  for (const m of String(instructions).matchAll(/([a-zA-Z]+)=([^ ]+)/g)) out[m[1]] = m[2];
  return out;
}

/**
 * The one scripted reply. Returns { text, latencyMs }.
 * Behavior table mirrors the mission script's expectations:
 *   - planner   step=plan    -> valid plan JSON (2 steps)
 *   - researcher step=research target=X -> valid finding JSON for that target
 *   - researcher step=cross  -> valid challenge JSON
 *   - verifier  step=verify round=1 -> malformed (truncated) JSON
 *               step=verify round=2 -> malformed (single-quoted) JSON
 *               step=verify round=3 -> valid audit JSON  (self-heal lands here)
 */
export function scriptedReply({ actorName, instructions }) {
  const mk = markersOf(instructions);
  const latencyMs = SCRIPTED_LATENCY_MS[actorName] ?? 5;
  switch (mk.step) {
    case 'plan':
      return {
        text: '{"steps":["isolate the connection pool","probe healthz until green"],"owner":"sre-oncall"}',
        latencyMs,
      };
    case 'research':
      return {
        text:
          '{"target":"' +
          String(mk.target ?? 'unknown') +
          '","signals":["sig-a","sig-b"],"confidence":0.82,"owner":"' +
          actorName +
          '"}',
        latencyMs,
      };
    case 'cross':
      return {
        text: '{"holds":true,"note":"evidence withstands challenge","challenger":"' + actorName + '"}',
        latencyMs,
      };
    case 'verify': {
      if (mk.round === '1') {
        // Malformed #1: valid JSON truncated mid-object.
        return { text: '{"approve": true, "riskScore":', latencyMs };
      }
      if (mk.round === '2') {
        // Malformed #2: single quotes / trailing comma — never legal JSON.
        return { text: "{'approve': true, 'riskScore': 42,}", latencyMs };
      }
      return {
        text: '{"approve":true,"riskScore":42,"rejected":["deploys"],"notes":"two malformed rounds healed on round 3"}',
        latencyMs,
      };
    }
    default:
      return { text: '{"status":"SUCCESS","message":"scripted default"}', latencyMs };
  }
}

/** The audit JSON the verifier is scripted to produce on round 3. */
export const EXPECTED_VERDICT = {
  approve: true,
  riskScore: 42,
  rejected: ['deploys'],
  notes: 'two malformed rounds healed on round 3',
};

/** Expected mission artifact (both runners assert their return equals this). */
export function expectedArtifact() {
  return {
    plan: {
      steps: ['isolate the connection pool', 'probe healthz until green'],
      owner: 'sre-oncall',
    },
    findingCount: 4,
    challengeCount: 4,
    verdict: EXPECTED_VERDICT,
    healRounds: 3,
  };
}
