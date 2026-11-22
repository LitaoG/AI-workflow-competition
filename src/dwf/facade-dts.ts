/**
 * Facade type declarations for facade-script workflows (Level-1 authoring surface).
 *
 * Modeled on the ZCode dynamic-workflow facade surface: the
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
 * omit it to use the registry default. Pass opts.tier ('fast' | 'deep') to opt this
 * actor into the task-attribute dual track (#151): 'fast' takes
 * AI_WORKFLOW_FAST_PROVIDER, 'deep' takes AI_WORKFLOW_DEEP_PROVIDER; with neither
 * configured both resolve to the registry default. Without a tier, asks with a
 * schema or a large prompt route deep automatically. All options must be
 * compile-time string literals — routing is part of the approved run shape.
 * opts.model binds the actor to a MODEL via model() (Issue #38 D8-③, canonical
 * parity): it wins over provider/tier; the id resolves against the run's model
 * directory at actor creation and an unknown id fails the run before any ask.
 */
declare function agent(name: string, opts?: { provider?: string; tier?: 'fast' | 'deep'; model?: ModelRef | string }): Agent;

/** A model declared with model() (Issue #38 D8-③). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/**
 * Declare a model subagents may run on: "modelId" or "providerId/modelId", optional
 * "$level" suffix (e.g. "mock", "bedrock/claude-opus-4-5$high"). String literal only;
 * resolved against the run's model directory (runner modelDirectory option; every
 * registered provider id is implicitly a model of the same name). Only valid as the
 * agent() opts.model binding — a model() call anywhere else is a compile error.
 */
declare function model(id: string): ModelRef;

/** Mark the start of a phase: a named group of the steps that follow. Required. Compile-time literal. */
declare function phase(name: string): void;

/** Emit a progress message to the user. */
declare function log(message: unknown): void;

/**
 * Publish one intermediate result while the run is going. Shown in the run pane.
 * The optional second argument is a compile-time literal naming a declared preset
 * (artifact.chart / table / metrics / board): the item feeds that artifact — one
 * chart point, one table row, one metric tile, or one board card (Issue #38).
 */
declare function report(item: unknown, artifactId?: string): void;

/**
 * Adjust the live plan graph mid-run (Issue #171): declare PENDING nodes ("boxes")
 * and dependency edges ("lines") that the run's graph.html shows immediately, before
 * (or instead of) their execution. Node ids are script-chosen runtime values; edges
 * may reference plan ids OR real site ids (the compile-time site table that
 * "workflow check" prints, e.g. "ask#5") — an edge whose endpoint has not appeared yet renders once that
 * node exists. Nodes that are never executed stay pending, exactly like the opening
 * plan skeleton. Re-declaring an existing id is a no-op (idempotent).
 *
 * Unlike the other primitives, "plan" may be SHADOWED by a local binding (workflow
 * scripts constantly bind "plan"): only the direct call plan({...}) reaches the
 * engine, and a call against a shadowing local typechecks against that local —
 * the ambiguity is guarded by the type checker, not a shadow ban.
 */
declare function plan(update: {
  nodes?: Array<{ id: string; name?: string; phase?: string }>;
  edges?: Array<{ from: string; to: string }>;
}): void;

/** The run's arguments (from --args JSON). Unknown at compile time; narrow before use. */
declare const args: Record<string, unknown>;

/**
 * This run's identity — stamp persistent artifacts and ledger lines with it so the
 * record names the run that produced them. id is seeded at boot from the parent's
 * spawn argv (Issue #266): safe to read at script TOP LEVEL, before any await —
 * it no longer races the parent's runInfo push. resumedFrom is present when this
 * run amends a prior one (the lineage parent) and arrives with that push.
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };

/**
 * The run's output-token budget (canonical parity: injected by the run config and
 * READ-ONLY — a script can read it but never raise its own cap). Set it with the
 * runner's budgetTotal option (workflow run-script --budget-total <n> or the
 * MCP budgetTotal argument). At agent()-call granularity, spending past total
 * stops FURTHER agent() calls with WorkflowBudgetExceededError — in-flight agents
 * complete and their results are preserved. total = null (default) means unlimited
 * and remaining() returns Infinity. spent()/remaining() reflect completed asks only.
 */
declare const budget: {
  readonly total: number | null;
  /** Output tokens spent by completed asks so far. */
  spent(): number;
  /** total minus spent; Infinity when total is null. */
  remaining(): number;
};

/** Card metadata every artifact kind accepts (Issue #38 D8-③ preset family). */
declare interface ArtifactOptions {
  /** Shown as the card title; defaults to the id. */
  title?: string;
  /** A sentence or two, shown beside the title when this artifact is the run's primary. */
  description?: string;
  /** The run's deliverable: at most one id per run; once set it stays set for later versions. */
  primary?: boolean;
}
/** One value taken from a reported item: a dot path into the item ("timing.after"). */
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: 'line' | 'bar' | 'scatter';
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];
  scale?: 'linear' | 'log';
  /** A reference value drawn as a horizontal rule, from the first item that has the field. */
  baseline?: ArtifactField;
}
declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  /** Field that identifies a row; a later item with the same key replaces the row. Absent = append-only. */
  key?: string;
}
declare interface MetricsSpec extends ArtifactOptions {
  /** Each tile shows the value from the latest item that has the field. */
  metrics: ArtifactField[];
}
declare interface BoardSpec extends ArtifactOptions {
  /** Field identifying a card; a later item with the same key moves/updates the card. */
  key: string;
  /** Field holding the card's column. */
  status: string;
  /** Column order. Items whose status is not listed land in a trailing "other" column. */
  columns: string[];
  /** Field for the card title (default: the key) and extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
}
/**
 * Publish what the user keeps. CONTENT members (file, markdown) are effects: async,
 * resolve to a versioned ref, reject catchably. PRESET members (chart, table,
 * metrics, board) are DECLARATIONS: synchronous and void, fed by
 * report(item, "<id>") items. Declare each once at the top level — an identical
 * re-declaration is a no-op, a different or malformed spec fails the whole run.
 * Every id is a compile-time string literal (non-empty, at most 64 characters of
 * [A-Za-z0-9_.-]) and is used with one member only.
 */
declare const artifact: {
  file(id: string, path: string, opts?: { title?: string }): Promise<{ id: string; version: number }>;
  markdown(id: string, content: string, opts?: { title?: string }): Promise<{ id: string; version: number }>;
  /** Declare a chart fed by report(item, id): each tagged item is one point. */
  chart(id: string, spec: ChartSpec): void;
  /** Declare a table fed by report(item, id): each tagged item is one row. */
  table(id: string, spec: TableSpec): void;
  /** Declare a metric tile row fed by report(item, id): each tile shows the newest value it has. */
  metrics(id: string, spec: MetricsSpec): void;
  /** Declare a board fed by report(item, id): each tagged item is a card, placed by its status field. */
  board(id: string, spec: BoardSpec): void;
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
 * Accepts a registry name. The child gets its own runId (lineage points back to
 * this run), its own compile-checked approvals, and its own sandbox. Composition
 * is multi-level but bounded: a chain may contain at most 5 saved workflows, and
 * a name may not repeat in the chain (cycle error names the full path).
 * Returns the child run's final value.
 */
declare function workflow(name: string): Promise<unknown>;

/**
 * Fan-out primitives (exact host-actor semantics):
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
 * Swarm: give every task to a subagent and collect the answers in task order.
 * Task i goes to agents[i % agents.length]. All tasks start at once; the run's
 * concurrency limit (maxConcurrency / AI_WORKFLOW_MAX_CONCURRENT_AGENTS) caps how
 * many run at the same time. With a type argument every answer is a value of type T,
 * validated like ask<T>. A task whose ask fails with WorkflowBudgetExceededError
 * drops to null (the budget is a run-level fact, not a task failure); any other
 * first failure rejects the swarm and cancels the tasks still running. All tasks
 * share this run's working tree (no per-task worktree).
 */
declare function swarm<T = string>(agents: readonly Agent[], tasks: readonly string[]): Promise<T[]>;

/**
 * Sessionful-worker primitives over persistent actors (start/steer are just ask on a
 * shared actor: an actor's asks run FIFO on one warm conversation).
 * - waitAny(turns): resolve with whichever turn settles first; losers keep running
 *   unless you cancel them. With timeoutMs, rejects when nobody settles in time.
 * - race(turns): speculative execution — resolve with the first turn that FULFILLS
 *   and cancel every other pending turn (its provider call aborts). Rejects when
 *   all turns reject, or on timeoutMs, cancelling every pending turn in both cases.
 *   Pass raw agent(...).ask(...) turns (not wrapped promises) so losers can be
 *   cancelled.
 * - cancel(turn): abort a pending turn — its provider call stops, no result or
 *   failure is journalled, and a resumed run re-executes it (a cancelled turn
 *   replays as "never happened").
 */
declare const sessions: {
  waitAny(turns: readonly PromiseLike<unknown>[], opts?: { timeoutMs?: number }): Promise<unknown>;
  race(turns: readonly PromiseLike<unknown>[], opts?: { timeoutMs?: number }): Promise<unknown>;
  cancel(turn: PromiseLike<unknown>): void;
};

/**
 * A typed channel between concurrent parts of one script (a pure cell: no site, no
 * journal entry — coordination never crosses the run boundary). send() never waits
 * (unbounded buffer); each buffered item is taken by exactly one receiver, FIFO.
 * close() is idempotent; after it send() throws a catchable ChannelClosed error,
 * while receivers drain what is left and then see ChannelClosed (receive) or a
 * normal loop end (for await). A receiver parked on an open channel that no sender
 * can reach anymore is rejected with ChannelDeadlock (the message names the channel).
 */
declare interface Channel<T> {
  /** Buffer one item (never waits). Throws ChannelClosed once the channel is closed. */
  send(value: T): void;
  /** Close the channel: idempotent. Parked receivers wake: receive() rejects ChannelClosed, for await ends normally. */
  close(): void;
  /** Take the next buffered item, or park until one arrives / the channel closes. */
  receive(): Promise<T>;
  /** Drain until closed: for await (const item of ch) { ... } ends normally at close. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * A one-shot cell for handing a value to code that does not exist yet (a pure cell:
 * no site, no journal entry). resolve()/reject() settle promise once — later calls
 * on the same future are ignored.
 */
declare interface Future<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

/** Create a channel (see Channel). */
declare function channel<T>(): Channel<T>;

/** Create a future (see Future). */
declare function future<T = unknown>(): Future<T>;

/** One matching line found by files.grep. */
declare interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** One related file of a repomap slice, with its usage weight against the target. */
declare interface RepomapFileScore {
  file: string;
  score: number;
}

/** What files.map returns: a budget-capped, symbol-relevant view of one file. */
declare interface RepomapSlice {
  /** Workspace-relative target the slice was built for. */
  target: string;
  /** The sliced text — never over the budget; truncation is announced in-band. */
  text: string;
  /** True when the budget cut the slice short. */
  truncated: boolean;
  /** Top-level declarations kept in the slice. */
  keptSymbols: string[];
  /** Related files (importers + imports), most relevant first. */
  ranked: RepomapFileScore[];
}

/** Read-only views of the workspace. Recorded for replay; there is no write from a script. */
declare const files: {
  /** Workspace-relative paths matching a glob, sorted. Over 2000 files the call rejects. */
  glob(pattern: string): Promise<string[]>;
  /** Read one workspace file as UTF-8 text. Size-capped. */
  read(path: string): Promise<string>;
  /** Search contents with a regex, optionally narrowed by a glob over paths. */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
  /**
   * AST symbol map for one file (y.md pillar 2): the file's relevant
   * declarations plus its import/importer neighborhood, under a hard
   * character budget. Read-only; the map walks the workspace's TS sources
   * (node_modules/dist excluded, 500-file cap).
   */
  map(target: string): Promise<RepomapSlice>;
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
