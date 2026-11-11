/**
 * Issue #127 (direction 3): the MCP execute face runs scripts the CALLER
 * names — without a boundary, a prompt-injected workflow_script_run can point
 * at any file on the machine. The resolved script path must stay inside the
 * workspace cwd the call declares; escapes fail before anything spawns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuiltinWorkflowMCPServer } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function withSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'path-guard-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.getServer().connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  }
}

test('workflow_script_run refuses a script path that escapes the workspace cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  try {
    await withSession(async (client) => {
      const res = (await client.callTool({
        name: 'workflow_script_run',
        arguments: { scriptPath: path.join(os.tmpdir(), 'elsewhere', 'evil.facade.ts'), cwd },
      })) as { isError?: boolean; content?: Array<{ type: string; text: string }> };
      assert.equal(res.isError, true, 'the escape attempt fails');
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.match(text, /outside the workspace cwd/, 'the boundary message names the rule');
    });
  } finally {
    // Issue #224: the sandbox child's cwd handle outlives client.close() for a
    // moment on Windows — bounded rmSync retries ride out the EPERM window
    // (same pattern as tests/e2e/helpers/env.ts; slower exit race → 5×200ms).
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('workflow_script_run accepts a script inside the workspace cwd (boundary stays porous inward)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  try {
    // A minimal facade script inside the workspace; the run itself fails on
    // the missing journal/provider surface is fine — the BOUNDARY must not be
    // what rejects it.
    fs.writeFileSync(path.join(cwd, 'ok.facade.ts'), 'phase("p");\nreturn 1;\n');
    await withSession(async (client) => {
      const res = (await client.callTool({
        name: 'workflow_script_run',
        arguments: { scriptPath: 'ok.facade.ts', cwd },
      })) as { isError?: boolean; content?: Array<{ type: string; text: string }> };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.doesNotMatch(text, /outside the workspace cwd/, 'the boundary is not what rejected an inside-workspace script');
    });
  } finally {
    // Issue #224: the sandbox child's cwd handle outlives client.close() for a
    // moment on Windows — bounded rmSync retries ride out the EPERM window
    // (same pattern as tests/e2e/helpers/env.ts; slower exit race → 5×200ms).
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('workflow_script_check refuses a script path that escapes the workspace cwd (Issue #194 P2)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  try {
    await withSession(async (client) => {
      // The check face only READS files — TS diagnostics can embed source
      // fragments and ENOENT/EISDIR is a path-existence oracle, so the read
      // surface must sit behind the same cwd boundary as the execute face.
      const res = (await client.callTool({
        name: 'workflow_script_check',
        arguments: { scriptPath: path.join(os.tmpdir(), 'elsewhere', 'evil.facade.ts'), cwd },
      })) as { isError?: boolean; content?: Array<{ type: string; text: string }> };
      assert.equal(res.isError, true, 'the escape attempt fails before any read');
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.match(text, /outside the workspace cwd/, 'the boundary message names the rule');
    });
  } finally {
    // Issue #224: the sandbox child's cwd handle outlives client.close() for a
    // moment on Windows — bounded rmSync retries ride out the EPERM window
    // (same pattern as tests/e2e/helpers/env.ts; slower exit race → 5×200ms).
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('workflow_script_check honors the declared cwd for an inside-workspace script (Issue #194 P2)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  try {
    fs.writeFileSync(path.join(cwd, 'ok.facade.ts'), 'phase("p");\nreturn 1;\n');
    await withSession(async (client) => {
      const res = (await client.callTool({
        name: 'workflow_script_check',
        arguments: { scriptPath: 'ok.facade.ts', cwd },
      })) as { isError?: boolean; content?: Array<{ type: string; text: string }> };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.doesNotMatch(text, /outside the workspace cwd/, 'the boundary must not reject an inside-workspace script');
      assert.match(text, /"ok": true/, 'a successful check returns the analysis JSON');
    });
  } finally {
    // Issue #224: the sandbox child's cwd handle outlives client.close() for a
    // moment on Windows — bounded rmSync retries ride out the EPERM window
    // (same pattern as tests/e2e/helpers/env.ts; slower exit race → 5×200ms).
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
