import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFacadeScript } from '../../src/dwf/runner.js';
import { hashScriptSource } from '../../src/dwf/compile.js';
import { spawnSupervised } from '../../src/process-supervision.js';
import { createSQLiteStore } from '../../src/state/store.js';
import { EventLogReader } from '../../src/state/event-log.js';
import { SQLiteStateStore } from '../../src/state/sqlite-store.js';
import { DwfJournalStore } from '../../src/types.js';

/** Fake, self-made token shapes — nothing here is a real credential. */
const FAKE_GITHUB_TOKEN = 'gho_0123456789abcdefghij0123456789abcd';

const SCRIPT = `
phase("Inspect");
const health = await agent("inspector").ask<Health>("inspect health report of the service");
phase("Record");
report({ health: health.healthStatus });
return { healthStatus: health.healthStatus };

interface Health {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
`;

const ESCAPE_SCRIPT = `
const files = await agent("x").ask("read files");
return files;
`;

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-e2e-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello dwf\n');
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* child may briefly hold the dir on Windows */ } } };
}

function openJournal(dbPath: string): SQLiteStateStore & DwfJournalStore {
  return createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
}

test('facade script runs end-to-end in the sandbox and replays at zero provider calls', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(first.status, 'completed', `first run failed: ${first.error ?? JSON.stringify(first.diagnostics)}`);
    assert.equal((first.value as { healthStatus: string }).healthStatus, 'HEALTHY');
    assert.equal(first.stats.asks, 1);
    assert.equal(first.stats.replayHits, 0);

    // Resume: journal short-circuit — zero provider calls, identical result
    const second = await runFacadeScript({ scriptPath, cwd: ws.dir, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', `resume failed: ${second.error}`);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.stats.asks, 0, 'resume must not execute any ask');
    assert.equal(second.stats.replayHits, 1, 'resume replays the ask from the journal');
  } finally {
    ws.cleanup();
  }
});

test('compile failures never spawn the sandbox and carry mapped diagnostics', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'bad.facade.ts');
    fs.writeFileSync(scriptPath, 'const t = Date.now();\nreturn t;');
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'compile_failed');
    assert.ok(r.diagnostics!.some((d) => d.category === 'purity-ban' && d.line === 1));
  } finally {
    ws.cleanup();
  }
});

test('script errors surface as failed runs and stay resumable', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'throw.facade.ts');
    fs.writeFileSync(scriptPath, 'phase("Boom");\nthrow new Error("kaboom");');
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'failed');
    assert.match(r.error!, /kaboom/);

    // resume of a failed run works (nothing journalled → re-executes, fails again)
    const r2 = await runFacadeScript({ scriptPath, cwd: ws.dir, resumeRunId: r.runId });
    assert.equal(r2.status, 'failed');
    assert.match(r2.error!, /kaboom/);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Stale-running takeover (engine crash-recovery rules — zero-token resume
// reachable in the most-needed scenario: the host itself died mid-run)
// ---------------------------------------------------------------------------

/** Seed a dwf_runs row exactly as the shape under test needs it. */
async function seedRunRow(
  dbPath: string,
  row: { runId: string; scriptHash: string; scriptPath: string; status: 'running'; runnerPid?: number },
): Promise<void> {
  const seeder = openJournal(dbPath);
  try {
    await seeder.saveDwfRun({ ...row, argsJson: '{}' });
  } finally {
    seeder.close();
  }
}

test('resume takes over a stale running row whose recorded pid is dead and emits dwf_resume_takeover', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    const scriptHash = hashScriptSource(fs.readFileSync(scriptPath, 'utf8'));
    await seedRunRow(dbPath, { runId: 'dwfrun-crashed', scriptHash, scriptPath, status: 'running', runnerPid: 999999999 });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath,
      resumeRunId: 'dwfrun-crashed',
      // Injected dead probe: deterministic cross-platform, nothing real is signaled.
      pidLivenessProbe: () => false,
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.status, 'completed', `takeover resume failed: ${result.error ?? ''}`);
    assert.equal(result.stats.replayHits, 0, 'nothing was journalled by the dead host — the takeover re-executes');

    const takeover = events.find((e) => e.type === 'dwf_resume_takeover');
    assert.ok(takeover, 'the takeover must be announced as a dwf_resume_takeover event');
    assert.equal(takeover.data.deadPid, 999999999);
    assert.equal(takeover.data.reason, 'dead-pid');
    assert.equal(takeover.data.scriptHash, scriptHash);
    assert.equal(takeover.data.resumedRunId, 'dwfrun-crashed');

    // The takeover host recorded ITS OWN pid, so a later resume probes the right host.
    const store = openJournal(dbPath);
    try {
      const row = await store.getDwfRun('dwfrun-crashed');
      // A settled run has no owning process (the pid column clears on the
      // terminal save) — liveness probing only ever reads `running` rows.
      assert.equal(row?.runnerPid, undefined, 'a settled run has no owning process');
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('resume refuses a running row whose host pid is alive and names the pid in the error', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    await seedRunRow(dbPath, { runId: 'dwfrun-live-host', scriptHash: hashScriptSource(fs.readFileSync(scriptPath, 'utf8')), scriptPath, status: 'running', runnerPid: 424242 });

    const result = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath,
      resumeRunId: 'dwfrun-live-host',
      // Injected alive probe (EPERM semantics included): another host owns the run.
      pidLivenessProbe: (pid) => pid === 424242,
    });
    assert.equal(result.status, 'failed', 'a live host must keep its exclusive claim on the running row');
    assert.match(result.error!, /already running/);
    assert.match(result.error!, /424242/, 'the refusal must name the alive pid');
  } finally {
    ws.cleanup();
  }
});

test('resume refuses a genuinely live host pid with the real OS probe (no injection)', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, 'dwf.sqlite');

    // A REAL live process pins the platform semantics of process.kill(pid, 0).
    const sleeper = spawnSupervised(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: ws.dir });
    try {
      assert.ok(sleeper.pid !== undefined, 'the sleeper must have a pid');
      await seedRunRow(dbPath, { runId: 'dwfrun-live-real', scriptHash: hashScriptSource(fs.readFileSync(scriptPath, 'utf8')), scriptPath, status: 'running', runnerPid: sleeper.pid });

      // NO pidLivenessProbe — the default probe must see the live child.
      const result = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath, resumeRunId: 'dwfrun-live-real' });
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /already running/);
      assert.match(result.error!, new RegExp(`pid ${sleeper.pid}`));
    } finally {
      await sleeper.killTree();
    }
  } finally {
    ws.cleanup();
  }
});

test('resume takes over a pre-pid running row (no recorded host pid) without probing', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    // No pid on the row — the shape a pre-takeover build (or the manual legacy
    // migration) leaves behind.
    await seedRunRow(dbPath, { runId: 'dwfrun-pre-pid', scriptHash: hashScriptSource(fs.readFileSync(scriptPath, 'utf8')), scriptPath, status: 'running' });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await runFacadeScript({
      scriptPath,
      cwd: ws.dir,
      dbPath,
      resumeRunId: 'dwfrun-pre-pid',
      // Must never be called: a pid-less row has nothing to probe — it is a
      // crash takeover by definition (forward compatibility with old journals).
      pidLivenessProbe: () => {
        throw new Error('a pid-less row must not be probed');
      },
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.status, 'completed', `pre-pid takeover resume failed: ${result.error ?? ''}`);

    const takeover = events.find((e) => e.type === 'dwf_resume_takeover');
    assert.ok(takeover, 'the pre-pid takeover must be announced too');
    assert.equal(takeover.data.reason, 'no-recorded-pid');
    assert.equal('deadPid' in takeover.data, false, 'a pre-pid takeover carries no deadPid');
  } finally {
    ws.cleanup();
  }
});

test('purity backstop: Math.random throws inside the sandbox even without the compiler', async () => {
  const ws = makeWorkspace();
  try {
    // Hand-write the entry file the child would run — no compiler in the loop —
    // and drive child-main.js directly to prove the runtime backstop.
    const runDir = path.join(ws.dir, '.workflow', 'runs', 'dwfrun-purity');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'script.js'), 'async function __workflowScript__() { return String(Math.random()); }');

    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // compiled test lives at dist/tests/integration/ → engine child at dist/src/dwf/
    const childEntry = fileURLToPath(new URL('../../src/dwf/child-main.js', import.meta.url));
    const child = spawn(process.execPath, [childEntry, path.join(runDir, 'script.js'), '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (c: Buffer) => (buf += c.toString()));
      child.on('close', () => resolve(buf));
    });
    const line = out.trim().split('\n').find((l) => l.includes('scriptError'));
    assert.ok(line, `expected a scriptError frame, got: ${out}`);
    const frame = JSON.parse(line!);
    assert.match(frame.message, /Purity violation: Math\.random/);
  } finally {
    ws.cleanup();
  }
});

test('world.run approved command executes and nonzero exit resolves as a value', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'gate.facade.ts');
    fs.writeFileSync(scriptPath, `
phase("Gate");
const gate = await world.run("node", ["--version"]);
log("node gate done");
return { exitCode: gate.exitCode, hasVersion: gate.stdout.includes("v") };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.equal((r.value as { exitCode: number }).exitCode, 0);
    assert.equal((r.value as { hasVersion: boolean }).hasVersion, true);
  } finally {
    ws.cleanup();
  }
});

test('files.glob and files.read are recorded world reads', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'files.facade.ts');
    fs.writeFileSync(scriptPath, `
const list = await files.glob("*.txt");
const content = await files.read("notes.txt");
return { count: list.length, content };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir });
    assert.equal(r.status, 'completed', r.error);
    assert.deepEqual(r.value, { count: 1, content: 'hello dwf\n' });
  } finally {
    ws.cleanup();
  }
});

test('world.run output with credentials is redacted before it reaches the journal', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'leak.facade.ts');
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    // A world.run whose output mimics `git remote -v` with an embedded password
    // and an echoed token — the two shapes the engine's zero-credential rule forbids on disk.
    fs.writeFileSync(scriptPath, `
phase("Leak");
const out = await world.run("node", ["-e", "process.stdout.write('remote: https://alice:pat-123456@github.com/org/repo.git\\\\ntoken=${FAKE_GITHUB_TOKEN}\\\\n');"]);
return { exitCode: out.exitCode, stdout: out.stdout };
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(r.status, 'completed', `run failed: ${r.error ?? ''}`);

    // The value the script sees is already masked — and it is the journalled value.
    const returned = (r.value as { stdout: string }).stdout;
    assert.ok(!returned.includes('pat-123456'), `password survived into the script result: ${returned}`);
    assert.ok(!returned.includes('gho_0123'), `token survived into the script result: ${returned}`);
    assert.ok(returned.includes('://***:***@github.com/org/repo.git'));
    assert.ok(returned.includes('token=***REDACTED***'));

    const store = openJournal(dbPath);
    try {
      const nodes = await store.getDwfNodes(r.runId);
      const worldRunNode = nodes.find((n) => n.kind === 'worldRun');
      assert.ok(worldRunNode?.resultJson, 'the worldRun node must be journalled');
      assert.ok(!worldRunNode.resultJson.includes('pat-123456'), 'raw password landed in dwf_nodes.result_json!');
      assert.ok(!worldRunNode.resultJson.includes('gho_0123'), 'raw token landed in dwf_nodes.result_json!');
      assert.ok(worldRunNode.resultJson.includes('://***:***@'));
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('dwf_call_error events are redacted before they land in SQLite', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'boom.facade.ts');
    const dbPath = path.join(ws.dir, 'dwf.sqlite');
    // A files.grep pattern carrying a token: the invalid-regex error embeds the
    // pattern verbatim and surfaces as dwf_call_error (deterministic call failure).
    fs.writeFileSync(scriptPath, `
phase("Boom");
const hits = await files.grep("(unclosed-${FAKE_GITHUB_TOKEN}");
return hits;
`);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(r.status, 'failed');
    assert.ok(r.error, 'a failed run must carry an error');
    assert.ok(!r.error.includes(FAKE_GITHUB_TOKEN), 'the returned run error carries the raw token');
    assert.ok(r.error.includes('***REDACTED***'));

    const store = openJournal(dbPath);
    try {
      const events = await store.getEvents(r.runId);
      const callError = events.find((e) => e.type === 'dwf_call_error');
      assert.ok(callError, 'expected a dwf_call_error event');
      const serialized = JSON.stringify(callError.data);
      assert.ok(!serialized.includes(FAKE_GITHUB_TOKEN), 'raw token landed in the dwf_call_error event!');
      assert.ok(serialized.includes('***REDACTED***'));
      const failed = events.find((e) => e.type === 'dwf_failed');
      assert.ok(failed, 'expected a dwf_failed event');
      assert.ok(!JSON.stringify(failed.data).includes(FAKE_GITHUB_TOKEN), 'raw token landed in the dwf_failed event!');
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('a full run with poisoned host credentials completes and the journal stays clean', async () => {
  const ws = makeWorkspace();
  const dbPath = path.join(ws.dir, 'dwf.sqlite');
  // Host-side provider credentials (Bedrock reads AWS_* in the parent only):
  // the redacted sandbox env must neither break the run nor leak into storage.
  process.env.AWS_ACCESS_KEY_ID = 'EXAMPLEACCESSKEYID0123456789';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  process.env.GITHUB_TOKEN = FAKE_GITHUB_TOKEN;
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const r = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(r.status, 'completed', `redaction must not break the run: ${r.error ?? ''}`);
    assert.equal((r.value as { healthStatus: string }).healthStatus, 'HEALTHY');

    const store = openJournal(dbPath);
    try {
      const [events, nodes] = await Promise.all([store.getEvents(r.runId), store.getDwfNodes(r.runId)]);
      const blob = JSON.stringify({ events, nodes });
      assert.ok(!blob.includes('EXAMPLEACCESSKEYID0123456789'), 'AWS key id leaked into the journal!');
      assert.ok(!blob.includes('wJalrXUtnFEMI'), 'AWS secret leaked into the journal!');
      assert.ok(!blob.includes(FAKE_GITHUB_TOKEN), 'GITHUB_TOKEN leaked into the journal!');
    } finally {
      store.close();
    }
  } finally {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.GITHUB_TOKEN;
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Dual persistence (the engine's dual-persistence rule): every event goes to SQLite (authoritative)
// AND to .workflow/runs/<runId>/events.jsonl (append-only mirror).
// ---------------------------------------------------------------------------

test('a run dual-writes its event stream: events.jsonl mirrors the SQLite journal and a resume continues both', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(first.status, 'completed', `first run failed: ${first.error ?? ''}`);

    const jsonlPath = path.join(ws.dir, '.workflow', 'runs', first.runId, 'events.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'events.jsonl must exist for every run');

    const store = openJournal(dbPath);
    try {
      const assertMirrorsSqlite = async (): Promise<void> => {
        const sqliteEvents = await store.getEvents(first.runId);
        const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
        assert.equal(lines.length, sqliteEvents.length, 'JSONL line count must equal the SQLite event count');
        const parsed = lines.map((l) => JSON.parse(l) as { id: string; sequence: number });
        assert.deepEqual(parsed.map((e) => e.id), sqliteEvents.map((e) => e.id), 'JSONL must carry the same events, same order');
        assert.deepEqual(parsed.map((e) => e.sequence), sqliteEvents.map((e) => e.sequence), 'JSONL sequences must match SQLite');
      };
      await assertMirrorsSqlite();

      // Resume: the same stream continues in both stores (no re-numbering,
      // no duplicate ids) — the mirror is append-only across invocations.
      const second = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath, resumeRunId: first.runId });
      assert.equal(second.status, 'completed', `resume failed: ${second.error ?? ''}`);
      assert.equal(second.stats.replayHits, 1);
      await assertMirrorsSqlite();
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('a torn trailing events.jsonl line is tolerated on resume and the stream continues past it', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');

    const first = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(first.status, 'completed', first.error);
    const jsonlPath = path.join(ws.dir, '.workflow', 'runs', first.runId, 'events.jsonl');

    // Simulate a crash mid-append: the last line is cut half-way (that event
    // is already safe in SQLite — the file lags the journal, never leads it).
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
    const torn = lines[lines.length - 1]!;
    const tornSequence = (JSON.parse(torn) as { sequence: number }).sequence;
    fs.writeFileSync(
      jsonlPath,
      lines.slice(0, -1).join('\n') + '\n' + torn.slice(0, Math.floor(torn.length / 2)),
      'utf8',
    );

    const second = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath, resumeRunId: first.runId });
    assert.equal(second.status, 'completed', `resume over a torn line failed: ${second.error ?? ''}`);

    // Event-log recovery semantics: the unparseable fragment is skipped, the
    // repaired newline keeps every later append on its own line, and every
    // SQLite event past the torn one is present in the mirror.
    const events = await EventLogReader.readAll(jsonlPath);
    assert.equal(events.length, new Set(events.map((e) => e.id)).size, 'no duplicate event ids after recovery');
    const store = openJournal(dbPath);
    try {
      const sqliteEvents = await store.getEvents(first.runId);
      const jsonlIds = new Set(events.map((e) => e.id));
      for (const evt of sqliteEvents) {
        if ((evt.sequence ?? 0) > tornSequence) {
          assert.ok(jsonlIds.has(evt.id), `resumed event ${evt.id} must be in the JSONL mirror`);
        }
      }
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('a failed events.jsonl append degrades the mirror with ONE StorageError-tagged journal event and never fails the run', async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = path.join(ws.dir, 'script.facade.ts');
    fs.writeFileSync(scriptPath, SCRIPT);
    const dbPath = path.join(ws.dir, '.workflow', 'dwf.sqlite');

    // Run once to obtain a stable runId + journal, then sabotage the mirror
    // path: a DIRECTORY where events.jsonl must be — every append fails.
    const first = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath });
    assert.equal(first.status, 'completed', first.error);
    const jsonlPath = path.join(ws.dir, '.workflow', 'runs', first.runId, 'events.jsonl');
    fs.rmSync(jsonlPath);
    fs.mkdirSync(jsonlPath);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...msg: unknown[]) => {
      warnings.push(msg.map(String).join(' '));
    };
    let secondStatus: string;
    try {
      const second = await runFacadeScript({ scriptPath, cwd: ws.dir, dbPath, resumeRunId: first.runId });
      secondStatus = second.status;
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(secondStatus, 'completed', 'a JSONL mirror failure must never fail the run');

    const store = openJournal(dbPath);
    try {
      const events = await store.getEvents(first.runId);
      const failures = events.filter((e) => e.type === 'dwf_event_log_write_failed');
      assert.equal(failures.length, 1, 'exactly one degradation marker — later failures must not spam the journal');
      const tagged = (failures[0]!.data as { taggedError: { tag: string } }).taggedError;
      assert.equal(tagged.tag, 'StorageError', 'the failure must speak the domain error algebra');
      assert.ok(warnings.some((w) => w.includes('events.jsonl append failed')), 'the degradation must warn, not stay silent');

      // The authoritative stream is intact and gapless across the degradation.
      const sequences = events.map((e) => e.sequence ?? 0).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i + 1));
    } finally {
      store.close();
    }
  } finally {
    ws.cleanup();
  }
});
