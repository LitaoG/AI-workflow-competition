/**
 * Workflow synthesizer (Phase 7b, Issue #154):
 * an LLM writes the facade script for a task, and the script is only accepted
 * when it passes the SAME compile purity gate every hand-written script goes
 * through (analyzeFacadeScript — AST bans, literal rules, type check). Failed
 * attempts feed the real diagnostics back to the model, bounded retries, then
 * a structured failure. The compiler stays the sole authority — the synthesizer
 * can never smuggle a script past the gate because it never bypasses it.
 */
import { z } from 'zod';
import { agent } from '../agent/rpc.js';
import { analyzeFacadeScript } from './compile.js';
import type { FacadeDiagnostic } from './diagnostics.js';

const SynthesisReply = z.object({
  script: z.string().min(1).describe('The complete facade script TypeScript source'),
  notes: z.string().optional().describe('One short paragraph: what the workflow does and how to call it'),
});
type SynthesisReplyShape = z.infer<typeof SynthesisReply>;

export interface SynthesisOk {
  ok: true;
  script: string;
  notes?: string;
  attempts: number;
}
export interface SynthesisFail {
  ok: false;
  attempts: number;
  lastDiagnostics: FacadeDiagnostic[];
}
export type SynthesisResult = SynthesisOk | SynthesisFail;

export interface SynthesizerOptions {
  task: string;
  /** Hard cap on compile-gate attempts (default 3 — one draft + bounded repairs). */
  maxAttempts?: number;
  /** Provider id for the synthesis ask (routing is part of the call; tier routing applies via env). */
  providerId?: string;
}

const SYSTEM_PROMPT = `You write AI-Workflow facade scripts ("code as workflow"). The script is TypeScript executed in a sandboxed VM realm with ONLY the workflow facade in scope — no imports, no process, no Date.now, no Math.random, no fetch.

Available primitives (all compile-time checked):
- phase("name") — declare a phase (required; literal).
- const reply = await agent("name").ask("prompt") — a subagent ask; agent names are literals. With a type argument the reply is validated: await agent("x").ask<Shape>("...").
- files.glob(pattern) / files.read(path) / files.grep(pattern, glob?) / files.map(target) — read-only workspace views.
- world.run(cmd, args?) — run an allow-listed command literal (e.g. "node", "git"); the command name must be a string literal.
- budget.spent / budget.remaining — token budget probes.
- args — the run's input object (fields the caller passes).
- escalate("question") — park the run for a human answer.
- swarm<T>([agent("a"), agent("b")], [tasks]) — batch fan-out asks.
- artifact.file("name.txt", content) / artifact.markdown("name", md) — publish outputs.

Rules:
1. The script MUST begin with a phase("...") declaration.
2. Every agent()/phase()/world.run() name must be a compile-time string literal.
3. Control flow is plain TypeScript (if/for/while) — deterministic; no timing, no randomness.
4. return a JSON-serializable result value at the end.
5. Reply with ONLY one JSON object: {"script": "<the complete script source>", "notes": "<one short paragraph>"}`;

/** Compose one synthesis attempt's user prompt (task + optional repair feedback). */
function buildAttemptPrompt(task: string, feedback?: { script: string; diagnostics: FacadeDiagnostic[] }): string {
  if (!feedback) {
    return `Task: ${task}\n\nWrite the facade script for this task. Reply with the JSON object described in the system prompt.`;
  }
  const diag = feedback.diagnostics
    .slice(0, 10)
    .map((d) => `- code ${d.code} at line ${d.line}: ${d.message}`)
    .join('\n');
  return [
    `Task: ${task}`,
    '',
    'Your previous script FAILED the compile purity gate. Fix it and reply with the JSON object again.',
    'Diagnostics:',
    diag,
    '',
    'Your previous script (for reference):',
    '```typescript',
    feedback.script,
    '```',
  ].join('\n');
}

/** Render diagnostics as the repair feedback (bounded, line-referenced). */
function feedbackFrom(script: string, diagnostics: FacadeDiagnostic[]): { script: string; diagnostics: FacadeDiagnostic[] } {
  return { script, diagnostics };
}

/**
 * Synthesize one facade script for `task` under the compile purity gate.
 * Attempts are bounded; every rejection feeds the exact compiler diagnostics
 * back to the model. The result is either a gate-clean script or the last
 * diagnostics — never an unchecked script.
 */
export async function synthesizeFacadeScript(options: SynthesizerOptions): Promise<SynthesisResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  let feedback: { script: string; diagnostics: FacadeDiagnostic[] } | undefined;
  let lastDiagnostics: FacadeDiagnostic[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let reply: { script: string; notes?: string };
    try {
      reply = await agent('ultracode-synthesizer').ask<SynthesisReplyShape>(buildAttemptPrompt(options.task, feedback), SynthesisReply, {
        systemPrompt: SYSTEM_PROMPT,
        providerId: options.providerId,
      });
    } catch (err) {
      // The ask layer's own failures (provider down, schema never repaired)
      // end the synthesis with the error surfaced — no silent partial script.
      throw err;
    }
    const check = analyzeFacadeScript(reply.script);
    if (check.ok) {
      return { ok: true, script: reply.script, notes: reply.notes, attempts: attempt };
    }
    lastDiagnostics = check.diagnostics;
    feedback = feedbackFrom(reply.script, check.diagnostics);
  }
  return { ok: false, attempts: maxAttempts, lastDiagnostics };
}
