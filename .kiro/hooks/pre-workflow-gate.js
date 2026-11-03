#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

async function main() {
  process.stdout.write('[KIRO HOOK] Running Pre-Workflow Environment Probe Gate...\n');
  try {
    let prober;
    try {
      const distPath = path.join(projectRoot, 'dist', 'src', 'index.js');
      prober = await import(pathToFileURL(distPath).href);
    } catch {
      const srcPath = path.join(projectRoot, 'src', 'index.ts');
      prober = await import(pathToFileURL(srcPath).href);
    }
    const result = await prober.probe({ cwd: projectRoot });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.stdout.write('[KIRO HOOK] Environment verified successfully.\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[GATE FAILED] Deterministic probe failed: ${err.message}\n`);
    process.exit(1);
  }
}

main();
