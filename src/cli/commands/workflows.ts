/**
 * `/workflow workflows list|run` — the saved-workflows registry (P2).
 * list: enumerate `.workflow/workflows/*.facade.ts` (project) + `~/.workflow/workflows/` (global)
 * run:  run by name with arg validation and defaults
 */
import { listSavedWorkflows, validateSavedArgs } from '../../dwf/saved.js';
import { runFacadeScript } from '../../dwf/runner.js';
import { printDwfEvent } from '../console-events.js';

export async function executeWorkflowsList(options: { json?: boolean; lang?: string }): Promise<number> {
  const saved = listSavedWorkflows();
  if (options.json) {
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  }
  if (saved.length === 0) {
    console.log('no saved workflows — add facade scripts with frontmatter to .workflow/workflows/*.facade.ts');
    return 0;
  }
  console.log(`saved workflows (${saved.length}):`);
  for (const wf of saved) {
    console.log(`  • ${wf.name}  [${wf.scope}]  ${wf.description}`);
    const argNames = Object.keys(wf.args);
    if (argNames.length > 0) console.log(`      args: ${argNames.join(', ')}`);
    if (wf.whenToUse) console.log(`      when: ${wf.whenToUse}`);
  }
  return 0;
}

export async function executeWorkflowsRun(
  name: string,
  options: { argsJson?: string; resume?: string; dbPath?: string; live?: string; maxConcurrency?: string; lang?: string; cwd?: string },
): Promise<number> {
  const saved = listSavedWorkflows(options.cwd);
  const wf = saved.find((w) => w.name === name);
  if (!wf) {
    console.error(`Error: no saved workflow named "${name}" — run "workflow workflows list" to see what's registered.`);
    return 1;
  }

  let args: Record<string, unknown> = {};
  if (options.argsJson) {
    try {
      args = JSON.parse(options.argsJson);
    } catch (err) {
      console.error(`Error: --args is not valid JSON: ${(err as Error).message}`);
      return 1;
    }
  }
  const validated = validateSavedArgs(wf, args);
  if (!validated.ok) {
    console.error(`Error: ${validated.error}`);
    return 1;
  }

  console.log(`running saved workflow "${wf.name}" (${wf.scope}): ${wf.description}`);
  const exit = await runFacadeScript({
    scriptPath: wf.scriptPath,
    args: validated.args,
    resumeRunId: options.resume,
    dbPath: options.dbPath,
    cwd: options.cwd,
    liveHtmlPath: options.live,
    maxConcurrency: options.maxConcurrency ? Number(options.maxConcurrency) : undefined,
    onEvent: printDwfEvent,
  });

  if (exit.status === 'completed') {
    console.log(`\n✔ ${wf.name} (${exit.runId}) — result: ${JSON.stringify(exit.value)}`);
    return 0;
  }
  if (exit.status === 'parked') {
    console.log(`\n⏸ parked at ${exit.parkedAt?.kind} "${exit.parkedAt?.name}" — continue with fill/answer`);
    return 0;
  }
  console.error(`\n✖ ${wf.name} failed: ${exit.error}`);
  return 1;
}
