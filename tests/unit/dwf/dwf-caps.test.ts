/**
 * Issue #40 / GAP-MATRIX D8④ — the caps alignment set, each with a named
 * rejection (or boundary-open) assertion:
 *   1. git.log over 100 is structurally rejected — never silently clamped;
 *   2. artifact ids must match [A-Za-z0-9_.-]{1,64};
 *   3. files.grep over a 5000-file corpus is a named rejection, not a silent
 *      narrowing of the search set;
 *   4. the 20MB/256KB/1MB caps are KiB/MiB-aligned — probed at the old decimal
 *      boundaries (1,000,001 bytes / 256,001 chars now fit; the binary caps
 *      still reject one byte/char over);
 *   5. world.run stdout over the 16 MiB stream cap is a named rejection and
 *      the worldRun node journals as failed — never a silently truncated
 *      success value (Issue #56); the cap is byte-accounted (not UTF-16 code
 *      units), injectable per WorldBoundary, and its breach kills the child
 *      tree instead of letting a rejected world.run keep mutating the world.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { WorldBoundary } from '../../../src/dwf/host-boundary-dispatcher.js';
import { isSchemaValidationError } from '../../../src/domain/errors.js';
import type { DomainError } from '../../../src/domain/errors.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore } from '../../../src/types.js';

function makeEngine(runId: string, workspace: string): FacadeEngine {
  const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
  return new FacadeEngine({
    runId,
    workspace,
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
  });
}

function makeWorkspace(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* handle lock */ } } };
}

function worldRead(siteId: string, op: string, args: unknown[]) {
  return { t: 'call' as const, id: siteId.length, op: 'worldRead' as const, siteId, payload: [op, args] };
}

// --------------------------------------------------------------------- git.log

test('D8④ git.log: requesting more than 100 commits is a structured rejection, not a silent clamp', async () => {
  const ws = makeWorkspace('dwf-caps-gitlog-');
  try {
    const engine = makeEngine('dwfcaps-gitlog', ws.dir);
    await assert.rejects(
      () => engine.handleCall(worldRead('worldread#1', 'git.log', [150])),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        const e = err as Error & { details?: Record<string, unknown> };
        assert.match(e.message, /100/, e.message);
        assert.equal(e.details?.op, 'git.log');
        assert.equal(e.details?.cap, 100);
        assert.equal(e.details?.requested, 150);
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

test('D8④ git.log: 100 stays inside the cap (boundary open)', async () => {
  const ws = makeWorkspace('dwf-caps-gitrepo-');
  try {
    execSync('git init', { cwd: ws.dir, stdio: 'ignore' });
    execSync('git -c user.name=t -c user.email=t@example.com commit --allow-empty -m init', { cwd: ws.dir, stdio: 'ignore' });
    const engine = makeEngine('dwfcaps-gitlog-boundary', ws.dir);
    const res = await engine.handleCall(worldRead('worldread#2', 'git.log', [100]));
    assert.ok(Array.isArray(res) && res.length === 1, 'the hermetic repo has exactly one commit');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------- artifact id

test('D8④ artifact id: ids outside [A-Za-z0-9_.-]{1,64} are a named rejection', async () => {
  const ws = makeWorkspace('dwf-caps-artid-');
  try {
    const engine = makeEngine('dwfcaps-artid', ws.dir);
    const badIds = ['bad id!', 'a'.repeat(65), ''];
    for (let i = 0; i < badIds.length; i++) {
      const id = badIds[i]!;
      await assert.rejects(
        () => engine.handleCall({ t: 'call', id: i + 1, op: 'artifact', siteId: `artifact#${i + 1}`, payload: ['markdown', [id, 'x']] }),
        (err: unknown) => {
          assert.ok(isSchemaValidationError(err as DomainError), `"${id.slice(0, 12)}": expected SchemaValidationError, got ${(err as Error)?.name}`);
          assert.match((err as Error).message, /\[A-Za-z0-9_.\-\]\{1,64\}/, (err as Error).message);
          return true;
        },
      );
    }
  } finally {
    ws.cleanup();
  }
});

test('D8④ artifact id: a 64-char id is accepted and publishes', async () => {
  const ws = makeWorkspace('dwf-caps-artid-ok-');
  try {
    const engine = makeEngine('dwfcaps-artid-ok', ws.dir);
    const res = await engine.handleCall({ t: 'call', id: 1, op: 'artifact', siteId: 'artifact#1', payload: ['markdown', ['a'.repeat(64), 'hello']] }) as { id: string; version: number };
    assert.equal(res.version, 1);
  } finally {
    ws.cleanup();
  }
});

// ------------------------------------------------------------------ files.grep

test('D8④ files.grep: a corpus over 5000 files is a named rejection, not a silent narrowing', async () => {
  const ws = makeWorkspace('dwf-caps-grep-');
  try {
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(ws.dir, `f${i}.txt`), 'needle here\n');
    const engine = makeEngine('dwfcaps-grep', ws.dir);
    await assert.rejects(
      () => engine.handleCall(worldRead('worldread#1', 'files.grep', ['needle'])),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        const e = err as Error & { details?: Record<string, unknown> };
        assert.match(e.message, /5000/, e.message);
        assert.equal(e.details?.op, 'files.grep');
        assert.equal(e.details?.cap, 5000);
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

test('D8④ grep bytes cap is 256 KiB: 259,740 matched bytes pass (the old decimal 256,000 would reject)', async () => {
  const ws = makeWorkspace('dwf-caps-grepbytes-');
  try {
    const lines: string[] = [];
    for (let i = 0; i < 260; i++) lines.push('x'.repeat(999)); // 260 × 999 = 259,740 bytes
    fs.writeFileSync(path.join(ws.dir, 'lines.txt'), lines.join('\n'));
    const engine = makeEngine('dwfcaps-grepbytes-ok', ws.dir);
    const res = await engine.handleCall(worldRead('worldread#1', 'files.grep', ['x'])) as Array<{ path: string; line: number }>;
    assert.equal(res.length, 260, 'all 260 lines matched under the new 256 KiB cap');
  } finally {
    ws.cleanup();
  }
});

test('D8④ grep bytes cap is 256 KiB: 262,737 matched bytes is a named rejection with bytesCap 262144', async () => {
  const ws = makeWorkspace('dwf-caps-grepbytes-over-');
  try {
    const lines: string[] = [];
    for (let i = 0; i < 263; i++) lines.push('x'.repeat(999)); // 263 × 999 = 262,737 bytes
    fs.writeFileSync(path.join(ws.dir, 'lines.txt'), lines.join('\n'));
    const engine = makeEngine('dwfcaps-grepbytes-over', ws.dir);
    await assert.rejects(
      () => engine.handleCall(worldRead('worldread#1', 'files.grep', ['x'])),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError));
        const e = err as Error & { details?: Record<string, unknown> };
        assert.equal(e.details?.bytesCap, 256 * 1024, 'GREP_BYTES_CAP is 256 KiB, not the old decimal 256,000');
        assert.equal(e.details?.op, 'files.grep');
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

// ------------------------------------------------------- KiB/MiB cap alignment

test('D8④ caps are KiB/MiB-aligned: 256,001 chars now fit artifact.markdown (old decimal cap rejected it)', async () => {
  const ws = makeWorkspace('dwf-caps-kib-');
  try {
    const engine = makeEngine('dwfcaps-kib', ws.dir);
    const md = await engine.handleCall({ t: 'call', id: 1, op: 'artifact', siteId: 'artifact#1', payload: ['markdown', ['md-big', 'x'.repeat(256_001)]] }) as { id: string; version: number };
    assert.equal(md.version, 1, 'the old decimal 256KB cap would have rejected this body');
  } finally {
    ws.cleanup();
  }
});

test('D8④ caps are KiB/MiB-aligned: one byte/char over the binary caps is still a named rejection', async () => {
  const ws = makeWorkspace('dwf-caps-kib-over-');
  try {
    fs.writeFileSync(path.join(ws.dir, 'over.txt'), 'x'.repeat(1024 * 1024 + 1));
    const engine = makeEngine('dwfcaps-kib-over', ws.dir);
    await assert.rejects(
      () => engine.handleCall(worldRead('worldread#1', 'files.read', ['over.txt'])),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError));
        assert.equal((err as Error & { details?: Record<string, unknown> }).details?.cap, 1024 * 1024, 'FILE_READ_CAP is 1 MiB, not the old decimal 1,000,000');
        return true;
      },
    );
    const engine2 = makeEngine('dwfcaps-kib-over-md', ws.dir);
    await assert.rejects(
      () => engine2.handleCall({ t: 'call', id: 1, op: 'artifact', siteId: 'artifact#1', payload: ['markdown', ['md-over', 'x'.repeat(256 * 1024 + 1)]] }),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError));
        assert.equal((err as Error & { details?: Record<string, unknown> }).details?.cap, 256 * 1024, 'ARTIFACT_MD_CAP is 256 KiB, not the old decimal 256,000');
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

// ------------------------------------------------------------------ world.run

test('D8④ world.run: the output cap is byte-accounted and injectable — 4 KiB cap: 4096 bytes resolve verbatim, 4097 bytes is a named rejection', { timeout: 60_000 }, async () => {
  const ws = makeWorkspace('dwf-caps-worldrun-cap-');
  try {
    const boundary = new WorldBoundary(ws.dir, 4096);
    const ok = await boundary.spawnCaptured('node', ['-e', 'process.stdout.write("x".repeat(4096))'], 30_000);
    assert.equal(ok.exitCode, 0, 'exactly-at-cap output must still resolve (boundary open, D8④ convention)');
    assert.equal(ok.stdout, 'x'.repeat(4096), 'exactly-at-cap output must arrive verbatim — never truncated');
    await assert.rejects(
      () => boundary.spawnCaptured('node', ['-e', 'process.stdout.write("x".repeat(4097))'], 30_000),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        const e = err as Error & { details?: Record<string, unknown> };
        assert.match(e.message, /4096/, e.message);
        assert.equal(e.details?.op, 'world.run');
        assert.equal(e.details?.stream, 'stdout');
        assert.equal(e.details?.cap, 4096);
        assert.equal(e.details?.bytes, 4097, 'the verdict counts real Buffer bytes, not UTF-16 code units');
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

test('D8④ world.run: breaching the cap kills the child tree — a rejected world.run must not keep mutating the workspace until the timeout', { timeout: 60_000 }, async () => {
  const ws = makeWorkspace('dwf-caps-worldrun-kill-');
  try {
    const boundary = new WorldBoundary(ws.dir, 4096);
    const startedAt = Date.now();
    await assert.rejects(
      () => boundary.spawnCaptured('node', ['-e', 'setInterval(() => process.stdout.write("x".repeat(1024)), 10)'], 10_000),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError), `expected the cap rejection, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        const e = err as Error & { details?: Record<string, unknown> };
        assert.equal(e.details?.cap, 4096);
        assert.ok((e.details?.bytes as number) > 4096, `the error must carry the actual byte size, got ${e.details?.bytes}`);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    // Discriminates kill-on-overflow from reject-at-settle-only: without the
    // kill, this never-exiting child would only settle at the 10s timeout.
    assert.ok(elapsed < 5000, `the over-cap child must be killed promptly (took ${elapsed}ms; a no-kill implementation would wait out the 10s timeout)`);
  } finally {
    ws.cleanup();
  }
});

test('D8④ world.run: stdout over the 16 MiB stream cap is a named rejection — the node journals as failed, never a truncated success', { timeout: 60_000 }, async () => {
  const ws = makeWorkspace('dwf-caps-worldrun-');
  try {
    const store = createSQLiteStore(':memory:') as SQLiteStateStore & DwfJournalStore;
    const engine = new FacadeEngine({
      runId: 'dwfcaps-worldrun',
      workspace: ws.dir,
      store,
      args: {},
      approvedCommands: [{ name: 'node', source: 'explicit' as const }],
      onEvent: () => {},
    });
    await assert.rejects(
      () => engine.handleCall({ t: 'call', id: 1, op: 'worldRun', siteId: 'worldrun#1', payload: ['node', ['-e', 'process.stdout.write("x".repeat(17 * 1024 * 1024))'], undefined] }),
      (err: unknown) => {
        assert.ok(isSchemaValidationError(err as DomainError), `expected SchemaValidationError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        const e = err as Error & { details?: Record<string, unknown> };
        assert.match(e.message, /16777216/, e.message);
        assert.equal(e.details?.op, 'world.run');
        assert.equal(e.details?.stream, 'stdout');
        assert.equal(e.details?.cap, 16 * 1024 * 1024, 'WORLD_OUTPUT_CAP is 16 MiB (bytes)');
        assert.ok((e.details?.bytes as number) > 16 * 1024 * 1024, `the error must carry the actual byte size, got ${e.details?.bytes}`);
        return true;
      },
    );
    const nodes = await store.getDwfNodes('dwfcaps-worldrun');
    const failed = nodes.find((n) => n.kind === 'worldRun' && n.status === 'failed');
    assert.ok(failed, 'the over-cap world.run node must journal as failed, not completed');
    assert.match(failed.errorText ?? '', /16777216/, 'the journalled error text carries the cap');
    store.close();
  } finally {
    ws.cleanup();
  }
});
