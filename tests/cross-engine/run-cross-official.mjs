#!/usr/bin/env node
/**
 * Cross-engine benchmark (deliverable 4) — OFFICIAL track.
 *
 * Runs the shared mission (cross-benchmark-mission.facade.ts) on the OFFICIAL
 * ZCode dynamic-workflow package fully in-process, with a scripted fake model
 * (no API key, no network): a WorkflowDriver whose startAsk() plays the model
 * exactly like the official tests' FakeDriver does.
 *
 * Pipeline per run: compileWorkflowScript -> analyze/lower -> WorkflowEngine
 * with the lowered code executed via new Function("__host", ...) — the lowered
 * body's only free identifier (HOST_BINDING).
 *
 * Probes:
 *   A. mission x2     — planner -> 4-way researcher fanout -> verifier
 *                       (script-level malformed-JSON self-heal) -> report/complete.
 *                       Run twice; settle sequences must match (determinism).
 *   B. repair/nudge   — ENGINE-level typed-ask self-heal: scripted model submits
 *                       bad JSON twice then a legal payload; counts node-repairing
 *                       rounds, then the turn-ended nudge path (node-nudged).
 *   C. hole park/fill — engine.hole() parks; fillHole() with a full HoleFill
 *                       payload (constructed from the compile artifacts) releases
 *                       the parked promise synchronously.
 *
 * Output: results/official-cross-benchmark.json (+ stdout summary).
 * Usage: node tests/cross-engine/run-cross-official.mjs [officialPkgRoot]
 *   (default: OFFICIAL_DWF env var, or the research checkout path)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MISSION_PATH = join(HERE, "cross-benchmark-mission.facade.ts");
const OUT_PATH = join(HERE, "results", "official-cross-benchmark.json");

const pkgRoot =
  process.argv[2] ??
  process.env.OFFICIAL_DWF ??
  (() => {
    throw new Error("OFFICIAL_DWF is not set: point it at the official ZCode checkout containing apps/zcode-cli/packages/dynamic-workflow (see tests/cross-engine/README.md)");
  })();

const dwf = await import(pathToFileURL(join(pkgRoot, "dist", "index.js")).href);

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const src = readFileSync(MISSION_PATH, "utf8");

// Scripted fake model — the ONE shared behavior table (scripted-model.mjs),
// consumed identically by the ours-side runner. Deterministic pure function of
// (actor name, key=value markers in the instructions). No network, no API key.
const { scriptedReply, SCRIPTED_MODEL, expectedArtifact } = await import(
  pathToFileURL(join(HERE, "scripted-model.mjs")).href
);

// ---------------------------------------------------------------------------
// Scripted driver (Boundary B): the engine drives it; startAsk plays the model.
// ---------------------------------------------------------------------------
class ScriptedDriver {
  constructor(runId, opts = {}) {
    this.runId = runId;
    this.manual = opts.manual === true; // probe mode: the test plays the model by hand
    this.journal = new dwf.InMemoryJournalStore();
    this.engineRef = null;
    this.events = []; // {t, type, site, ordinal, kind, outcome, actor, phase}
    this.sessions = 0;
    this.submitVerdicts = []; // for the repair probe
    this.startAsks = [];
    this.disposed = 0;
  }
  async createActorSession(actor, persona) {
    this.sessions += 1;
    return { id: `session:${persona.name ?? actor.siteId}` };
  }
  startAsk(session, instance, message) {
    this.startAsks.push({ site: instance.siteId, ordinal: instance.ordinal, typed: message.typed });
    if (this.manual) return; // repair/nudge probe drives submits itself
    const actorName = session.id.startsWith("session:") ? session.id.slice("session:".length) : "unknown";
    const reply = scriptedReply({ actorName, instructions: message.instructions });
    setTimeout(() => {
      if (this.disposed) return;
      const eng = this.engineRef;
      eng.askStats(instance, { tokens: 120, toolCalls: 0, turns: 1 });
      eng.askTurnEnded(instance, reply.text);
    }, reply.latencyMs);
  }
  respondToSubmit(instance, verdict) {
    this.submitVerdicts.push({
      site: instance.siteId,
      ordinal: instance.ordinal,
      kind: verdict.kind,
      violations: verdict.kind === "reject" ? verdict.violations.length : undefined,
    });
  }
  cancelAsk() {}
  async executeWorldRead(op, args) {
    return { op, argc: args.length };
  }
  emit(event) {
    this.events.push({
      t: nowMs(),
      type: event.type,
      site: event.instance?.siteId,
      ordinal: event.instance?.ordinal,
      kind: event.kind,
      outcome: event.outcome,
      actor: event.actorName,
      phase: event.phaseName ?? (event.type === "phase-entered" ? event.name : undefined),
    });
  }
  dispose() {
    this.disposed += 1;
  }
}

function untypedSpecs(...ids) {
  return new Map(ids.map((id) => [id, { typed: false }]));
}

// The real pipeline: askSpecs / phases come from the SAME compilation as the
// lowering (site table + schema synthesis are one pass) — never hand-listed.
let missionSpecs = null;
function missionAskSpecs() {
  if (!missionSpecs) {
    const synthesis = dwf.synthesizeWorkflowSchemas(src);
    missionSpecs = dwf.buildAskSpecs(compiledSitesTable(), synthesis.schemas ?? {});
  }
  return missionSpecs;
}
let sitesTable = null;
function compiledSitesTable() {
  if (!sitesTable) {
    const prog = dwf.createWorkflowProgram(src);
    sitesTable = dwf.collectSites(prog);
  }
  return sitesTable;
}

function buildHost(engine) {
  return {
    createActor: (siteId, name, persona) => engine.createActor(siteId, name, persona),
    ask: (siteId, actor, instructions) => engine.ask(siteId, actor, instructions),
    report: (siteId, item, artifactId) => engine.report(siteId, item, artifactId),
    enterPhase: (name) => engine.enterPhase(name),
    log: (message) => engine.log(message),
  };
}

// ---------------------------------------------------------------------------
// A. mission runs
// ---------------------------------------------------------------------------
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
  const driver = new ScriptedDriver(runId);
  const engine = new dwf.WorkflowEngine({
    runId,
    driver,
    caps: { maxConcurrency },
    askSpecs: missionAskSpecs(),
    validate: dwf.validate,
    scriptText: src,
    scriptHash: `sha256:${runId}`,
  });
  driver.engineRef = engine;

  const heap = heapSampler();
  const t0 = nowMs();
  const artifact = await new Function(
    "__host",
    "return (async () => {\n" + compiled.lowered.code + "\n})()",
  )(buildHost(engine));
  // The host feeds the script's top-level return to the engine (Boundary A:
  // completed = script return), then the run settles.
  engine.complete(artifact);
  const settled = await engine.settled;
  const wall = nowMs() - t0;
  clearInterval(heap.timer);
  if (heap.peak > peakHeapUsed) peakHeapUsed = heap.peak;

  const settledRows = driver.events.filter((e) => e.type === "node-settled");
  const settleSequence = settledRows.map((e) => `${e.kind ?? "ask"}:${e.site}@${e.ordinal}`);
  const eventTypeSequence = driver.events.map((e) => e.type);

  // Per-instance latency decomposition (ask sites only, live runs).
  const bySite = new Map();
  for (const e of driver.events) {
    if (!e.site) continue;
    const key = `${e.site}@${e.ordinal}`;
    const row = bySite.get(key) ?? {};
    if (e.type === "node-queued") row.queuedAt = e.t;
    if (e.type === "node-dispatched") row.dispatchedAt = e.t;
    if (e.type === "node-settled") row.settledAt = e.t;
    bySite.set(key, row);
  }
  const instances = [...bySite.entries()].map(([key, r]) => ({
    instance: key,
    queueWaitMs: r.dispatchedAt !== undefined && r.queuedAt !== undefined ? +(r.dispatchedAt - r.queuedAt).toFixed(3) : null,
    occupancyMs: r.settledAt !== undefined && r.dispatchedAt !== undefined ? +(r.settledAt - r.dispatchedAt).toFixed(3) : null,
    totalMs: r.settledAt !== undefined && r.queuedAt !== undefined ? +(r.settledAt - r.queuedAt).toFixed(3) : null,
  }));

  // Issue #148: the caller used to pass a `limit: "all"` sentinel the official
  // journal API types as number|undefined — Math.max(0,"all")=NaN → slice(0,NaN)
  // = [] — so journalEventSequence compared two empty arrays and the determinism
  // signal was vacuously true. Omitting limit reads the full sequence (default).
  const journalEvents = driver.journal
    .listEvents(runId, { types: "all", reportItems: { limit: 0 } })
    .map((s) => s.event.type);

  return {
    runId,
    wallMs: +wall.toFixed(3),
    artifact,
    artifactMatchesExpected: JSON.stringify(artifact) === JSON.stringify(expectedArtifact()),
    settlement: { status: settled.status, artifact: settled.artifact },
    eventsEmitted: driver.events.length,
    eventCounts: driver.events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {}),
    eventTypeSequence,
    settleSequence,
    journalEventSequence: journalEvents,
    phasesEntered: driver.events.filter((e) => e.type === "phase-entered").map((e) => e.phase),
    driverSessions: driver.sessions,
    disposedCalls: driver.disposed,
    instanceTimings: instances,
    askSitesStarted: driver.startAsks.map((a) => `${a.site}@${a.ordinal}${a.typed ? ":typed" : ""}`),
  };
}

// ---------------------------------------------------------------------------
// B. repair / nudge probe (ENGINE-level typed-ask self-heal)
// ---------------------------------------------------------------------------
async function repairNudgeProbe() {
  const schema = {
    type: "object",
    properties: { pass: { type: "boolean" }, risk: { type: "string" } },
    required: ["pass", "risk"],
    additionalProperties: false,
  };
  const driver = new ScriptedDriver("cross-official-repair", { manual: true });
  const engine = new dwf.WorkflowEngine({
    runId: "cross-official-repair",
    driver,
    caps: { maxConcurrency: 4 },
    askSpecs: new Map([["ask#1", { typed: true, schema }]]),
    validate: dwf.validate,
    scriptText: "probe",
    scriptHash: "h0",
  });
  driver.engineRef = engine;

  const actor = engine.createActor("actor#1", "auditor");
  const t0 = nowMs();
  const p = engine.ask("ask#1", actor, "Return the audit verdict as JSON.");
  await new Promise((r) => setTimeout(r, 25));
  // Attempt 1: malformed shape (missing required fields) -> reject (repair 1).
  engine.askSubmitAttempted({ siteId: "ask#1", ordinal: 1 }, { wrong: 1 });
  await new Promise((r) => setTimeout(r, 25));
  // Attempt 2: parseable object, wrong type -> reject (repair 2).
  engine.askSubmitAttempted({ siteId: "ask#1", ordinal: 1 }, { pass: "no", risk: "low" });
  await new Promise((r) => setTimeout(r, 25));
  // Attempt 3: legal JSON -> accept.
  engine.askSubmitAttempted({ siteId: "ask#1", ordinal: 1 }, { pass: true, risk: "low" });
  const repaired = await p.then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, error: String(e?.code ?? e) }),
  );
  const repairWallMs = +(nowMs() - t0).toFixed(3);

  // Nudge path: a second instance whose turn ends WITHOUT a submit_result.
  const p2 = engine.ask("ask#1", actor, "Return the audit verdict as JSON (again).");
  await new Promise((r) => setTimeout(r, 25));
  engine.askTurnEnded({ siteId: "ask#1", ordinal: 2 }, "no submit this turn");
  await new Promise((r) => setTimeout(r, 10));
  engine.askSubmitAttempted({ siteId: "ask#1", ordinal: 2 }, { pass: true, risk: "low" });
  const nudged = await p2.then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, error: String(e?.code ?? e) }),
  );

  engine.complete("probe-done");
  await engine.settled;

  return {
    mechanism: "typed-ask submit_result validation (REPAIR_ATTEMPTS=3, NUDGE_ATTEMPTS=1)",
    schema,
    repair: {
      scriptedSubmitPayloads: [{ wrong: 1 }, { pass: "no", risk: "low" }, { pass: true, risk: "low" }],
      submitVerdicts: driver.submitVerdicts.filter((v) => v.ordinal === 1).map((v) => v.kind),
      nodeRepairingEvents: driver.events.filter((e) => e.type === "node-repairing").map((e) => e.instance?.ordinal ?? e.ordinal),
      repairRounds: driver.events.filter((e) => e.type === "node-repairing").length,
      outcome: repaired,
      wallMs: repairWallMs,
    },
    nudge: {
      turnEndedWithoutSubmit: true,
      submitVerdicts: driver.submitVerdicts.filter((v) => v.ordinal === 2).map((v) => v.kind),
      nodeNudgedEvents: driver.events.filter((e) => e.type === "node-nudged").length,
      outcome: nudged,
    },
  };
}

// ---------------------------------------------------------------------------
// C. hole park + fillHole (full HoleFill payload from compile artifacts)
// ---------------------------------------------------------------------------
async function holeProbe() {
  const driver = new ScriptedDriver("cross-official-hole");
  const engine = new dwf.WorkflowEngine({
    runId: "cross-official-hole",
    driver,
    caps: { maxConcurrency: 4 },
    askSpecs: untypedSpecs("ask#1"),
    validate: dwf.validate,
    scriptText: "original",
    scriptHash: "h0",
    now: () => 1000,
  });
  driver.engineRef = engine;

  const tPark = nowMs();
  const parkedPromise = engine.hole("hole#1", "Verdict", "Decide the verdict.");
  const openBefore = engine.openHoles();
  const holeReached = driver.events.filter((e) => e.type === "hole-reached").length;

  // Full HoleFill: code is the effective script's holeBodies[siteId] — a lowered
  // `(async () => {...})` body; specs/phases are the effective script's tables.
  const code = '(async () => { return "verdict-42"; })';
  const fill = engine.fillHole({
    siteId: "hole#1",
    code,
    script: { text: "effective", hash: "h1" },
    askSpecs: untypedSpecs("ask#1", "hole#1/ask#1"),
    sitePhases: new Map([["hole#1/ask#1", "Verdict"]]),
    phaseNames: ["Gather", "Verdict"],
    holes: [],
    filledBy: "session-main",
  });
  const released = await parkedPromise.then(
    (v) => ({ resolved: true, value: v }),
    (e) => ({ resolved: false, error: String(e) }),
  );
  const parkToFillMs = +(nowMs() - tPark).toFixed(3);

  engine.complete("hole-probe-done");
  await engine.settled;

  return {
    holeReachedEvents: holeReached,
    parked: released.resolved && released.value?.code === code,
    releasedValue: released.value ?? released.error,
    fillResult: fill,
    openHolesBefore: openBefore.map((h) => `${h.siteId}@${h.ordinal} ${h.name}`),
    openHolesAfter: engine.openHoles().map((h) => `${h.siteId}@${h.ordinal}`),
    filledHolesAfter: engine.filledHoles().map((h) => `${h.siteId}@${h.filledAt}`),
    holeEvents: driver.events.filter((e) => e.type.startsWith("hole-")).map((e) => e.type),
    parkToFillMs,
    note: "HoleFill payload constructed per engine-holes.ts: code = the effective script's lowering holeBodies[siteId]; specs/phases = the effective script's superset tables. The parked promise resolves with { code } in one synchronous fillHole step.",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let peakHeapUsed = 0;
const c0 = nowMs();
const compiled = dwf.lowerWorkflowScript(src);
const coldLowerMs = nowMs() - c0;
const coldCompile = dwf.compileWorkflowScript(src);
const coldCompileMs = nowMs() - c0 - coldLowerMs;
if (!coldCompile.ok || !compiled.ok) {
  console.error("mission failed to compile on the official compiler:", JSON.stringify(coldCompile.diagnostics ?? compiled.diagnostics));
  process.exit(1);
}
const warmCompile = [];
for (let i = 0; i < 5; i++) {
  const t = nowMs();
  dwf.compileWorkflowScript(src);
  warmCompile.push(+(nowMs() - t).toFixed(3));
}

const MAX_CONCURRENCY = 4;
const run1 = await runMission("cross-official-run-1", MAX_CONCURRENCY);
const run2 = await runMission("cross-official-run-2", MAX_CONCURRENCY);

const settleDeterministic = JSON.stringify(run1.settleSequence) === JSON.stringify(run2.settleSequence);
const eventSeqDeterministic = JSON.stringify(run1.eventTypeSequence) === JSON.stringify(run2.eventTypeSequence);
const journalDeterministic = JSON.stringify(run1.journalEventSequence) === JSON.stringify(run2.journalEventSequence);
const artifactDeterministic = JSON.stringify(run1.artifact) === JSON.stringify(run2.artifact);

const repair = await repairNudgeProbe();
const hole = await holeProbe();

const out = {
  benchmark: "cross-engine-deliverable-4",
  track: "official",
  engine: "ZCode apps/zcode-cli/packages/dynamic-workflow (dist)",
  pkgRoot,
  node: process.version,
  mission: "cross-benchmark-mission.facade.ts (planner -> 4-way fanout -> verifier self-heal -> report/complete; common-subset facade)",
  facadeSurfaceUsed: ["agent(name)", ".ask (untyped)", "phase(literal)", "report(item)", "log(text)"],
  compile: {
    coldCompileMs: +coldCompileMs.toFixed(3),
    coldLowerMs: +coldLowerMs.toFixed(3),
    warmCompileMeanMs: +(warmCompile.reduce((a, b) => a + b, 0) / warmCompile.length).toFixed(3),
    diagnostics: coldCompile.diagnostics?.length ?? 0,
    loweredSiteIds: compiled.lowered.siteIds,
    holeBodies: Object.keys(compiled.lowered.holeBodies ?? {}),
  },
  maxConcurrency: MAX_CONCURRENCY,
  runs: [run1, run2],
  determinism: {
    settleSequenceIdentical: settleDeterministic,
    eventTypeSequenceIdentical: eventSeqDeterministic,
    journalEventSequenceIdentical: journalDeterministic,
    artifactIdentical: artifactDeterministic,
    artifactMatchesExpectedTable: run1.artifactMatchesExpected && run2.artifactMatchesExpected,
  },
  repairNudge: repair,
  hole: hole,
  memory: {
    heapUsedPeakBytes: peakHeapUsed,
    heapUsedPeakMB: +(peakHeapUsed / 1048576).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(2),
    sampling: "process.memoryUsage().heapUsed every 5ms during both mission runs",
  },
  fakeModel: {
    kind: "ScriptedDriver (Boundary B WorkflowDriver) — startAsk() plays the model via engine.askStats + engine.askTurnEnded; shared behavior table scripted-model.mjs",
    model: SCRIPTED_MODEL,
    networkCalls: 0,
    apiKeysUsed: false,
    latencyTableMs: "scripted-model.mjs SCRIPTED_LATENCY_MS (per actor name)",
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
// Issue #148 companion: sanitize machine paths before the baseline lands in
// git — the README documents the $OFFICIAL_DWF / $AI_WORKFLOW_WORKSPACE
// placeholders; previously applying them was a manual pre-commit step.
const workspaceRoot = resolve(HERE, "..", "..", "..");
const jsonEsc = (s) => s.replaceAll("\\", "\\\\");
const sanitized =
  JSON.stringify(out, null, 2)
    .replaceAll(jsonEsc(pkgRoot), "$OFFICIAL_DWF")
    .replaceAll(pkgRoot.replaceAll("\\", "/"), "$OFFICIAL_DWF")
    .replaceAll(jsonEsc(workspaceRoot), "$AI_WORKFLOW_WORKSPACE")
    .replaceAll(workspaceRoot.replaceAll("\\", "/"), "$AI_WORKFLOW_WORKSPACE");
writeFileSync(OUT_PATH, sanitized);
console.log(`official track written: ${OUT_PATH}`);
console.log(
  JSON.stringify(
    {
      coldCompileMs: out.compile.coldCompileMs,
      run1WallMs: run1.wallMs,
      run2WallMs: run2.wallMs,
      eventsRun1: run1.eventsEmitted,
      settleDeterministic,
      eventSeqDeterministic,
      repairRounds: out.repairNudge.repair.repairRounds,
      nudges: out.repairNudge.nudge.nodeNudgedEvents,
      holeParkedAndFilled: out.hole.parked,
      heapUsedPeakMB: out.memory.heapUsedPeakMB,
      artifact: run1.artifact,
    },
    null,
    1,
  ),
);
