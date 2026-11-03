import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../../src/types.js';

/**
 * Evidence ledger at the journal saveNode point (the engine's evidence rules):
 * kind mapping (ask→inference, world ops→observation, failure→unknown),
 * inputHash agreement with dwf_nodes, token usage, and irreversible redaction
 * of user-derived content before it reaches SQLite.
 */

/** Fake, self-made token shapes — nothing here is a real credential. */
const FAKE_GITHUB_TOKEN = 'gho_0123456789abcdefghij0123456789abcd';

function makeEngine(runId: string, store: SQLiteStateStore & DwfJournalStore, workspace: string): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace,
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
  });
}

function actorFrame(id: number, siteId: string, name: string): { t: 'call'; id: number; op: 'createActor'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op: 'createActor', siteId, payload: [name] };
}

function callFrame(id: number, op: 'ask' | 'worldRead', siteId: string, payload: unknown[]): { t: 'call'; id: number; op: 'ask' | 'worldRead'; siteId: string; payload: unknown[] } {
  return { t: 'call', id, op, siteId, payload };
}

test('engine evidence: asks record inferences with token usage, world reads observations, and hashes agree with dwf_nodes', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-evidence-'));
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello evidence\n');
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-evidence', store, ws);

    // A deterministic world read (observation)…
    await engine.handleCall(callFrame(1, 'worldRead', 'glob#1', ['files.glob', '*.txt']));
    // …then an ask whose prompt carries a sensitive sample (inference).
    const actor = await engine.handleCall(actorFrame(2, 'actor#1', 'inspector'));
    await engine.handleCall(callFrame(3, 'ask', 'ask#1', [actor, `inspect the service with api_key=super-secret-value-123`, null]));

    const entries = await store.getDwfEvidence('dwfrun-evidence');
    assert.equal(entries.length, 2, 'one evidence entry per journalled node save');

    // Append (ordinal) order: the world read first, the ask second.
    assert.equal(entries[0]!.kind, 'observation');
    assert.equal(entries[0]!.provenance, 'dwf:worldRead:glob#1@1');
    assert.match(entries[0]!.label, /worldRead/);
    assert.equal(entries[1]!.kind, 'inference');
    assert.equal(entries[1]!.provenance, 'dwf:ask:ask#1@1');
    // The mock provider reports 42/88/130 per round-trip — the ask's usage is on the ledger.
    assert.deepEqual(entries[1]!.tokenUsage, { promptTokens: 42, completionTokens: 88, totalTokens: 130 });
    assert.ok(typeof entries[1]!.durationMs === 'number');

    // Irreversible redaction before persistence: the prompt-borne secret is
    // masked in the ledger prose, and the bare-hex inputHash survives verbatim.
    const blob = JSON.stringify(entries);
    assert.ok(!blob.includes('super-secret-value-123'), 'the prompt secret survived into the evidence ledger!');
    assert.ok(blob.includes('***REDACTED***'));
    assert.match(entries[1]!.inputHash, /^[0-9a-f]{64}$/, 'the inputHash must not be mangled by redaction');

    // Every entry shares its inputHash — and its site — with a dwf_nodes row.
    const nodes = await store.getDwfNodes('dwfrun-evidence');
    assert.equal(nodes.length, 2);
    for (const entry of entries) {
      const node = nodes.find((n) => n.inputHash === entry.inputHash);
      assert.ok(node, `evidence entry ${entry.id} must share its inputHash with a dwf_nodes row`);
      const site = entry.provenance.slice(entry.provenance.lastIndexOf(':') + 1).split('@')[0];
      assert.equal(node!.siteId, site);
    }
  } finally {
    store.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('engine evidence: a failed node records an explicit unknown entry whose prose is redacted', async () => {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  try {
    const engine = makeEngine('dwfrun-evidence-failed', store, process.cwd());

    // files.grep with an invalid regex carrying a token: the call fails inside
    // journalled() — the node row is written as 'failed' and the ledger gets an
    // explicit 'unknown' entry whose label embeds (a masked form of) the input.
    await assert.rejects(
      () => engine.handleCall(callFrame(1, 'worldRead', 'grep#1', ['files.grep', [`(unclosed-${FAKE_GITHUB_TOKEN}`]])),
    );

    const entries = await store.getDwfEvidence('dwfrun-evidence-failed');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, 'unknown', 'a failed node establishes nothing — recorded as unknown, never faked');
    assert.match(entries[0]!.limitations, /no result was established/);
    assert.ok(!JSON.stringify(entries).includes(FAKE_GITHUB_TOKEN), 'the raw token survived into the evidence ledger!');
    assert.ok(JSON.stringify(entries).includes('***REDACTED***'));

    // The unknown entry still agrees with the failed node row.
    const nodes = await store.getDwfNodes('dwfrun-evidence-failed');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.status, 'failed');
    assert.equal(nodes[0]!.inputHash, entries[0]!.inputHash);
    assert.ok((nodes[0]!.durationMs ?? 0) >= 0, 'the failed node row also carries its duration');
  } finally {
    store.close();
  }
});
