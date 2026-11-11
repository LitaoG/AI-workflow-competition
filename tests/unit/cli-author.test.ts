// Issue #103 — `workflow author` unit tests. All providers are scripted fakes
// (LLMProvider DI), so no network and no real tokens are ever spent (F7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeAuthor } from '../../src/cli/commands/author.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

const GOOD_SCRIPT = [
  "phase('Solo');",
  "const v = await agent('worker').ask<{ n: number }>('give a number');",
  'report({ n: v.n });',
  'return v;',
].join('\n');

const BAD_SCRIPT = "import fs from 'node:fs';\nphase('Broken');";

/** Scripted provider: pops one entry per generate call; a string is content, an Error is thrown. */
function scriptedProvider(script: Array<string | Error>, usage?: { promptTokens?: number; completionTokens?: number }): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    id: 'scripted-author',
    name: 'Scripted Author Provider',
    calls,
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls.push(request);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return {
        content: next ?? '',
        model: 'scripted',
        usage: { promptTokens: usage?.promptTokens ?? 10, completionTokens: usage?.completionTokens ?? 0, totalTokens: 0 },
        latencyMs: 1,
      };
    },
  } as LLMProvider & { calls: LLMRequest[] };
}

function withCapturedConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
  return fn().then(
    (result) => {
      console.log = origLog;
      console.error = origError;
      return { result, logs, errors };
    },
    (err) => {
      console.log = origLog;
      console.error = origError;
      throw err;
    },
  );
}

function tmpOut(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'author-test-')), 'authored.workflow.ts');
}

test('author: self-heals one compile failure and writes the corrected script', async () => {
  const out = tmpOut();
  // First attempt carries an illegal import; the second is fenced (models fence anyway).
  const provider = scriptedProvider([BAD_SCRIPT, '```ts\n' + GOOD_SCRIPT + '\n```']);
  const { result, logs } = await withCapturedConsole(() => executeAuthor(['Check', 'project', 'health'], { out, providerInstance: provider }));
  assert.equal(result, 0);
  assert.equal(provider.calls.length, 2, 'exactly one retry after the compile failure');
  const retryPrompt = provider.calls[1]!.messages.find((m) => m.role === 'user')!.content;
  assert.match(retryPrompt, /Compiler diagnostics:/, 'the compile error is re-injected into the retry prompt');
  assert.match(retryPrompt, /node:fs/, 'the retry prompt quotes the failing script');
  const written = fs.readFileSync(out, 'utf8');
  assert.ok(written.includes("phase('Solo')"), 'the corrected script is written');
  assert.ok(!written.includes('```'), 'code fences are stripped');
  assert.ok(logs.some((l) => l.includes('ask sites: 1')), 'the summary lists the ask site count');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: three failing attempts exit non-zero with the last script and diagnostics (F7)', async () => {
  const out = tmpOut();
  // Two DIFFERENT broken shapes so the same-diagnostics early stop (F2) does
  // not fire first — this test exercises the 3-attempt cap itself.
  const otherBad = "phase('Other');\nconst q: DefinitelyNotAType = 1;";
  const provider = scriptedProvider([BAD_SCRIPT, otherBad, otherBad]);
  const { result, errors } = await withCapturedConsole(() => executeAuthor(['broken intent'], { out, providerInstance: provider }));
  assert.equal(result, 1);
  assert.equal(provider.calls.length, 3, 'the loop stops at the 3-attempt cap');
  assert.ok(errors.some((e) => e.includes('Last compiler diagnostics:')), 'diagnostics are surfaced');
  assert.ok(errors.some((e) => e.includes("phase('Other')")), 'the last script is surfaced');
  assert.ok(!fs.existsSync(out), 'nothing is written on failure');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: identical diagnostics twice stop the loop before the third paid call (F2)', async () => {
  const out = tmpOut();
  const provider = scriptedProvider([BAD_SCRIPT, BAD_SCRIPT]);
  const { result } = await withCapturedConsole(() => executeAuthor(['stuck intent'], { out, providerInstance: provider }));
  assert.equal(result, 1);
  assert.equal(provider.calls.length, 2, 'a third identical attempt is not paid for');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: a 429 is retried with backoff and then succeeds (F7)', async () => {
  const out = tmpOut();
  const provider = scriptedProvider([new Error('429 rate limit exceeded, try again later'), GOOD_SCRIPT]);
  const { result } = await withCapturedConsole(() => executeAuthor(['flaky intent'], { out, providerInstance: provider }));
  assert.equal(result, 0);
  assert.equal(provider.calls.length, 2, 'the rate-limited generation is retried once');
  assert.ok(fs.existsSync(out));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: an existing output file is refused without --force, before any provider call (F3)', async () => {
  const out = tmpOut();
  fs.writeFileSync(out, 'existing', 'utf8');
  const provider = scriptedProvider([GOOD_SCRIPT]);
  const { result, errors } = await withCapturedConsole(() => executeAuthor(['any intent'], { out, providerInstance: provider }));
  assert.equal(result, 1);
  assert.equal(provider.calls.length, 0, 'no model call is paid when the write would clobber');
  assert.ok(errors.some((e) => e.includes('--force')));
  assert.equal(fs.readFileSync(out, 'utf8'), 'existing', 'the existing file is untouched');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: the intent is redacted before it reaches the prompt (F4)', async () => {
  const out = tmpOut();
  const provider = scriptedProvider([GOOD_SCRIPT]);
  await withCapturedConsole(() =>
    executeAuthor(['deploy check with token=ghp_0123456789abcdefghij0123456789abcd in env'], { out, providerInstance: provider }),
  );
  const firstPrompt = provider.calls[0]!.messages.map((m) => m.content).join('\n');
  assert.ok(!firstPrompt.includes('ghp_0123456789abcdefghij0123456789abcd'), 'the raw credential never reaches the prompt');
  assert.ok(firstPrompt.includes('***REDACTED***'), 'the credential is masked in the prompt');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('author: a response cut off at the token ceiling is called out and the retry asks for a shorter script (F2)', async () => {
  const out = tmpOut();
  const provider = scriptedProvider([BAD_SCRIPT, GOOD_SCRIPT], { completionTokens: 64 });
  const { result } = await withCapturedConsole(() =>
    executeAuthor(['big intent'], { out, providerInstance: provider, maxTokens: 64 }),
  );
  assert.equal(result, 0);
  const retryPrompt = provider.calls[1]!.messages.find((m) => m.role === 'user')!.content;
  assert.match(retryPrompt, /CUT OFF at the token ceiling/, 'truncation is named as such in the retry prompt');
  assert.match(retryPrompt, /SHORTER, COMPLETE/, 'the retry asks for a shorter complete script');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});
