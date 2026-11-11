import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeScriptArgs, parseSetPairs, readArgsFile } from '../../src/cli/args-input.js';

test('--set pairs infer natural scalar types', () => {
  const { args, errors } = parseSetPairs([
    'scenario=p1_db_pool_exhaustion', // string
    'retries=3', // number
    'ratio=0.5', // float
    'negative=-7', // signed number
    'dryRun=true', // bool
    'verbose=false', // bool
    'payload={"a":1}', // JSON object
    'tags=["x","y"]', // JSON array
    'quoted="raw stays"', // JSON string
    'notjson={broken', // looks JSON-ish but isn't → stays a string
  ]);
  assert.deepEqual(errors, []);
  assert.equal(args.scenario, 'p1_db_pool_exhaustion');
  assert.equal(args.retries, 3);
  assert.equal(args.ratio, 0.5);
  assert.equal(args.negative, -7);
  assert.equal(args.dryRun, true);
  assert.equal(args.verbose, false);
  assert.deepEqual(args.payload, { a: 1 });
  assert.deepEqual(args.tags, ['x', 'y']);
  assert.equal(args.quoted, 'raw stays');
  assert.equal(args.notjson, '{broken');
});

test('--set pair without = is a hard usage error', () => {
  const bad = parseSetPairs(['broken']);
  assert.ok(bad.errors.length > 0);
  assert.ok(bad.errors[0].includes('--set expects key=value'));
  const emptyKey = parseSetPairs(['=value']);
  assert.ok(emptyKey.errors.length > 0);
});

test('--args-file reads a JSON object and rejects non-objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'args-file-'));
  try {
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, '{"scenario":"p2","level":2}');
    assert.deepEqual(readArgsFile(good).args, { scenario: 'p2', level: 2 });

    const array = path.join(dir, 'array.json');
    fs.writeFileSync(array, '[1,2]');
    assert.ok(readArgsFile(array).error?.includes('must contain a JSON object'));

    const invalid = path.join(dir, 'invalid.json');
    fs.writeFileSync(invalid, '{nope');
    assert.ok(readArgsFile(invalid).error?.includes('not valid JSON'));

    assert.ok(readArgsFile(path.join(dir, 'missing.json')).error?.includes('cannot read'));
    assert.deepEqual(readArgsFile(undefined).args, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('composeScriptArgs precedence: --args < --args-file < --set (later channel wins)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-args-'));
  try {
    const file = path.join(dir, 'file.json');
    fs.writeFileSync(file, '{"scenario":"from-file","level":1,"fromFileOnly":true}');

    const merged = composeScriptArgs({
      argsJson: '{"scenario":"from-json","fromJsonOnly":true}',
      argsFile: file,
      setPairs: ['scenario=from-set', 'level=9'],
    });
    assert.equal(merged.error, undefined);
    assert.equal(merged.args!.scenario, 'from-set', '--set overrides both other channels');
    assert.equal(merged.args!.level, 9, '--set overrides --args-file');
    assert.equal(merged.args!.fromJsonOnly, true, '--args keys survive without conflicts');
    assert.equal(merged.args!.fromFileOnly, true, '--args-file keys survive without conflicts');

    // --set alone (the PowerShell-safe default channel) still works.
    const setsOnly = composeScriptArgs({ setPairs: ['a=1'] });
    assert.deepEqual(setsOnly.args, { a: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('composeScriptArgs reports channel errors instead of throwing', () => {
  assert.ok(composeScriptArgs({ argsJson: '{broken' }).error?.includes('--args is not valid JSON'));
  assert.ok(composeScriptArgs({ argsJson: '[1]' }).error?.includes('must be a JSON object'));
  assert.ok(composeScriptArgs({ argsFile: 'Z:/nope/missing.json' }).error?.includes('cannot read'));
  assert.ok(composeScriptArgs({ setPairs: ['noeq'] }).error?.includes('--set expects key=value'));
});
