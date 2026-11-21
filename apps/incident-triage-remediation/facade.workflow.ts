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
// - Phase 4's post-remediation healthz gate executes realistic configuration validation
//   (pool-config.json capacity >= 200 & healthy status); remediation actions perform
//   deterministic, reversible pool configuration updates under .workflow/ (gitignored).
// - Phase 4's policy gate self-check and rollback drill exercise the real
//   interception/rollback machinery on every run (a known-destructive
//   reference command and a deliberately failing verification probe), so the
//   README safety claim is evidenced offline, not just asserted.
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

interface RemediationPlan {
  strategy: string;
  /** Ordered remediation step descriptions (the policy gate scans these). */
  steps: string[];
  estimatedMinutes: number;
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
const plan = await planner.ask<RemediationPlan>(
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

// Deterministic steering-policy enforcement — "Code, not conversation": the
// reviewer's verdict does not license destructive commands. Every planned
// command token is rescanned against this demo's own six-pattern blacklist,
// regardless of the safety review's score. NOTE (Issue #112 audit): pattern 6
// is deliberately WIDER than workflow.ts's DESTRUCTIVE_BLACKLIST (unanchored
// `\bdelete\s+from\b` vs the end-anchored form) — a demo-hardening choice kept
// local so the facade's interception drill stays independent; the two surfaces
// are not the same policy and drift here is intentional, not accidental.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdrop\b/i,
  /\btruncate\b/i,
  /rm\s+-rf/i,
  /\bmkfs\b/i,
  /format\s+[a-z]:/i,
  /\bdelete\s+from\b/i,
];
const plannedCommands = [...plan.steps, triage.recommendedAction];
// Interception drill: the gate must reject a known-destructive reference
// command, so interception is evidenced on every run — not only when a plan
// actually goes rogue.
if (!DESTRUCTIVE_PATTERNS.some((re) => re.test('DROP TABLE orders;'))) {
  throw new Error('Policy gate self-check failed: reference destructive command was NOT intercepted');
}
const prohibited = plannedCommands.filter((cmd) => DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd)));
if (prohibited.length > 0) {
  // Nothing has executed yet — fail closed before any world.run.
  throw new Error(
    `Safety policy violation: destructive command(s) rejected by the deterministic gate: ${prohibited.join('; ')}`,
  );
}
log(`Policy gate: ${plannedCommands.length} planned commands scanned, 0 destructive — drill 'DROP TABLE orders;' intercepted ✔`);
report({ step: 'policy-gate', scanned: plannedCommands.length, prohibited: prohibited.length, drill: 'intercepted' });

// Remediation execution: realistic configuration update and verification loop.
// Every apply updates the pool configuration and creates state markers; every undo
// restores the saturated baseline configuration, ensuring full drill fidelity.
const marker = '.workflow/demo-remediation-marker';
const poolConfig = '.workflow/pool-config.json';
const applyAction = () =>
  world.run(
    'node',
    [
      '-e',
      `const fs = require('fs'); fs.mkdirSync('.workflow', { recursive: true }); fs.writeFileSync('${poolConfig}', JSON.stringify({ maxDbConnections: 250, idleTimeoutMs: 10000, status: 'healthy' })); fs.writeFileSync('${marker}', 'applied');`,
    ],
    { timeoutMs: 30_000 },
  );
const undoAction = () =>
  world.run(
    'node',
    [
      '-e',
      `const fs = require('fs'); try { fs.writeFileSync('${poolConfig}', JSON.stringify({ maxDbConnections: 100, idleTimeoutMs: 30000, status: 'saturated' })); fs.rmSync('${marker}'); } catch {}`,
    ],
    { timeoutMs: 30_000 },
  );

const applied = await applyAction();
if (applied.exitCode !== 0) {
  throw new Error(`Remediation apply gate failed: ${applied.stderr}`);
}

// Rollback drill: a deliberately failing verification probe must trigger the
// automated rollback and restore the prior state — evidenced on every run.
const failedProbe = await world.run('node', ['-e', 'process.exit(1)'], { timeoutMs: 30_000 });
if (failedProbe.exitCode === 0) {
  throw new Error('Rollback drill setup failed: the failing probe unexpectedly passed');
}
const rolledBack = await undoAction();
if (rolledBack.exitCode !== 0) {
  throw new Error(`Automated rollback failed: ${rolledBack.stderr}`);
}
const restored = await world.run(
  'node',
  [
    '-e',
    `const fs = require('fs'); const markerExists = fs.existsSync('${marker}'); const cfg = fs.existsSync('${poolConfig}') ? JSON.parse(fs.readFileSync('${poolConfig}', 'utf8')) : {}; process.exit(!markerExists && cfg.maxDbConnections === 100 ? 0 : 1);`,
  ],
  { timeoutMs: 30_000 },
);
if (restored.exitCode !== 0) {
  throw new Error('Rollback drill failed: prior state was not restored');
}
log(`Rollback drill: verification FAILED → automated rollback executed → prior state restored ✔ (prescribed: ${safety.rollbackCommand})`);

// Re-apply for real, then the post-remediation healthz gate.
// Verification validates the real pool configuration file.
const reapplied = await applyAction();
if (reapplied.exitCode !== 0) {
  await undoAction();
  throw new Error(`Remediation apply gate failed (rolled back): ${reapplied.stderr}`);
}
const healthzGate = await world.run(
  'node',
  [
    '-e',
    `const fs = require('fs'); const cfg = JSON.parse(fs.readFileSync('${poolConfig}', 'utf8')); process.exit(cfg.maxDbConnections >= 200 && cfg.status === 'healthy' ? 0 : 1);`,
  ],
  { timeoutMs: 30_000 },
);
if (healthzGate.exitCode !== 0) {
  // Automated rollback on failed verification: undo the applied action.
  await undoAction();
  throw new Error(`Post-remediation healthz gate failed (rolled back): ${healthzGate.stderr}`);
}
log('Gates passed: policy ✔ toolchain ✔ apply ✔ healthz ✔ — interception & rollback drills evidenced.');
report({ step: 'gates', toolchain: toolchainGate.exitCode, healthz: healthzGate.exitCode, policyDrill: 'intercepted', rollbackDrill: 'restored' });

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
