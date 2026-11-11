/**
 * `/workflow check <script.ts>` — compile-check a facade script and print its phase
 * graph, actors and approved world.run commands. Diagnostics map to the author's
 * original line numbers; nothing runs.
 */
import * as fs from 'node:fs';
import { analyzeFacadeScript } from '../../dwf/compile.js';

export async function executeCheck(scriptPath: string, options: { json?: boolean; lang?: string }): Promise<number> {
  let source: string;
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch (err) {
    console.error(`Error: cannot read script "${scriptPath}": ${(err as Error).message}`);
    return 1;
  }

  const analysis = analyzeFacadeScript(source);

  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
    return analysis.ok ? 0 : 1;
  }

  if (analysis.ok) {
    console.log(`✔ facade script compiled clean (${analysis.sites.length} sites)`);
  } else {
    console.error(`✖ facade script failed compilation — ${analysis.diagnostics.length} diagnostic(s):`);
    for (const d of analysis.diagnostics) {
      console.error(`  ${scriptPath}:${d.line}:${d.column}  ${d.category}(${d.code}): ${d.message}`);
      if (d.hint) console.error(`    💡 ${d.hint}`);
    }
    return 1;
  }

  console.log('');
  console.log('Phases:');
  if (analysis.phases.length === 0) {
    console.log('  (none — a script must open at least one phase)');
  } else {
    for (const p of analysis.phases) console.log(`  • ${p}`);
  }

  console.log('Actors:');
  if (analysis.actors.length === 0) console.log('  (none)');
  else for (const a of analysis.actors) console.log(`  • ${a}`);

  if (analysis.commands.length > 0) {
    console.log('Approved world.run commands (compile-time literals):');
    for (const c of analysis.commands) console.log(`  • ${c}`);
  }

  console.log('');
  console.log('Sites:');
  for (const s of analysis.sites) {
    const extra = s.kind === 'ask' && s.typeArgText ? ` <${s.typeArgText}>` : '';
    const target = s.actorName ?? s.phaseName ?? s.readOp ?? s.command ?? '';
    console.log(`  ${s.siteId.padEnd(14)} ${s.kind.padEnd(10)} L${s.line}${extra ? extra : ''}${target ? `  ${target}` : ''}`);
  }

  return 0;
}
