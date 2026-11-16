// MISSION-B Phase-2 telemetry probe (Deliverable 4 tool, part 1/2).
// Drives the OFFICIAL ZCode dynamic-workflow package in-process and prints
// structured JSON measurements to stdout. No repo files are modified.
//
// Usage:
//   node tests/cross-engine/official-telemetry-probe.mjs [officialPkgRoot]
//   (default pkg root: OFFICIAL_DWF env var, or the research checkout path)
//
// Probes:
//   A. engine-run   — planner -> 4-way researcher fanout -> verifier via the real
//                     WorkflowEngine + InMemoryJournalStore; captures every emit()
//                     event with hrtime timestamps and the full journal tail.
//   B. aimd         — ConcurrencyController grow/shrink/recovery curve under a
//                     scripted 429-with-Retry-After burst (pure API, virtual clock).
//   C. compile      — cold + warm compileWorkflowScript / lowerWorkflowScript cost
//                     on the official tests/workflows fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pkgRoot =
  process.argv[2] ??
  process.env.OFFICIAL_DWF ??
  (() => {
    throw new Error("OFFICIAL_DWF is not set: point it at the official ZCode checkout containing apps/zcode-cli/packages/dynamic-workflow (see tests/cross-engine/README.md)");
  })();

const dwf = await import(pathToFileURL(join(pkgRoot, "dist", "index.js")).href);

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

// ---------------------------------------------------------------------------
// Probe A: real engine run — planner -> fanout(4) -> verifier -> report/complete
// ---------------------------------------------------------------------------
async function probeEngineRun() {
  const journal = new dwf.InMemoryJournalStore();
  const emitted = [];
  let engine;
  let disposed = false;
  // Per-site simulated model latency (ms): planner 12, researchers staggered,
  // verifier 10. Cross-actor parallelism is the thing under observation.
  const latency = { "ask#1": 12, "ask#2": 40, "ask#3": 25, "ask#4": 33, "ask#5": 18, "ask#6": 10 };

  const driver = {
    journal,
    sessions: 0,
    async createActorSession(actor) {
      this.sessions += 1;
      return { id: `sess-${this.sessions}`, actor };
    },
    startAsk(_session, instance, _message) {
      const wait = latency[instance.siteId] ?? 20;
      setTimeout(() => {
        engine.askStats(instance, { tokens: 120, toolCalls: 0, turns: 1 });
        engine.askTurnEnded(instance, `result:${instance.siteId}@${instance.ordinal}`);
      }, wait);
    },
    respondToSubmit() {},
    cancelAsk() {},
    async executeWorldRead(op, args) {
      return { op, argc: args.length };
    },
    emit(event) {
      emitted.push({
        t: nowMs(),
        type: event.type,
        site: event.instance?.siteId ?? undefined,
        actor: event.actorName ?? undefined,
        phase: event.phaseName ?? undefined,
        outcome: event.outcome ?? undefined,
      });
    },
    dispose() {
      disposed = true;
    },
  };

  const askSpecs = new Map(
    ["ask#1", "ask#2", "ask#3", "ask#4", "ask#5", "ask#6"].map((id) => [id, { typed: false }]),
  );

  engine = new dwf.WorkflowEngine({
    runId: "telemetry-run",
    driver,
    caps: { maxConcurrency: 4 },
    askSpecs,
  });

  const t0 = nowMs();
  const planner = engine.createActor("actor#1", "planner");
  const researchers = [2, 3, 4, 5].map((n) => engine.createActor(`actor#${n}`, `researcher-${n}`));
  const verifier = engine.createActor("actor#6", "verifier");

  engine.enterPhase("plan");
  const plan = await engine.ask("ask#1", planner, "produce the plan");

  engine.enterPhase("research");
  const findings = await Promise.all(
    researchers.map((r, i) => engine.ask(`ask#${i + 2}`, r, `research ${plan}`)),
  );

  engine.enterPhase("verify");
  const verdict = await engine.ask("ask#6", verifier, `verify ${findings.length} findings`);

  engine.report("report#1", { verdict, findings: findings.length });
  engine.complete({ verdict });

  const settled = await engine.settled;
  const wall = nowMs() - t0;

  // Per-instance latency decomposition from the emit stream.
  const bySite = new Map();
  for (const e of emitted) {
    if (!e.site) continue;
    const row = bySite.get(e.site) ?? {};
    if (e.type === "node-queued") row.queuedAt = e.t;
    if (e.type === "node-dispatched") row.dispatchedAt = e.t;
    if (e.type === "node-settled") row.settledAt = e.t;
    bySite.set(e.site, row);
  }
  const instances = [...bySite.entries()].map(([site, r]) => ({
    site,
    queueWaitMs: r.dispatchedAt && r.queuedAt ? +(r.dispatchedAt - r.queuedAt).toFixed(3) : null,
    occupancyMs: r.settledAt && r.dispatchedAt ? +(r.settledAt - r.dispatchedAt).toFixed(3) : null,
    totalMs: r.settledAt && r.queuedAt ? +(r.settledAt - r.queuedAt).toFixed(3) : null,
  }));

  const runStartedAt = emitted.find((e) => e.type === "run-started")?.t ?? t0;
  // Issue #89 fix: listEvents' limit option is a numeric truncation cap, not the
  // read-face "all" marker — passing "all" produced slice(0, NaN) = empty page.
  const journalEvents = journal
    .listEvents("telemetry-run", { types: "all", reportItems: { limit: 0 }, limit: 10_000 })
    .map((s) => s.event.type);

  return {
    scenario: "planner -> fanout(4, maxConcurrency=4) -> verifier -> report -> complete",
    wallMs: +wall.toFixed(3),
    eventsEmitted: emitted.length,
    eventCounts: emitted.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {}),
    journalEventSequence: journalEvents,
    phasesEntered: emitted.filter((e) => e.type === "phase-entered").map((e) => e.phase),
    instanceTimings: instances,
    firstAskAfterRunStartMs: +(
      (emitted.find((e) => e.type === "node-dispatched")?.t ?? t0) - runStartedAt
    ).toFixed(3),
    driverSessions: driver.sessions,
    disposedOnSettle: disposed,
    settlement: { status: settled.status, result: settled.result },
  };
}

// ---------------------------------------------------------------------------
// Probe B: AIMD curve on the real ConcurrencyController (virtual clock).
// ---------------------------------------------------------------------------
function probeAimd() {
  const c = new dwf.ConcurrencyController("prov/model", 8, 32);
  const log = [];
  const sig = (label, changes) => {
    log.push({ step: label, cap: c.snapshot().cap, changes });
  };
  let now = 0;
  let epoch = 0;

  // Growth: 24 admitted requests that all succeed.
  for (let i = 0; i < 24; i++) {
    if (!c.canAdmit(now)) now += 5; // virtual time; nobody is cooling down here
    c.observe(now);
    const changes = c.succeeded(now, epoch);
    if (changes.length) sig(`success#${i + 1}`, changes.map((x) => x.reason));
  }

  // 429 burst WITH Retry-After: three throttled completions of current-epoch
  // requests, mirroring a provider overload window.
  const shrink = [];
  for (let i = 0; i < 3; i++) {
    c.observe(now);
    const changes = c.throttled(now, epoch, "rate_limited", 1200);
    now += 1;
    shrink.push({ cap: c.snapshot().cap, changes: changes.map((x) => ({ reason: x.reason, cooldownMs: x.cooldownMs })) });
  }
  sig("after-429-burst", shrink.flatMap((s) => s.changes.map((x) => x.reason)));
  const cooldownActiveDuring = c.canAdmit(now); // still inside Retry-After window

  // Recovery: cooldown elapses, then a success streak rebuilds the cap.
  now += 1300;
  epoch += 1; // requests admitted after the burst carry the new epoch
  const recovery = [];
  for (let i = 0; i < 20; i++) {
    c.observe(now);
    const changes = c.succeeded(now, epoch);
    now += 5;
    recovery.push(c.snapshot().cap);
    if (changes.length) sig(`recover-success#${i + 1}`, changes.map((x) => x.reason));
  }

  return {
    controller: "prov/model initial=8 growthLimit=32",
    params: {
      decreaseFactor: dwf.CONCURRENCY_DECREASE_FACTOR,
      increaseStep: dwf.CONCURRENCY_INCREASE_STEP,
      increaseAfterSuccesses: dwf.CONCURRENCY_INCREASE_AFTER_SUCCESSES,
      floor: dwf.CONCURRENCY_FLOOR,
      idleResetMs: dwf.CONCURRENCY_IDLE_RESET_MS,
    },
    capAfter24Successes: recovery.length ? undefined : undefined, // filled via log below
    growCaps: log.filter((l) => l.step.startsWith("success#")).map((l) => l.cap),
    shrinkCurve: shrink.map((s) => s.cap),
    cooldownBlockedAdmissionDuringWindow: cooldownActiveDuring === false,
    recoveryCaps: [...new Set(recovery)],
    finalSnapshot: c.snapshot(),
  };
}

// ---------------------------------------------------------------------------
// Probe C: compile + lowering cost on the official workflow fixtures.
// ---------------------------------------------------------------------------
function probeCompile() {
  const fixturesDir = join(pkgRoot, "tests", "workflows");
  const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".ts")).sort();
  const rows = [];
  const p95 = (xs) => xs.slice(Math.floor(xs.length * 0.95) - 1, Math.floor(xs.length * 0.95))[0] ?? xs.at(-1);

  for (const f of fixtures) {
    const source = readFileSync(join(fixturesDir, f), "utf8");
    // Cold pass (full TS program + virtual host).
    const c0 = nowMs();
    const cold = dwf.compileWorkflowScript(source);
    const coldMs = nowMs() - c0;
    // Warm passes.
    const warm = [];
    let ok = cold.ok;
    for (let i = 0; i < 10; i++) {
      const t = nowMs();
      const r = dwf.compileWorkflowScript(source);
      warm.push(nowMs() - t);
      ok = ok && r.ok;
    }
    warm.sort((a, b) => a - b);
    // Lowering on clean scripts only (dirty scripts must not lower).
    let lowerMs = null;
    if (cold.ok) {
      const t = nowMs();
      const lowered = dwf.lowerWorkflowScript(source);
      lowerMs = +(nowMs() - t).toFixed(3);
      if (lowered === undefined) lowerMs = null;
    }
    rows.push({
      fixture: f,
      diagnostics: cold.diagnostics?.length ?? 0,
      coldMs: +coldMs.toFixed(3),
      warmMeanMs: +(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(3),
      warmP95Ms: +p95(warm).toFixed(3),
      lowerMs,
    });
  }
  return { iterations: 10, fixtures: rows };
}

// ---------------------------------------------------------------------------
// Probe D (issue #89): schema synthesis + runtime validation cost.
// B.md §4.3 asks for the cost of "TS generic extraction → runtime JSON validation":
// phase 1 = synthesizeWorkflowSchemas on a typed-ask script (extraction);
// phase 2 = validate() per call on a compliant and a violating payload.
// ---------------------------------------------------------------------------
function probeSchemaCost() {
  // A typed-ask script with a realistic nested payload (object/array/union/optional)
  // mirroring the cross-benchmark verifier's shape family.
  const script = `
async function main() {
  const planner = agent("planner");
  const reviewer = agent("reviewer");
  const plan = await planner.ask<{ steps: string[]; risk: "low" | "medium" | "high"; meta?: { owner: string } }>("plan");
  const verdict = await reviewer.ask<{ pass: boolean; findings: Array<{ path: string; line: number; severity: string }>; note?: string }>("review " + JSON.stringify(plan));
  report(verdict);
  return verdict;
}
main();
`;
  const heap = () => process.memoryUsage().heapUsed;

  // Phase 1: extraction (synth from TS generics). Cold + 20 warm passes.
  const extractWarm = [];
  let extraction = undefined;
  const h0 = heap();
  const tCold0 = nowMs();
  extraction = dwf.synthesizeWorkflowSchemas(script);
  const extractColdMs = nowMs() - tCold0;
  for (let i = 0; i < 20; i++) {
    const t = nowMs();
    dwf.synthesizeWorkflowSchemas(script);
    extractWarm.push(nowMs() - t);
  }
  extractWarm.sort((a, b) => a - b);
  const extractHeapDeltaMb = +((heap() - h0) / 1048576).toFixed(3);

  const schemas = extraction?.schemas ?? {};
  const schemaEntries = Object.entries(schemas);
  if (schemaEntries.length === 0) {
    return { error: "no schemas synthesized — script shape mismatch", extraction: extraction && Object.keys(extraction) };
  }

  // The verifier-shaped schema (second ask): nested object with array + union.
  const [, verifierSchema] = schemaEntries[schemaEntries.length - 1];
  const compliant = {
    pass: true,
    findings: [
      { path: "src/a.ts", line: 12, severity: "high" },
      { path: "src/b.ts", line: 3, severity: "low" },
    ],
    note: "ok",
  };
  const violating = { pass: "yes", findings: [{ path: 1, line: "x" }] };

  const benchValidate = (schema, value, iterations) => {
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const t = nowMs();
      dwf.validate(schema, value);
      samples.push((nowMs() - t) * 1000); // µs
    }
    samples.sort((a, b) => a - b);
    return {
      meanUs: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2),
      p95Us: +samples[Math.floor(samples.length * 0.95) - 1].toFixed(2),
      maxUs: +samples[samples.length - 1].toFixed(2),
    };
  };
  const ITER = 500;
  const h1 = heap();
  const okCost = benchValidate(verifierSchema, compliant, ITER);
  const bad = benchValidate(verifierSchema, violating, ITER);
  const validateHeapDeltaMb = +((heap() - h1) / 1048576).toFixed(3);

  return {
    scriptAsks: schemaEntries.length,
    extractionColdMs: +extractColdMs.toFixed(3),
    extractionWarmMeanMs: +(extractWarm.reduce((a, b) => a + b, 0) / extractWarm.length).toFixed(3),
    extractionWarmP95Ms: +extractWarm[Math.floor(extractWarm.length * 0.95) - 1].toFixed(3),
    extractionHeapDeltaMb: extractHeapDeltaMb,
    validate: {
      iterations: ITER,
      schemaBytes: JSON.stringify(verifierSchema).length,
      compliant: okCost,
      violating: bad,
      violationsEmitted: dwf.validate(verifierSchema, violating).length,
      heapDeltaMb: validateHeapDeltaMb,
    },
  };
}

// ---------------------------------------------------------------------------
const out = {
  probe: "official-telemetry",
  node: process.version,
  pkgRoot,
  engine: await probeEngineRun(),
  aimd: probeAimd(),
  compile: probeCompile(),
  schema: probeSchemaCost(),
};
console.log(JSON.stringify(out, null, 2));
