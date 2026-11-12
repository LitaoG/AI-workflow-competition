/**
 * (Issue #126 §2.2): runtime line mapping — the lowering emits
 * a source map alongside script.js, and a script error's top `workflow.facade.js`
 * frame maps back to the author's row/column.
 *
 * F3 (replay identity): the site-call sequence in the emitted JS stays exactly
 * the analyzer's site order — the journal keys on (kind, siteId, prompt-hash),
 * never on the emitted bytes, so the one-pass lowering must not move a single
 * site id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerFacadeScript } from '../../../src/dwf/lower.js';
import { firstFacadeStackFrame, mapToAuthorPosition } from '../../../src/dwf/runner.js';

test('the lowering emits a source map without sourcesContent', () => {
  const lowered = lowerFacadeScript('const v = await agent("x").ask("q");\nreturn v;');
  assert.ok(lowered.sourceMap, 'a source map accompanies the emitted JS');
  const map = JSON.parse(lowered.sourceMap!) as Record<string, unknown>;
  assert.equal(map.version, 3);
  assert.ok(!('sourcesContent' in map), 'the map must not carry the script source (F5)');
});

test('a throw frame maps back to the author row/column through the emitted map', () => {
  // Author lines: 1 = the ask, 2 = the throw. Wrapped adds one prelude line.
  const lowered = lowerFacadeScript('const v = await agent("x").ask("q");\nthrow new Error("kaboom");');
  const map = lowered.sourceMap!;
  // The throw frame in the emitted JS: find the emitted `new Error` position.
  const jsLines = lowered.js.split('\n');
  const generatedLine = jsLines.findIndex((l) => l.includes('new Error')) + 1;
  const generatedColumn = (jsLines[generatedLine - 1]!.indexOf('new Error') ?? 0) + 1;
  const author = mapToAuthorPosition(generatedLine, generatedColumn, map);
  assert.ok(author, 'the throw frame maps back');
  assert.equal(author!.line, 2, 'author line 2 (one prelude line is subtracted)');
  assert.ok(author!.column >= 1 && author!.column <= 10, 'the column lands inside the throw statement');

  // Frames before the first mapping (the prelude row) map to nothing: findEntry
  // returns an entry without original fields. Positions past the last mapping
  // fall back to the nearest preceding mapping — findEntry's contract — which is
  // harmless for real frames: a vm frame column always sits inside emitted code.
  assert.equal(mapToAuthorPosition(1, 1, map), undefined, 'the prelude row is not an author row');
  assert.equal(mapToAuthorPosition(1, 1, '{not json'), undefined, 'a malformed map degrades to unmappable');
});

test('firstFacadeStackFrame picks the topmost workflow.facade.js frame', () => {
  const stack = [
    'Error: kaboom',
    '    at inner (workflow.facade.js:5:11)',
    '    at __workflowScript__ (workflow.facade.js:9:3)',
    '    at node:internal/main/run_main_module:23:47',
  ].join('\n');
  assert.deepEqual(firstFacadeStackFrame(stack), { line: 5, column: 11 });
  assert.equal(firstFacadeStackFrame('    at node:internal/main/run_main_module:23:47'), undefined);
  assert.equal(firstFacadeStackFrame(undefined), undefined);
});

test('the emitted site-call sequence matches the analyzer site order (replay identity, F3)', () => {
  const source = [
    'const a = agent("x");',
    'const b = await a.ask("one");',
    'const c = await swarm([agent("y")], ["t1"]);',
    'phase("P");',
    'log("hello");',
    'return null;',
  ].join('\n');
  const lowered = lowerFacadeScript(source);
  const emitted = [...lowered.js.matchAll(/"(?:actor|ask|swarm|log)#\d+"/g)].map((m) => m[0]);
  // phase() lowers to enterPhase(name, index) — its site id never enters the
  // emitted code (pre-existing behavior), so compare the id-carrying kinds only.
  const expected = lowered.analysis.sites
    .filter((s) => s.kind !== 'phase')
    .map((s) => `"${s.siteId}"`);
  assert.deepEqual(emitted, expected, 'every id-carrying site appears in the emitted JS, in analyzer order');
});
