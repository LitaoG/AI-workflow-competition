import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { providerRegistry } from '../../src/agent/provider.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.js';

/**
 * A provider that reports a structured quota reset on its first call (the shape
 * canonical quota-reset contract consumes: `quotaLimits = { status: 'rejected', resetsAt }`),
 * then succeeds. `resetsAt` is epoch seconds.
 */
class QuotaResetProvider implements LLMProvider {
  calls = 0;
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly resetInSeconds: number,
  ) {}

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      const err = new Error('HTTP 429: quota exceeded for this billing period');
      (err as Error & { details?: unknown }).details = {
        provider: this.id,
        retryable: false,
        quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + this.resetInSeconds },
      };
      throw err;
    }
    return { content: JSON.stringify({ healthStatus: 'HEALTHY' }), model: 'quota-reset', latencyMs: 1 };
  }
}

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-quota-wait-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* transient Windows lock */
      }
    },
  };
}

function scriptFor(providerId: string): string {
  return `
phase("Quota");
const out = await agent("quota-worker", { provider: "${providerId}" }).ask<Answer>("inspect health report of the service");
return { status: out.healthStatus };

interface Answer { healthStatus: string; }
`;
}

test('quota reset within the run deadline is waited out and retried on the same provider', async () => {
  const provider = new QuotaResetProvider('quota-reset-near', 'Quota reset near', 1);
  providerRegistry.register(provider);
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'quota-near.facade.ts');
    fs.writeFileSync(scriptPath, scriptFor(provider.id));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const r = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      runTimeoutMs: 20000,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.status, 'completed', r.error);
    assert.equal((r.value as { status: string }).status, 'HEALTHY');
    assert.equal(provider.calls, 2, 'the ask retried after the reset instead of policy-stopping');
    const wait = events.find((e) => e.type === 'dwf_failover' && e.data.action === 'wait');
    assert.ok(wait, `expected a wait event, got: ${JSON.stringify(events.filter((e) => e.type === 'dwf_failover'))}`);
    assert.ok(Number(wait!.data.waitMs) >= 1000, 'the wait covers the reset plus a grace second');
  } finally {
    ws.cleanup();
  }
});

test('a reset beyond the run deadline keeps the existing policy stop (no blind sleep)', async () => {
  const provider = new QuotaResetProvider('quota-reset-far', 'Quota reset far', 3600);
  providerRegistry.register(provider);
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'quota-far.facade.ts');
    fs.writeFileSync(scriptPath, scriptFor(provider.id));
    const r = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      runTimeoutMs: 5000,
      onEvent: () => undefined,
    });
    assert.equal(r.status, 'stopped', `expected stopped(provider), got ${r.status}: ${r.error}`);
    assert.match(r.error ?? '', /quota exceeded/i);
    assert.equal(provider.calls, 1, 'a reset outside the deadline must not retry-storm');
  } finally {
    ws.cleanup();
  }
});