/**
 * Facade type declarations for facade-script workflows (Level-1 authoring surface).
 *
 * Independently engineered from black-box behavioral specification: the
 * script author sees exactly these primitives and nothing else. The compiler injects
 * this text as an extra in-memory source file, so any use of Node/web ambient APIs
 * (`process`, `fetch`, `fs`, ...) fails typechecking before the script ever runs.
 *
 * Keep this in sync with `src/dwf/lower.ts` (the lowering targets `__host.*`) and
 * `src/dwf/engine.ts` (the parent-side executor of those calls).
 */
export const FACADE_DTS = `
/** The pending result of one ask. Await it, or pass it to Promise.all with others. */
declare interface Node<T> extends PromiseLike<T> {}

/**
 * A subagent: one conversation that keeps its context across asks — ask #2 continues
 * from what the subagent saw in ask #1. Asks issued while it is busy wait their turn,
 * first in, first out. To share one conversation, share the returned value.
 */
declare interface Agent {
  /**
   * Give the subagent one task. With a type argument the answer is a value of type T,
   * validated against a JSON schema synthesized from that type at compile time
   * (JSDoc on a property becomes its field description). Without one, the answer is
   * the subagent's final reply text.
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * Create a subagent. Every call starts a new conversation; to share one, share the
 * returned value. A non-empty name is the card the user sees. Pass opts.provider to
 * route this actor's asks to a specific registered provider (e.g. "mock", "bedrock");
 * omit it to use the registry default.
 */
declare function agent(name: string, opts?: { provider?: string }): Agent;

/** Mark the start of a phase: a named group of the steps that follow. Required. Compile-time literal. */
declare function phase(name: string): void;

/** Emit a progress message to the user. */
declare function log(message: unknown): void;

/** Publish one intermediate result while the run is going. Shown in the run pane. */
declare function report(item: unknown): void;

/** The run's arguments (from --args JSON). Unknown at compile time; narrow before use. */
declare const args: Record<string, unknown>;

/**
 * This run's identity — stamp persistent artifacts and ledger lines with it so the
 * record names the run that produced them. resumedFrom is present when this run
 * amends a prior one (the lineage parent).
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };

/**
 * The run's output-token budget (independently calibrated via black-box behavioral specification).
 * Set budget.total (output tokens) to hard-cap the run: at agent()-call granularity,
 * spending past total stops FURTHER agent() calls with WorkflowBudgetExceededError —
 * in-flight agents complete and their results are preserved. total = null (default)
 * means unlimited and remaining() returns Infinity. spent()/remaining() reflect
 * completed asks only.
 */
declare const budget: {
  total: number | null;
  /** Output tokens spent by completed asks so far. */
  spent(): number;
  /** total minus spent; Infinity when total is null. */
  remaining(): number;
};

/** Publish a file or markdown text the user keeps after the run ends. */
declare const artifact: {
  file(id: string, path: string, opts?: { title?: string }): Promise<{ id: string; version: number }>;
  markdown(id: string, content: string, opts?: { title?: string }): Promise<{ id: string; version: number }>;
};

/**
 * A typed gap: code you write later, once an earlier step's findings are in. When the
 * run reaches an unfilled hole it parks and reports the hole; fill it with
 * "workflow fill <runId> <holeName> <bodyFile>" — the body is spliced where
 * the hole stands (it sees every binding declared before it and may use facade calls),
 * the run forks as an amend (completed nodes replay from the journal at zero cost), and
 * the new run continues with the body's value.
 */
declare function hole<T>(name: string, prompt?: string): Promise<T>;

/**
 * Ask the run owner a blocking question (a human gate). The run parks and reports the
 * question with an id shaped like "dwfq-..."; answer it with
 * "workflow answer <runId> <questionId> <text>" — the answer is journalled, the run
 * resumes (completed nodes replay at zero cost) and this call resolves to the answer.
 */
declare function escalate(question: string): Promise<string>;

/**
 * Compose a SAVED workflow (from the registry: "workflows list") as a child run.
 * Accepts a registry name or {scriptPath}. The child gets its own runId (lineage
 * points back to this run), its own compile-checked approvals, and its own sandbox;
 * nesting is limited to one level — a child cannot call workflow() again.
 * Returns the child run's final value.
 */
declare function workflow(name: string): Promise<unknown>;

/**
 * Fan-out primitives (independently calibrated to a black-box behavioral specification):
 * - parallel(thunks): run thunk functions concurrently; a failed thunk becomes null
 *   (never rejects); budget-exceeded slots are dropped with a summary line.
 * - pipeline(items, ...stages): each item flows through every stage independently
 *   (no global barrier); a null from any stage stops that item's downstream.
 * Both take THUNK functions — "() => agent(...)" — not promises.
 */
declare const fanout: {
  parallel(thunks: ReadonlyArray<() => unknown>): Promise<unknown[]>;
  pipeline(items: ReadonlyArray<unknown>, ...stages: ReadonlyArray<(value: unknown, item: unknown, index: number) => unknown>): Promise<unknown[]>;
};

/**
 * Sessionful-worker primitives over persistent actors (start/steer are just ask on a
 * shared actor: an actor's asks run FIFO on one warm conversation).
 * - waitAny(turns): resolve with whichever turn settles first; losers keep running
 *   unless you cancel them. With timeoutMs, rejects when nobody settles in time.
 * - cancel(turn): abort a pending turn — its provider call stops and nothing is
 *   journalled (a cancelled turn replays as "never happened").
 */
declare const sessions: {
  waitAny(turns: readonly PromiseLike<unknown>[], opts?: { timeoutMs?: number }): Promise<unknown>;
  cancel(turn: PromiseLike<unknown>): void;
};

/** One matching line found by files.grep. */
declare interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Read-only views of the workspace. Recorded for replay; there is no write from a script. */
declare const files: {
  /** Workspace-relative paths matching a glob, sorted. Over 2000 files the call rejects. */
  glob(pattern: string): Promise<string[]>;
  /** Read one workspace file as UTF-8 text. Size-capped. */
  read(path: string): Promise<string>;
  /** Search contents with a regex, optionally narrowed by a glob over paths. */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** The current working tree's status. */
declare interface GitStatus {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** One commit, newest first. */
declare interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** Read-only git views. Recorded for replay. Outside a repository every call rejects. */
declare const git: {
  changedFiles(base?: string): Promise<string[]>;
  diff(base?: string, path?: string): Promise<string>;
  status(): Promise<GitStatus>;
  log(count?: number): Promise<GitCommit[]>;
};

/** The outcome of one world.run command, including nonzero exits. */
declare interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command. The command name must be a compile-time string literal (the script's
 * command set is shown for approval before the run). Fixed argv, never a shell.
 * A completed process resolves, nonzero exit included; rejects only on spawn failure
 * or timeout (default 300000ms, timeoutMs overrides).
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};
`;
