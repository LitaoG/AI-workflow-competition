#!/usr/bin/env node
/**
 * PostToolUse audit: records SHA-256 hashes of the artifacts/ files present
 * after each tool step.
 *
 * Issue #145 honesty fix: this hook never validated any event sequence — it
 * printed "monotonic sequence and artifacts verified" unconditionally, even
 * with no artifacts/ directory present, while the docs claimed an append-only
 * event-stream audit. The wording below states exactly what the hook does;
 * the authoritative event sequence lives in the SQLite journal /
 * events.jsonl and is audited by the engine itself (docs/ARCHITECTURE.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function auditArtifacts() {
  const artifactsDir = path.join(projectRoot, 'artifacts');
  let hashed = 0;
  if (fs.existsSync(artifactsDir)) {
    for (const file of fs.readdirSync(artifactsDir)) {
      const fullPath = path.join(artifactsDir, file);
      if (fs.statSync(fullPath).isFile()) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
        process.stdout.write(`[AUDIT] artifact hashed: ${file} (sha256:${hash.slice(0, 16)}...)\n`);
        hashed++;
      }
    }
  }
  process.stdout.write(`[KIRO HOOK] Post-step audit recorded ${hashed} artifact hashes. This hook performs no event-sequence validation — the SQLite journal / events.jsonl is the authoritative audit stream.\n`);
  process.exit(0);
}

auditArtifacts();
