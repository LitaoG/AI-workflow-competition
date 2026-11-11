/**
 * Run event stream — the runner's dual persistence channel. Every event goes
 * to SQLite (the authoritative journal) AND to `.workflow/runs/<runId>/events.jsonl`
 * (a crash-safe, tooling-readable mirror carrying byte-identical event
 * ids/sequences, so the two stores stay directly comparable — a resume
 * continues the same stream in both because `seq` is seeded from SQLite and
 * the file already holds the earlier lines).
 *
 * Degradation policies (both degrade ONCE per run, never silently, never
 * failing the run — a view/mirror failure is not a journal fact):
 * - events.jsonl append failure → one StorageError-tagged `dwf_event_log_write_failed`
 *   event recorded into the authoritative SQLite stream (never into the broken
 *   file, which would recurse), then appends are skipped for the rest of the
 *   invocation (locked by tests/integration/dwf-run.test.ts).
 * - watch-graph render failure → one StorageError-tagged warning on stderr and
 *   the rebuild is skipped for the rest of the run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HTMLRenderer } from '../dag/html-renderer.js';
import { projectEventsToGraph } from '../dag/journal-projection.js';
import { EventLogWriter } from '../state/event-log.js';
import { domainError, toSerializableError } from '../domain/errors.js';
import { redactValue } from './redact.js';
import type { SQLiteStateStore } from '../state/sqlite-store.js';
import type { DwfJournalStore, WorkflowEvent, WorkflowEventType } from '../types.js';

export class RunEventStream {
  private seq = 0;
  private eventLogDegraded = false;
  private watchGraphDegraded = false;
  private readonly watchedEvents: WorkflowEvent[] = [];
  private readonly eventLog: EventLogWriter;
  private readonly eventsJsonlPath: string;
  private readonly watchGraphPath: string;

  constructor(
    private readonly store: SQLiteStateStore & DwfJournalStore,
    private readonly runId: string,
    runDir: string,
    private readonly onEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    watchGraph?: boolean,
    /** The run-scope settled flag — hoisted in the runner; finish() is its only writer. */
    private readonly isSettled: () => boolean = () => false,
  ) {
    this.eventsJsonlPath = path.join(runDir, 'events.jsonl');
    this.eventLog = new EventLogWriter(runDir);
    this.watchGraphPath = path.join(runDir, 'graph.html');
    if (!watchGraph) return;
    // The watcher re-folds the accumulated stream after every emit through the
    // SAME pure projection the cold replay uses (projectEventsToGraph) — a
    // watched run and its later `workflow graph` replay render byte-identically
    // by construction; runs are bounded by the agent-call cap, so the quadratic
    // total cost is negligible.
    this.renderWatchGraph = (event: WorkflowEvent): void => {
      if (this.watchGraphDegraded) return;
      this.watchedEvents.push(event);
      try {
        const graph = projectEventsToGraph(this.watchedEvents);
        fs.writeFileSync(this.watchGraphPath, new HTMLRenderer().render(graph), 'utf8');
      } catch (err) {
        this.watchGraphDegraded = true;
        const storageError = domainError(
          'StorageError',
          `graph.html write failed for run ${runId} — the watch-graph view is degraded for the rest of this run; the run itself is unaffected and the journal remains authoritative`,
          { details: { runId, path: this.watchGraphPath }, cause: (err as Error).message },
        );
        console.warn(`[dwf] ${storageError.message} (cause: ${(err as Error).message})`);
      }
    };
  }

  private renderWatchGraph?: (event: WorkflowEvent) => void;

  /**
   * A resumed run continues the SAME stream: seed the watcher with the journal
   * prefix so the watched graph covers the whole run — exactly what a later
   * `workflow graph <run-dir>` cold replay folds. An amend forks a NEW stream
   * (new runId), so it correctly starts empty; its warm hits appear as
   * dwf_amend_hit events in the new stream.
   */
  async seedWatchedEvents(resumeRunId: string | undefined): Promise<void> {
    if (!this.renderWatchGraph || !resumeRunId) return;
    try {
      this.watchedEvents.push(...(await this.store.getEvents(resumeRunId)));
    } catch {
      /* fresh journal — the watcher starts from this invocation's stream */
    }
  }

  /**
   * Append-only event ids: a resumed run must CONTINUE the sequence, not
   * restart it — restarting re-uses ids and ON CONFLICT overwrites the first
   * run's events (e.g. dwf_escalation_open lost its question payload). Seed
   * from the id suffix (event.sequence was not persisted before this fix).
   */
  async seedSequence(resumeRunId: string | undefined): Promise<void> {
    if (!resumeRunId) return;
    try {
      const prior = await this.store.getEvents(resumeRunId);
      this.seq = prior.reduce((m, e) => {
        const suffix = Number(e.id.slice(e.id.lastIndexOf('-') + 1));
        return Math.max(m, Number.isFinite(suffix) ? suffix : 0, e.sequence ?? 0);
      }, 0);
    } catch {
      /* fresh journal — nothing to continue */
    }
  }

  emit(type: WorkflowEventType, data: Record<string, unknown>): void {
    this.onEvent?.({ type, data });
    const n = ++this.seq;
    const event: WorkflowEvent = {
      id: `dwf-${this.runId}-${n}`,
      runId: this.runId,
      workflowId: 'facade-script',
      type,
      sequence: n,
      timestamp: new Date().toISOString(),
      data,
    };
    this.renderWatchGraph?.(event);
    // SQLite — the authoritative copy. The write stays fire-and-forget, but its
    // rejection is not dropped blindly: BEFORE the run settles a storage
    // failure keeps its original loud behavior (rethrown, so it still surfaces
    // as an unhandledRejection), while AFTER the settle it is the close race
    // (the store already closed; the result no longer reads the journal) and
    // degrades to a warning.
    void this.store.recordEvent(event).catch((err) => {
      if (!this.isSettled()) throw err;
      console.warn(`[dwf] journal write for ${event.id} after run settle dropped: ${(err as Error).message}`);
    });
    // events.jsonl — best-effort mirror with explicit, non-silent degradation.
    if (this.eventLogDegraded) return;
    try {
      this.eventLog.appendEvent(event);
    } catch (err) {
      this.eventLogDegraded = true;
      const storageError = domainError(
        'StorageError',
        `events.jsonl append failed for event ${event.id} — the JSONL mirror is degraded for the rest of this run; the SQLite journal remains authoritative`,
        { details: { runId: this.runId, event: event.id, path: this.eventsJsonlPath }, cause: (err as Error).message },
      );
      const fn = ++this.seq;
      // Same settle-race guard as the authoritative write above.
      void this.store.recordEvent({
        id: `dwf-${this.runId}-${fn}`,
        runId: this.runId,
        workflowId: 'facade-script',
        type: 'dwf_event_log_write_failed',
        sequence: fn,
        timestamp: new Date().toISOString(),
        data: { error: storageError.message, taggedError: redactValue(toSerializableError(storageError)) },
      }).catch((err) => {
        if (!this.isSettled()) throw err;
        console.warn(`[dwf] degradation marker for ${`dwf-${this.runId}-${fn}`} after run settle dropped: ${(err as Error).message}`);
      });
      console.warn(`[dwf] ${storageError.message} (cause: ${(err as Error).message})`);
    }
  }
}
