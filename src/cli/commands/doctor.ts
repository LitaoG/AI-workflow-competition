/**
 * `/workflow doctor` — readiness check for facade-script runs (borrowed from Open
 * Dynamic Workflow's doctor): runtime, git, compiler, journal writability, providers.
 * Exit 0 when everything a facade run needs is in place; non-zero otherwise.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerRegistry } from '../../agent/provider.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function executeDoctor(options: { json?: boolean; lang?: string }): Promise<number> {
  const checks: Check[] = [];

  // Runtime
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node runtime', ok: major >= 22, detail: `node ${process.versions.node} (sandbox children need >= 22)` });

  // TypeScript compiler (the facade compiler loads lib files from the package)
  let tsOk = false;
  let tsVersion = '';
  try {
    const { createRequire } = await import('node:module');
    const require_ = createRequire(import.meta.url);
    const pkg = require_('typescript/package.json') as { version: string };
    tsOk = true;
    tsVersion = pkg.version;
  } catch {
    tsOk = false;
  }
  checks.push({ name: 'typescript compiler', ok: tsOk, detail: tsOk ? `typescript ${tsVersion}` : 'typescript not resolvable — facade compilation unavailable' });

  // Git (world reads)
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  checks.push({ name: 'git', ok: git.status === 0, detail: git.status === 0 ? git.stdout.trim() : 'git not on PATH — files/git world reads will reject' });

  // Journal writability
  const journalDir = path.resolve('.workflow');
  let journalOk = false;
  let journalDetail = '';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    const probe = path.join(journalDir, `.doctor-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    journalOk = true;
    journalDetail = `${journalDir} writable`;
  } catch (err) {
    journalDetail = `cannot write ${journalDir}: ${(err as Error).message}`;
  }
  checks.push({ name: 'journal storage', ok: journalOk, detail: journalDetail });

  // Sandbox child entry present (compiled CLI lives at dist/src/cli/commands/)
  const childEntry = new URL('../../dwf/child-main.js', import.meta.url);
  const childOk = fs.existsSync(childEntry);
  checks.push({ name: 'sandbox child', ok: childOk, detail: childOk ? 'dist/src/dwf/child-main.js built' : 'run `npm run build` — the sandbox child is missing' });

  // Providers + per-provider health (ODW-style readiness, no model call)
  const providers = providerRegistry.list();
  checks.push({ name: 'providers', ok: providers.length > 0, detail: `registered: ${providers.join(', ')} (default: mock)` });
  for (const id of providers) {
    const provider = providerRegistry.get(id);
    if (typeof provider.checkHealth === 'function') {
      try {
        const health = await provider.checkHealth();
        checks.push({ name: `provider:${id}`, ok: health.ok, detail: health.detail });
      } catch (err) {
        checks.push({ name: `provider:${id}`, ok: false, detail: `health probe failed: ${(err as Error).message}` });
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (options.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    console.log('AI-Workflow doctor — facade-script readiness');
    for (const c of checks) {
      console.log(`  ${c.ok ? '✔' : '✖'} ${c.name.padEnd(20)} ${c.detail}`);
    }
    console.log('');
    console.log(failed.length === 0 ? '✔ ready to run facade scripts' : `✖ ${failed.length} check(s) failed`);
  }
  return failed.length === 0 ? 0 : 1;
}
