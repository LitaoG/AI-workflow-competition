/**
 * `/workflow author <intent...>` — one sentence in, a compile-checked facade
 * script out (Issue #103). The model authors, the compiler disposes: every
 * candidate is validated by the SAME `analyzeFacadeScript` the `check` command
 * uses, and compile diagnostics are re-injected into the next attempt (bounded
 * self-healing loop, max 3 attempts).
 *
 * Deliberately writes files only — it never runs the script (F1): the summary
 * printed before exit shows the phases, the ask sites and the world.run
 * approval set so the operator can review cost and side effects before
 * spending a single token on `run-script`.
 *
 * Cost discipline (F2): every generation is capped by --max-tokens, all
 * attempts' usage is accumulated and reported, the same diagnostics twice in a
 * row stops the loop early (a third identical call would pay for nothing),
 * provider errors go through the shared attempt-classifier (retryable classes
 * back off, policy stops like quota/invalid_request/auth fail fast), and a
 * response truncated at the token ceiling is called out as such instead of
 * being treated as an ordinary compile error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeFacadeScript } from '../../dwf/compile.js';
import { FACADE_DTS } from '../../dwf/facade-dts.js';
import { redactText } from '../../dwf/redact.js';
import { providerRegistry } from '../../agent/provider.js';
import { classifyFailure, backoffSleep } from '../../agent/attempt-classifier.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../../types.js';

/** Bounded self-healing: at most 3 model generations per invocation (Issue #103 design). */
const MAX_AUTHOR_ATTEMPTS = 3;
/** Infra-level retries (429/5xx/stall) per generation, shared classifier semantics. */
const INFRA_RETRY_CAP = 3;
/** Default output ceiling per generation; a full facade script rarely needs more. */
const DEFAULT_MAX_TOKENS = 8192;

export interface AuthorOptions {
  /** Output path for the authored script (default ./authored.workflow.ts). */
  out?: string;
  /** Overwrite an existing output file. */
  force?: boolean;
  /** Registry id of the provider to author with (default: registry default). */
  provider?: string;
  /** Model override forwarded to the provider. */
  model?: string;
  /** Output token ceiling per generation attempt. */
  maxTokens?: number;
  /** Dependency-injected provider — tests script one inline instead of touching the registry. */
  providerInstance?: LLMProvider;
}

interface UsageTally {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

function tally(t: UsageTally, res: LLMResponse): void {
  t.calls += 1;
  t.promptTokens += res.usage?.promptTokens ?? 0;
  t.completionTokens += res.usage?.completionTokens ?? 0;
}

function usageLine(t: UsageTally): string {
  return `usage: ${t.calls} generation call(s), ${t.promptTokens} prompt + ${t.completionTokens} completion tokens`;
}

/** Strip one optional markdown code fence pair; the model was told not to, but models fence anyway. */
function stripCodeFence(content: string): string {
  const fenced = content.match(/^\s*```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1]! : content;
}

const SYSTEM_PROMPT = [
  'You author AI-workflow facade scripts. A facade script is a single top-level-await TypeScript module:',
  'no imports, no exports, no function main — the runner wraps it. Every capability is an ambient global',
  'declared in the .d.ts below (phase, agent with ask<T>, files, world, log, report, args, hole, escalate, workflow).',
  '',
  'Hard rules:',
  '- Output ONLY the complete TypeScript module. No markdown fences, no prose before or after.',
  '- Open at least one phase("...") before the first ask.',
  '- Side effects go through the facade only: files.* for workspace files, world.run("cmd") for approved commands.',
  '- Deterministic: no reading wall-clock time or randomness; typed asks via agent("name").ask<Shape>(...).',
  '- Keep scripts compact: few phases, few asks, typed result shapes.',
  '',
  'The facade API contract you must code against (verbatim .d.ts):',
  FACADE_DTS,
].join('\n');

export async function executeAuthor(intentParts: string[], options: AuthorOptions = {}): Promise<number> {
  const intent = intentParts.join(' ').trim();
  if (!intent) {
    console.error('Error: an intent sentence is required — workflow author <intent...>');
    return 1;
  }
  // F4: the intent can carry credentials as easily as any pasted config — the
  // prompt sees the redacted text only.
  const safeIntent = redactText(intent);

  const provider = options.providerInstance ?? (() => {
    try {
      return providerRegistry.get(options.provider);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return undefined;
    }
  })();
  if (!provider) return 1;

  const outPath = path.resolve(process.cwd(), options.out ?? './authored.workflow.ts');
  // F3: never clobber an existing file without --force (the #114 lesson, cf. init).
  if (fs.existsSync(outPath) && !options.force) {
    console.error(`Error: output file already exists: ${outPath} — pass --force to overwrite`);
    return 1;
  }

  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const usage: UsageTally = { calls: 0, promptTokens: 0, completionTokens: 0 };
  let lastScript = '';
  let lastDiagnostics: string[] = [];
  let lastDiagnosticKey = '';
  let truncatedLast = false;

  for (let attempt = 1; attempt <= MAX_AUTHOR_ATTEMPTS; attempt++) {
    const userParts: string[] = [];
    if (attempt === 1) {
      userParts.push(`Author a workflow facade script for this intent:\n\n${safeIntent}`);
    } else {
      userParts.push(
        `Your previous script failed the facade compiler. Fix it and output the complete corrected module only.\n` +
        `Intent:\n${safeIntent}\n\n` +
        `Compiler diagnostics:\n${lastDiagnostics.map((d) => `- ${d}`).join('\n')}\n\n` +
        `Previous script:\n\`\`\`\n${lastScript}\n\`\`\``,
      );
      if (truncatedLast) {
        userParts.push('Your previous output was CUT OFF at the token ceiling. Produce a SHORTER, COMPLETE script.');
      }
    }
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts.join('\n\n') },
    ];

    let response: LLMResponse | undefined;
    for (let infraAttempt = 0; infraAttempt < INFRA_RETRY_CAP; infraAttempt++) {
      try {
        response = await provider.generate({ messages, temperature: 0.0, maxTokens, model: options.model });
        break;
      } catch (err) {
        const cls = classifyFailure(err, infraAttempt);
        if (!cls.retryable || infraAttempt === INFRA_RETRY_CAP - 1) {
          console.error(`Error: provider call failed (${cls.category}, not retried): ${err instanceof Error ? err.message : String(err)}`);
          console.error(usageLine(usage));
          return 1;
        }
        await backoffSleep(cls.backoffMs);
      }
    }
    if (!response) return 1; // unreachable: the loop above always returns or sets
    tally(usage, response);

    const script = stripCodeFence(response.content).trim();
    lastScript = script;
    truncatedLast = (response.usage?.completionTokens ?? 0) >= maxTokens;
    const analysis = analyzeFacadeScript(script);
    if (analysis.ok) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, script.endsWith('\n') ? script : `${script}\n`, 'utf8');
      // F1: make the script's cost and side-effect surface visible BEFORE it runs.
      const askSites = analysis.sites.filter((site) => site.kind === 'ask').length;
      console.log(`✔ facade script authored and compile-checked: ${outPath} (attempt ${attempt}/${MAX_AUTHOR_ATTEMPTS})`);
      console.log(`  phases: ${analysis.phases.length ? analysis.phases.join(', ') : '(none)'}`);
      console.log(`  ask sites: ${askSites}`);
      if (analysis.commands.length > 0) {
        console.log(`  world.run commands (side effects, re-confirm before running): ${analysis.commands.join(', ')}`);
      } else {
        console.log('  world.run commands: (none)');
      }
      console.log(`  ${usageLine(usage)}`);
      console.log('  next: review the script, then `workflow run-script <file> --budget-total <n>`');
      return 0;
    }

    lastDiagnostics = analysis.diagnostics.map((d) => `${d.category}(${d.code}) @ line ${d.line}:${d.column} — ${d.message}`);
    // F2: the same compiler complaints twice in a row means the loop is not
    // converging — stop before paying for a third identical failure.
    const diagnosticKey = JSON.stringify(lastDiagnostics);
    if (diagnosticKey === lastDiagnosticKey) {
      console.error(`Error: the compiler diagnostics did not change between attempts — stopping before attempt ${attempt + 1} (loop not converging)`);
      break;
    }
    lastDiagnosticKey = diagnosticKey;
    if (truncatedLast) {
      console.error(`Warning: attempt ${attempt} output hit the ${maxTokens}-token ceiling and is likely truncated`);
    }
  }

  // F7: all attempts failed — surface the last script and diagnostics, exit non-zero.
  console.error(`✖ authoring failed after ${usage.calls} generation call(s); ${usageLine(usage)}`);
  console.error('Last compiler diagnostics:');
  for (const d of lastDiagnostics) console.error(`  - ${d}`);
  console.error('Last script:');
  console.error(lastScript);
  return 1;
}
