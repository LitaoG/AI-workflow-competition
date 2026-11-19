#!/usr/bin/env node
/**
 * PreToolUse Gate: Kiro exit code 2 deny protocol.
 * Exit 0: Allow tool execution.
 * Exit 2: Deny tool execution and feed stderr back to model as actionable guidance.
 * Other exit: Abort session.
 *
 * Issue #145: Kiro delivers the tool call as a JSON object on STDIN
 * (kiro.dev/docs/hooks: "The command receives session context as JSON on
 * STDIN"). This gate used to read only argv and PROHIBITED_OP, so under the
 * real wiring commandToCheck was always empty and the deny branch never
 * fired — `rm -rf /` piped on stdin printed [GATE ALLOWED]. Read the stdin
 * payload's tool_input.command with a bounded wait (a silent open pipe —
 * e.g. a spawnSync without input — must not hang the gate), falling back to
 * argv / env for direct and test-harness invocations.
 */
import * as process from 'node:process';

const DESTRUCTIVE_PATTERN = /(rm\s+-rf\s+\/|format\s+[a-zA-Z]:|mkfs|git\s+reset\s+--hard|git\s+push\s+--force\s+origin\s+main)/i;

async function readStdinCommandBounded(timeoutMs) {
  if (process.stdin.isTTY) return ''; // manual terminal run — no piped context
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        process.stdin.pause();
      } catch {
        /* stdin already gone — nothing to detach */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(''), timeoutMs);
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      if (!raw.trim()) return done('');
      try {
        const parsed = JSON.parse(raw);
        const command = parsed && typeof parsed === 'object' ? parsed.tool_input?.command : undefined;
        done(typeof command === 'string' ? command : '');
      } catch {
        done(''); // non-JSON stdin — not the Kiro hook protocol
      }
    });
    process.stdin.on('error', () => done(''));
  });
}

const stdinCommand = await readStdinCommandBounded(300);
const args = process.argv.slice(2).join(' ');
const envOp = process.env.PROHIBITED_OP || '';
const commandToCheck = [stdinCommand, args, envOp].filter(Boolean).join(' ').trim();

if (DESTRUCTIVE_PATTERN.test(commandToCheck)) {
  process.stderr.write(`[GATE DENIED] Prohibited destructive operation detected: "${commandToCheck}". Execution is blocked by policy-guardrails.\n`);
  process.exit(2);
}

process.stdout.write('[GATE ALLOWED] Step operation approved.\n');
process.exit(0);
