import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCPClientManager, expandEnvRefs } from '../../dist/src/mcp/client.js';
import { McpConfigError } from '../../dist/src/index.js';

// Issue #106 invariants for the run-scoped MCP pool (src/mcp/client.ts):
// 1. `${VAR}` / `${VAR:-default}` expansion matches a reference model, and an
//    unset `${VAR}` always fails with McpConfigError naming VAR.
// 2. Any burst of concurrent first calls opens exactly one handshake per server.

const STDIO = { transport: 'stdio' as const, command: 'unused-by-factory' };

async function echoTransport(serverName: string) {
  const server = new Server({ name: `echo-${serverName}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text' as const, text: `${serverName}:${String(request.params.arguments?.text ?? '')}` }],
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return clientSide;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

type Segment =
  | { kind: 'lit'; text: string }
  | { kind: 'ref'; name: string }
  | { kind: 'def'; name: string; fallback: string };

const NAMES = ['A', 'B_1', 'c', '_D'] as const;
const literal = fc.string({ maxLength: 6 }).filter((s) => !/[${}]/.test(s));
const segment: fc.Arbitrary<Segment> = fc.oneof(
  literal.map((text) => ({ kind: 'lit' as const, text })),
  fc.constantFrom(...NAMES).map((name) => ({ kind: 'ref' as const, name })),
  fc.tuple(fc.constantFrom(...NAMES), literal).map(([name, fallback]) => ({ kind: 'def' as const, name, fallback }))
);
const envValue = fc.option(fc.string({ maxLength: 5 }), { nil: undefined });
const envArb = fc.record({ A: envValue, B_1: envValue, c: envValue, _D: envValue });

function render(segments: Segment[]): string {
  return segments
    .map((s) => (s.kind === 'lit' ? s.text : s.kind === 'ref' ? `\${${s.name}}` : `\${${s.name}:-${s.fallback}}`))
    .join('');
}

/** Reference semantics: single left-to-right pass; the first unset `${VAR}` aborts. */
function model(segments: Segment[], env: Record<string, string | undefined>): { ok: string } | { missing: string } {
  let out = '';
  for (const s of segments) {
    if (s.kind === 'lit') {
      out += s.text;
    } else if (s.kind === 'ref') {
      const value = env[s.name];
      if (value === undefined) return { missing: s.name };
      out += value;
    } else {
      const value = env[s.name];
      out += value === undefined ? s.fallback : value; // an empty string counts as set
    }
  }
  return { ok: out };
}

describe('Engine PBT: MCP lazy connect invariants (Issue #106)', () => {
  test('PBT: expandEnvRefs agrees with the ${VAR} / ${VAR:-default} reference model', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), envArb, (segments, env) => {
        const template = render(segments);
        const expected = model(segments, env);
        if ('ok' in expected) {
          assert.equal(expandEnvRefs(template, env, 'pbt'), expected.ok);
        } else {
          assert.throws(
            () => expandEnvRefs(template, env, 'pbt'),
            (err: unknown) => err instanceof McpConfigError && err.message.includes(`"${expected.missing}"`)
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  test('PBT: concurrent first calls open exactly one handshake per server', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 16 }),
        fc.record({ a: fc.nat({ max: 3 }), b: fc.nat({ max: 3 }), c: fc.nat({ max: 3 }) }),
        async (targets, delays) => {
          const handshakes = new Map<string, number>();
          const manager = new MCPClientManager(false, {
            servers: { a: STDIO, b: STDIO, c: STDIO },
            transportFactory: async (name: string) => {
              handshakes.set(name, (handshakes.get(name) ?? 0) + 1);
              await new Promise((resolve) => setTimeout(resolve, delays[name as 'a' | 'b' | 'c']));
              return echoTransport(name);
            },
          });
          try {
            const results = await Promise.all(
              targets.map((name, i) => manager.callTool(name, 'echo', { text: String(i) }))
            );
            results.forEach((result, i) => assert.equal(textOf(result), `${targets[i]}:${i}`));
            const used = new Set(targets);
            assert.equal(handshakes.size, used.size);
            for (const name of used) assert.equal(handshakes.get(name), 1);
          } finally {
            await manager.disconnectAll();
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});
