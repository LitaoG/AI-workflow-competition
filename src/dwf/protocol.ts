/**
 * NDJSON protocol between the sandbox child (script realm) and the parent engine.
 *
 * Child → parent: one JSON object per line. Two kinds:
 *   {t:"call", id, op, siteId?, payload}  — a facade boundary call, awaiting a reply
 *   {t:"done"|"scriptError", ...}         — the script finished (terminal)
 * Parent → child:
 *   {t:"ok", id, value} | {t:"err", id, message} | {t:"abort"}
 *
 * The child is the only writer of its stdout; the parent only writes replies. All
 * frames are single-line JSON (no embedded newlines — JSON.stringify guarantees it).
 *
 * Error-carrying frames (`err`, `scriptError`) optionally carry the domain Tagged
 * Error Algebra (`error` field, the serialized shape from `domain/errors.ts`): new
 * hosts dispatch on `tag`, old hosts ignore the field — frames without it are
 * byte-compatible with the pre-tagged protocol.
 */
import type { SerializableError } from '../domain/errors.js';

export type HostOp =
  | 'createActor'
  | 'ask'
  | 'enterPhase'
  | 'log'
  | 'report'
  | 'artifact'
  | 'declareArtifact'
  | 'worldRead'
  | 'worldRun'
  | 'hole'
  | 'escalate'
  | 'workflow'
  | 'banned';

export interface HostCallFrame {
  t: 'call';
  /** correlation id, unique within the child's lifetime */
  id: number;
  op: HostOp;
  siteId?: string;
  payload: unknown[];
}

export interface HostReplyOk {
  t: 'ok';
  id: number;
  value: unknown;
}
export interface HostReplyErr {
  t: 'err';
  id: number;
  message: string;
  /** Error class name (e.g. WorkflowBudgetExceededError) — the realm rebuilds it. */
  name?: string;
  /**
   * Optional tagged error (the `domain/errors.ts` wire shape): tag dispatch for the
   * realm and the journal. Absent on legacy hosts; never replaces `message`/`name`.
   */
  error?: SerializableError;
}
export type HostReply = HostReplyOk | HostReplyErr | { t: 'abort' };

export interface ScriptDoneFrame {
  t: 'done';
  value: unknown;
}
export interface ScriptErrorFrame {
  t: 'scriptError';
  message: string;
  /** best-effort stack from the child realm */
  stack?: string;
  /** Error class name (e.g. WorkflowPolicyStopError) — the runner maps it to a stop. */
  name?: string;
  /**
   * Optional tagged error (the `domain/errors.ts` wire shape): the child converts
   * whatever the script threw before re-raising across the boundary. Absent on
   * legacy children; `message`/`stack` stay authoritative for old hosts.
   */
  error?: SerializableError;
}
/** Fire-and-forget notification (no reply). actorCreated registers display name + provider + tier; cancelCall routes an abort by child call id. */
export interface ChildNotifyFrame {
  t: 'notify';
  op: 'actorCreated' | 'cancelCall' | 'budgetSync' | 'runInfo' | 'childIdle';
  siteId: string;
  name?: string;
  provider?: string;
  /** For actorCreated: the actor's tier routing literal ('fast' | 'deep') when declared (#151). */
  tier?: string;
  /** For actorCreated: the persona model() literal the script declared (Issue #38 D8-③). */
  model?: string;
  /** For cancelCall: the child call id whose provider request must abort. */
  cancelId?: number;
  /** For budgetSync: the parent-side output-token total spent by completed asks. */
  spent?: number;
  /** Legacy (read-only budget): accepted but ignored; `spent` is the only live field. */
  total?: number | null;
  /** For runInfo: the run identity the script sees as `run`. */
  runId?: string;
  resumedFrom?: string;
}
export type ChildToParent = HostCallFrame | ScriptDoneFrame | ScriptErrorFrame | ChildNotifyFrame;

/** The outcome of one world.run command, including nonzero exits. */
export interface WorldRunResult {
  /** The process exit code. Nonzero is a normal, returned outcome — branch on it. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + '\n';
}
