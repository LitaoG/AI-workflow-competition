import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StateStore, WorkflowEvent, StepCheckpoint, WorkflowArtifact, WorkflowStatus, DwfNode, DwfRunRow, DwfEvidenceRow, EvidenceEntry, EvidenceKind } from '../types.js';
// The irreversible mask at THE serialization boundary (Issue #112): every
// checkpoint/event payload passes through here on its way to disk, so the
// builder engine inherits the same credential-shape rule the dwf journal
// already enforces at its own boundary. Redaction is idempotent — the dwf
// engine's earlier masking is preserved as-is. Leaf-utility import (redact.ts
// pulls only ../prober), same precedent as the permission-gate migration.
import { redactValue } from '../dwf/redact.js';

/**
 * Event payloads are masked wholesale (Issue #112) — with ONE documented
 * exception: a top-level `inputHash`. It is engine plumbing, not user
 * payload: the sha256 replay key the `workflow answer` / hole-fill CLI reads
 * back from the open event to journal a reply the resume pool matches
 * against. Masking it silently broke that flow (Issue #169): a 64-hex sha256
 * trips the anchored whole-value hex rule, so every resumed run re-opened
 * its question and parked forever — with no gate going red, because the
 * resume "succeeds" as a fresh park. The hash is not an additional exposure:
 * its sibling `question` field is stored verbatim by design, so the hash
 * reveals nothing the event does not already carry.
 */
function redactEventPayload(data: unknown): Record<string, unknown> {
  const masked = redactValue(data ?? {}) as Record<string, unknown>;
  const original = data as Record<string, unknown> | undefined;
  if (typeof original?.inputHash === 'string' && masked.inputHash !== original.inputHash) {
    masked.inputHash = original.inputHash; // structural replay key — restore verbatim
  }
  return masked;
}

export class SQLiteStateStore implements StateStore {
  private db: DatabaseSync;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        current_phase TEXT,
        active_subagents INTEGER DEFAULT 0,
        total_steps INTEGER DEFAULT 0,
        completed_steps INTEGER DEFAULT 0,
        failed_steps INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        step_id TEXT,
        phase_id TEXT,
        type TEXT NOT NULL,
        sequence INTEGER,
        timestamp TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        phase_id TEXT,
        role TEXT,
        status TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        error_text TEXT,
        duration_ms INTEGER DEFAULT 0,
        tokens_prompt INTEGER DEFAULT 0,
        tokens_completion INTEGER DEFAULT 0,
        completed_at TEXT,
        input_hash TEXT,
        PRIMARY KEY (run_id, step_id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        name TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_step ON artifacts(run_id, step_id);

      CREATE TABLE IF NOT EXISTS dwf_runs (
        run_id TEXT PRIMARY KEY,
        script_hash TEXT NOT NULL,
        script_path TEXT,
        args_json TEXT,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dwf_nodes (
        run_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        duration_ms INTEGER DEFAULT 0,
        completed_at TEXT,
        PRIMARY KEY (run_id, site_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_dwf_nodes_run ON dwf_nodes(run_id, ordinal);

      CREATE TABLE IF NOT EXISTS dwf_evidence (
        run_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        node_ordinal INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        provenance TEXT NOT NULL,
        coverage TEXT NOT NULL,
        limitations TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tokens_json TEXT,
        recorded_at TEXT,
        PRIMARY KEY (run_id, site_id, node_ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_dwf_evidence_run ON dwf_evidence(run_id, ordinal);
    `);
    // Migration: runner_pid for orphan-run convergence and stale-`running`
    // takeover (audit gap #2 / GOAL.md §1.5). Existing journals get the column
    // via ALTER; fresh ones get it here too (the `CREATE TABLE` above carries
    // neither column — this is the single source of both). The resume path
    // probes it to tell a live run from a crashed one; rows written before the
    // migration read back NULL → undefined ("host pid unknown, pre-pid journal
    // row") and are treated as crash takeovers, never as permanent locks.
    const dwfRunCols = (this.db.prepare('PRAGMA table_info(dwf_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!dwfRunCols.includes('runner_pid')) {
      this.db.exec('ALTER TABLE dwf_runs ADD COLUMN runner_pid INTEGER');
    }
    if (!dwfRunCols.includes('output_tokens_spent')) {
      this.db.exec('ALTER TABLE dwf_runs ADD COLUMN output_tokens_spent INTEGER');
    }
    // Issue #118: the budget cap belongs to the RUN, not to one CLI invocation
    // — persisted at launch and restored by every continuation door
    // (answer/resume/amend/rerun/MCP script_run).
    if (!dwfRunCols.includes('budget_total')) {
      this.db.exec('ALTER TABLE dwf_runs ADD COLUMN budget_total INTEGER');
    }
    // Issue #39: per-actor named-cache identity columns on ask rows. The pragma
    // guard keeps old journals readable in place (missing columns read back
    // as undefined and the actor-keyed cache path stays inert for them).
    const dwfNodeCols = (this.db.prepare('PRAGMA table_info(dwf_nodes)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const [name, ddl] of [['actor_name', 'TEXT'], ['actor_seq', 'INTEGER'], ['content_hash', 'TEXT'], ['persona_json', 'TEXT']] as const) {
      if (!dwfNodeCols.includes(name)) {
        this.db.exec(`ALTER TABLE dwf_nodes ADD COLUMN ${name} ${ddl}`);
      }
    }
    this.migrateCheckpointsAddInputHash();
  }

  /**
   * Idempotent schema migration: add the `checkpoints.input_hash` column when
   * it is missing (audit fix — the core replay short-circuit must bind a
   * checkpoint to the exact step definition + input that produced it, not to
   * `stepId` alone).
   *
   * Migration order mirrors the runner_pid migration: `initSchema` first
   * runs `CREATE TABLE IF NOT EXISTS checkpoints` — which already carries the
   * column in current builds, so on a fresh database this helper is a no-op —
   * then this helper only fires for database files created before the column
   * existed. `ALTER TABLE ADD COLUMN` preserves every existing row, and the
   * `PRAGMA table_info` existence check makes repeated calls (every subsequent
   * store open) no-ops.
   *
   * Old-data semantics: rows written before the migration read back with
   * `inputHash = undefined` ("no recorded binding, legacy checkpoint"); the
   * replay path treats such rows as a fail-safe miss and re-executes the step
   * instead of serving an unverifiable result.
   */
  private migrateCheckpointsAddInputHash(): void {
    const columns = this.db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'input_hash')) return;
    this.db.exec('ALTER TABLE checkpoints ADD COLUMN input_hash TEXT');
  }

  public upsertRun(run: {
    runId: string;
    workflowId: string;
    workflowName: string;
    status: string;
    currentPhase?: string;
    activeSubagents?: number;
    totalSteps?: number;
    completedSteps?: number;
    failedSteps?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO runs (
        run_id, workflow_id, workflow_name, status, current_phase,
        active_subagents, total_steps, completed_steps, failed_steps,
        created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        current_phase = excluded.current_phase,
        active_subagents = excluded.active_subagents,
        total_steps = excluded.total_steps,
        completed_steps = excluded.completed_steps,
        failed_steps = excluded.failed_steps,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `);

    stmt.run(
      run.runId,
      run.workflowId,
      run.workflowName,
      run.status,
      run.currentPhase || null,
      run.activeSubagents || 0,
      run.totalSteps || 0,
      run.completedSteps || 0,
      run.failedSteps || 0,
      now,
      now,
      run.metadata ? JSON.stringify(run.metadata) : null
    );
  }

  public async recordEvent(event: WorkflowEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, run_id, workflow_id, step_id, phase_id, type, sequence, timestamp, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
    `);

    stmt.run(
      event.id,
      event.runId,
      event.workflowId,
      event.stepId || null,
      event.phaseId || null,
      event.type,
      event.sequence || 0,
      event.timestamp,
      JSON.stringify(redactEventPayload(event.data))
    );

    // Also update run record if event represents status transition
    if (event.type === 'workflow_start') {
      this.upsertRun({
        runId: event.runId,
        workflowId: event.workflowId,
        workflowName: event.workflowId,
        status: 'running',
      });
    } else if (event.type === 'workflow_complete') {
      this.upsertRun({
        runId: event.runId,
        workflowId: event.workflowId,
        workflowName: event.workflowId,
        status: 'completed',
      });
    } else if (event.type === 'workflow_aborted') {
      // The aborted status must persist too — before this branch an aborted
      // run's DB row stayed 'running' forever (and even earlier, wrongly read
      // 'completed'; 2026-11-14 repair round, verifier residual).
      this.upsertRun({
        runId: event.runId,
        workflowId: event.workflowId,
        workflowName: event.workflowId,
        status: 'aborted',
      });
    } else if (event.type === 'workflow_failed') {
      this.upsertRun({
        runId: event.runId,
        workflowId: event.workflowId,
        workflowName: event.workflowId,
        status: 'failed',
      });
    }
  }

  public async getEvents(runId: string): Promise<WorkflowEvent[]> {
    const stmt = this.db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY sequence ASC`);
    const rows = stmt.all(runId) as any[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      workflowId: r.workflow_id,
      stepId: r.step_id || undefined,
      phaseId: r.phase_id || undefined,
      type: r.type,
      sequence: r.sequence,
      timestamp: r.timestamp,
      data: JSON.parse(r.data_json),
    }));
  }

  public async saveCheckpoint(runId: string, checkpoint: StepCheckpoint): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (
        run_id, step_id, phase_id, role, status,
        input_json, output_json, error_text, duration_ms,
        tokens_prompt, tokens_completion, completed_at, input_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step_id) DO UPDATE SET
        phase_id = excluded.phase_id,
        role = excluded.role,
        status = excluded.status,
        input_json = excluded.input_json,
        output_json = excluded.output_json,
        error_text = excluded.error_text,
        duration_ms = excluded.duration_ms,
        tokens_prompt = excluded.tokens_prompt,
        tokens_completion = excluded.tokens_completion,
        completed_at = excluded.completed_at,
        input_hash = excluded.input_hash
    `);

    stmt.run(
      runId,
      checkpoint.stepId,
      checkpoint.phaseId || null,
      checkpoint.role || null,
      checkpoint.status,
      JSON.stringify(checkpoint.input !== undefined ? redactValue(checkpoint.input) : null),
      checkpoint.output !== undefined ? JSON.stringify(redactValue(checkpoint.output)) : null,
      checkpoint.error ? redactValue(checkpoint.error) : null,
      checkpoint.durationMs || 0,
      checkpoint.tokens?.prompt || 0,
      checkpoint.tokens?.completion || 0,
      checkpoint.completedAt || new Date().toISOString(),
      checkpoint.inputHash ?? null
    );
  }

  public async getCheckpoint(runId: string, stepId: string): Promise<StepCheckpoint | null> {
    const stmt = this.db.prepare(`SELECT * FROM checkpoints WHERE run_id = ? AND step_id = ?`);
    const row = stmt.get(runId, stepId) as any;
    if (!row) return null;

    return {
      stepId: row.step_id,
      phaseId: row.phase_id,
      role: row.role,
      status: row.status,
      input: row.input_json ? JSON.parse(row.input_json) : undefined,
      output: row.output_json ? JSON.parse(row.output_json) : undefined,
      error: row.error_text || undefined,
      durationMs: row.duration_ms,
      tokens: { prompt: row.tokens_prompt, completion: row.tokens_completion },
      completedAt: row.completed_at || undefined,
      inputHash: row.input_hash ?? undefined,
    };
  }

  /**
   * Invalidate checkpoints of a run — all of them, or exactly one step.
   *
   * The invalidation primitive behind `replay --force-recompute` (delete all →
   * every step genuinely re-executes on the rebuilt run) and `replay --step`
   * (delete one → that step genuinely re-executes; its upstream still
   * short-circuits and its downstream re-executes only where the new input
   * diverges). Deleting a row is the honest replacement for the former fake
   * "re-completed" checkpoint writes: the engine re-runs the real executor and
   * records a real result.
   *
   * @param runId - The run whose checkpoints are invalidated.
   * @param stepId - When given, only this step's checkpoint is deleted.
   */
  public async deleteCheckpoints(runId: string, stepId?: string): Promise<void> {
    if (stepId !== undefined) {
      this.db.prepare(`DELETE FROM checkpoints WHERE run_id = ? AND step_id = ?`).run(runId, stepId);
    } else {
      this.db.prepare(`DELETE FROM checkpoints WHERE run_id = ?`).run(runId);
    }
  }

  public async getAllCheckpoints(runId: string): Promise<Record<string, StepCheckpoint>> {
    const stmt = this.db.prepare(`SELECT * FROM checkpoints WHERE run_id = ?`);
    const rows = stmt.all(runId) as any[];
    const result: Record<string, StepCheckpoint> = {};

    for (const row of rows) {
      result[row.step_id] = {
        stepId: row.step_id,
        phaseId: row.phase_id,
        role: row.role,
        status: row.status,
        input: row.input_json ? JSON.parse(row.input_json) : undefined,
        output: row.output_json ? JSON.parse(row.output_json) : undefined,
        error: row.error_text || undefined,
        durationMs: row.duration_ms,
        tokens: { prompt: row.tokens_prompt, completion: row.tokens_completion },
        completedAt: row.completed_at || undefined,
        inputHash: row.input_hash ?? undefined,
      };
    }

    return result;
  }

  public async getRunStatus(runId: string): Promise<{
    status: WorkflowStatus;
    completedSteps: string[];
    failedSteps: string[];
    activeSubagents: number;
  }> {
    const runStmt = this.db.prepare(`SELECT status, active_subagents FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(runId) as any;

    const completedStmt = this.db.prepare(
      `SELECT step_id FROM checkpoints WHERE run_id = ? AND status = 'completed'`
    );
    const completedRows = completedStmt.all(runId) as any[];

    const failedStmt = this.db.prepare(
      `SELECT step_id FROM checkpoints WHERE run_id = ? AND status = 'failed'`
    );
    const failedRows = failedStmt.all(runId) as any[];

    return {
      status: (runRow ? runRow.status : 'not_found') as WorkflowStatus,
      activeSubagents: runRow ? runRow.active_subagents : 0,
      completedSteps: completedRows.map((r) => r.step_id),
      failedSteps: failedRows.map((r) => r.step_id),
    };
  }

  public async saveArtifact(artifact: WorkflowArtifact): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, step_id, name, artifact_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET content = excluded.content
    `);
    stmt.run(
      artifact.artifactId,
      artifact.runId,
      artifact.stepId,
      artifact.name,
      artifact.artifactType,
      artifact.content,
      artifact.createdAt
    );
  }

  public async getArtifacts(runId: string): Promise<WorkflowArtifact[]> {
    const stmt = this.db.prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`);
    const rows = stmt.all(runId) as any[];
    return rows.map((r) => ({
      artifactId: r.artifact_id,
      runId: r.run_id,
      stepId: r.step_id,
      name: r.name,
      artifactType: r.artifact_type,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  public listRuns(options?: { limit?: number; status?: string }): Array<{
    runId: string;
    workflowId: string;
    workflowName: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }> {
    let query = 'SELECT * FROM runs';
    const params: any[] = [];
    if (options?.status && options.status !== 'all') {
      query += ' WHERE status = ?';
      params.push(options.status);
    }
    query += ' ORDER BY created_at DESC';
    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((r) => ({
      runId: r.run_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Facade-script (dwf) journal — (run_id, site_id, ordinal) replay keys
  // ------------------------------------------------------------------

  public async saveDwfNode(node: DwfNode): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO dwf_nodes (run_id, site_id, ordinal, kind, input_hash, status, result_json, error_text, duration_ms, completed_at, actor_name, actor_seq, content_hash, persona_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, site_id, ordinal) DO UPDATE SET
        kind = excluded.kind,
        input_hash = excluded.input_hash,
        status = excluded.status,
        result_json = excluded.result_json,
        error_text = excluded.error_text,
        duration_ms = excluded.duration_ms,
        completed_at = excluded.completed_at,
        actor_name = excluded.actor_name,
        actor_seq = excluded.actor_seq,
        content_hash = excluded.content_hash,
        persona_json = excluded.persona_json
    `);
    stmt.run(
      node.runId,
      node.siteId,
      node.ordinal,
      node.kind,
      node.inputHash,
      node.status,
      node.resultJson ?? null,
      node.errorText ?? null,
      node.durationMs ?? 0,
      node.completedAt ?? new Date().toISOString(),
      node.actorName ?? null,
      node.actorSeq ?? null,
      node.contentHash ?? null,
      node.personaJson ?? null
    );
  }

  public async getDwfNode(runId: string, siteId: string, ordinal: number): Promise<DwfNode | null> {
    const stmt = this.db.prepare(`SELECT * FROM dwf_nodes WHERE run_id = ? AND site_id = ? AND ordinal = ?`);
    const row = stmt.get(runId, siteId, ordinal) as any;
    if (!row) return null;
    return {
      runId: row.run_id,
      siteId: row.site_id,
      ordinal: row.ordinal,
      kind: row.kind,
      inputHash: row.input_hash,
      status: row.status,
      resultJson: row.result_json ?? undefined,
      errorText: row.error_text ?? undefined,
      durationMs: row.duration_ms,
      completedAt: row.completed_at ?? undefined,
    };
  }

  public async getDwfNodes(runId: string): Promise<DwfNode[]> {
    const stmt = this.db.prepare(`SELECT * FROM dwf_nodes WHERE run_id = ? ORDER BY completed_at ASC`);
    const rows = stmt.all(runId) as any[];
    return rows.map((row) => ({
      runId: row.run_id,
      siteId: row.site_id,
      ordinal: row.ordinal,
      kind: row.kind,
      inputHash: row.input_hash,
      status: row.status,
      resultJson: row.result_json ?? undefined,
      errorText: row.error_text ?? undefined,
      durationMs: row.duration_ms,
      completedAt: row.completed_at ?? undefined,
      actorName: row.actor_name ?? undefined,
      actorSeq: row.actor_seq ?? undefined,
      contentHash: row.content_hash ?? undefined,
      personaJson: row.persona_json ?? undefined,
    }));
  }

  public async saveDwfRun(row: DwfRunRow): Promise<void> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO dwf_runs (run_id, script_hash, script_path, args_json, status, parent_run_id, runner_pid, output_tokens_spent, budget_total, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        parent_run_id = excluded.parent_run_id,
        runner_pid = excluded.runner_pid,
        output_tokens_spent = excluded.output_tokens_spent,
        budget_total = excluded.budget_total
    `);
    stmt.run(row.runId, row.scriptHash, row.scriptPath ?? null, row.argsJson ?? null, row.status, row.parentRunId ?? null, row.runnerPid ?? null, row.outputTokensSpent ?? null, row.budgetTotal ?? null, row.createdAt ?? now, row.updatedAt ?? now);
  }

  public async getDwfRun(runId: string): Promise<DwfRunRow | null> {
    const stmt = this.db.prepare(`SELECT * FROM dwf_runs WHERE run_id = ?`);
    const row = stmt.get(runId) as any;
    if (!row) return null;
    return this.mapDwfRunRow(row);
  }

  /** Snake-case dwf_runs row → DwfRunRow (single mapping for get/list). */
  private mapDwfRunRow(row: any): DwfRunRow {
    return {
      runId: row.run_id,
      scriptHash: row.script_hash,
      scriptPath: row.script_path ?? undefined,
      argsJson: row.args_json ?? undefined,
      status: row.status,
      parentRunId: row.parent_run_id ?? undefined,
      runnerPid: row.runner_pid === null || row.runner_pid === undefined ? undefined : Number(row.runner_pid),
      outputTokensSpent: row.output_tokens_spent === null || row.output_tokens_spent === undefined ? undefined : Number(row.output_tokens_spent),
      budgetTotal: row.budget_total === null || row.budget_total === undefined ? undefined : Number(row.budget_total),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List facade-script run rows, newest first — the dwf counterpart of
   * `listRuns` (telemetry hookup, gap-matrix D2): without it a facade runId
   * never surfaces in the `list` face because builder runs live in `runs` and
   * facade runs only in `dwf_runs`. Same filter/limit contract as `listRuns`.
   */
  public async listDwfRuns(options?: { limit?: number; status?: string }): Promise<DwfRunRow[]> {
    let query = 'SELECT * FROM dwf_runs';
    const params: any[] = [];
    if (options?.status && options.status !== 'all') {
      query += ' WHERE status = ?';
      params.push(options.status);
    }
    query += ' ORDER BY created_at DESC';
    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.mapDwfRunRow(row));
  }

  // ------------------------------------------------------------------
  // Facade-script (dwf) evidence ledger — GOAL.md 证据凭证法则
  // ------------------------------------------------------------------

  /**
   * Append one evidence entry for a run. The per-run append `ordinal` is
   * assigned in the SAME statement as the insert (`COALESCE(MAX(ordinal), 0)+1`
   * over the run's rows) — `node:sqlite` executes a statement atomically on the
   * event loop, so concurrent journalled nodes can never collide on an ordinal.
   * The write is idempotent per `(run_id, site_id, node_ordinal)` — the same
   * node re-recording (e.g. a failed attempt followed by a completed retry)
   * updates its row in place and keeps its original append position, mirroring
   * the upsert semantics of `dwf_nodes`.
   */
  public async saveDwfEvidence(row: DwfEvidenceRow): Promise<void> {
    const entry = row.entry;
    this.db
      .prepare(
        `
        INSERT INTO dwf_evidence (
          run_id, site_id, node_ordinal, ordinal, kind, label, input_hash,
          provenance, coverage, limitations, duration_ms, tokens_json, recorded_at
        )
        SELECT ?, ?, ?, COALESCE(MAX(ordinal), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM dwf_evidence WHERE run_id = ?
        ON CONFLICT(run_id, site_id, node_ordinal) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          input_hash = excluded.input_hash,
          provenance = excluded.provenance,
          coverage = excluded.coverage,
          limitations = excluded.limitations,
          duration_ms = excluded.duration_ms,
          tokens_json = excluded.tokens_json,
          recorded_at = excluded.recorded_at
        `
      )
      .run(
        row.runId,
        row.siteId,
        row.nodeOrdinal,
        entry.kind,
        entry.label,
        entry.inputHash,
        entry.provenance,
        entry.coverage,
        entry.limitations,
        entry.durationMs ?? 0,
        entry.tokenUsage ? JSON.stringify(entry.tokenUsage) : null,
        entry.recordedAt ?? null,
        row.runId
      );
  }

  /**
   * All evidence entries of a run, ordered by the per-run append ordinal
   * (the order they were recorded in). Each entry's `id` is rebuilt as
   * `e-<ordinal>` — stable, run-unique, and aligned with the ledger's
   * auto-assigned id convention.
   */
  public async getDwfEvidence(runId: string): Promise<EvidenceEntry[]> {
    const rows = this.db
      .prepare(`SELECT * FROM dwf_evidence WHERE run_id = ? ORDER BY ordinal ASC`)
      .all(runId) as any[];
    return rows.map((row) => ({
      id: `e-${row.ordinal}`,
      kind: row.kind as EvidenceKind,
      label: row.label,
      inputHash: row.input_hash,
      provenance: row.provenance,
      coverage: row.coverage,
      limitations: row.limitations,
      durationMs: row.duration_ms,
      ...(row.tokens_json ? { tokenUsage: JSON.parse(row.tokens_json) } : {}),
      ...(row.recorded_at ? { recordedAt: row.recorded_at } : {}),
    }));
  }
}
