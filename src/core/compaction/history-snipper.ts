/**
 * History snipper: tier 2 of the context compaction pipeline (
 * Issue #102). It folds old turns into one-line records.
 *
 * Only the most recent `keepRecentTurns` turns stay verbatim. Every older
 * turn (its assistant reply, tool results and engine feedback) becomes one
 * short `snipped` record. The system prompt, the goal, snapshots and earlier
 * records are never folded.
 */
import type { ContextMessage } from './pipeline.js';

export interface SnipOptions {
  /** Most recent turns kept verbatim (at least 1). */
  keepRecentTurns: number;
  /** Characters kept from each folded message (default 120). */
  excerptChars?: number;
}

export interface SnipResult {
  messages: ContextMessage[];
  /** Turns folded by this call, ascending. */
  foldedTurns: number[];
}

/** Message kinds that belong to one loop turn, and so may be folded. */
export function isTurnMessage(message: ContextMessage): boolean {
  return message.kind === 'assistant' || message.kind === 'tool_result' || message.kind === 'feedback';
}

/** Fold every turn except the most recent `keepRecentTurns` into one record each. */
export function snipHistory(messages: readonly ContextMessage[], options: SnipOptions): SnipResult {
  const keep = Math.max(1, Math.floor(options.keepRecentTurns));
  const excerptChars = Math.max(16, Math.floor(options.excerptChars ?? 120));
  const turns = [...new Set(messages.filter(isTurnMessage).map((m) => m.turn))].sort((a, b) => a - b);
  const foldCount = turns.length - keep;
  if (foldCount <= 0) return { messages: [...messages], foldedTurns: [] };
  const folded = new Set(turns.slice(0, foldCount));

  const partsByTurn = new Map<number, ContextMessage[]>();
  for (const message of messages) {
    if (!isTurnMessage(message) || !folded.has(message.turn)) continue;
    const parts = partsByTurn.get(message.turn) ?? [];
    parts.push(message);
    partsByTurn.set(message.turn, parts);
  }

  const out: ContextMessage[] = [];
  const emitted = new Set<number>();
  for (const message of messages) {
    if (!isTurnMessage(message) || !folded.has(message.turn)) {
      out.push(message);
      continue;
    }
    if (emitted.has(message.turn)) continue;
    emitted.add(message.turn);
    out.push(foldTurn(message.turn, partsByTurn.get(message.turn) ?? [], excerptChars));
  }
  return { messages: out, foldedTurns: [...folded] };
}

function foldTurn(turn: number, parts: readonly ContextMessage[], excerptChars: number): ContextMessage {
  const lines = parts.map((part) => `${part.kind}: ${excerpt(part.content, excerptChars)}`);
  return { role: 'user', kind: 'snipped', turn, content: `[turn ${turn} folded] ${lines.join(' | ')}` };
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}
