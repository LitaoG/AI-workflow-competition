#!/usr/bin/env node
/**
 * Cross-engine benchmark (deliverable 4) — OURS track.
 *
 * Runs the SAME shared mission (cross-benchmark-mission.facade.ts) on OUR engine
 * (AI-workflow src/dwf FacadeEngine), fully in-process, with the SAME scripted
 * fake model (scripted-model.mjs — no API key, no network): an LLMProvider whose
 * generate() answers from the shared behavior table, like tests/unit/dwf's fake
 * provider assemblies (providerRegistry.register + setDefault).
 *
 * Pipeline per run: analyzeFacadeScript -> lowerFacadeScript (the same two
 * passes our runner performs) -> FacadeEngine driven directly through
 * handleCall(HostCallFrame) with a __host shim over the lowered code.
 *
 * Probes (mirroring the official track):
 *   A. mission x2     — same topology; determinism = settle/event sequences
 *                       identical across the two runs.
 *   B. repair         — OUR engine-level typed-ask self-heal: the schema-repair
 *                       loop inside src/agent/rpc.ts (repair prompts on
 *                       unparseable/invalid JSON, maxRetries=3). The scripted
 *                       provider returns bad JSON twice then a legal payload;
 *                       rounds = repair prompts injected / provider calls - 1.
 *                       Nudge: N/A on this side — see repairNudge.nudge.note.
 *   C. hole park/fill — OUR hole mechanism is runner-level: `hole()` parks the
 *                       in-process call (dwf_hole_open) and the fill is an amend
 *                       fork (spliceHoleBody + runFacadeScript). Probed through
 *                       the REAL pipeline: runFacadeScript parks, fillHoleAndRun
 *                       forks and completes. Best-effort: if the sandbox child
 *                       cannot run in this environment the probe records why.
 *
 * Output: results/ours-cross-benchmark.json (+ a crossCompare section against
 * results/official-cross-benchmark.json when present) + stdout summary.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WT = join(HERE, "..", ".."); // worktree root
const MISSION_PATH = join(HERE, "cross-benchmark-mission.facade.ts");
const OUT_PATH = join(HERE, "results", "ours-cross-benchmark.json");
const OFFICIAL_JSON = join(HERE, "results", "official-cross-benchmark.json");

const { scriptedReply, SCRIPTED_MODEL, expectedArtifact, SCRIPTED_LATENCY_MS } = await import(
  pathToFileURL(join(HERE, "scripted-model.mjs")).href
);
const { analyzeFacadeScript } = await import(pathToFileURL(join(WT, "dist", "src", "dwf", "compile.js")).href);
const { lowerFacadeScript } = await import(pathToFileURL(join(WT, "dist", "src", "dwf", "lower.js")).href);
const { FacadeEngine } = await import(pathToFileURL(join(WT, "dist", "src", "dwf", "engine.js")).href);
const { createSQLiteStore } = await import(pathToFileURL(join(WT, "dist", "src", "state", "store.js")).href);
const { providerRegistry } = await import(pathToFileURL(join(WT, "dist", "src", "agent", "provider.js")).href);

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const src = readFileSync(MISSION_PATH, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scripted fake provider (our Boundary): the actor name rides the system prompt
// ("You are specialized agent \"NAME\"."), the instructions are the last user
// message. Replies and latencies come from the shared behavior table.
// ---------------------------------------------------------------------------
class ScriptedProvider {
  constructor() {
    this.id = SCRIPTED_MODEL;
    this.name = "Scripted fake model (cross-engine benchmark, offline)";
    this.calls = 0;
    this.repairPromptSeens = [];
    this.lastActorName = null;
  }
  checkHealth() {
    return { ok: true, detail: "scripted offline model — no network, no API key" };
  }
  async generate(request) {
    this.calls += 1;
    const t0 = nowMs();
    if (request.signal?.aborted) {
      const e = new Error("ask cancelled");
      e.name = "AbortError";
      throw e;
    }
    const systemMessage = request.messages.find((m) => m.role === "system")?.content ?? "";
    const actorName = /You are specialized agent "([^"]+)"/.exec(systemMessage)?.[1] ?? "unknown";
    this.lastActorName = actorName;
    const instructions = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const repairPrompts = request.messages.filter(
      (m) => m.role === "user" && (m.content.includes("not valid JSON") || m.content.includes("failed runtime schema validation")),
    );
    if (repairPrompts.length > this.repairPromptSeens.length) this.repairPromptSeens = repairPrompts;
    const reply = scriptedReply({ actorName, instructions });
    if (reply.latencyMs > 0) await sleep(reply.latencyMs);
    return {
      content: reply.text,
      model: SCRIPTED_MODEL,
      usage: { promptTokens: 12, completionTokens: 40, totalTokens: 52 },
      latencyMs: +(nowMs() - t0).toFixed(3),
    };
  }
}

// Restore the registry default afterwards — tests share this process state.
const previousDefault = providerRegistry.get().id;

// ---------------------------------------------------------------------------
// A. mission runs on FacadeEngine (in-process, same script text)
// ---------------------------------------------------------------------------
let missionLower = null;
function getMissionLower() {
  if (!missionLower) {
    const analysis = analyzeFacadeScript(src);
    if (!analysis.ok) throw new Error("mission failed OUR compile: " + JSON.stringify(analysis.diagnostics ?? []).slice(0, 500));
    missionLower = lowerFacadeScript(src);
  }
  return missionLower;
}

function heapSampler() {
  const state = { peak: 0, timer: null };
  state.timer = setInterval(() => {
    const h = process.memoryUsage().heapUsed;
    if (h > state.peak) state.peak = h;
  }, 5);
  state.timer.unref();
  return state;
}

async function runMission(runId, maxConcurrency) {
  const provider = new ScriptedProvider();
  providerRegistry.register(provider);
  providerRegistry.setDefault(provider.id);

  const { js, analysis } = getMissionLower();
  const askSiteIds = analysis.sites.filter((s) => s.kind === "ask").map((s) => s.siteId);
  const events = [];
  let callSeq = 0;

  const store = createSQLiteStore(":memory:");
  const engine = new FacadeEngine({
    runId,
    workspace: WT,
    store,
    args: {},
    approvedCommands: [],
    maxConcurrency,
    onEvent: (e) => events.push({ t: nowMs(), type: e.type, data: e.data ?? {} }),
  });

  // __host shim over handleCall — the exact payload shapes of src/dwf/lower.ts.
  const shimCall = (op, siteId, payload) => {
    callSeq += 1;
    return engine.handleCall({ t: "call", id: callSeq, op, siteId, payload });
  };
  const askWall = new Map(); // `${siteId}#${occ}` -> {start}
  const askOccurrence = new Map();
  const host = {
    args: {},
    run: { id: runId },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    // createActor is SYNCHRONOUS in the script realm (child-main.ts:156-164): the
    // registration happens inside handleCall before its first await, and the
    // handle is returned locally so the script can chain .ask() without an await.
    createActor: (siteId, name, providerOverride) => {
      void shimCall("createActor", siteId, [name, providerOverride]).catch((e) => {
        throw new Error(`createActor(${siteId}) failed: ${(e && e.message) || e}`);
      });
      return { __actor: siteId };
    },
    ask: (siteId, actor, prompt, schemaJson) => {
      const occ = (askOccurrence.get(siteId) ?? 0) + 1;
      askOccurrence.set(siteId, occ);
      const key = `${siteId}#${occ}`;
      askWall.set(key, { start: nowMs() });
      return shimCall("ask", siteId, [actor, prompt, schemaJson ?? null]).finally(() => {
        const row = askWall.get(key);
        if (row) row.end = nowMs();
      });
    },
    enterPhase: (name, index) => shimCall("enterPhase", undefined, [name, index]),
    log: (siteId, message) => shimCall("log", siteId, [message]),
    report: (siteId, item) => shimCall("report", siteId, [item]),
  };

  const heap = heapSampler();
  const t0 = nowMs();
  const runScript = new Function("__host", js + "\nreturn __workflowScript__;")(host);
  const artifact = await runScript();
  const wall = nowMs() - t0;
  clearInterval(heap.timer);
  if (heap.peak > peakHeapUsed) peakHeapUsed = heap.peak;

  // Settle sequence: dwf_ask_complete arrival order, keyed `ask:<siteId>#<occ>` —
  // the same asks-only surface as the official track's node-settled sequence
  // (our dwf_report events are progress items, counted separately).
  const settleOccurrence = new Map();
  const settleSequence = [];
  const eventTypeSequence = [];
  for (const e of events) {
    eventTypeSequence.push(e.type);
    if (e.type === "dwf_ask_complete") {
      const siteId = String(e.data.siteId ?? "?");
      const occ = (settleOccurrence.get(siteId) ?? 0) + 1;
      settleOccurrence.set(siteId, occ);
      settleSequence.push(`ask:${siteId}#${occ}`);
    }
  }

  // Per-instance decomposition: total = host call wall; occupancy =
  // dwf_ask_start -> dwf_ask_complete event delta; queueWait = total - occupancy
  // (our engine emits no queue/dispatch events — derived, stated as such).
  const startAt = new Map();
  const completeAt = new Map();
  const startOcc = new Map();
  for (const e of events) {
    if (e.type === "dwf_ask_start" || e.type === "dwf_ask_complete") {
      const kind = e.type === "dwf_ask_start" ? "start" : "complete";
      const siteId = String(e.data.siteId ?? "?");
      const occ = (startOcc.get(kind + ":" + siteId) ?? 0) + 1;
      startOcc.set(kind + ":" + siteId, occ);
      const m = kind === "start" ? startAt : completeAt;
      m.set(`${siteId}#${occ}`, e.t);
    }
  }
  const instanceTimings = askSiteIds.flatMap((siteId) => {
    const rows = [];
    for (let occ = 1; askWall.has(`${siteId}#${occ}`); occ++) {
      const w = askWall.get(`${siteId}#${occ}`);
      const s = startAt.get(`${siteId}#${occ}`);
      const c = completeAt.get(`${siteId}#${occ}`);
      const totalMs = w.end - w.start;
      const occupancyMs = s !== undefined && c !== undefined ? c - s : null;
      rows.push({
        instance: `${siteId}#${occ}`,
        totalMs: +totalMs.toFixed(3),
        occupancyMs: occupancyMs === null ? null : +occupancyMs.toFixed(3),
        queueWaitMs: occupancyMs === null ? null : +(totalMs - occupancyMs).toFixed(3),
        queueWaitDerived: true,
      });
    }
    return rows;
  });

  const journalNodes = await store.getDwfNodes(runId);
  store.close();
  providerRegistry.setDefault(previousDefault);

  return {
    runId,
    wallMs: +wall.toFixed(3),
    artifact,
    artifactMatchesExpected: JSON.stringify(artifact) === JSON.stringify(expectedArtifact()),
    eventsEmitted: events.length,
    eventCounts: events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {}),
    eventTypeSequence,
    settleSequence,
    phasesEntered: events.filter((e) => e.type === "dwf_phase").map((e) => e.data.phase),
    journalNodes: journalNodes.length,
    journalAskNodes: journalNodes.filter((n) => n.kind === "ask").length,
    providerCalls: provider.calls,
    instanceTimings,
    maxConcurrency,
  };
}

// ---------------------------------------------------------------------------
// B. repair probe: OUR engine-level typed-ask self-heal (rpc schema-repair loop)
// ---------------------------------------------------------------------------
async function repairProbe() {
  const schema = {
    type: "object",
    properties: { pass: { type: "boolean" }, risk: { type: "string" } },
    required: ["pass", "risk"],
    additionalProperties: false,
  };
  const store = createSQLiteStore(":memory:");
  const engine = new FacadeEngine({
    runId: "cross-ours-repair",
    workspace: WT,
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
  });
  // Rounds 1-2 mirror the official probe's bad submits (parseable objects that
  // fail the schema), round 3 is the legal payload. On this side they arrive as
  // the provider's reply TEXT and go through extractJson/repairJsonString first.
  const bad1 = '{"wrong": 1}'; // parses; missing required fields -> schema repair
  const bad2 = '{"pass": "no", "risk": "low"}'; // parses; wrong type -> schema repair
  const good = '{"pass":true,"risk":"low"}';
  const scripted = [bad1, bad2, good];
  const repairPromptTexts = [];
  const probeProvider = {
    id: "cross-ours-repair-model",
    name: "scripted repair probe",
    calls: 0,
    checkHealth: () => ({ ok: true, detail: "scripted" }),
    async generate(request) {
      this.calls += 1;
      for (const m of request.messages) {
        if (m.role === "user" && (m.content.includes("not valid JSON") || m.content.includes("failed runtime schema validation"))) {
          repairPromptTexts.push(m.content);
        }
      }
      const text = scripted[Math.min(this.calls - 1, scripted.length - 1)];
      return { content: text, model: this.id, usage: { promptTokens: 8, completionTokens: 24, totalTokens: 32 }, latencyMs: 1 };
    },
  };
  providerRegistry.register(probeProvider);
  providerRegistry.setDefault(probeProvider.id);

  const schemaJson = JSON.stringify(schema);
  const t0 = nowMs();
  let outcome;
  try {
    const actor = await engine.handleCall({ t: "call", id: 1, op: "createActor", siteId: "actor#1", payload: ["auditor", null] });
    const reply = await engine.handleCall({
      t: "call",
      id: 2,
      op: "ask",
      siteId: "ask#1",
      payload: [actor, "Return the audit verdict as JSON.", schemaJson],
    });
    outcome = { ok: true, value: reply };
  } catch (err) {
    outcome = { ok: false, error: `${(err && err.name) || "Error"}: ${(err && err.message) || String(err)}` };
  }
  const wallMs = +(nowMs() - t0).toFixed(3);

  providerRegistry.setDefault(previousDefault);
  store.close();

  return {
    mechanism: "typed-ask schema repair inside src/agent/rpc.ts (extractJson/repairJsonString + zod safeParse; maxRetries=3 default)",
    schema,
    scriptedProviderReplies: scripted,
    providerCalls: probeProvider.calls,
    repairRounds: Math.max(0, probeProvider.calls - 1),
    // The conversation accumulates: call N sees the repair prompts of all
    // earlier rounds, so occurrences = 1 + 2 + ... = rounds*(rounds+1)/2.
    repairPromptOccurrencesInHistory: repairPromptTexts.map((t) => t.slice(0, 90)),
    outcome,
    wallMs,
    note: "Each repair round injects a user message ('Your response was not valid JSON...' or '...failed runtime schema validation...') and retries within the SAME ask node — one journalled node, N provider calls.",
  };
}

// ---------------------------------------------------------------------------
// C. hole park + fill through the REAL runner pipeline (our fill is runner-level)
// ---------------------------------------------------------------------------
async function holeProbe() {
  const holeScript = `phase('Dock');
const scout = agent('scout');
const prep = await scout.ask('mission=holeprep step=dock round=1 confirm ready');
log('docked: ' + prep.slice(0, 16));
const verdict = await hole<string>('verdict-hole', 'Decide the verdict for the cross-engine hole probe.');
log('hole value: ' + String(verdict));
report({ phase: 'Dock', verdict: String(verdict) });
return { verdict: String(verdict) };
`;
  let workspace = null;
  try {
    const analysis = analyzeFacadeScript(holeScript);
    if (!analysis.ok) {
      return { feasible: false, reason: "hole probe script failed OUR compile: " + JSON.stringify(analysis.diagnostics ?? []).slice(0, 300) };
    }
    workspace = mkdtempSync(join(os.tmpdir(), "cross-ours-hole-"));
    const scriptPath = join(workspace, "hole-mission.facade.ts");
    writeFileSync(scriptPath, holeScript);
    const dbPath = join(workspace, "dwf.sqlite");

    const provider = new ScriptedProvider();
    providerRegistry.register(provider);
    providerRegistry.setDefault(provider.id);

    const { runFacadeScript, fillHoleAndRun } = await import(
      pathToFileURL(join(WT, "dist", "src", "dwf", "runner.js")).href
    );

    const parkEvents = [];
    const t0 = nowMs();
    const parked = await runFacadeScript({
      scriptPath,
      cwd: workspace,
      args: {},
      dbPath,
      maxConcurrency: 4,
      runTimeoutMs: 120000,
      onEvent: (e) => parkEvents.push({ type: e.type, data: e.data ?? {} }),
    });
    const parkWallMs = +(nowMs() - t0).toFixed(3);
    globalThis.__holeProbeRunId = parked.runId;

    if (parked.status !== "parked") {
      return {
        feasible: false,
        reason: `expected status 'parked', got '${parked.status}'` + (parked.error ? ` (${parked.error})` : ""),
        parkWallMs,
        events: parkEvents.map((e) => e.type),
      };
    }

    const fillEvents = [];
    const t1 = nowMs();
    const filled = await fillHoleAndRun({
      runId: parked.runId,
      holeName: parked.parkedAt?.name ?? "verdict-hole",
      body: 'return "verdict-42";',
      dbPath,
      maxConcurrency: 4,
      runTimeoutMs: 120000,
      onEvent: (e) => fillEvents.push({ type: e.type, data: e.data ?? {} }),
    });
    const fillWallMs = +(nowMs() - t1).toFixed(3);
    globalThis.__holeProbeForkId = filled.run?.runId;

    providerRegistry.setDefault(previousDefault);
    return {
      feasible: true,
      park: {
        status: parked.status,
        runId: parked.runId,
        parkedAt: parked.parkedAt,
        holeOpenEvents: parkEvents.filter((e) => e.type === "dwf_hole_open").length,
        wallMs: parkWallMs,
      },
      fill: {
        status: filled.status,
        forkedRunId: filled.run?.runId,
        value: filled.run?.value,
        refused: filled.status === "refused" ? filled.error : undefined,
        amendHitEvents: fillEvents.filter((e) => e.type === "dwf_amend_hit").length,
        holeValue: fillEvents.find((e) => e.type === "dwf_log" && String(e.data.message ?? "").includes("hole value"))?.data?.message,
        wallMs: fillWallMs,
        effectiveScriptPath: filled.effectiveScriptPath,
      },
      note: "Our fill is NOT an engine-level payload swap (official fillHole): hole() parks in-process (dwf_hole_open) and `workflow fill` splices the body into the script, forks an amend run (new runId, lineage to the parked run) whose unchanged nodes replay from the journal at zero cost (dwf_amend_hit). Probed through the real runner pipeline with the scripted offline provider.",
    };
  } catch (err) {
    return { feasible: false, reason: `hole probe threw: ${(err && err.message) || String(err)}` };
  } finally {
    if (workspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* Windows handle lag — best-effort cleanup */
      }
    }
    // The runner writes run artifacts under <process.cwd()>/.workflow/runs/
    // even when the journal dbPath lives in the temp workspace — remove the
    // dirs THIS probe minted (artifact cleanup discipline).
    try {
      const runsDir = join(WT, ".workflow", "runs");
      for (const id of [globalThis.__holeProbeRunId, globalThis.__holeProbeForkId]) {
        if (typeof id === "string" && id.startsWith("dwfrun-")) rmSync(join(runsDir, id), { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// cross-engine structural compare (needs the official JSON on disk)
// ---------------------------------------------------------------------------
// Raw site ids differ by numbering scheme (official numbers asks only; ours
// numbers every facade call), so each side's ids are normalized INDEPENDENTLY
// to first-appearance order (A1..An) before comparing.
function buildSiteMap(seq) {
  const map = new Map();
  let n = 0;
  for (const k of seq) {
    // site ids may themselves contain '#' (official "ask#1") — anchor on the
    // LAST [@#] separator before the trailing occurrence digits.
    const m = /^ask:(.+)[@#](\d+)$/.exec(k);
    if (m && !map.has(m[1])) map.set(m[1], `A${++n}`);
  }
  return map;
}
function normalizeSequence(seq, siteMap) {
  return seq.map((k) => {
    const m = /^ask:(.+)[@#](\d+)$/.exec(k);
    if (!m) return k;
    return `ask:${siteMap.get(m[1]) ?? m[1]}@${m[2]}`;
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let peakHeapUsed = 0;
const c0 = nowMs();
const lowerProbe = lowerFacadeScript(src);
const coldCompileMs = nowMs() - c0;
const warmCompile = [];
for (let i = 0; i < 5; i++) {
  const t = nowMs();
  lowerFacadeScript(src);
  warmCompile.push(+(nowMs() - t).toFixed(3));
}

const MAX_CONCURRENCY = 4;
const run1 = await runMission("cross-ours-run-1", MAX_CONCURRENCY);
const run2 = await runMission("cross-ours-run-2", MAX_CONCURRENCY);

const determinism = {
  settleSequenceIdentical: JSON.stringify(run1.settleSequence) === JSON.stringify(run2.settleSequence),
  eventTypeSequenceIdentical: JSON.stringify(run1.eventTypeSequence) === JSON.stringify(run2.eventTypeSequence),
  artifactIdentical: JSON.stringify(run1.artifact) === JSON.stringify(run2.artifact),
  artifactMatchesExpectedTable: run1.artifactMatchesExpected && run2.artifactMatchesExpected,
};

const repair = await repairProbe();
const hole = await holeProbe();

// Cross-compare with the official track.
let crossCompare = { available: false, reason: "official results JSON not found (run run-cross-official.mjs first)" };
try {
  const official = JSON.parse(readFileSync(OFFICIAL_JSON, "utf8"));
  const offNorm = normalizeSequence(official.runs[0].settleSequence, buildSiteMap(official.runs[0].settleSequence));
  const oursNorm = normalizeSequence(run1.settleSequence, buildSiteMap(run1.settleSequence));
  crossCompare = {
    available: true,
    settleSequenceStructurallyEqual: JSON.stringify(offNorm) === JSON.stringify(oursNorm),
    normalizedOfficialSettle: offNorm,
    normalizedOursSettle: oursNorm,
    officialSettleCount: official.runs[0].settleSequence.length,
    oursSettleCount: run1.settleSequence.length,
    wallMs: { officialRun1: official.runs[0].wallMs, oursRun1: run1.wallMs },
    healRounds: { official: "engine repairRounds=" + official.repairNudge.repair.repairRounds + " (driver submits), script-level healRounds=" + (official.runs[0].artifact?.healRounds ?? "?"), ours: "provider repairRounds=" + repair.repairRounds + " (rpc repair loop), script-level healRounds=" + (run1.artifact?.healRounds ?? "?") },
    providerCalls: { official: "driver-modeled (no provider)", oursRun1: run1.providerCalls },
    heapUsedPeakMB: { official: official.memory.heapUsedPeakMB, ours: +(peakHeapUsed / 1048576).toFixed(2) },
    coldCompileMs: { official: official.compile.coldCompileMs, ours: +coldCompileMs.toFixed(3) },
    note: "Site ids differ by numbering scheme (official numbers asks only; ours numbers every facade call) — sequences are normalized to first-appearance order A1..An/R1..Rn before compare.",
  };
} catch {
  /* official JSON absent — keep the honest unavailable marker */
}

const out = {
  benchmark: "cross-engine-deliverable-4",
  track: "ours",
  engine: "AI-workflow src/dwf FacadeEngine (WT/dist build)",
  wtRoot: WT,
  node: process.version,
  mission: "cross-benchmark-mission.facade.ts (same file as the official track)",
  facadeSurfaceUsed: ["agent(name)", ".ask (untyped)", "phase(literal)", "report(item)", "log(text)"],
  compile: {
    coldCompileMs: +coldCompileMs.toFixed(3),
    warmCompileMeanMs: +(warmCompile.reduce((a, b) => a + b, 0) / warmCompile.length).toFixed(3),
    loweredAskSiteIds: getMissionLower().analysis.sites.filter((s) => s.kind === "ask").map((s) => s.siteId),
    loweredSiteCount: getMissionLower().analysis.sites.length,
  },
  maxConcurrency: MAX_CONCURRENCY,
  runs: [run1, run2],
  determinism,
  repairNudge: {
    repair,
    nudge: {
      mechanism: "none on this side",
      status: "N/A",
      note: "Our engine has no turn-ended/nudge boundary: an untyped ask settles on the provider's final text (dwf_ask_complete) and a typed ask repairs on validation failure inside rpc.ts. The official turn-ended-without-submit nudge (NUDGE_ATTEMPTS) has no corresponding mechanism here.",
    },
  },
  hole,
  memory: {
    heapUsedPeakBytes: peakHeapUsed,
    heapUsedPeakMB: +(peakHeapUsed / 1048576).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(2),
    sampling: "process.memoryUsage().heapUsed every 5ms during both mission runs",
  },
  crossCompare,
  fakeModel: {
    kind: "ScriptedProvider (LLMProvider via providerRegistry) — generate() answers from the shared behavior table",
    model: SCRIPTED_MODEL,
    networkCalls: 0,
    apiKeysUsed: false,
    latencyTableMs: SCRIPTED_LATENCY_MS,
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`ours track written: ${OUT_PATH}`);
console.log(
  JSON.stringify(
    {
      coldCompileMs: out.compile.coldCompileMs,
      run1WallMs: run1.wallMs,
      run2WallMs: run2.wallMs,
      eventsRun1: run1.eventsEmitted,
      settleDeterministic: determinism.settleSequenceIdentical,
      eventSeqDeterministic: determinism.eventTypeSequenceIdentical,
      artifactMatchesExpected: determinism.artifactMatchesExpectedTable,
      repairRounds: repair.repairRounds,
      repairOutcomeOk: repair.outcome?.ok === true,
      holeFeasible: hole.feasible,
      holeFillStatus: hole.feasible ? hole.fill?.status : hole.reason,
      crossSettleEqual: crossCompare.available ? crossCompare.settleSequenceStructurallyEqual : null,
      heapUsedPeakMB: out.memory.heapUsedPeakMB,
    },
    null,
    1,
  ),
);
