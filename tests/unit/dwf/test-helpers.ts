/**
 * (Issue #108): shared test assembly for tests/unit/dwf — the engine/provider/
 * frame scaffolding that a dozen dwf unit tests previously duplicated verbatim
 * lives here exactly once. Test-internal refactor only: same inputs produce the
 * same engine config, the same frame shapes, and the same counting behavior as
 * the removed per-file copies.
 */
import { FacadeEngine } from '../../../src/dwf/engine.js';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { createSQLiteStore } from '../../../src/state/store.js';
import type { SQLiteStateStore } from '../../../src/state/sqlite-store.js';
import type { DwfJournalStore, DwfNode, LLMProvider, LLMRequest, LLMResponse } from '../../../src/types.js';
import { MockProvider } from '../../../src/agent/mock-provider.js';

/** FacadeEngine constructor overrides accepted by the makeEngine helpers. */
export type EngineOptions = Partial<ConstructorParameters<typeof FacadeEngine>[0]>;

/** The journal-backed store type every dwf unit test assembles. */
export type DwfTestStore = SQLiteStateStore & DwfJournalStore;

/** The host-call frame shape the child realm sends (the shared local type). */
export type CallFrame = { t: 'call'; id: number; op: 'ask' | 'createActor'; siteId: string; payload: unknown[] };

/**
 * The shared engine assembly (empty approval set): runId + journal store +
 * optional overrides on top of the duplicated default config.
 */
export function makeEngine(runId: string, store: DwfTestStore, overrides: EngineOptions = {}): FacadeEngine {
  return new FacadeEngine({
    runId,
    workspace: process.cwd(),
    store,
    args: {},
    approvedCommands: [],
    onEvent: () => {},
    ...overrides,
  });
}

/** Same assembly with the second duplicated variant: `node` pre-approved. */
export function makeNodeApprovedEngine(runId: string, store: DwfTestStore, overrides: EngineOptions = {}): FacadeEngine {
  return makeEngine(runId, store, { approvedCommands: [{ name: 'node', source: 'explicit' as const }], ...overrides });
}

/** Fresh in-memory SQLite store typed for the dwf journal. */
export function makeStore(): DwfTestStore {
  return createSQLiteStore(':memory:') as DwfTestStore;
}

/** Counting wrapper so tests can assert exactly how many provider calls happened. */
export class CountingProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  calls = 0;
  private readonly inner = new MockProvider();
  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return this.inner.generate(request);
  }
}

/** Canned LLMResponse factory; each test file binds its own mock model label. */
export function makeRespond(model: string): (content: string) => LLMResponse {
  return (content: string): LLMResponse => ({
    content,
    model,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 0,
  });
}

/** A provider factory that records it was called — the routing assertion reads the taps. */
export function makeTap(model: string): (id: string) => LLMProvider & { hits: number } {
  const respond = makeRespond(model);
  return (id: string): LLMProvider & { hits: number } => ({
    id,
    name: id,
    hits: 0,
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      this.hits += 1;
      return respond(`ok from ${id}`);
    },
  });
}

/** createActor frame with the 'inspector' agent name (the replay-family shape). */
export function actorFrame(id: number, siteId: string): CallFrame {
  return { t: 'call', id, op: 'createActor', siteId, payload: ['inspector'] };
}

/** ask frame with an optional reply schema (the replay-family shape). */
export function askFrame(id: number, siteId: string, actor: unknown, prompt: string, schemaJson: string | null = null): CallFrame {
  return { t: 'call', id, op: 'ask', siteId, payload: [actor, prompt, schemaJson] };
}

/** Build the amend warm cache from a prior run's journal rows (the runner's --amend import shape). */
export function warmCache(nodes: DwfNode[]): Map<string, DwfNode> {
  return new Map(nodes.map((n) => [`${n.siteId}#${n.ordinal}`, n]));
}

/** Compile a facade snippet with the standard trailing return (the tier/model tests' shape). */
export const compile = (body: string) => analyzeFacadeScript(`${body}\nreturn null;`);
