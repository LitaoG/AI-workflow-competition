import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexCliProvider,
  GeminiCliProvider,
  OpenCodeProvider,
  configureCliProvidersFromEnv,
} from '../../src/agent/cli-providers.js';
import { providerRegistry } from '../../src/agent/provider.js';
import { agent } from '../../src/agent/rpc.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A deterministic fake "agent CLI": echoes the prompt back as JSON. */
function makeFakeCli(): { command: string; scriptPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-'));
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      'const prompt = process.argv[2] ?? "";',
      'const asked = JSON.stringify({ prompt });',
      '// Reply like a model would when told to emit JSON:',
      'console.log(JSON.stringify({ echo: prompt.length, asked }));',
    ].join('\n'),
  );
  return { command: process.execPath, scriptPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const fake = makeFakeCli();

test('CodexCliProvider routes the flattened turn through a supervised spawn', async () => {
  const provider = new CodexCliProvider({
    command: fake.command,
    argsPrefix: [fake.scriptPath],
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
  });
  const res = await provider.generate({
    messages: [
      { role: 'system', content: 'Respond with JSON.' },
      { role: 'user', content: 'review this diff' },
    ],
  });
  assert.equal(res.model, 'codex-cli:cli');
  const parsed = JSON.parse(res.content) as { echo: number; asked: string };
  assert.ok(parsed.echo > 0);
  const asked = JSON.parse(parsed.asked) as { prompt: string };
  assert.ok(asked.prompt.includes('Respond with JSON.'), 'system prompt must reach the CLI');
  assert.ok(asked.prompt.includes('review this diff'));
  fake.cleanup();
});

test('all three CLI providers share the same supervised-spawn path', async () => {
  const scriptPath = path.join(os.tmpdir(), 'fake-cli-shared.mjs');
  fs.writeFileSync(scriptPath, 'console.log(JSON.stringify({ ok: true }));');
  const providers = [
    new CodexCliProvider({ command: process.execPath, argsPrefix: [scriptPath] }),
    new GeminiCliProvider({ command: process.execPath, argsPrefix: [scriptPath] }),
    new OpenCodeProvider({ command: process.execPath, argsPrefix: [scriptPath] }),
  ];
  for (const p of providers) {
    const res = await p.generate({ messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(JSON.parse(res.content).ok, true, `${p.id} failed`);
  }
  fs.rmSync(scriptPath, { force: true });
});

test('configureCliProvidersFromEnv selects and defaults; unknown is a no-op', () => {
  const before = providerRegistry.get().id;
  assert.equal(configureCliProvidersFromEnv({ AI_WORKFLOW_PROVIDER: 'not-a-thing' }), undefined);
  assert.equal(providerRegistry.get().id, before, 'unknown selection must not change the default');

  const selected = configureCliProvidersFromEnv({ AI_WORKFLOW_PROVIDER: 'opencode' });
  assert.equal(selected, 'opencode');
  assert.equal(providerRegistry.get().id, 'opencode');
  const anyProvider = providerRegistry.get();
  assert.equal(anyProvider.id, 'opencode');

  // Restore the mock default for other tests.
  providerRegistry.setDefault('mock');
});

test('end-to-end: facade-style ask through a CLI provider with a schema', async () => {
  const scriptPath = path.join(os.tmpdir(), 'fake-cli-e2e.mjs');
  fs.writeFileSync(
    scriptPath,
    'const prompt = process.argv[2] ?? "";\nconsole.log(JSON.stringify({ status: "OK", promptLen: prompt.length }));',
  );
  const { z } = await import('zod');
  const provider = new OpenCodeProvider({ command: process.execPath, argsPrefix: [scriptPath] });
  providerRegistry.register(provider);
  providerRegistry.setDefault(provider.id);
  try {
    const result = await agent('worker').ask(
      'say OK back',
      z.object({ status: z.string(), promptLen: z.number() }),
      { maxRetries: 1 },
    );
    assert.equal(result.status, 'OK');
    assert.ok(result.promptLen > 0);
  } finally {
    fs.rmSync(scriptPath, { force: true });
    providerRegistry.setDefault('mock');
  }
});

test('promptMode: "stdin" delivers prompt via stdin and handles large context (>32KB) without argv limitation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-stdin-'));
  const scriptPath = path.join(dir, 'fake-cli-stdin.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      'import * as fs from "node:fs";',
      'const stdin = fs.readFileSync(0, "utf8");',
      'const argvPrompt = process.argv[2] ?? "";',
      'console.log(JSON.stringify({ stdinLen: stdin.length, hasArgv: argvPrompt.length > 0, echo: stdin.slice(0, 30) }));',
    ].join('\n'),
  );

  try {
    const provider = new CodexCliProvider({
      command: process.execPath,
      argsPrefix: [scriptPath],
      promptMode: 'stdin',
      timeoutMs: 30_000,
    });

    // 1. Normal prompt verification
    const resNormal = await provider.generate({
      messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'User question' },
      ],
    });
    const parsedNormal = JSON.parse(resNormal.content) as { stdinLen: number; hasArgv: boolean; echo: string };
    assert.equal(parsedNormal.hasArgv, false, 'prompt should not be passed via argv in stdin mode');
    assert.ok(parsedNormal.stdinLen > 0);
    assert.ok(parsedNormal.echo.includes('System instruction'));

    // 2. Large context (>32KB, e.g. 40KB) that exceeds Windows argv/command line limits
    const largeMessage = 'A'.repeat(40_000);
    const resLarge = await provider.generate({
      messages: [{ role: 'user', content: largeMessage }],
    });
    const parsedLarge = JSON.parse(resLarge.content) as { stdinLen: number; hasArgv: boolean; echo: string };
    assert.equal(parsedLarge.hasArgv, false, 'large prompt must not touch argv');
    assert.equal(parsedLarge.stdinLen, 40_000, 'all 40KB must be faithfully transmitted through stdin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configureCliProvidersFromEnv respects AI_WORKFLOW_CLI_PROMPT_MODE=stdin', () => {
  const selected = configureCliProvidersFromEnv({
    AI_WORKFLOW_PROVIDER: 'gemini',
    AI_WORKFLOW_CLI_PROMPT_MODE: 'stdin',
  });
  assert.equal(selected, 'gemini-cli');
  const provider = providerRegistry.get() as any;
  assert.equal(provider.promptMode, 'stdin');

  // Case-insensitive / whitespace-tolerant check
  configureCliProvidersFromEnv({
    AI_WORKFLOW_PROVIDER: 'codex',
    AI_WORKFLOW_CLI_PROMPT_MODE: ' STDIN ',
  });
  const codexProvider = providerRegistry.get() as any;
  assert.equal(codexProvider.promptMode, 'stdin');

  providerRegistry.setDefault('mock');
});
