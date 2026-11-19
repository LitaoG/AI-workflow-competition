/**
 * The static MCP tool catalog — descriptor shapes and the verbatim catalog
 * table (moved from server.ts). The five legacy builder-engine tools keep
 * their hand-written JSON Schemas and are marked deprecated (Issue #153):
 * they stay functional through the transition period, with every description
 * pointing at the workflow_script_* facade face. The facade-script tools
 * derive theirs from the zod schemas in server.ts so validation and
 * documentation share one source. Exported so `workflow export-schema`
 * (OpenAI tool-calling face) and other surfaces reuse the exact same
 * descriptors — never a drifted copy. (P-INT-1: structured flags live only
 * here at the catalog source; wire-facing state rides `description`.)
 */
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

export const RunScriptArgs = z.object({
  scriptPath: z.string().min(1).describe('Path to the facade script (.ts) to run'),
  args: z.record(z.string(), z.unknown()).optional().describe('Script input, available inside the script as `args`'),
  // Issue #142: the resumeHint this face emits tells the caller to re-run with
  // resumeRunId — the field must exist on the same face or the hint silently
  // routes the caller into a full-price fresh run (zod stripped the unknown key).
  resumeRunId: z.string().optional().describe('Resume a prior run — completed nodes replay from the journal at zero cost'),
  cwd: z.string().optional().describe('Workspace root for world reads and world.run gates (default: process.cwd())'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under cwd)'),
  runTimeoutMs: z.number().int().positive().optional().describe('Whole-run wall clock; the sandbox child tree is killed on expiry (default 600000)'),
  budgetTotal: z.number().int().positive().optional().describe('Output-token budget for the run (read-only inside the script)'),
  approvedCommands: z.array(z.string()).optional().describe('Externally authorized world.run command names (Issue #127: the script own command list no longer authorizes — pass the ones this run may execute; unlisted commands are refused in the non-TTY MCP context)'),
  quiet: z.boolean().optional().describe('When true (the default) the response omits the capped event log; the journal keeps every event'),
});

export const InspectRunArgs = z.object({
  runId: z.string().min(1).describe('Facade-script run ID to inspect (dwf_runs.run_id)'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under the server cwd)'),
});

export const GetRunArgs = z.object({
  runId: z.string().min(1).describe('Facade-script run ID (dwf_runs.run_id)'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under the server cwd)'),
});

export const facadeSchemas = { RunScriptArgs, InspectRunArgs, GetRunArgs };

/** Tool descriptor shape shared by the catalog and the tool registry. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * True for the legacy builder-engine face (Issue #153): kept through the
   * transition period, but every consumer is pointed at the workflow_script_*
   * facade-tools face, which runs the dwf sandbox security standard.
   */
  deprecated?: boolean;
}

/**
 * The static tool catalog. The five legacy builder-engine tools keep their
 * hand-written JSON Schemas verbatim and are marked deprecated (Issue #153):
 * they stay functional through the transition period, with every description
 * pointing at the workflow_script_* facade face. The facade-script tools
 * derive theirs from the zod schemas above so validation and documentation
 * share one source.
 * Exported so `workflow export-schema` (OpenAI tool-calling face) and other
 * surfaces reuse the exact same descriptors — never a drifted copy.
 */
export const TOOL_CATALOG: McpToolDescriptor[] = [
  {
    name: 'workflow_run',
    description: '[legacy — prefer the workflow_script_* facade tools] Execute an AI-Workflow by file path with options, state persistence, and event logging',
    deprecated: true,
    inputSchema: {
      type: 'object',
      properties: {
        workflowPath: { type: 'string', description: 'Path to workflow TypeScript file' },
        mock: { type: 'boolean', description: 'Execute in deterministic offline mock mode' },
        runId: { type: 'string', description: 'Optional custom run ID' },
        dbPath: { type: 'string', description: 'Optional custom SQLite database path' },
        outDir: { type: 'string', description: 'Optional custom output directory' },
      },
      required: ['workflowPath'],
    },
  },
  {
    name: 'workflow_probe',
    description: '[legacy — prefer the workflow_script_* facade tools] Execute deterministic system, git, and toolchain environment probing with secret redaction',
    deprecated: true,
    inputSchema: {
      type: 'object',
      properties: {
        targetDir: { type: 'string', description: 'Target working directory to probe' },
        sanitizeEnv: { type: 'boolean', description: 'Whether to sanitize and redact sensitive env variables' },
      },
    },
  },
  {
    name: 'workflow_inspect',
    description: '[legacy — prefer workflow_inspect_run] Inspect step checkpoints, events, and artifacts of a workflow run from SQLite store',
    deprecated: true,
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Workflow run ID to inspect' },
        dbPath: { type: 'string', description: 'Optional custom SQLite database path' },
        stepId: { type: 'string', description: 'Optional specific step ID to inspect' },
        includeEvents: { type: 'boolean', description: 'Whether to include raw event stream' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'workflow_replay',
    description: '[legacy — prefer workflow_script_run with resumeRunId] Replay or resume a workflow run from failure with zero re-token spend',
    deprecated: true,
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Workflow run ID to replay' },
        resumeFromFailed: { type: 'boolean', description: 'Re-execute failed steps and resume execution' },
        dbPath: { type: 'string', description: 'Optional custom SQLite database path' },
        forceRecompute: { type: 'boolean', description: 'Force recompute of all steps' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'workflow_graph',
    description: '[legacy — prefer the workflow_script_* facade tools] Generate static DAG graph visualization without execution (HTML, Mermaid, or ASCII)',
    deprecated: true,
    inputSchema: {
      type: 'object',
      properties: {
        workflowPath: { type: 'string', description: 'Path to workflow TypeScript file' },
        format: { type: 'string', enum: ['html', 'mermaid', 'ascii'], description: 'Visualization output format' },
        lang: { type: 'string', enum: ['en', 'zh'], description: 'Language for HTML visualizer (en/zh)' },
      },
      required: ['workflowPath'],
    },
  },
  {
    name: 'workflow_script_check',
    description: 'Compile-check a facade script (strict TS against the workflow facade, purity bans, literal rules) and return diagnostics, phases, and the site table — without executing anything',
    inputSchema: {
      type: 'object',
      properties: {
        scriptPath: { type: 'string', description: 'Path to the facade script (.ts) to check' },
        cwd: { type: 'string', description: 'Workspace root the script targets (default: process.cwd())' },
      },
      required: ['scriptPath'],
    },
  },
  {
    name: 'workflow_script_run',
    description: 'Run a facade script in the sandbox (deterministic journal; --resume replays completed nodes at zero provider calls). Returns runId, status, result value, and stats (asks/replayHits).',
    inputSchema: {
      type: 'object',
      properties: {
        scriptPath: { type: 'string', description: 'Path to the facade script (.ts) to run' },
        cwd: { type: 'string', description: 'Workspace root for world reads and world.run gates (default: process.cwd())' },
        args: { type: 'object', description: 'Script input, available inside the script as `args`' },
        resumeRunId: { type: 'string', description: 'Resume a prior run — completed nodes replay from the journal at zero cost' },
        dbPath: { type: 'string', description: 'Journal database path (default .workflow/dwf.sqlite under cwd)' },
        runTimeoutMs: { type: 'number', description: 'Whole-run wall clock; the sandbox child tree is killed on expiry (default 600000)' },
        budgetTotal: { type: 'number', description: 'Output-token budget for the run (read-only inside the script)' },
        // Issue #142: the executor reads approvedCommands (server.ts workflow_script_run
        // branch) — the catalog must document what the executor actually reads.
        approvedCommands: { type: 'array', items: { type: 'string' }, description: 'Externally authorized world.run command names (Issue #127: the script own command list no longer authorizes — pass the ones this run may execute; unlisted commands are refused in the non-TTY MCP context)' },
      },
      required: ['scriptPath'],
    },
  },
  {
    name: 'workflow_run_script',
    description: 'Run a facade script through the sandboxed engine (journal-backed deterministic replay) and return runId, final status, per-site summaries (siteId/ordinal/status/durationMs) and stats; bounded by runTimeoutMs',
    inputSchema: toJsonSchemaCompat(RunScriptArgs),
  },
  {
    name: 'workflow_inspect_run',
    description: 'Inspect a facade-script run in the journal: the dwf_runs status row, the per-site dwf_nodes table (redacted) and an evidence-ledger summary (counts and the latest entries)',
    inputSchema: toJsonSchemaCompat(InspectRunArgs),
  },
  {
    name: 'workflow_get_run',
    description: "Fetch a facade-script run's journal short-circuit statistics — total asks, replay hits, amend hits, divergences and world.run executions (same accounting as the runner stats)",
    inputSchema: toJsonSchemaCompat(GetRunArgs),
  },
];
