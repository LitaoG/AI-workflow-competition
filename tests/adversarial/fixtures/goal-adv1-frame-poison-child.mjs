/**
 * ADV-1 attack fixture — hostile sandbox child ("protocol poisoning").
 *
 * TEST-GOAL 阶段4.2 攻防: this entry impersonates the sandbox child (same spawn
 * contract as src/dwf/child-main.js: `node <entry> <scriptJsPath> <argsJsPath>`)
 * and is wired into the REAL parent runner via RunFacadeOptions.childEntryPath
 * (src/dwf/runner.ts:53). It emits adversarial byte streams on stdout to probe the
 * parent's NDJSON parser (src/dwf/runner.ts:373-390) for:
 *   - frame tearing / 粘包 (torn frames across writes, many frames per chunk)
 *   - CRLF / NUL / control-byte garbage lines
 *   - forged protocol frames ({t:"done"} terminal forgery)
 *   - stderr flooding (parent caps the tail at 4000 chars, runner.ts:399)
 *   - dead silence (the whole-run timeout must produce a catchable failure)
 *
 * The scenario is selected via the args JSON the parent wrote (args.scenario).
 * This file is NOT compiled by tsconfig (tests/ is outside include) — it is data
 * for the runner, never engine code.
 */

const fs = await import('node:fs');

const argsPath = process.argv[3];
let scenario = 'garbage';
let logCallId = 7;
try {
  const parsed = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  scenario = String(parsed.scenario ?? 'garbage');
  logCallId = Number(parsed.logCallId ?? 7);
} catch {
  /* stay on the default scenario */
}

const write = (s) => process.stdout.write(s);

function legitLogCallFrame(message) {
  return JSON.stringify({ t: 'call', id: logCallId, op: 'log', siteId: 'adv1', payload: [message] }) + '\n';
}
function legitDoneFrame(value) {
  return JSON.stringify({ t: 'done', value }) + '\n';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  switch (scenario) {
    /** Scenario A: control-byte garbage, CRLF endings, broken JSON, noise between frames. */
    case 'garbage': {
      write('\x00\x01\x02 this is not json \r\n');           // NUL+control garbage, CRLF
      write('{"t":"call","id":1,"op":"log"\n');               // broken JSON line (truncated)
      write('{"t":"call","id":2,"op":"log","payload":["noise-should-not-parse"]}\r\n'); // CRLF-terminated valid frame
      write('\n\n');                                          // blank lines
      write('{"t":"call",\n"payload":"pretty-printed-across-lines"}\n'); // newline inside frame
      write('42\n[1,2,3]\n"a string"\n');                     // valid JSON, wrong shape
      write(JSON.stringify({ t: 'notify', op: 'actorCreated', siteId: 'a1', name: 'real-actor' }) + '\n');
      write(legitLogCallFrame('legit-log-after-garbage'));
      write(legitDoneFrame({ ok: 'real-done' }));
      await sleep(300);
      return;
    }

    /** Scenario B: chunk-boundary tearing — one clean torn frame (must reassemble)
     *  plus one poisoned torn frame (mid-JSON garbage, must be rejected, no crash). */
    case 'torn': {
      write(JSON.stringify({ t: 'notify', op: 'actorCreated', siteId: 'b1', name: 'torn-actor' }) + '\n');
      // B1: clean tear across three writes — pure chunk boundary, must reassemble.
      const clean = legitLogCallFrame('torn-frame-reassembled-intact');
      const c1 = Math.floor(clean.length / 3);
      const c2 = Math.floor((clean.length * 2) / 3);
      write(clean.slice(0, c1));
      await sleep(60);
      write(clean.slice(c1, c2));
      await sleep(60);
      write(clean.slice(c2));
      // B2: poisoned tear — a RAW NUL byte wedged inside the line. Raw control
      // bytes (<0x20) are illegal inside JSON strings → parse must fail and the
      // whole line be dropped without crashing the parser.
      const poisoned = legitLogCallFrame('poisoned-torn-frame-must-be-rejected');
      const pcut = Math.floor(poisoned.length / 2);
      write(poisoned.slice(0, pcut));
      await sleep(60);
      write('\x00RAW-CTRL-WEDGE\x01');
      write(poisoned.slice(pcut));
      // B3: a "complete" frame carrying RAW unescaped control bytes in its payload —
      // illegal JSON per RFC 8259 (control chars must be escaped) → clean rejection.
      write('{"t":"call","id":9,"op":"log","siteId":"adv1","payload":["raw\x00\x01\x1fctrl-must-be-rejected"]}\n');
      write(legitDoneFrame({ ok: 'torn-done' }));
      await sleep(300);
      return;
    }

    /** Scenario C: a single 1 MiB log frame through the pipe, then done. */
    case 'mb1': {
      const big = 'A'.repeat(1024 * 1024);
      write(JSON.stringify({ t: 'notify', op: 'actorCreated', siteId: 'c1', name: 'big-actor' }) + '\n');
      write(legitLogCallFrame(big));
      write(legitDoneFrame({ ok: 'mb1-done' }));
      await sleep(1500);
      return;
    }

    /** Scenario D: a single >32 MiB log frame through the pipe, then done. */
    case 'mb33': {
      const big = 'B'.repeat(33 * 1024 * 1024);
      write(JSON.stringify({ t: 'notify', op: 'actorCreated', siteId: 'd1', name: 'huge-actor' }) + '\n');
      write(legitLogCallFrame(big));
      write(legitDoneFrame({ ok: 'mb33-done' }));
      await sleep(3000);
      return;
    }

    /** Scenario E: terminal frame forgery — the child lies "done" before doing work. */
    case 'forged': {
      write(JSON.stringify({ t: 'notify', op: 'actorCreated', siteId: 'e1', name: 'forged-actor' }) + '\n');
      write(legitDoneFrame({ forged: 'FORGED_DONE' }));
      await sleep(150);
      // Everything after the forged done must be ignored (settled gate, runner.ts:406).
      write(legitLogCallFrame('after-forged-done-should-never-land'));
      write(legitDoneFrame({ ok: 'real-done-too-late' }));
      await sleep(300);
      return;
    }

    /** Scenario F: 5 MiB stderr flood while stdout stays silent then done. */
    case 'stderrflood': {
      process.stderr.write('E'.repeat(5 * 1024 * 1024));
      write(legitDoneFrame({ ok: 'stderrflood-done' }));
      await sleep(300);
      return;
    }

    /** Scenario S: total silence — never emits, never exits (timeout probe). */
    case 'silent': {
      await sleep(120_000);
      return;
    }

    /** Scenario FLOOD: bounded garbage flood (200 MiB, yielding loop) without a done
     *  frame — probes whether the parent's parser survives sustained noise and the
     *  whole-run timeout still fires at its bound. */
    case 'flood': {
      const garbage = '\x00 junk line \r\n';
      const total = 200 * 1024 * 1024;
      let written = 0;
      while (written < total) {
        write(garbage);
        written += garbage.length;
        if ((written & 0xffffff) === 0) await sleep(1); // yield: no memory bomb
      }
      await sleep(120_000); // stay alive, silent — the timeout must still fire
      return;
    }

    /** Scenario FLOODBOMB: UNTHROTTLED endless write loop (no yield, no byte cap).
     *  Memory-bomb DoS ADV — measured to starve the parent event loop for as long
     *  as the bomb runs (timeout bound does NOT hold). Kept out of the fast suite. */
    case 'floodbomb': {
      const garbage = '\x00 junk line \r\n';
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) write(garbage);
      return;
    }

    default:
      write(legitDoneFrame({ ok: 'default-done' }));
      await sleep(200);
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
