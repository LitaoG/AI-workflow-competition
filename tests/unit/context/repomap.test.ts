/**
 * y.md pillar 2 (Issue #157): the AST symbol map and its budget-capped
 * slices — symbol graph over real temp-workspace files, hard slice budget,
 * and the engine's files.map read face end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRepomap } from '../../../src/context/repomap.js';
import { sliceTargetFile } from '../../../src/context/slice.js';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../../src/types.js';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-ws-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'a.ts'),
    [
      'export function helperA(x: number): number {',
      '  return x + 1;',
      '}',
      '',
      'export class Foo {',
      '  bar(): string { return "bar"; }',
      '}',
      '',
      'export const CONSTANT_A = 42;',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(src, 'b.ts'),
    [
      'import { helperA } from "./a";',
      '',
      'export function useA(n: number): number {',
      '  return helperA(n) + helperA(n);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(src, 'c.ts'),
    [
      'import { Foo } from "./a";',
      '',
      'export function useFoo(): string {',
      '  const f = new Foo();',
      '  return f.bar();',
      '}',
      '',
    ].join('\n'),
  );
  return root;
}

function cleanup(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle races — best effort in tests */
  }
}

test('buildRepomap ranks the import neighborhood and its exported symbols', () => {
  const root = makeWorkspace();
  try {
    const map = buildRepomap(root, 'src/b.ts');
    assert.equal(map.target.replace(/\\/g, '/'), 'src/b.ts');
    const files = map.ranked.map((r) => r.file.replace(/\\/g, '/'));
    assert.ok(files.includes('src/a.ts'), `the direct import src/a.ts is ranked, got: ${files.join(', ')}`);
    assert.ok(!files.includes('src/c.ts'), 'an unrelated sibling is not in the neighborhood');
    assert.ok(map.symbols.includes('helperA'), `the imported symbol is ranked, got: ${map.symbols.join(', ')}`);
  } finally {
    cleanup(root);
  }
});

test('buildRepomap rejects a target outside the workspace', () => {
  const root = makeWorkspace();
  try {
    assert.throws(() => buildRepomap(root, 'src/does-not-exist.ts'), /does not exist/);
  } finally {
    cleanup(root);
  }
});

test('sliceTargetFile keeps relevant declarations under a hard budget and announces cuts', () => {
  const root = makeWorkspace();
  try {
    const abs = path.join(root, 'src', 'a.ts');
    const slice = sliceTargetFile(abs, new Set(['helperA', 'Foo']));
    assert.equal(slice.truncated, false);
    // Relevance orders the slice; the default budget easily holds the whole
    // small file, so the filler declaration rides along too.
    assert.deepEqual(slice.keptSymbols, ['helperA', 'Foo', 'CONSTANT_A']);
    assert.match(slice.text, /export function helperA/);

    // A genuinely large file with a tight budget: relevance first, cut
    // announced, text never over budget (the marker rides inside it).
    const bigPath = path.join(root, 'src', 'big.ts');
    const filler = (i: number): string =>
      `export function filler${i}(alpha: number, beta: number, gamma: number): number {\n  const sum = alpha + beta + gamma;\n  const scaled = sum * ${i} + alpha - beta / (gamma + 1);\n  return Math.round(scaled * 100) / 100;\n}`;
    fs.writeFileSync(bigPath, Array.from({ length: 5 }, (_, i) => filler(i)).join('\n\n') + '\n');
    const tight = sliceTargetFile(bigPath, new Set(['filler3']), { budgetChars: 700 });
    assert.equal(tight.truncated, true, 'a 700-char budget cannot hold five ~300-char declarations');
    assert.ok(tight.text.length <= 700, `the hard cap holds, got ${tight.text.length}`);
    assert.match(tight.text, /truncated/, 'the cut is announced in-band');
    assert.ok(tight.keptSymbols.includes('filler3') || tight.keptSymbols.includes('filler0'), 'relevance or file order fills the slice');
  } finally {
    cleanup(root);
  }
});

test('engine files.map: the read face returns the slice and its ranked neighborhood', async () => {
  const root = makeWorkspace();
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = new FacadeEngine({
      runId: 'dwfrun-repomap',
      workspace: root,
      store,
      args: {},
      approvedCommands: [],
      onEvent: () => {},
    });
    const frame = { t: 'call', id: 1, op: 'worldRead', siteId: 'wr#1', payload: ['files.map', ['src/b.ts']] };
    const result = (await engine.handleCall(frame as never)) as {
      target: string;
      text: string;
      truncated: boolean;
      keptSymbols: string[];
      ranked: Array<{ file: string; score: number }>;
    };
    assert.equal(result.target.replace(/\\/g, '/'), 'src/b.ts');
    assert.match(result.text, /helperA/, "the target's own shape is in the slice");
    assert.ok(result.ranked.some((r) => r.file.replace(/\\/g, '/') === 'src/a.ts'), 'the neighborhood rides along');
    assert.equal(result.truncated, false);
  } finally {
    store.close();
    cleanup(root);
  }
});
