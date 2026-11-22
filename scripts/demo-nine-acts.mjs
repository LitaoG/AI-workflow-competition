#!/usr/bin/env node
// Windows-native nine-act showcase (Issue #254): a byte-for-byte port of
// scripts/demo.sh's nine acts onto Node's child_process — no bash, sed or grep
// required, so `npm run demo:nine-acts:win` runs in Windows PowerShell and every
// other native shell. The bash original remains the governance-pinned entry
// (`demo:nine-acts`); this port mirrors its act structure, evidence greps and
// verdict semantics (per-act OK/FAIL, non-zero exit when any act failed).
//
// Offline (mock providers, <4s per act). Every act prints the evidence line
// that proves the capability it demos.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'workflow.js');
const DB = path.join(ROOT, '.workflow', 'demo-dwf.sqlite');
const TOUR = path.join(ROOT, 'apps', 'capabilities-tour');

fs.mkdirSync(path.join(ROOT, '.workflow'), { recursive: true });

if (!fs.existsSync(BIN)) {
  console.error('FATAL: bin/workflow.js not found — run `npm run build` first (dist required).');
  process.exit(127);
}

let actFails = 0;
const ok = (n, msg) => console.log(`[act ${n}] OK  ${msg}`);
const fail = (n, msg) => { console.error(`[act ${n}] FAIL ${msg}`); actFails++; };

/** Run the workflow CLI and return { status, stdout, stderr } (utf8). */
function wf(args, cwd = ROOT) {
  const r = spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runIdOf(output) {
  const matches = output.match(/dwfrun-[A-Za-z0-9_-]+/g);
  return matches ? matches[matches.length - 1] : '';
}

let incidentId = '';

// act 1 — check: incident demo compiles (strict TS + authorization rules)
console.log('== 1/9 check: incident demo compiles (strict TS + authorization rules) ==');
{
  const r = wf(['check', 'apps/incident-triage-remediation/facade.workflow.ts']);
  const out = (r.stdout + r.stderr).trim();
  console.log(out.split('\n').slice(0, 8).join('\n'));
  if (r.status === 0) ok(1, `compiled clean: ${out.split('\n')[0]}`);
  else fail(1, out);
}

// act 2 — run: incident triage & remediation (mock)
console.log('\n== 2/9 run: incident triage & remediation (mock) ==');
{
  const r = wf(
    ['run-script', 'facade.workflow.ts', '--db', DB, '--args', '{"scenario":"p1_db_pool_exhaustion"}', '--approve-cmd', 'node'],
    path.join(ROOT, 'apps', 'incident-triage-remediation'),
  );
  const out = r.stdout + r.stderr;
  console.log(out.split('\n').filter((l) => /run dwfrun|result:/.test(l)).slice(0, 2).join('\n'));
  incidentId = runIdOf(out);
  if (out.includes('completed')) ok(2, 'sandbox run completed');
  else fail(2, out.slice(0, 400));
}

// act 3 — resume: the SAME run replays at ZERO provider calls
console.log('\n== 3/9 resume: the SAME run replays at ZERO provider calls ==');
{
  const r = wf(
    ['run-script', 'facade.workflow.ts', '--db', DB, '--args', '{"scenario":"p1_db_pool_exhaustion"}', '--resume', incidentId, '--approve-cmd', 'node'],
    path.join(ROOT, 'apps', 'incident-triage-remediation'),
  );
  const out = r.stdout + r.stderr;
  console.log(out.split('\n').filter((l) => /asks:|⚡/.test(l)).slice(0, 4).join('\n'));
  if (out.includes('asks: 0 (replayed from journal:')) ok(3, 'zero-provider replay');
  else fail(3, out.slice(0, 400));
}

// act 4 — run: AWS SDK v2->v3 migration (mock)
console.log('\n== 4/9 run: AWS SDK v2->v3 migration (mock) ==');
{
  const r = wf(
    ['run-script', 'facade.workflow.ts', '--db', DB, '--approve-cmd', 'node'],
    path.join(ROOT, 'apps', 'repo-migration-engine'),
  );
  const out = r.stdout + r.stderr;
  console.log(out.split('\n').filter((l) => /asks:|result:/.test(l)).slice(0, 2).join('\n'));
  if (out.includes('completed')) ok(4, 'migration completed');
  else fail(4, out.slice(0, 400));
}

// act 5 — amend: edit the script, fork — unchanged ♻ reused, changed ⑂ diverged
console.log('\n== 5/9 amend: edit the script, fork — unchanged ♻ reused, changed ⑂ diverged ==');
{
  const v2 = path.join(TOUR, 'lineage-v2.facade.ts');
  try {
    const source = fs.readFileSync(path.join(TOUR, 'lineage.facade.ts'), 'utf8');
    fs.writeFileSync(v2, source.replace('Assess this reading', 'SENIOR review with extra scrutiny of this reading'));
    const base = wf(['run-script', 'lineage.facade.ts', '--db', DB], TOUR);
    const baseId = runIdOf(base.stdout + base.stderr);
    const amend = wf(['run-script', 'lineage-v2.facade.ts', '--db', DB, '--amend', baseId], TOUR);
    const out = amend.stdout + amend.stderr;
    console.log(out.split('\n').filter((l) => /♻|⑂|asks:/.test(l)).slice(0, 4).join('\n'));
    if (out.includes('♻ amended run reused')) ok(5, 'amend lineage (reuse + diverge)');
    else fail(5, out.slice(0, 400));
  } finally {
    fs.rmSync(v2, { force: true });
  }
}

// act 6 — holes: the run parks, fill it with code, it continues as an amend
console.log('\n== 6/9 holes: the run parks, fill it with code, it continues as an amend ==');
{
  const park = wf(['run-script', 'growth.facade.ts', '--db', DB], TOUR);
  const parkOut = park.stdout + park.stderr;
  const parkId = runIdOf(parkOut);
  console.log(parkOut.split('\n').filter((l) => l.includes('parked')).slice(0, 1).join('\n'));
  const fill = wf(['fill', parkId, 'plan-remediation', path.join(TOUR, 'fill-plan.js'), '--db', DB], TOUR);
  const out = fill.stdout + fill.stderr;
  console.log(out.split('\n').filter((l) => /♻|✔ hole/.test(l)).slice(0, 3).join('\n'));
  if (out.includes('✔ hole')) ok(6, 'hole park + fill + amend continue');
  else fail(6, out.slice(0, 400));
}

// act 7 — escalation: park on a human gate, answer, resume at zero cost
console.log('\n== 7/9 escalation: park on a human gate, answer, resume at zero cost ==');
{
  const gate = wf(['run-script', 'gate.facade.ts', '--db', DB], TOUR);
  const gateOut = gate.stdout + gate.stderr;
  const gateId = runIdOf(gateOut);
  const qMatch = gateOut.match(/dwfq-[a-z0-9]+/);
  const qid = qMatch ? qMatch[0] : '';
  console.log(gateOut.split('\n').filter((l) => l.includes('question')).slice(0, 1).join('\n'));
  const ans = wf(['answer', gateId, qid, 'yes - hotfix verified by the deterministic gate', '--db', DB], TOUR);
  const out = ans.stdout + ans.stderr;
  console.log(out.split('\n').filter((l) => /⚡|✔ run/.test(l)).slice(0, 3).join('\n'));
  if (out.includes('completed with the answer')) ok(7, 'escalation park + answer resume');
  else fail(7, out.slice(0, 400));
}

// act 8 — budget: budget.total hard-stops further agent() calls
console.log('\n== 8/9 budget: budget.total hard-stops further agent() calls ==');
{
  const r = wf(['run-script', 'budget.facade.ts', '--db', DB, '--budget-total', '80'], TOUR);
  const out = r.stdout + r.stderr;
  console.log(out.split('\n').filter((l) => l.includes('result:')).slice(0, 1).join('\n'));
  if (out.includes('WorkflowBudgetExceededError')) ok(8, 'budget hard stop');
  else fail(8, out.slice(0, 400));
}

// act 9 — view + live attach
console.log('\n== 9/9 view + live attach ==');
{
  const viewOut = path.join(ROOT, '.workflow', 'views', 'demo.html');
  if (incidentId) {
    const r = wf(['view', incidentId, '--db', DB, '-o', viewOut]);
    if (r.status === 0) {
      ok(9, 'journal-rendered report + live attach');
      console.log(`Static report: ${viewOut}`);
      console.log(`Live attach:   node bin/workflow.js serve ${incidentId} --db ${DB}`);
    } else {
      fail(9, 'SKIP — view failed');
    }
  } else {
    fail(9, 'SKIP — no run id');
  }
}

console.log('');
if (actFails === 0) {
  console.log('ALL NINE ACTS COMPLETE — every capability evidenced above.');
} else {
  console.error(`DEMO INCOMPLETE: ${actFails} act(s) failed — see [act N] FAIL lines above.`);
  process.exit(1);
}
