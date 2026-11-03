#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const distEntry = path.resolve(__dirname, '..', 'dist', 'src', 'cli', 'index.js');
  const srcEntry = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

  let cliModule;
  if (fs.existsSync(distEntry)) {
    cliModule = await import(pathToFileURL(distEntry).href);
  } else if (fs.existsSync(srcEntry)) {
    cliModule = await import(pathToFileURL(srcEntry).href);
  } else {
    console.error('Error: Neither dist/src/cli/index.js nor src/cli/index.ts found. Run "npm run build" first.');
    process.exit(1);
  }

  const exitCode = await cliModule.runCLI(process.argv);
  process.exit(typeof exitCode === 'number' ? exitCode : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
