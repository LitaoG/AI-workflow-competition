// ============================================================================
// Incident Triage & Remediation — facade-script edition (P0-4)
//
// The same 5-phase "Code, not conversation" flow as workflow.ts, authored as a
// dwf facade script: control flow is native TypeScript, every side effect goes
// through the facade (files / world.run / agent().ask<T>()), and every node is
// journalled for zero-provider-call resume.
//
// Run it offline (mock provider is the registry default, <4s, 0 tokens):
//   node bin/workflow.js run-script apps/incident-triage-remediation/facade.workflow.ts \
//     --cwd apps/incident-triage-remediation --args '{"scenario":"p1_db_pool_exhaustion"}'
// Replay the completed run at zero cost:
//   node bin/workflow.js run-script apps/incident-triage-remediation/facade.workflow.ts \
//     --cwd apps/incident-triage-remediation --args '{"scenario":"p1_db_pool_exhaustion"}' --resume <runId>
//
// Mock-mode substitutions (documented, deterministic):
// - Phase 1 telemetry comes from files.read of a scenario fixture instead of a
//   live metrics endpoint.
// - Phase 4's post-remediation healthz gate is simulated by a `node -e` exit-0
//   check instead of a real service healthz probe.
// ============================================================================

interface Telemetry {
  serviceName: string;
  healthCheckStatus: string;
  http5xxRatePercent: number;
  p99LatencyMs: number;
  activeDbConnections: number;
  maxDbConnections: number;
  recentLogErrors: string[];
}

interface TriageAssessment {
  /** PagerDuty-style incident id from the mock provider. */
  incidentId: string;
  severity: 'P1' | 'P2' | 'P3';
  failureDomain: string;
  suspectedCommit: string;
  /** One sentence root cause. */
  rootCause: string;
  recommendedAction: string;
  /** 0..1 triage confidence. */
  confidence: number;
}

interface SafetyReview {
  isApproved: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  safetyViolations: string[];
  rollbackCommand: string;
  signedOffBy: string;
}

interface PostMortemAck {
  status: string;
  message: string;
  timestamp: string;
}

const scenarioName = (args.scenario as string | undefined) ?? 'p1_db_pool_exhaustion';

// ---------------------------------------------------------------------------
// Phase 1 — Detection & Telemetry Probing (deterministic world reads only)
// ---------------------------------------------------------------------------
phase('Detection & Telemetry Probing');
// Self-locating: works whether the workspace root is the repo or this demo dir.
const scenarioHits = await files.glob(`**/scenarios/${scenarioName}.json`);
if (scenarioHits.length === 0) {
  throw new Error(`scenario fixture not found: scenarios/${scenarioName}.json (expected in apps/incident-triage-remediation/scenarios/)`);
}
const scenarioText = await files.read(scenarioHits[0]!);
const scenario = JSON.parse(scenarioText) as {
  name: string;
  severity: string;
  telemetry: Telemetry;
};
const telemetry = scenario.telemetry;

const tripped =
  telemetry.healthCheckStatus !== 'HEALTHY' ||
  telemetry.http5xxRatePercent >= 5.0 ||
  (telemetry.maxDbConnections > 0 && telemetry.activeDbConnections >= telemetry.maxDbConnections);

if (!tripped) {
  log(`Telemetry probe: ${telemetry.serviceName} is HEALTHY — no incident to triage.`);
  return { tripped: false, serviceName: telemetry.serviceName };
}
log(
  `Incident tripped: 5xx=${telemetry.http5xxRatePercent}%, DB pool=${telemetry.activeDbConnections}/${telemetry.maxDbConnections}, p99=${telemetry.p99LatencyMs}ms`,
);
report({ step: 'probe', serviceName: telemetry.serviceName, severity: scenario.severity });

// ---------------------------------------------------------------------------
// Phase 2 — Triage & Root Cause Analysis (single typed inspector ask)
// ---------------------------------------------------------------------------
phase('Triage & Root Cause Analysis');
const inspector = agent('inspector');
const triage = await inspector.ask<TriageAssessment>(
  `Triage this incident. Telemetry: ${JSON.stringify({
    service: telemetry.serviceName,
    health: telemetry.healthCheckStatus,
    http5xxRatePercent: telemetry.http5xxRatePercent,
    dbPool: `${telemetry.activeDbConnections}/${telemetry.maxDbConnections}`,
    recentLogErrors: telemetry.recentLogErrors,
  })}`,
);
log(`Triage: ${triage.incidentId} [${triage.severity}] ${triage.failureDomain} — suspect ${triage.suspectedCommit}`);
report({ step: 'triage', incidentId: triage.incidentId, confidence: triage.confidence });

// ---------------------------------------------------------------------------
// Phase 3 — Remediation Synthesis & Safety Pair Review (planner → reviewer)
// ---------------------------------------------------------------------------
phase('Remediation Synthesis & Safety Pair Review');
const planner = agent('planner');
const plan = await planner.ask(
  `Draft a remediation plan for this incident: ${JSON.stringify(triage)}`,
);
log('Remediation plan drafted; routing to safety reviewer.');

const reviewer = agent('safety-reviewer');
const safety = await reviewer.ask<SafetyReview>(
  `Safety review this remediation plan (blast radius, rollback, data safety): ${JSON.stringify(plan)}`,
);
if (!safety.isApproved) {
  throw new Error(`Safety review rejected the plan (${safety.riskLevel}): ${safety.safetyViolations.join('; ')}`);
}
log(`Safety review approved by ${safety.signedOffBy} (risk ${safety.riskLevel}).`);
report({ step: 'safety-review', riskLevel: safety.riskLevel, rollback: safety.rollbackCommand });

// ---------------------------------------------------------------------------
// Phase 4 — Execution & Verification Gate (deterministic shell gates)
// ---------------------------------------------------------------------------
phase('Execution & Verification Gate');
// Toolchain gate: the runtime is present before we call the fix applied.
const toolchainGate = await world.run('node', ['--version'], { timeoutMs: 30_000 });
if (toolchainGate.exitCode !== 0) {
  throw new Error(`Toolchain gate failed: ${toolchainGate.stderr}`);
}
// Post-remediation healthz gate (mock-mode substitution for a live probe).
const healthzGate = await world.run('node', ['-e', 'process.exit(0)'], { timeoutMs: 30_000 });
if (healthzGate.exitCode !== 0) {
  throw new Error(`Post-remediation healthz gate failed: ${healthzGate.stderr}`);
}
log('Gates passed: toolchain + post-remediation healthz (exit 0).');
report({ step: 'gates', toolchain: toolchainGate.exitCode, healthz: healthzGate.exitCode });

// ---------------------------------------------------------------------------
// Phase 5 — Post-Mortem Synthesis & Dashboard Export
// ---------------------------------------------------------------------------
phase('Post-Mortem Synthesis & Dashboard Export');
const coordinator = agent('coordinator');
const postMortem = await coordinator.ask<PostMortemAck>(
  `File the post-mortem record for ${triage.incidentId}: ${JSON.stringify({
    rootCause: triage.rootCause,
    action: triage.recommendedAction,
    rollback: safety.rollbackCommand,
    gates: 'passed',
  })}`,
);

const markdown = [
  `# Post-Mortem: ${triage.incidentId}`,
  '',
  `- **Scenario**: ${scenario.name} (${scenarioName})`,
  `- **Severity**: ${triage.severity} — domain ${triage.failureDomain}`,
  `- **Root cause**: ${triage.rootCause}`,
  `- **Suspect commit**: ${triage.suspectedCommit}`,
  `- **Remediation**: ${triage.recommendedAction}`,
  `- **Rollback**: \`${safety.rollbackCommand}\``,
  `- **Safety sign-off**: ${safety.signedOffBy} (risk ${safety.riskLevel})`,
  `- **Gates**: toolchain ✔ healthz ✔`,
  `- **Record**: ${postMortem.status} — ${postMortem.message}`,
].join('\n');
await artifact.markdown('postmortem', markdown, { title: `Post-Mortem ${triage.incidentId}` });

return {
  tripped: true,
  incidentId: triage.incidentId,
  severity: triage.severity,
  rootCause: triage.rootCause,
  safetyRisk: safety.riskLevel,
  gates: 'passed',
  record: postMortem.status,
};
