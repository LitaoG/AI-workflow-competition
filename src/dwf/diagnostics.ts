/**
 * Diagnostics and site-table types for the facade-script compiler.
 *
 * Two channels of compile-time guarantees, mirroring ZCode's dwf compiler:
 *  - TS type diagnostics: strict checking against the facade d.ts (wrong types, unknown
 *    identifiers like `process`/`fetch` — they are simply not declared).
 *  - Authorization rules (9xxx codes): AST-level checks the type system cannot express —
 *    literal rules, purity bans, shadowing bans. The numbers are log bits; the message
 *    prefix is the real discriminator.
 *
 * Every diagnostic speaks the domain's Tagged Error Algebra: a {@link FacadeDiagnostic}
 * IS a `CompileError` value ({@link CompileError['tag']} carried on the object) with the
 * compiler's position/code/category fields kept alongside for backwards compatibility.
 */
import { CompileError } from '../domain/errors.js';

export type FacadeSiteKind =
  | 'actor'
  | 'ask'
  | 'phase'
  | 'log'
  | 'report'
  | 'artifact'
  | 'worldRead'
  | 'worldRun'
  | 'hole'
  | 'escalate'
  | 'workflow';

/** One facade call site discovered in the script AST (static, compile-time). */
export interface FacadeSite {
  /** Stable identity, e.g. "ask#3". Sequential in AST visit order. */
  siteId: string;
  kind: FacadeSiteKind;
  /** 1-based line in the author's original source. */
  line: number;
  /** For `ask`: the type argument text, e.g. "TriageResult". */
  typeArgText?: string;
  /** For `actor`/`ask`: subagent display name when statically known (string literal). */
  actorName?: string;
  /** For `phase`: the literal phase name. */
  phaseName?: string;
  /** For `worldRun`: the literal command name. */
  command?: string;
  /** For `worldRead`: which read, e.g. "files.glob". */
  readOp?: string;
  /** For `hole`: the compile-time hole name. */
  holeName?: string;
  /** For `phase`: the 0-based declaration order (event index for view grouping). */
  phaseIndex?: number;
  /** For `hole`: whether a type argument was present. */
  typed?: boolean;
  /** For `actor`: provider routing when written as a literal ({ provider: "mock" }). */
  provider?: string;
  /** For `ask<T>`: the JSON schema synthesized from T at compile time. */
  schema?: Record<string, unknown>;
}

export interface FacadeDiagnostic extends CompileError {
  /** 1-based line in the author's source. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 9xxx authorization-rule code or 2xxx TS type error code. */
  code: number;
  /** e.g. "purity-ban" | "literal-rule" | "facade-misuse" | "type-error" | "schema-synth". */
  category: string;
}

/** Result of analyzing a facade script (used by both `check` and `run-script`). */
export interface FacadeAnalysis {
  ok: boolean;
  diagnostics: FacadeDiagnostic[];
  sites: FacadeSite[];
  /** Phase names in first-appearance order (all compile-time literals). */
  phases: string[];
  /** Distinct literal world.run command names (the approval set). */
  commands: string[];
  /** Actors in creation order. */
  actors: string[];
}
