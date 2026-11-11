import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Workflow } from '../../src/core/workflow.js';
import { SchemaValidationError } from '../../src/agent/schema-validation-error.js';
import { actionStep, gateStep } from '../../src/core/step.js';
import {
  GateFailureError,
  McpToolError,
  StepExecutionError,
  WorkflowAbortedError,
  withRetry,
} from '../../src/core/error.js';
import { WorkflowExecutionContext } from '../../src/core/context.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { ExecutionContext, LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

// Issue #120: failure paths of the builder engine that pay twice.
// A. A step with a retryPolicy reran on deterministic errors (`isRecoverable: false`),
//    paying again for every model call before the failure point.
// B. In a parallel batch, the first failure rejected `Promise.all` at once: sibling
//    steps kept calling models nobody would read, and `Workflow.run()` closed the MCP
//    connections while a sibling was still in a tool call.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STDIO_TEST_TIMEOUT_MS = 30_000;
const OK_SCHEMA = z.object({ ok: z.boolean() });

type CountingProvider = LLMProvider & { calls: number };

/** A provider that answers `{"ok":true}` and counts every model call. */
function countingProvider(id: string): CountingProvider {
  const provider: CountingProvider = {
    id,
    name: `counting provider ${id}`,
    calls: 0,
    async generate(): Promise<LLMResponse> {
      provider.calls++;
      return { content: '{"ok":true}', model: 'counting', latencyMs: 0 };
    },
  };
  providerRegistry.register(provider);
  return provider;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One step that asks a model once and then fails with `failure`; returns the model call count. */
async function askThenFail(
  providerId: string,
  failure: () => Error,
  retryPolicy: { maxRetries: number; initialDelayMs: number; retryableErrorFilter?: (error: Error) => boolean }
): Promise<number> {
  const provider = countingProvider(providerId);
  const wf = new Workflow({ name: `issue-120-${providerId}` });
  wf.addPhase({ id: 'p1', name: 'Ask then fail' });
  wf.addStep({
    ...actionStep<unknown, unknown>({
      id: 'step',
      name: 'Ask a model, then hit a failure',
      phaseId: 'p1',
      action: async (_input: unknown, ctx: ExecutionContext) => {
        await ctx.agent('planner').ask('plan the change', OK_SCHEMA, { providerId });
        throw failure();
      },
    }),
    retryPolicy,
  });
  await assert.rejects(wf.run(), (err: unknown) => err instanceof StepExecutionError && err.stepId === 'step');
  return provider.calls;
}

test('#120 A: a step with a retryPolicy does not rerun on a non-recoverable error (McpToolError)', async () => {
  const calls = await askThenFail('issue120-a-tool', () => new McpToolError('files', 'write_file', 'bad arguments'), {
    maxRetries: 2,
    initialDelayMs: 1,
  });
  assert.equal(calls, 1, 'the model call before a deterministic failure is paid once, not once per retry');
});

test('#120 A: an error without isRecoverable is still retried (unchanged behaviour)', async () => {
  const calls = await askThenFail('issue120-a-plain', () => new Error('flaky network'), { maxRetries: 2, initialDelayMs: 1 });
  assert.equal(calls, 3, 'one attempt plus two retries');
});

test('#120 A: a retryableErrorFilter still decides alone', async () => {
  const calls = await askThenFail('issue120-a-filter', () => new McpToolError('files', 'write_file', 'locked, try again'), {
    maxRetries: 2,
    initialDelayMs: 1,
    retryableErrorFilter: () => true,
  });
  assert.equal(calls, 3, 'the filter can opt a non-recoverable error back into retries');
});

test('#120 B: when a parallel sibling fails, the other step makes no further model calls', async () => {
  const provider = countingProvider('issue120-b-late');
  const wf = new Workflow({ name: 'issue-120-b' });
  wf.addPhase({ id: 'p1', name: 'Parallel batch' });
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'fails',
      name: 'Fails at once',
      phaseId: 'p1',
      action: async () => {
        throw new Error('boom');
      },
    })
  );
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'late',
      name: 'Asks a model after 200 ms',
      phaseId: 'p1',
      action: async (_input: unknown, ctx: ExecutionContext) => {
        await sleep(200);
        return ctx.agent('late').ask('summarise', OK_SCHEMA, { providerId: 'issue120-b-late' });
      },
    })
  );
  await assert.rejects(wf.run(), (err: unknown) => err instanceof StepExecutionError && err.stepId === 'fails');
  await sleep(400); // a sibling the engine did not wait for would make its call in this window
  assert.equal(provider.calls, 0, 'no model call is made after the batch has already failed');
});

// One-line ESM MCP server (imports resolve from cwd = repo root): `echo` answers at
// once, `slow` answers after 3 s. That is longer than the SDK's 2 s graceful close
// before SIGTERM (`StdioClientTransport.close`), so closing the connection under a
// running `slow` call cuts the tool off half-way. It writes its pid for the exit check.
const MCP_SERVER_SRC = [
  "import { writeFileSync } from 'node:fs';",
  "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
  "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
  "import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
  'writeFileSync(process.env.MCP_PID_FILE, String(process.pid));',
  "const server = new Server({ name: 'slow-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });",
  "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }, { name: 'slow', inputSchema: { type: 'object' } }] }));",
  "server.setRequestHandler(CallToolRequestSchema, async (r) => { if (r.params.name === 'slow') { await new Promise((res) => setTimeout(res, 3000)); return { content: [{ type: 'text', text: 'slow done' }] }; } return { content: [{ type: 'text', text: 'echo:' + String(r.params.arguments?.text ?? '') }] }; });",
  'await server.connect(new StdioServerTransport());',
].join(' ');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

test(
  '#120 B: a sibling failure lets an in-flight MCP call finish, starts no new one, and the run waits before closing MCP',
  { timeout: STDIO_TEST_TIMEOUT_MS },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue120-mcp-'));
    const pidFile = path.join(dir, 'mcp.pid');
    const log: string[] = [];
    let markSlowCallStarted!: () => void;
    const slowCallStarted = new Promise<void>((resolve) => {
      markSlowCallStarted = resolve;
    });
    try {
      const wf = new Workflow({ name: 'issue-120-b-mcp' });
      wf.addPhase({ id: 'p1', name: 'Parallel batch' });
      wf.addStep(
        actionStep<unknown, unknown>({
          id: 'fails',
          name: 'Fails while the sibling is inside a tool call',
          phaseId: 'p1',
          action: async () => {
            await Promise.race([slowCallStarted, sleep(15_000)]);
            throw new Error('boom');
          },
        })
      );
      wf.addStep(
        actionStep<unknown, unknown>({
          id: 'tools',
          name: 'Runs a slow tool, then tries another one',
          phaseId: 'p1',
          action: async (_input: unknown, ctx: ExecutionContext) => {
            await ctx.mcp!.callTool('slow', 'echo', { text: 'warm-up' });
            const slow = ctx.mcp!.callTool('slow', 'slow', {});
            markSlowCallStarted();
            await slow.then(
              () => log.push('slow done'),
              (err: unknown) => log.push(`slow failed: ${(err as Error).message}`)
            );
            await ctx.mcp!.callTool('slow', 'echo', { text: 'after' }).then(
              () => log.push('second call ran'),
              (err: unknown) => log.push((err as Error).name)
            );
            return 'finished';
          },
        })
      );
      await assert.rejects(
        wf.run({
          mcpServers: {
            slow: {
              transport: 'stdio',
              command: process.execPath,
              args: ['--input-type=module', '-e', MCP_SERVER_SRC],
              env: { MCP_PID_FILE: pidFile },
              cwd: REPO_ROOT,
            },
          },
        }),
        (err: unknown) => err instanceof StepExecutionError && err.stepId === 'fails'
      );
      assert.deepEqual(
        log,
        ['slow done', 'WorkflowAbortedError'],
        'the in-flight call finished, the next one was refused, and the run waited for both'
      );
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(await waitForExit(pid), `stdio server ${pid} must exit once the run ends`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('#130: withRetry never retries a SchemaValidationError under its default filter', async () => {
  // The ask layer already burns maxRetries repair turns before throwing the
  // terminal SchemaValidationError (Issue #110's class — isRecoverable=false).
  // Re-running the whole step on top of that would triple-bill a deterministic
  // failure (temperature 0.0): one schema failure must cost exactly one call.
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new SchemaValidationError('step-schema', 'raw', [], 3);
      },
      { maxRetries: 2 }
    ),
    (err: unknown) => err instanceof SchemaValidationError
  );
  assert.equal(calls, 1, 'the terminal schema failure must not be retried by default');
});

test('#120: withRetry stops at once when its signal aborts during the backoff', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const started = Date.now();
  setTimeout(() => controller.abort('stop'), 50);
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new Error('transient');
      },
      { maxRetries: 5, initialDelayMs: 10_000 },
      controller.signal
    ),
    /transient/
  );
  assert.equal(attempts, 1, 'no attempt starts after the abort');
  assert.ok(Date.now() - started < 2_000, 'the 10 s backoff ended when the signal aborted');
});

test('#120: a cancelled step context refuses new model, MCP and gate calls', async () => {
  const provider = countingProvider('issue120-ctx');
  const root = new WorkflowExecutionContext({ workflowId: 'issue-120-ctx' });
  const controller = new AbortController();
  const ctx = root.createChildContext('s1', controller.signal);
  try {
    assert.equal(ctx.signal, controller.signal);
    assert.equal(root.signal, undefined, 'the root context carries no step signal');
    controller.abort('sibling step "x" failed');
    await assert.rejects(
      ctx.agent('a').ask('q', OK_SCHEMA, { providerId: 'issue120-ctx' }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError'
    );
    await assert.rejects(
      ctx.mcp!.callTool('srv', 'tool', {}),
      (err: unknown) => err instanceof WorkflowAbortedError && /sibling step "x" failed/.test(err.message)
    );
    await assert.rejects(ctx.gate('node -e "process.exit(0)"'), (err: unknown) => err instanceof WorkflowAbortedError);
    assert.equal(provider.calls, 0, 'no model call after the abort');
  } finally {
    await root.disposeMcp();
  }
});

test('#120: a call-level signal still cancels an ask on a context without a step signal', async () => {
  const provider = countingProvider('issue120-call-signal');
  const root = new WorkflowExecutionContext({ workflowId: 'issue-120-call-signal' });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      root.agent('a').ask('q', OK_SCHEMA, { providerId: 'issue120-call-signal', signal: controller.signal }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError'
    );
    assert.equal(provider.calls, 0);
  } finally {
    await root.disposeMcp();
  }
});

test('#120 review F3: a cancelled sibling is recorded as cancelled, not as a second root failure', async () => {
  countingProvider('issue120-f3');
  const wf = new Workflow({ name: 'issue-120-f3' });
  const failed: Array<{ stepId?: string; data: Record<string, unknown> }> = [];
  wf.on('step_failed', (event: { stepId?: string; data: Record<string, unknown> }) => failed.push(event));
  wf.addPhase({ id: 'p1', name: 'Parallel batch' });
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'fails',
      name: 'Fails at once',
      phaseId: 'p1',
      action: async () => {
        throw new Error('boom');
      },
    })
  );
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'late',
      name: 'Asks a model after 100 ms',
      phaseId: 'p1',
      action: async (_input: unknown, ctx: ExecutionContext) => {
        await sleep(100);
        return ctx.agent('late').ask('summarise', OK_SCHEMA, { providerId: 'issue120-f3' });
      },
    })
  );
  await assert.rejects(wf.run(), (err: unknown) => err instanceof StepExecutionError && err.stepId === 'fails');
  const byStep = new Map(failed.map((event) => [event.stepId, event.data]));
  assert.equal(byStep.get('fails')?.cancelled, undefined, 'the root failure is not marked cancelled');
  assert.equal(byStep.get('fails')?.error, 'boom');
  assert.equal(byStep.get('late')?.cancelled, true);
  assert.equal(byStep.get('late')?.cancelledBy, 'fails');
  assert.match(String(byStep.get('late')?.error), /^cancelled because sibling step "fails" failed/);
});

test('#131: an in-flight ask aborted with signal.reason (fetch semantics) is cancelled, not a second failure', async () => {
  // WHATWG fetch (undici included) rejects an aborted in-flight request with
  // `signal.reason` VERBATIM — whatever the abort reason is. With the pre-#131
  // string abort reason, that string flowed through the provider into
  // isCancellation (which only knows WorkflowAbortedError / AbortError), so
  // the cancelled sibling was recorded as a SECOND root failure with an empty
  // error. The batch now aborts with a WorkflowAbortedError instance.
  let calls = 0;
  const inflight: LLMProvider = {
    id: 'issue131-inflight',
    name: 'in-flight provider issue131',
    generate(request: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      // In flight until the abort lands; then reject like fetch does.
      return new Promise<LLMResponse>((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      });
    },
  };
  providerRegistry.register(inflight);
  const wf = new Workflow({ name: 'issue-131-inflight' });
  const failed: Array<{ stepId?: string; data: Record<string, unknown> }> = [];
  wf.on('step_failed', (event: { stepId?: string; data: Record<string, unknown> }) => failed.push(event));
  wf.addPhase({ id: 'p1', name: 'Parallel batch' });
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'fails',
      name: 'Fails while the sibling is in flight',
      phaseId: 'p1',
      // Hold just long enough for the sibling's ask to be genuinely in flight —
      // otherwise the pre-flight abort check (a different, already-covered path)
      // would fire instead.
      action: async () => {
        await sleep(100);
        throw new Error('boom');
      },
    })
  );
  wf.addStep(
    actionStep<unknown, unknown>({
      id: 'late',
      name: 'Asks a model that never answers',
      phaseId: 'p1',
      action: async (_input: unknown, ctx: ExecutionContext) =>
        ctx.agent('late').ask('summarise', OK_SCHEMA, { providerId: 'issue131-inflight' }),
    })
  );
  await assert.rejects(wf.run(), (err: unknown) => err instanceof StepExecutionError && err.stepId === 'fails');
  const byStep = new Map(failed.map((event) => [event.stepId, event.data]));
  assert.equal(byStep.get('late')?.cancelled, true, 'the in-flight sibling must be recognized as cancelled');
  assert.equal(byStep.get('late')?.cancelledBy, 'fails');
  assert.match(
    String(byStep.get('late')?.error),
    /^cancelled because sibling step "fails" failed/,
    `error must not be empty: ${JSON.stringify(byStep.get('late')?.error)}`,
  );
  assert.equal(calls, 1, 'a cancelled ask must not be retried');
});

test('#120 review F1: a failing gate is not retried by default; a retryableErrorFilter opts it back in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue120-gate-'));
  try {
    const cases: Array<{ label: string; filter?: (error: Error) => boolean; runs: number }> = [
      { label: 'default', runs: 1 },
      { label: 'filter', filter: (err: Error) => err instanceof GateFailureError, runs: 3 },
    ];
    for (const { label, filter, runs } of cases) {
      const counter = path.join(dir, `${label}.txt`);
      const wf = new Workflow({ name: `issue-120-gate-${label}` });
      wf.addPhase({ id: 'p1', name: 'Gate' });
      wf.addStep({
        ...gateStep({
          id: 'flaky',
          name: 'Gate that always fails and counts its runs',
          phaseId: 'p1',
          command: `node -e "require('fs').appendFileSync(process.argv[1], 'x'); process.exit(1)" "${counter}"`,
        }),
        retryPolicy: { maxRetries: 2, initialDelayMs: 1, retryableErrorFilter: filter },
      });
      await assert.rejects(wf.run(), (err: unknown) => err instanceof StepExecutionError && err.stepId === 'flaky');
      assert.equal(fs.readFileSync(counter, 'utf8').length, runs, `${label}: gate command runs`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
