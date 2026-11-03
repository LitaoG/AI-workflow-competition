#!/usr/bin/env node
/**
 * PreToolUse Gate: Kiro exit code 2 deny protocol.
 * Exit 0: Allow tool execution.
 * Exit 2: Deny tool execution and feed stderr back to model as actionable guidance.
 * Other exit: Abort session.
 */
import * as process from 'node:process';

const args = process.argv.slice(2).join(' ');
const envOp = process.env.PROHIBITED_OP || '';
const commandToCheck = (args + ' ' + envOp).trim();

const destructivePattern = /(rm\s+-rf\s+\/|format\s+[a-zA-Z]:|mkfs|git\s+reset\s+--hard|git\s+push\s+--force\s+origin\s+main)/i;

if (destructivePattern.test(commandToCheck)) {
  process.stderr.write(`[GATE DENIED] Prohibited destructive operation detected: "${commandToCheck}". Execution is blocked by policy-guardrails.\n`);
  process.exit(2);
}

process.stdout.write('[GATE ALLOWED] Step operation approved.\n');
process.exit(0);
