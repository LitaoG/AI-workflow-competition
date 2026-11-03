import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';

const CLEAN = `
phase("Gather");
const a = await agent("inspector").ask<Health>("inspect the service");
phase("Verify");
const gate = await world.run("node", ["--version"]);
report(a);
return { a, gate };

interface Health {
  /** Overall verdict. */
  healthStatus: string;
  checks: string[];
}
`;

test('clean facade script compiles with a full site table', () => {
  const r = analyzeFacadeScript(CLEAN);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const kinds = r.sites.map((s) => `${s.siteId}:${s.kind}`);
  // AST visit order: phase, ask (receiver visited after the ask site is recorded? no —
  // ask is recorded first, then its receiver call), phase, worldRun, report
  assert.ok(kinds.some((k) => k.startsWith('ask#') && k.endsWith(':ask')), kinds.join(','));
  assert.ok(kinds.some((k) => k.endsWith(':actor')));
  assert.deepEqual(r.phases, ['Gather', 'Verify']);
  assert.deepEqual(r.commands, ['node']);
  assert.deepEqual(r.actors, ['inspector']);
});

test('purity bans: Date.now / Math.random / no-arg new Date / fetch are diagnostics', () => {
  for (const [snippet, needle] of [
    ['const t = Date.now();', 'Date.now'],
    ['const r = Math.random();', 'Math.random'],
    ['const d = new Date();', 'new Date()'],
    ['const x = await fetch("http://x");', 'fetch'],
  ] as Array<[string, string]>) {
    const r = analyzeFacadeScript(`\n${snippet}\nreturn null;`);
    assert.equal(r.ok, false, snippet);
    assert.ok(r.diagnostics.some((d) => d.category === 'purity-ban' && d.message.includes(needle.replace('()', ''))), `${snippet}: ${JSON.stringify(r.diagnostics)}`);
  }
});

test('literal rules: phase() and world.run() need compile-time literals', () => {
  const r1 = analyzeFacadeScript('phase(String(args.p));\nreturn null;');
  assert.equal(r1.ok, false);
  assert.ok(r1.diagnostics.some((d) => d.category === 'literal-rule'));

  const r2 = analyzeFacadeScript('const c = "node";\nawait world.run(c, []);\nreturn null;');
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.category === 'literal-rule'));
});

test('shadowing facade primitives is a diagnostic', () => {
  const r = analyzeFacadeScript('const log = 3;\nreturn log;');
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === 9004 && d.message.includes('log')));
});

test('imports are banned (closed world)', () => {
  const r = analyzeFacadeScript('import fs from "node:fs";\nreturn null;');
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === 9006));
});

test('ask<T> synthesizes a JSON schema with JSDoc descriptions', () => {
  const r = analyzeFacadeScript(CLEAN);
  assert.equal(r.ok, true);
  const askSite = r.sites.find((s) => s.kind === 'ask');
  assert.ok(askSite?.schema, 'schema synthesized');
  const props = (askSite!.schema as { properties: Record<string, { type?: string; description?: string; items?: unknown }> }).properties;
  assert.equal(props.healthStatus.type, 'string');
  assert.equal(props.healthStatus.description, 'Overall verdict.');
  assert.deepEqual(props.checks, { type: 'array', items: { type: 'string' } });
});

test('boolean properties survive synthesis (boolean = union of literals internally)', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<V>("hi");
return v;
interface V { isApproved: boolean; riskLevel: "LOW" | "MEDIUM" | "HIGH"; }
`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const props = (r.sites.find((s) => s.kind === 'ask')!.schema as { properties: Record<string, { type?: string; enum?: string[] }> }).properties;
  assert.equal(props.isApproved.type, 'boolean');
  assert.deepEqual(props.riskLevel.enum, ['LOW', 'MEDIUM', 'HIGH']);
});

test('unsupported ask<T> shapes fail loudly with 9005', () => {
  const r = analyzeFacadeScript(`
const v = await agent("x").ask<string[]>("hi");
return v;
`);
  // string[] IS supported; use a function type instead
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));

  const r2 = analyzeFacadeScript(`
const v = await agent("x").ask<Map<string, number>>("hi");
return v;
`);
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.code === 9005));
});

test('diagnostics map to author line numbers (prelude line subtracted)', () => {
  const r = analyzeFacadeScript('return null;\nconst t = Date.now();');
  const d = r.diagnostics.find((x) => x.category === 'purity-ban');
  assert.ok(d);
  assert.equal(d!.line, 2);
});

// ---- invariant-1 pentest variants (goal-e2e-pentest): every escape must be statically diagnosed ----

const INV1_VARIANTS: Array<[string, string]> = [
  ['v1-process-exit', 'phase("Pentest");\nprocess.exit(1);\nreturn "v1-executed";'],
  ['v2-eval', 'phase("Pentest");\nconst doubled = eval("1 + 1");\nreturn { doubled };'],
  ['v3-date-now', 'phase("Pentest");\nconst stamp = Date.now();\nreturn { stamp };'],
  ['v4-math-random', 'phase("Pentest");\nconst roll = Math.random();\nreturn { roll };'],
];

test('invariant-1 v1-v4 escape variants are statically diagnosed with 9002', () => {
  for (const [name, source] of INV1_VARIANTS) {
    const r = analyzeFacadeScript(source);
    assert.equal(r.ok, false, `${name} must not pass the static check`);
    assert.ok(
      r.diagnostics.some((d) => d.code === 9002 && d.category === 'purity-ban'),
      `${name}: expected a 9002 purity-ban, got ${JSON.stringify(r.diagnostics)}`,
    );
  }
});

test('invariant-1 v1 process.exit also carries the TS2591 type error', () => {
  const r = analyzeFacadeScript(INV1_VARIANTS[0][1]);
  assert.ok(r.diagnostics.some((d) => d.code === 2591), `expected TS2591 for undeclared "process", got ${JSON.stringify(r.diagnostics)}`);
});

test('invariant-1 v5 ({}).constructor.constructor is statically banned with 9002 (GAP-02 hole)', () => {
  const r = analyzeFacadeScript('const rebuild = ({}).constructor.constructor;\nconst stolen = rebuild("return 40 + 2")();\nreturn { escapeReached: true, stolen };');
  assert.equal(r.ok, false, 'v5 constructor chain must not pass the static check');
  const hit = r.diagnostics.find((d) => d.code === 9002 && d.category === 'purity-ban');
  assert.ok(hit, `expected a 9002 purity-ban, got ${JSON.stringify(r.diagnostics)}`);
  assert.ok(hit!.message.includes('constructor-chain'), hit!.message);
});

test('invariant-1 v5 bracket form o["constructor"] is statically banned with 9002', () => {
  const r = analyzeFacadeScript('const o: Record<string, unknown> = {};\nconst f = o["constructor"];\nreturn f;');
  assert.equal(r.ok, false, 'bracket-form constructor access must not pass the static check');
  assert.ok(r.diagnostics.some((d) => d.code === 9002 && d.category === 'purity-ban'), JSON.stringify(r.diagnostics));
});

// ---- Issue #40 / GAP-MATRIX D3 + D9: initializer-position references & glob-in-comment ----

test('D3: initializer-position eval/globalThis are references and hit 9002 (const e = eval)', () => {
  const r1 = analyzeFacadeScript('const e = eval;\nreturn typeof e;');
  assert.equal(r1.ok, false, 'const e = eval must not pass the static check');
  assert.ok(r1.diagnostics.some((d) => d.code === 9002 && d.category === 'purity-ban'), JSON.stringify(r1.diagnostics));

  const r2 = analyzeFacadeScript('const g = globalThis;\nreturn typeof g;');
  assert.equal(r2.ok, false, 'const g = globalThis must not pass the static check');
  assert.ok(r2.diagnostics.some((d) => d.code === 9002 && d.category === 'purity-ban'), JSON.stringify(r2.diagnostics));
});

test('D3: the declaration NAME position stays excluded — 9002 fires on the use site, not the binding', () => {
  const r = analyzeFacadeScript('const Function = 3;\nreturn Function;');
  const hits = r.diagnostics.filter((d) => d.code === 9002);
  assert.ok(hits.length > 0, 'the use site is still a reference');
  assert.ok(hits.every((d) => d.line === 2), `9002 must fire on the use site only, got lines ${JSON.stringify(hits.map((h) => h.line))}`);
});

test('D9: a glob inside a block comment ends it early — one precise 9016 at the comment, not a flood', () => {
  const r = analyzeFacadeScript('/* workflow\nname: probe\ndescription: scan src/**/*.ts\n*/\nphase("P");\nreturn null;');
  assert.equal(r.ok, false, 'the script must fail the check');
  const hits = r.diagnostics.filter((d) => d.code === 9016);
  assert.equal(hits.length, 1, `exactly one precise diagnostic, got ${JSON.stringify(r.diagnostics)}`);
  assert.equal(hits[0]!.line, 1, 'points at the comment start');
  assert.equal(hits[0]!.category, 'facade-misuse');
  assert.equal(r.diagnostics.length, 1, 'no corrupt-parse diagnostic flood');
});

test('D9: the same-root-cause variant glob naming a file (double-star then main.ts) is caught too', () => {
  const r = analyzeFacadeScript('/* scan src/**/main.ts */\nphase("P");\nreturn null;');
  assert.equal(r.ok, false, 'the variant must fail the check');
  const hits = r.diagnostics.filter((d) => d.code === 9016);
  assert.equal(hits.length, 1, `exactly one precise diagnostic, got ${JSON.stringify(r.diagnostics)}`);
  assert.equal(hits[0]!.line, 1, 'points at the comment start');
  assert.equal(r.diagnostics.length, 1, 'no corrupt-parse diagnostic flood');
});

test('D9: pure star-rule separator comments (runs of stars) are not flagged', () => {
  const r = analyzeFacadeScript('/*******************/\nphase("P");\nreturn null;');
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test('D9: legal star-star-slash comment closings stay clean (no orphan terminator follows)', () => {
  // JSDoc-style trailing close
  const r1 = analyzeFacadeScript('/** Builds the summary. **/\nphase("P");\nreturn null;');
  assert.equal(r1.ok, true, JSON.stringify(r1.diagnostics));
  // complete comment followed by legal code
  const r2 = analyzeFacadeScript('/* note **/ phase("P");\nreturn null;');
  assert.equal(r2.ok, true, JSON.stringify(r2.diagnostics));
  // a later legal comment owns its own terminator — not an orphan
  const r3 = analyzeFacadeScript('/* note **/ phase("P"); /* tail */\nreturn null;');
  assert.equal(r3.ok, true, JSON.stringify(r3.diagnostics));
});

test('D9: star-star-slash close plus a leaked orphan terminator downstream is still caught', () => {
  const r = analyzeFacadeScript('/** Builds the summary. **/ stray */\nphase("P");\nreturn null;');
  assert.equal(r.ok, false, 'the orphan terminator is a syntax wound');
  assert.ok(r.diagnostics.some((d) => d.code === 9016), JSON.stringify(r.diagnostics));
});

test('D9: globs inside strings and line comments stay clean', () => {
  const r = analyzeFacadeScript('const pat = "src/**/*.ts";\n// also documented: src/**/*.ts\nphase("P");\nreturn pat;');
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test('positive control: minimal agent+ask facade script stays clean (no regression)', () => {
  const r = analyzeFacadeScript('const a = await agent("scout").ask<string>("inspect the service");\nreturn a;');
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});
