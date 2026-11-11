/**
 * `workflow new <name>` — zero-friction scaffold generator (Mission D 支柱四).
 *
 * Generates a compile-clean facade script from one of the built-in templates:
 * code-review | incident-triage | repo-migration | multi-agent (custom team).
 * Every template passes `workflow check` untouched and runs offline on the
 * deterministic mock provider — the actor names / prompt keywords below are
 * aligned with the mock provider's routing table so the first
 * `workflow run` always lands (real providers replace mock seamlessly).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';

export interface NewCommandOptions {
  template?: string;
  /** Destination directory (defaults to cwd). */
  dir?: string;
  lang?: string;
}

export const NEW_TEMPLATES: Record<string, { title: string; body: string }> = {
  'code-review': {
    title: 'Code Review & Verification (代码安全审查与自动化验证)',
    body: `/**
 * <NAME> — typed parallel reviews over the changed files.
 * Run: workflow run <NAME>.facade.ts --cwd <workspace>
 */
phase('Scan');
const changed = await git.changedFiles('origin/main');
log(\`\${changed.length} changed files\`);
report({ changed: changed.length });

phase('Parallel Review');
const reviews = await Promise.all(changed.slice(0, 8).map((file) =>
  agent('reviewer').ask<Verdict>(\`review \${file} for correctness and security\`)
));

phase('Report');
const blockers = reviews.filter((v) => !v.isApproved).length;
await artifact.markdown('review', \`# Review\\n\\n\${changed.length} files reviewed, \${blockers} need changes\\n\\n\` +
  reviews.map((v, i) => \`- \${changed[i]}: \${v.isApproved ? 'approve' : 'changes requested'} (risk \${v.riskLevel})\`).join('\\n') + '\\n');
return { files: changed.length, blockers };

interface Verdict {
  /** Whether the reviewed file passes the correctness/safety bar. */
  isApproved: boolean;
  /** LOW | MEDIUM | HIGH overall risk. */
  riskLevel: string;
}
`,
  },
  'incident-triage': {
    title: 'Incident Triage & Hotfix (线上突发故障自主分诊与修复)',
    body: `/**
 * <NAME> — detect → triage → remediate with a shell verification gate.
 * Run: workflow run <NAME>.facade.ts --cwd <workspace>
 */
phase('Detect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
log(\`service health: \${health.healthStatus}\`);

phase('Triage');
const triage = await agent('triage').ask<Triage>(\`triage the \${health.healthStatus} service: root cause + recommended action\`);
report({ incidentId: triage.incidentId, severity: triage.severity });

phase('Verify Fix');
const gate = await world.run('node', ['--version'], { timeoutMs: 30_000 });
if (gate.exitCode !== 0) throw new Error(\`verification gate failed: \${gate.stderr}\`);

await artifact.markdown('postmortem', \`# Incident \${triage.incidentId}\\n\\nseverity: \${triage.severity}\\nroot cause: \${triage.rootCause}\\naction: \${triage.recommendedAction}\\ngate exit: \${gate.exitCode}\\n\`);
return { incidentId: triage.incidentId, severity: triage.severity, gate: gate.exitCode };

interface Health {
  /** HEALTHY | DEGRADED | DOWN (mock provider returns HEALTHY). */
  healthStatus: string;
}
interface Triage {
  /** Incident id, e.g. INC-20261031-01. */
  incidentId: string;
  /** P0..P3 severity. */
  severity: string;
  /** One-paragraph root cause. */
  rootCause: string;
  /** Recommended remediation action. */
  recommendedAction: string;
}
`,
  },
  'repo-migration': {
    title: 'Repo Migration Pipeline (依赖与架构自动化重构迁移)',
    body: `/**
 * <NAME> — scan → plan → execute migration steps behind shell gates.
 * Run: workflow run <NAME>.facade.ts --set target=lodash@4 --cwd <workspace>
 */
phase('Inventory');
const paths = await files.glob(String(args.glob ?? 'src/**/*.ts'));
log(\`\${paths.length} files in scope\`);

phase('Migration Plan');
const plan = await agent('planner').ask<Plan>(\`remediation plan: migrate to \${String(args.target ?? 'the target dependency')} over \${paths.length} files\`);
report({ steps: plan.steps.length });

phase('Execute');
for (const step of plan.steps) {
  log(\`step: \${step}\`);
  report({ step });
}

phase('Gate');
const gate = await world.run('node', ['--version'], { timeoutMs: 30_000 });
return { files: paths.length, steps: plan.steps.length, gate: gate.exitCode };

interface Plan {
  /** Ordered migration steps, each a short imperative sentence. */
  steps: string[];
}
`,
  },
  'multi-agent': {
    title: 'Custom Multi-Agent Team (自定义多角色专家编排)',
    body: `/**
 * <NAME> — a three-role expert team with fresh-eyes review.
 * Run: workflow run <NAME>.facade.ts --set question='...'
 */
phase('Assess');
const base = await agent('analyst').ask<Assessment>(\`assess the situation: \${String(args.question ?? 'define args.question')}\`);
report({ confidence: base.confidence });

phase('Red Team');
const critique = await agent('red-team-analyst').ask<Assessment>(\`assess this take critically and propose improvements: \${base.assessment}\`);

phase('Finalize');
await artifact.markdown('assessment', \`# Assessment\\n\\n## Base view\\n\${base.assessment}\\n\\n## Red team (confidence \${critique.confidence})\\n\${critique.assessment}\\n\`);
return { confidence: base.confidence, refined: critique.assessment };

interface Assessment {
  /** One-paragraph expert assessment. */
  assessment: string;
  /** 0..1 confidence in the assessment. */
  confidence: number;
}
`,
  },
};

async function promptTemplate(): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Choose a template:');
    const keys = Object.keys(NEW_TEMPLATES);
    keys.forEach((k, i) => console.log(`  ${i + 1}) ${NEW_TEMPLATES[k]!.title} (${k})`));
    const answer = (await rl.question('Template number [1]: ')).trim();
    const idx = answer === '' ? 1 : Number(answer);
    if (!Number.isInteger(idx) || idx < 1 || idx > keys.length) return null;
    return keys[idx - 1]!;
  } finally {
    rl.close();
  }
}

export async function executeNew(name: string | undefined, options?: NewCommandOptions): Promise<number> {
  if (!name || !/^[\w.-]+$/.test(name)) {
    console.error('Error: a workflow name is required — workflow new <name> [--template <t>]');
    return 1;
  }
  let template = options?.template;
  if (!template) template = (await promptTemplate()) ?? undefined;
  if (!template) {
    console.error('Error: choose a template (interactive prompt unavailable in non-TTY):');
    for (const k of Object.keys(NEW_TEMPLATES)) console.error(`  workflow new <name> --template ${k}   # ${NEW_TEMPLATES[k]!.title}`);
    return 1;
  }
  const tpl = NEW_TEMPLATES[template];
  if (!tpl) {
    console.error(`Error: unknown template "${template}". Available: ${Object.keys(NEW_TEMPLATES).join(', ')}`);
    return 1;
  }
  const dir = path.resolve(options?.dir ?? process.cwd());
  const file = path.join(dir, `${name}.facade.ts`);
  if (fs.existsSync(file)) {
    console.error(`Error: ${file} already exists — pick another name.`);
    return 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, tpl.body.replaceAll('<NAME>', name));
  console.log(`✔ scaffolded ${file}`);
  console.log(`  template: ${tpl.title}`);
  console.log('Next steps:');
  console.log(`  workflow check ${name}.facade.ts                 # must report Result: OK`);
  console.log(`  workflow run ${name}.facade.ts --cwd <workspace>  # mock provider offline by default`);
  return 0;
}
