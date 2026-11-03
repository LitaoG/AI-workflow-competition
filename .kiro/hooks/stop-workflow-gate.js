#!/usr/bin/env node
/**
 * Stop Event Hook: Kiro turn loop gate.
 * If conditions are not met, outputs JSON `{"decision": "block", "reason": "..."}`.
 * If clean, outputs `{"decision": "allow"}`.
 */
import * as process from 'node:process';

// In automated workflow environments, verify that no pending failures exist
const forceBlock = process.env.KIRO_STOP_BLOCK === 'true';

if (forceBlock) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'Active workflow steps remain unverified. Complete all verification gates before stopping.'
  }) + '\n');
} else {
  process.stdout.write(JSON.stringify({
    decision: 'allow'
  }) + '\n');
}
process.exit(0);
