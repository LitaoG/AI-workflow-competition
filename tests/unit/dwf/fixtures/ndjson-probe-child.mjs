/**
 * NDJSON frame-boundary probe child (Issue #98 Phase 2, blueprint step 8).
 *
 * This file is DATA for the runner, never engine code: it impersonates the
 * sandbox child (same spawn contract as src/dwf/child-main.js —
 * `node <entry> <scriptJsPath> <argsJsPath>`) and is wired into the REAL
 * parent runner via RunFacadeOptions.childEntryPath. It emits precisely
 * calibrated byte streams on stdout to pin the parent's frame-pump edges
 * (src/dwf/runner.ts): the 16MB single-frame budget (strictly-greater trip),
 * the 32MB backlog budget (strictly-greater trip), UTF-8 mid-codepoint
 * tearing (StringDecoder reassembly), CRLF line endings, EOF residue and the
 * 512-frames-per-tick yield order. It is NOT compiled by tsconfig (.mjs data
 * file) and is NOT picked up by `node --test` (not *.test.*).
 *
 * Exit discipline (cross-platform): pipe writes to the parent are
 * asynchronous on POSIX, so exiting while a large write is still queued drops
 * its tail. Scenarios whose verdict belongs to the parent (a done frame, the
 * frame or backlog gate) therefore never exit on their own — they wait for
 * the parent's finish() tree kill. Scenarios that must end through child exit
 * ("exited before finishing") first wait until their bytes are handed to the
 * OS. Exiting early would also race child close against the parent's
 * 512-per-tick pump (#99).
 *
 * The scenario is selected via the args JSON the parent wrote (args.scenario).
 */

const fs = await import('node:fs');

const argsPath = process.argv[3];
let scenario = 'crlf';
try {
  scenario = String(JSON.parse(fs.readFileSync(argsPath, 'utf8')).scenario ?? 'crlf');
} catch {
  /* stay on the default scenario */
}

const write = (s) => process.stdout.write(s);
const writeBytes = (b) => process.stdout.write(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Write, then resolve once this chunk (and everything before it) is handed to the OS. */
const writeFlushed = (s) => new Promise((r) => process.stdout.write(s, () => r()));
/** The verdict is the parent's: stay alive until its finish() tree-kills us. */
const holdForParentKill = () => sleep(30_000);

let callId = 7;
function logFrame(message) {
  callId += 1;
  return JSON.stringify({ t: 'call', id: callId, op: 'log', siteId: 'probe', payload: [message] });
}
function doneFrame(value) {
  return JSON.stringify({ t: 'done', value }) + '\n';
}

/** The runner's single-frame budget in chars (strictly-greater trip). */
const FRAME_TARGET = 16 * 1024 * 1024;
/** The runner's backlog budget in chars (strictly-greater trip). */
const BACKLOG_TARGET = 32 * 1024 * 1024;

/** Calibrated so that the LINE (sans trailing newline) is exactly `lineChars`. */
function calibratedLogLine(lineChars) {
  const overhead = logFrame('').length; // payload contributes its length 1:1 ('A' has no escapes)
  return logFrame('A'.repeat(lineChars - overhead));
}

async function main() {
  switch (scenario) {
    /** ① the single-frame budget is EXACTLY reachable: a 16,777,216-char line passes. */
    case 'frame-exact': {
      write(calibratedLogLine(FRAME_TARGET) + '\n');
      write(doneFrame({ ok: 'frame-exact-done' }));
      await holdForParentKill();
      return;
    }
    /** ② one char over the single-frame budget → named ChildFrameLimitExceeded. */
    case 'frame-over': {
      write(calibratedLogLine(FRAME_TARGET + 1) + '\n');
      write(doneFrame({ ok: 'frame-over-done' }));
      await holdForParentKill();
      return;
    }
    /** ③ the backlog budget is EXACTLY reachable: 32M chars without a newline must NOT trip the gate. */
    case 'backlog-exact': {
      await writeFlushed('X'.repeat(BACKLOG_TARGET));
      await sleep(500);
      // no newline, no done — the run ends via child exit ("exited before finishing")
      return;
    }
    /** ④ one char over the backlog budget → named ChildFrameLimitExceeded (backlog shape). */
    case 'backlog-over': {
      write('X'.repeat(BACKLOG_TARGET + 1));
      await holdForParentKill();
      return;
    }
    /** ⑤ a 3-byte UTF-8 character torn mid-codepoint across 7-byte writes reassembles byte-exact. */
    case 'utf8-torn': {
      const payload = '中'.repeat(30);
      const bytes = Buffer.from(logFrame(payload) + '\n', 'utf8');
      for (let off = 0; off < bytes.length; off += 7) {
        writeBytes(bytes.subarray(off, Math.min(off + 7, bytes.length)));
        await sleep(1); // force a separate chunk per 7-byte slice
      }
      write(doneFrame({ ok: 'utf8-torn-done' }));
      await holdForParentKill();
      return;
    }
    /** ⑥ CRLF line endings: the trailing \r is JSON whitespace — frames parse, malformed stays 0. */
    case 'crlf': {
      for (let i = 0; i < 5; i++) write(logFrame(`crlf-${i}`) + '\r\n');
      write(doneFrame({ ok: 'crlf-done' }));
      await holdForParentKill();
      return;
    }
    /** ⑦ EOF with a half-frame residue: the residue is never parsed, malformed stays 0. */
    case 'eof-half': {
      await writeFlushed('{"t":"call","id":99,"op":"log","payl');
      await sleep(100);
      return;
    }
    /** ⑧ a 2000-frame burst stays strictly ordered across the 512-per-tick yield. */
    case 'burst': {
      for (let i = 0; i < 2000; i++) write(logFrame(`log-${i}`) + '\n');
      write(doneFrame({ ok: 'burst-done' }));
      await holdForParentKill();
      return;
    }
    /**
     * ⑨ #99 regression: the child exits the moment its burst and done frame
     * are handed to the OS — the shape of src/dwf/child-main.ts (send done,
     * then process.exit(0)). This is the one scenario that exits early on
     * purpose: child close must not win against frames the parent already holds.
     */
    case 'burst-exit': {
      let burst = '';
      for (let i = 0; i < 2000; i++) burst += logFrame(`log-${i}`) + '\n';
      await writeFlushed(burst + doneFrame({ ok: 'burst-exit-done' }));
      return;
    }
    default: {
      write(doneFrame({ ok: 'default-done' }));
      await holdForParentKill();
    }
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
