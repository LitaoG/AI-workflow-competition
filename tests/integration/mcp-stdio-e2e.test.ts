import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 真实 stdio 端到端：像 ZCode 宿主那样 spawn `workflow mcp serve` 子进程，
// 用 StdioClientTransport 走真实 stdio 管道（非 InMemory）驱动全部工具面。
// 每个用例显式设 timeout（Issue #32 / AI-PITFALLS P-TEST-3）：负载下 connect 可挂起，
// 无超时则整轮测试卡死且无 not ok 行名；超时把挂起转化为可诊断失败。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'workflow.js');

// StdioClientTransport 的 connect 无内置超时：宿主机负载下 stdio 管道握手可无限挂起，
// node:test 的 timeout 只能标记失败、无法打断已挂死的 await（Issue #32 采样 5 轮 3 轮挂死实测，
// AI-PITFALLS P-TEST-3）。connect 与竞速超时绑定，失败时关闭 transport（杀子进程防泄漏），
// 把"整轮挂死"转化为带行名的快速失败。
const CONNECT_TIMEOUT_MS = 20_000;

async function connect(extraEnv?: Record<string, string>): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', 'serve'],
    stderr: 'pipe',
    // The SDK spawns the server with a default-inherited env allowlist
    // (getDefaultEnvironment, client/stdio.js) — arbitrary vars like
    // IGCCSVC_DB are stripped unless passed explicitly here.
    env: extraEnv,
  });

  const client = new Client({ name: 'zcode-host-sim', version: '1.0.0' }, { capabilities: {} });
  const cleanup = async (): Promise<void> => {
    await client.close();
    // Issue #147: client.close() asks the server to exit, but on Windows the
    // process object can briefly outlive the pipes — under concurrent test
    // load that window is long enough for (a) a following test's rmSync to
    // hit EPERM on a temp dir the server still holds, and (b) the surviving
    // stdio pipes to hang this process's event loop after the run summary
    // printed. Make death unconditional instead of racing it.
    const pid = transport.pid;
    if (pid) {
      try {
        process.kill(pid, 0); // throws if already dead
        process.kill(pid);
      } catch {
        /* already exited — the good case */
      }
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const connectTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stdio connect timed out after ${CONNECT_TIMEOUT_MS}ms (Issue #32 hang guard)`)),
      CONNECT_TIMEOUT_MS
    );
  });
  try {
    const result = await Promise.race([
      client.connect(transport).then(() => ({ client, cleanup })),
      connectTimeout,
    ]);
    // connect 成功：撤销超时定时器，避免 pending timer 吊住 event loop
    // （评审第 1 轮实测：不清除时每用例尾部多挂 ~20s）
    if (timer) clearTimeout(timer);
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    // connect 失败/超时：关闭 transport 终止子进程，避免孤儿进程泄漏
    transport.close().catch(() => {});
    throw err;
  }
}

function workspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-e2e-'));
  // Issue #147: maxRetries/retryDelay absorb the Windows window between a
  // dying server process releasing its journal-file handle and the OS making
  // the directory deletable — the observed EPERM race, not a permission bug.
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

const SCRIPT = `
phase('Inspect');
const health = await agent('inspector').ask<Health>('inspect health report of the service');
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

test('stdio e2e: real spawn lists all seven tools', { timeout: 60_000 }, async () => {
  const { client, cleanup } = await connect();
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    for (const expected of [
      'workflow_run',
      'workflow_probe',
      'workflow_inspect',
      'workflow_replay',
      'workflow_graph',
      'workflow_script_check',
      'workflow_script_run',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected} in [${names}]`);
    }
  } finally {
    await cleanup();
  }
});

test('stdio e2e: script_check + script_run + zero-cost resume over real stdio', { timeout: 60_000 }, async () => {
  const { client, cleanup } = await connect();
  const ws = workspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    // 1. check
    // Issue #194 P2: the check face is bounded by the declared cwd.
    const check = await client.callTool({ name: 'workflow_script_check', arguments: { scriptPath: 'script.facade.ts', cwd: ws.dir } });
    const checkText = JSON.parse((check.content as Array<{ text: string }>)[0]!.text);
    assert.equal(checkText.ok, true, JSON.stringify(checkText.diagnostics));
    assert.deepEqual(checkText.phases, ['Inspect']);

    // 2. run (mock provider default — offline)
    const run = await client.callTool({
      name: 'workflow_script_run',
      arguments: { scriptPath, cwd: ws.dir, dbPath: path.join(ws.dir, 'j.db') },
    });
    const runText = JSON.parse((run.content as Array<{ text: string }>)[0]!.text);
    assert.equal(runText.status, 'completed', JSON.stringify(runText));
    assert.equal((runText.value as { healthStatus: string }).healthStatus, 'HEALTHY');
    assert.equal(runText.stats.asks, 1);
    assert.match(runText.resumeHint as string, /resumeRunId/);

    // 3. resume at zero cost
    const resume = await client.callTool({
      name: 'workflow_script_run',
      arguments: { scriptPath, cwd: ws.dir, dbPath: path.join(ws.dir, 'j.db'), resumeRunId: runText.runId },
    });
    const resumeText = JSON.parse((resume.content as Array<{ text: string }>)[0]!.text);
    assert.equal(resumeText.status, 'completed');
    assert.equal(resumeText.stats.asks, 0, 'resume must replay at zero asks');
    assert.equal(resumeText.stats.replayHits, 1);
    assert.deepEqual(resumeText.value, runText.value);
  } finally {
    // Issue #147: release server-side handles (client close + unconditional
    // child kill) BEFORE deleting the workspace the run wrote its journal into
    // — the previous order (rm first, close after) raced the server's open
    // j.db handle and produced the EPERM.
    await cleanup();
    ws.cleanup();
  }
});

test('stdio e2e: workflow_probe returns real host telemetry', { timeout: 60_000 }, async () => {
  // Inject a synthetic IGCCSVC_DB through the transport env so the redaction
  // assertion below is unconditional on every machine (the SDK strips
  // non-allowlisted vars from the inherited environment).
  const FAKE_IGCCSVC_BLOB = 'A'.repeat(416); // real value's shape
  const { client, cleanup } = await connect({ IGCCSVC_DB: FAKE_IGCCSVC_BLOB });
  try {
    const probe = await client.callTool({ name: 'workflow_probe', arguments: {} });
    const probeText = JSON.parse((probe.content as Array<{ text: string }>)[0]!.text);
    assert.ok(probeText.system, 'probe must include system telemetry');
    assert.ok(probeText.git, 'probe must include git state');

    // Issue #36: single sanitized env snapshot — no plaintext sensitive keys.
    assert.ok(probeText.env, 'probe must include the sanitized env snapshot');
    assert.ok(
      !('sanitizedEnv' in probeText),
      'probe must not carry the redundant sanitizedEnv duplicate (Issue #36)'
    );
    assert.equal(
      probeText.env.IGCCSVC_DB,
      '***REDACTED***',
      'IGCCSVC_DB DPAPI blob must be redacted, never plaintext (Issue #36)'
    );
    assert.ok(
      !JSON.stringify(probeText).includes(FAKE_IGCCSVC_BLOB),
      'the injected blob must not leak anywhere in the probe response'
    );
    for (const [key, value] of Object.entries(probeText.env as Record<string, string>)) {
      if (/igccsvc_db|secret|token|password|credential|apikey|api_key/i.test(key)) {
        assert.equal(value, '***REDACTED***', `sensitive key ${key} must be redacted in probe output`);
      }
    }
  } finally {
    await cleanup();
  }
});
