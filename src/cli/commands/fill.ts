/**
 * `/workflow fill <runId> <holeName> [bodyFile]` — fill a hole a run is parked at.
 * The body is spliced where the hole stands; the run forks as an amend (completed
 * nodes replay from the journal at zero cost) and continues with the body's value.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fillHoleAndRun } from '../../dwf/runner.js';

export async function executeFill(
  runId: string,
  holeName: string,
  bodyFile: string | undefined,
  options: { body?: string; dbPath?: string; maxConcurrency?: string; lang?: string },
): Promise<number> {
  let body = options.body;
  if (!body && bodyFile) {
    try {
      body = fs.readFileSync(path.resolve(bodyFile), 'utf8');
    } catch (err) {
      console.error(`Error: cannot read body file "${bodyFile}": ${(err as Error).message}`);
      return 1;
    }
  }
  if (!body || !body.trim()) {
    console.error('Error: a fill body is required — pass a body file path or --body "<statements>".');
    return 1;
  }

  const started = Date.now();
  const result = await fillHoleAndRun({
    runId,
    holeName,
    body,
    dbPath: options.dbPath,
    maxConcurrency: options.maxConcurrency ? Number(options.maxConcurrency) : undefined,
    onEvent: (e) => {
      switch (e.type) {
        case 'dwf_phase':
          console.log(`\n--- ${e.data.phase} ---`);
          break;
        case 'dwf_amend_hit':
          console.log(`  ♻ amended run reused: ${e.data.siteId}#${e.data.ordinal} (0 provider calls)`);
          break;
        case 'dwf_amend_diverged':
          console.log(`  ⑂ amended run diverged: ${e.data.siteId} (executing live)`);
          break;
        case 'dwf_ask_start':
          console.log(`  ask → ${e.data.actor} (${e.data.siteId})`);
          break;
        case 'dwf_ask_complete':
          console.log(`  ✔ ask done (${e.data.siteId})`);
          break;
        case 'dwf_hole_open':
          console.log(`  ⏸ hole open: ${e.data.name} (${e.data.siteId})`);
          break;
        case 'dwf_call_error':
          console.error(`  ✖ ${e.data.siteId ?? e.data.op}: ${e.data.error}`);
          break;
        default:
          break;
      }
    },
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  if (result.status === 'refused') {
    console.error(`✖ fill refused: ${result.error}`);
    for (const d of result.diagnostics ?? []) {
      console.error(`  L${d.line}:${d.column}  ${d.category}(${d.code}): ${d.message}`);
    }
    return 1;
  }

  const run = result.run!;
  if (run.status === 'completed') {
    console.log(`\n✔ hole "${holeName}" filled; forked run ${run.runId} completed in ${seconds}s`);
    console.log(`  asks: ${run.stats.asks} (amended-reused: ${run.stats.amendHits}, diverged: ${run.stats.diverged})`);
    console.log(`  result: ${JSON.stringify(run.value)}`);
    console.log(`  effective script: ${result.effectiveScriptPath}`);
    return 0;
  }
  if (run.status === 'parked') {
    console.log(`\n⏸ hole "${holeName}" filled; forked run ${run.runId} parked at another hole: ${run.parkedAt?.name}`);
    console.log(`  fill it next: node bin/workflow.js fill ${run.runId} ${run.parkedAt?.name} <bodyFile>`);
    return 0;
  }

  console.error(`\n✖ forked run ${run.runId} failed in ${seconds}s: ${run.error}`);
  return 1;
}
