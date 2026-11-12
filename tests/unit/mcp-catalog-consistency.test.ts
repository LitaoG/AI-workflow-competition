/**
 * (Issue #153): the MCP tool catalog and the real
 * protocol face must never drift — `workflow mcp list` renders what
 * tools/list returns (TOOL_CATALOG), and every cataloged tool must actually
 * dispatch (no虚标). Drives the REAL BuiltinWorkflowMCPServer over
 * InMemoryTransport, the same face the stdio server exposes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BuiltinWorkflowMCPServer, TOOL_CATALOG } from '../../src/mcp/server.js';

async function withSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-consistency-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.getServer().connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  }
}

const LEGACY_TOOLS = ['workflow_run', 'workflow_probe', 'workflow_inspect', 'workflow_replay', 'workflow_graph'];
const FACADE_TOOLS = ['workflow_script_check', 'workflow_script_run', 'workflow_run_script', 'workflow_inspect_run', 'workflow_get_run'];

test('tools/list over the wire equals the TOOL_CATALOG exactly (no virtual listings)', async () => {
  await withSession(async (client) => {
    const res = await client.listTools();
    const wire = res.tools.map((t) => t.name).sort();
    const catalog = TOOL_CATALOG.map((t) => t.name).sort();
    assert.deepEqual(wire, catalog, 'tools/list must render the catalog verbatim');
    assert.equal(wire.length, 10, 'the face is 5 legacy + 5 facade tools');
  });
});

test('the five legacy tools are marked deprecated with a facade pointer; facade tools are not', async () => {
  // The structured flag lives on the catalog source (the SDK's tools/list
  // schema strips unknown fields, so the wire carries the description marker).
  const catalogByName = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
  for (const name of LEGACY_TOOLS) {
    const tool = catalogByName.get(name);
    assert.ok(tool, `${name} is cataloged`);
    assert.equal(tool!.deprecated, true, `${name} carries the deprecated flag in the catalog`);
  }
  for (const name of FACADE_TOOLS) {
    assert.notEqual(catalogByName.get(name)?.deprecated, true, `${name} is the live face, not deprecated`);
  }

  // Over the wire, the description marker is the visible surface.
  await withSession(async (client) => {
    const res = await client.listTools();
    const byName = new Map(res.tools.map((t) => [t.name, t]));
    for (const name of LEGACY_TOOLS) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is listed`);
      assert.match(tool!.description ?? '', /\[legacy — prefer [^\]]+\]/, `${name}'s description points at the facade face`);
    }
    for (const name of FACADE_TOOLS) {
      assert.doesNotMatch(byName.get(name)!.description ?? '', /\[legacy/, `${name}'s description carries no legacy pointer`);
    }
  });
});

test('every cataloged tool dispatches: a call never answers "unknown tool" (no虚标)', async () => {
  await withSession(async (client) => {
    for (const tool of TOOL_CATALOG) {
      // Deliberately invalid/absent arguments: a KNOWN tool answers with a
      // schema/usage error (isError about the args or a redacted error body);
      // an uncataloged name would answer "Unknown tool". Either way the
      // dispatch must recognize the name.
      const res = (await client.callTool({ name: tool.name, arguments: {} })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.doesNotMatch(text, /unknown tool/i, `${tool.name} must be a dispatched tool, not a virtual listing`);
    }
  });
});

test('a name outside the catalog is refused as unknown (negative control)', async () => {
  await withSession(async (client) => {
    // The dispatch's default throws "Unknown MCP tool" — a protocol-level
    // rejection, not an isError result.
    await assert.rejects(
      client.callTool({ name: 'workflow_definitely_not_a_tool', arguments: {} }),
      /Unknown MCP tool/i,
      'the negative control must fail as unknown',
    );
  });
});
