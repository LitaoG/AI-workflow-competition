/**
 * Issue #38 D8-③ ③: artifact preset family (chart/table/metrics/board) —
 * compile enforces the declaration discipline (9007 id/tag rules, 9008
 * top-level hoisting, 9009 primary conflict), lowering emits the
 * declareArtifact frame (args packed positionally, zero validation), and the
 * engine journals the declaration with official failRun semantics: spec
 * validation, kind mismatch, identical re-declaration no-op, different-spec
 * ArtifactRedeclared, primary conflict, per-run id cap — plus report(item, tag)
 * linkage on the journal events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { lowerFacadeScript } from '../../../src/dwf/lower.js';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../../src/types.js';

const compile = (body: string) => analyzeFacadeScript(`${body}\nreturn null;`);

test('#38 compile 9007: id literal/charset rules across content and preset members', () => {
  const dynamic = compile(`artifact.chart(id2(), { x: { field: "a" }, y: { field: "b" } });`);
  assert.equal(dynamic.ok, false);
  assert.ok(dynamic.diagnostics.some((d) => d.code === 9007 && /non-empty compile-time string literal/.test(d.message)), JSON.stringify(dynamic.diagnostics));

  const bad = compile(`artifact.chart("bad id!", { x: { field: "a" }, y: { field: "b" } });`);
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === 9007 && /64 characters of \[A-Za-z0-9_.-\]/.test(d.message)));

  const long = compile(`artifact.table("${"a".repeat(65)}", { columns: [{ field: "a" }] });`);
  assert.equal(long.ok, false);
  assert.ok(long.diagnostics.some((d) => d.code === 9007));

  const clean = compile(`artifact.metrics("m1", { metrics: [{ field: "latency", unit: "ms" }] });`);
  assert.equal(clean.ok, true, JSON.stringify(clean.diagnostics));
});

test('#38 compile 9007: one id, one member — kind mismatch and report-tag targeting', () => {
  const clash = compile(`artifact.chart("dup", { x: { field: "a" }, y: { field: "b" } });\nartifact.table("dup", { columns: [{ field: "a" }] });`);
  assert.equal(clash.ok, false);
  assert.ok(clash.diagnostics.some((d) => d.code === 9007 && /one artifact member/.test(d.message)));

  const undeclared = compile(`report("point", "ghost");`);
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.diagnostics.some((d) => d.code === 9007 && /does not name a declared artifact preset/.test(d.message)));

  const contentTag = compile(`await artifact.file("rep", "out.txt");\nreport("x", "rep");`);
  assert.equal(contentTag.ok, false);
  assert.ok(contentTag.diagnostics.some((d) => d.code === 9007 && /content artifact id/.test(d.message)));

  const tagged = compile(`artifact.chart("pts", { x: { field: "t" }, y: { field: "v" } });\nreport("point", "pts");`);
  assert.equal(tagged.ok, true, JSON.stringify(tagged.diagnostics));
});

test('#38 compile 9008: preset declarations are top-level — loops/conditionals/callbacks banned, holes exempt', () => {
  const inLoop = compile(`for (const i of [1, 2]) {\n  artifact.chart("c" + "x".repeat(0) + "", { x: { field: "a" }, y: { field: "b" } });\n}`);
  assert.equal(inLoop.ok, false);
  assert.ok(inLoop.diagnostics.some((d) => d.code === 9008), JSON.stringify(inLoop.diagnostics));

  const inIf = compile(`if (true) { artifact.board("b1", { key: "k", status: "s", columns: ["s"] }); }`);
  assert.equal(inIf.ok, false);
  assert.ok(inIf.diagnostics.some((d) => d.code === 9008));

  const inCallback = compile(`[1].map(() => artifact.metrics("m2", { metrics: [{ field: "a" }] }));`);
  assert.equal(inCallback.ok, false);
  assert.ok(inCallback.diagnostics.some((d) => d.code === 9008));

  // hole bodies: our hole() takes no body — a fill body is spliced into the top
  // level and recompiles at fill time, so the hoisting ban judges it there.

  const topLevel = compile(`artifact.chart("top", { x: { field: "a" }, y: { field: "b" } });`);
  assert.equal(topLevel.ok, true);
});

test('#38 compile 9009: two literal primary:true ids conflict', () => {
  const both = compile(
    `artifact.chart("a1", { primary: true, x: { field: "a" }, y: { field: "b" } });\n` +
    `artifact.metrics("a2", { primary: true, metrics: [{ field: "a" }] });`,
  );
  assert.equal(both.ok, false);
  assert.ok(both.diagnostics.some((d) => d.code === 9009 && /primary/.test(d.message)), JSON.stringify(both.diagnostics));

  const one = compile(`artifact.chart("a1", { primary: true, x: { field: "a" }, y: { field: "b" } });`);
  assert.equal(one.ok, true);
});

test('#38 lowering: presets emit declareArtifact with positional args; report carries the tag', () => {
  const lowered = lowerFacadeScript(`artifact.chart("pts", { x: { field: "t" }, y: { field: "v" } });\nreport("point", "pts");`);
  assert.equal(lowered.analysis.ok, true, JSON.stringify(lowered.analysis.diagnostics));
  assert.match(lowered.js, /__host\.declareArtifact\([^)]*['"]chart['"][^)]*\[\s*['"]pts['"]/s, lowered.js);
  assert.match(lowered.js, /__host\.report\([^)]*["']pts["']\s*\)/s, 'the tag rides the report frame');
});

test('#38 engine: declaration journals once, identical re-declaration is a no-op, different spec fails the run', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine = new FacadeEngine({
      runId: 'preset-1',
      workspace: process.cwd(),
      store,
      args: {},
      approvedCommands: [],
      onEvent: (e) => events.push(e as { type: string; data: Record<string, unknown> }),
    });
    const spec = { x: { field: 't' }, y: { field: 'v' } };
    await engine.handleCall({ t: 'call', id: 1, op: 'declareArtifact', siteId: 'artifact#1', payload: ['chart', ['pts', spec]] } as never);
    await engine.handleCall({ t: 'call', id: 2, op: 'declareArtifact', siteId: 'artifact#1', payload: ['chart', ['pts', spec]] } as never);

    const nodes = await store.getDwfNodes('preset-1');
    const declared = nodes.filter((n) => n.kind === 'artifact' && (n.resultJson ?? '').includes('"spec"'));
    assert.equal(declared.length, 1, `an identical re-declaration journals nothing new, got ${declared.length}`);

    const art = events.filter((e) => e.type === 'dwf_artifact');
    assert.equal(art.length, 1, 'one declaration event');
    assert.equal(art[0].data.preset, true);
    assert.equal(art[0].data.kind, 'chart');

    // A DIFFERENT spec for the same id is ArtifactRedeclared → the run fails.
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 3, op: 'declareArtifact', siteId: 'artifact#2', payload: ['chart', ['pts', { x: { field: 'z' }, y: { field: 'w' } }]] } as never),
      (err: Error) => err.name === 'ArtifactRedeclared' && /different spec/.test(err.message),
    );

    // Kind mismatch on the same id → ArtifactKindMismatch.
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 4, op: 'declareArtifact', siteId: 'artifact#3', payload: ['table', ['pts', { columns: [{ field: 'a' }] }]] } as never),
      (err: Error) => err.name === 'ArtifactKindMismatch',
    );

    // Malformed spec → failRun with a human-readable problem.
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 5, op: 'declareArtifact', siteId: 'artifact#4', payload: ['chart', ['bad', { x: 42 }]] } as never),
      (err: Error) => /invalid spec/.test(err.message),
    );
  } finally {
    store.close();
  }
});

test('#38 engine: primary conflict and the 32-id cap fail the run; report tags link items', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const events2: Array<{ type: string; data: Record<string, unknown> }> = [];
    const engine = new FacadeEngine({
      runId: 'preset-2',
      workspace: process.cwd(),
      store,
      args: {},
      approvedCommands: [],
      onEvent: (e) => events2.push(e as { type: string; data: Record<string, unknown> }),
    });
    await engine.handleCall({ t: 'call', id: 1, op: 'declareArtifact', siteId: 'artifact#1', payload: ['metrics', ['m1', { primary: true, metrics: [{ field: 'a' }] }]] } as never);
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 2, op: 'declareArtifact', siteId: 'artifact#2', payload: ['board', ['b1', { primary: true, key: 'k', status: 's', columns: ['s'] }]] } as never),
      (err: Error) => err.name === 'ArtifactPrimaryConflict' && /primary/.test(err.message),
    );

    // report(item, tag) carries the artifactId on the journal event.
    await engine.handleCall({ t: 'call', id: 3, op: 'report', siteId: 'report#1', payload: [{ point: 1 }, 'm1'] } as never);
    const report = events2.filter((e) => e.type === 'dwf_report');
    assert.equal(report[report.length - 1]?.data.artifactId, 'm1', JSON.stringify(report.map((r) => r.data)));
  } finally {
    store.close();
  }

  // The 32-id cap counts presets and content alike.
  const store2 = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = new FacadeEngine({
      runId: 'preset-3',
      workspace: process.cwd(),
      store: store2,
      args: {},
      approvedCommands: [],
    });
    for (let i = 0; i < 32; i++) {
      await engine.handleCall({ t: 'call', id: i + 1, op: 'declareArtifact', siteId: `artifact#${i + 1}`, payload: ['metrics', [`m${i}`, { metrics: [{ field: 'a' }] }]] } as never);
    }
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 33, op: 'declareArtifact', siteId: 'artifact#33', payload: ['metrics', ['overflow', { metrics: [{ field: 'a' }] }]] } as never),
      (err: Error) => err.name === 'ArtifactCapExceeded',
    );
  } finally {
    store2.close();
  }
});
