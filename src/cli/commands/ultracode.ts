/**
 * `workflow ultracode "<task>"` (Issue #154): synthesize a
 * facade workflow from a task description, optionally trial-run it (mock or
 * real) and/or fixpoint it into the project saved-workflow registry — from
 * where `workflow workflows run <name>` runs it like any hand-written script.
 *
 * Every produced script passes the same compile purity gate as hand-written
 * ones (synthesizeFacadeScript); the registry write goes through
 * saveSavedWorkflow, so discovery/shadowing semantics are the registry's own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { synthesizeFacadeScript } from '../../dwf/workflow-synthesizer.js';
import { saveSavedWorkflow, slugifyWorkflowName } from '../../dwf/saved.js';
import { executeRunScript } from './run-script.js';

export interface UltracodeOptions {
  /** Fixpoint into the project registry under this name. */
  save?: string;
  /** Trial-run the script in deterministic offline mock mode. */
  mock?: boolean;
  /** Trial-run the script for real (uses the configured provider; costs tokens). */
  run?: boolean;
  /** Provider id for the synthesis ask. */
  provider?: string;
  lang?: string;
  /** Workspace (registry root + trial-run cwd). Defaults to process.cwd(). */
  cwd?: string;
}

export async function executeUltracode(task: string, options: UltracodeOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  console.log('─'.repeat(72));
  console.log(` ULTRACODE — synthesizing a facade workflow for:`);
  console.log(`   "${task}"`);
  console.log('─'.repeat(72));

  const result = await synthesizeFacadeScript({ task, providerId: options.provider });
  if (!result.ok) {
    console.error(`✘ Synthesis failed the compile purity gate after ${result.attempts} attempts. Last diagnostics:`);
    for (const d of result.lastDiagnostics.slice(0, 8)) {
      console.error(`   code ${d.code} @ line ${d.line}: ${d.message}`);
    }
    return 1;
  }
  console.log(`✔ Gate-clean script synthesized in ${result.attempts} attempt(s).`);
  if (result.notes) console.log(`  ${result.notes}`);

  // The runnable file: the saved registry entry when --save, else a scratch
  // file under .workflow/ultracode/ (trial runs need a path; nothing is lost —
  // the script is printed below either way).
  let scriptPath: string;
  if (options.save) {
    const saved = saveSavedWorkflow(cwd, { name: options.save, description: task }, result.script);
    if (!saved.ok) {
      console.error(`✘ Save failed: ${saved.error}`);
      return 1;
    }
    scriptPath = saved.path;
    console.log(`✔ Saved workflow "${options.save}" → ${saved.path}`);
    console.log(`  Run it any time:  workflow workflows run ${options.save}`);
  } else {
    const scratchDir = path.join(cwd, '.workflow', 'ultracode');
    fs.mkdirSync(scratchDir, { recursive: true });
    scriptPath = path.join(scratchDir, `${slugifyWorkflowName(task)}-${Date.now()}.facade.ts`);
    fs.writeFileSync(scriptPath, result.script);
  }
  console.log(`  Script: ${scriptPath}`);

  if (options.mock || options.run) {
    console.log('─'.repeat(72));
    console.log(` TRIAL RUN (${options.mock ? 'mock' : 'real'}):`);
    console.log('─'.repeat(72));
    return executeRunScript(scriptPath, {
      mock: options.mock,
      cwd,
      lang: options.lang,
      ultracode: true,
    });
  }

  console.log('─'.repeat(72));
  console.log(result.script);
  console.log('─'.repeat(72));
  console.log('Next: --mock to trial-run offline, --run for a real run, --save "<name>" to fixpoint it into the registry.');
  return 0;
}
