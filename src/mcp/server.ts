/**
 * Built-in AI-Workflow MCP server: exposes the legacy workflow tool face plus the
 * facade-script (dwf) tool face — server side aligned with the live engine.
 *
 * Two invariants hold for every tool in this file:
 * 1. Every response crosses the irreversible redaction boundary (`redactValue` /
 *    `redactText` from `src/dwf/redact.ts`) BEFORE serialization.
 * 2. New-tool error responses speak the domain error algebra: a JSON body
 *    `{ tag, message, details? }` produced by `toSerializableError` (项 5 serialization).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Workflow, defineWorkflow } from '../core/workflow.js';
import { probe } from '../prober/index.js';
import { SQLiteStateStore } from '../state/sqlite-store.js';
import { ReplayEngine } from '../state/replay.js';
import { EventLogWriter } from '../state/event-log.js';
import { DAGVisualizerCoordinator } from '../dag/visualizer.js';
import { analyzeFacadeScript } from '../dwf/compile.js';
import { resolveDwfJournalPath, runFacadeScript } from '../dwf/runner.js';
import { redactText, redactValue } from '../dwf/redact.js';
import {
  DomainErrorTag,
  domainError,
  toDomainError,
  toSerializableError,
} from '../domain/errors.js';
import { summarizeEvidence } from '../domain/evidence.js';
import { DwfNode, WorkflowEvent, DwfJournalStore } from '../types.js';
import { toolRegistry } from './registry.js';

/** Server name used as the registry namespace and the MCP server info. */
const SERVER_NAME = 'ai-workflow-server';

/** Max recent events carried by a non-quiet `workflow_run_script` response. */
const MAX_EVENT_SUMMARIES = 50;
/** How many of the latest evidence entries `workflow_inspect_run` returns. */
const LATEST_EVIDENCE_COUNT = 5;

// ---------------------------------------------------------------------------
// Zod input schemas for the facade-script tool face.
// The catalog exposes the JSON Schema form (via the MCP SDK's zod compat
// converter); the CallTool handler validates raw arguments with the same
// schema, so documentation and validation can never drift apart.
// ---------------------------------------------------------------------------

const RunScriptArgs = z.object({
  scriptPath: z.string().min(1).describe('Path to the facade script (.ts) to run'),
  args: z.record(z.unknown()).optional().describe('Script input, available inside the script as `args`'),
  cwd: z.string().optional().describe('Workspace root for world reads and world.run gates (default: process.cwd())'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under cwd)'),
  runTimeoutMs: z.number().int().positive().optional().describe('Whole-run wall clock; the sandbox child tree is killed on expiry (default 600000)'),
  quiet: z.boolean().optional().describe('When true (the default) the response omits the capped event log; the journal keeps every event'),
});

const InspectRunArgs = z.object({
  runId: z.string().min(1).describe('Facade-script run ID to inspect (dwf_runs.run_id)'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under the server cwd)'),
});

const GetRunArgs = z.object({
  runId: z.string().min(1).describe('Facade-script run ID (dwf_runs.run_id)'),
  dbPath: z.string().optional().describe('Journal database path (default .workflow/dwf.sqlite under the server cwd)'),
});

/** One per-site execution summary (`workflow_run_script` response field). */
interface RunSiteSummary {
  siteId: string;
  ordinal: number;
  kind: DwfNode['kind'];
  status: DwfNode['status'];
  durationMs: number;
}

/** Tool descriptor shape shared by the catalog and the tool registry. */
interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The static tool catalog. The seven legacy tools keep their hand-written JSON
 * Schemas verbatim; the three facade-script tools derive theirs from the zod
 * schemas above so validation and documentation share one source.
 */
const TOOL_CATALOG: McpToolDescriptor[] = [
  {
    name: 'workflow_run',
    description: 'Execute an AI-Workflow by file path with options, state persistence, and event logging',
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
    description: 'Execute deterministic system, git, and toolchain environment probing with secret redaction',
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
    description: 'Inspect step checkpoints, events, and artifacts of a workflow run from SQLite store',
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
    description: 'Replay or resume a workflow run from failure with zero re-token spend',
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
    description: 'Generate static DAG graph visualization without execution (HTML, Mermaid, or ASCII)',
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

// ---------------------------------------------------------------------------
// Shared response helpers — every tool response crosses the redaction boundary
// exactly once, here, before JSON serialization.
// ---------------------------------------------------------------------------

/** Serialize a tool payload as redacted JSON text (strings, keys and nested values masked). */
function maskedJsonText(payload: unknown): string {
  return JSON.stringify(redactValue(payload), null, 2);
}

/** A successful tool response carrying one text block. */
function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/** A masked JSON tool response. */
function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return textResult(maskedJsonText(payload));
}

/**
 * A tagged error tool response: the domain error algebra (`{ tag, message, ... }`,
 * 项 5 serialization), redacted before serialization. Any thrown value is mapped
 * onto the algebra with `fallbackTag` so clients always get a parseable body.
 */
function taggedErrorResult(err: unknown, fallbackTag: DomainErrorTag = 'McpError'): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const safe = redactValue(toSerializableError(toDomainError(err, fallbackTag)));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
}

/** Map a zod parse failure onto the domain error algebra (never echoes the raw arguments). */
function zodArgsError(error: z.ZodError): { tag: DomainErrorTag; message: string } {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join('.') : '(root)';
  return domainError(
    'SchemaValidationError',
    `invalid tool arguments: ${where}: ${first?.message ?? 'validation failed'}`,
    { details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
  );
}

/** Parse a journalled JSON string defensively: parsed JSON, or the raw text. */
function parseMaybeJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Read one run's per-site summaries from the journal (the single source of
 * truth for siteId/ordinal/status/durationMs). Degrades to an empty list with
 * a note instead of failing the whole tool response — the run result itself
 * never depends on this read.
 */
async function readRunSites(journalPath: string, runId: string): Promise<{ sites: RunSiteSummary[]; sitesError?: string }> {
  const store = new SQLiteStateStore(journalPath);
  try {
    const nodes = await store.getDwfNodes(runId);
    return {
      sites: nodes.map((n) => ({
        siteId: n.siteId,
        ordinal: n.ordinal,
        kind: n.kind,
        status: n.status,
        durationMs: n.durationMs ?? 0,
      })),
    };
  } catch (err) {
    return { sites: [], sitesError: (err as Error).message };
  } finally {
    store.close();
  }
}

/** Count the journal events of one canonical type (the runner/view accounting). */
function countEvents(events: WorkflowEvent[], type: WorkflowEvent['type']): number {
  return events.filter((e) => e.type === type).length;
}

export class BuiltinWorkflowMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
    // Catalog the full tool face into the shared registry (serverName:tool keys).
    // Registration is idempotent (Map.set), so repeated server instances never
    // duplicate entries.
    for (const tool of TOOL_CATALOG) {
      toolRegistry.register(SERVER_NAME, tool);
    }
  }

  public getServer(): Server {
    return this.server;
  }

  private setupHandlers(): void {
    // 1. Tool Catalog Exposure
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_CATALOG,
    }));

    // 2. Tool Execution Handlers
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'workflow_probe': {
          try {
            const cwd = args?.targetDir ? path.resolve(process.cwd(), String(args.targetDir)) : process.cwd();
            const probeResult = await probe({
              cwd,
              sanitizeEnv: args?.sanitizeEnv !== false,
            });

            return jsonResult(probeResult);
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Probe Error: ${redactText(err.message)}` }],
            };
          }
        }

        case 'workflow_run': {
          const rawPath = String(args?.workflowPath ?? '');
          const resolvedPath = path.resolve(process.cwd(), rawPath);

          if (!fs.existsSync(resolvedPath)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Workflow file not found: ${resolvedPath}` }],
            };
          }

          let mod: any;
          try {
            const fileUrl = pathToFileURL(resolvedPath).href;
            mod = await import(fileUrl);
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Failed to load workflow module: ${redactText(err.message)}` }],
            };
          }

          let wf = mod.default ?? mod.workflow;
          if (wf && !(wf instanceof Workflow) && (wf.steps || wf.phases)) {
            wf = defineWorkflow(wf);
          }

          if (!wf || !(wf instanceof Workflow)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Module "${rawPath}" does not export a valid Workflow instance.` }],
            };
          }

          const runId = (args?.runId as string) || `run-mcp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
          const dbPath = (args?.dbPath as string) || path.join(process.cwd(), '.workflow', 'runs.db');
          const outDir = (args?.outDir as string) || path.join(process.cwd(), '.workflow', 'runs', runId);
          fs.mkdirSync(outDir, { recursive: true });

          const store = new SQLiteStateStore(dbPath);
          const logWriter = new EventLogWriter(outDir);

          wf.on('event', (evt) => {
            logWriter.record({
              workflowId: wf.name,
              runId,
              stepId: evt.stepId,
              phaseId: evt.phaseId,
              type: evt.type,
              data: evt.data,
            });
          });

          try {
            const startTime = Date.now();
            const result = await wf.run({
              runId,
              mockMode: Boolean(args?.mock),
              stateStore: store,
            });

            const durationMs = Date.now() - startTime;
            const checkpoints = await store.getAllCheckpoints(runId);
            const runStatus = await store.getRunStatus(runId);

            return jsonResult({
              runId,
              workflowName: wf.name,
              status: result.status,
              durationMs,
              completedSteps: runStatus.completedSteps,
              failedSteps: runStatus.failedSteps,
              checkpointsCount: Object.keys(checkpoints).length,
              artifactsDir: outDir,
            });
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Workflow Run Error: ${redactText(err.message)}` }],
            };
          } finally {
            store.close();
            logWriter.close();
          }
        }

        case 'workflow_inspect': {
          const runId = String(args?.runId ?? '');
          const dbPath = (args?.dbPath as string) || path.join(process.cwd(), '.workflow', 'runs.db');
          const store = new SQLiteStateStore(dbPath) as SQLiteStateStore & DwfJournalStore;

          try {
            // Facade-journal branch: dwf runs live in dwf_runs/dwf_nodes, never
            // in checkpoints — without this branch a facade runId passed with
            // its journal dbPath is invisible here. Builder runs answer null
            // and fall through with zero behavior change.
            const facadeRun = await store.getDwfRun(runId);
            if (facadeRun) {
              const nodes = await store.getDwfNodes(runId);
              const events = args?.includeEvents ? await store.getEvents(runId) : undefined;
              return jsonResult({
                runId,
                store: 'facade-journal',
                status: facadeRun.status,
                parentRunId: facadeRun.parentRunId,
                scriptPath: facadeRun.scriptPath,
                nodes: nodes.map((n) => ({
                  siteId: n.siteId,
                  ordinal: n.ordinal,
                  kind: n.kind,
                  status: n.status,
                  durationMs: n.durationMs ?? 0,
                  error: n.errorText,
                })),
                events,
              });
            }

            const checkpoints = await store.getAllCheckpoints(runId);
            if (Object.keys(checkpoints).length === 0) {
              return {
                isError: true,
                content: [{ type: 'text', text: `Run not found in database: ${runId}` }],
              };
            }

            const runStatus = await store.getRunStatus(runId);
            const artifacts = await store.getArtifacts(runId);
            const events = args?.includeEvents ? await store.getEvents(runId) : undefined;
            const selectedStep = args?.stepId ? checkpoints[String(args.stepId)] : undefined;

            return jsonResult({
              runId,
              status: runStatus.status,
              completedSteps: runStatus.completedSteps,
              failedSteps: runStatus.failedSteps,
              activeSubagents: runStatus.activeSubagents,
              checkpointsCount: Object.keys(checkpoints).length,
              selectedStep,
              checkpoints: args?.stepId ? undefined : checkpoints,
              artifacts,
              events,
            });
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Inspect Error: ${redactText(err.message)}` }],
            };
          } finally {
            store.close();
          }
        }

        case 'workflow_replay': {
          const runId = String(args?.runId ?? '');
          const dbPath = (args?.dbPath as string) || path.join(process.cwd(), '.workflow', 'runs.db');
          const store = new SQLiteStateStore(dbPath);

          try {
            const checkpoints = await store.getAllCheckpoints(runId);
            const stepIds = Object.keys(checkpoints);
            if (stepIds.length === 0) {
              return {
                isError: true,
                content: [{ type: 'text', text: `Run not found for replay: ${runId}` }],
              };
            }

            const replayEngine = new ReplayEngine(store);
            const plan = await replayEngine.analyzeRun(runId, stepIds, {
              forceRecompute: Boolean(args?.forceRecompute),
            });

            // This tool ANALYZES the journal; it never writes checkpoints.
            // (It used to fake `completed` checkpoints for resumeFromFailed —
            // removed with the CLI's honest-replay contract, item 9.) Real
            // re-execution happens on the run's own runtime path: facade runs
            // resume at zero token via `workflow run-script --resume <runId>`,
            // core runs genuinely re-execute failed steps via
            // `workflow replay <runId>`.

            return jsonResult({
              runId,
              resumable: plan.resumable,
              firstFailedStepId: plan.firstFailedStepId,
              stepsToSkip: plan.stepsToSkip,
              stepsToExecute: plan.stepsToExecute,
              tokensSavedEstimate: plan.tokensSavedEstimate,
              resumeFromFailedRequested: Boolean(args?.resumeFromFailed),
              resumeHint:
                'Analysis only — resume facade runs with `workflow run-script --resume <runId>` (journal short-circuit, zero token) or core runs with `workflow replay <runId>` (failed steps re-execute for real).',
            });
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Replay Error: ${redactText(err.message)}` }],
            };
          } finally {
            store.close();
          }
        }

        case 'workflow_graph': {
          const rawPath = String(args?.workflowPath ?? '');
          const resolvedPath = path.resolve(process.cwd(), rawPath);

          if (!fs.existsSync(resolvedPath)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Workflow file not found: ${resolvedPath}` }],
            };
          }

          let mod: any;
          try {
            const fileUrl = pathToFileURL(resolvedPath).href;
            mod = await import(fileUrl);
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Failed to load workflow module: ${redactText(err.message)}` }],
            };
          }

          let wf = mod.default ?? mod.workflow;
          if (wf && !(wf instanceof Workflow) && (wf.steps || wf.phases)) {
            wf = defineWorkflow(wf);
          }

          if (!wf || !(wf instanceof Workflow)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Module "${rawPath}" does not export a valid Workflow instance.` }],
            };
          }

          try {
            wf.validate();
            const visualizer = new DAGVisualizerCoordinator();
            const graph = wf.exportGraph('mcp-graph');
            const format = (args?.format as 'html' | 'mermaid' | 'ascii') || 'ascii';
            const lang = (args?.lang as 'en' | 'zh') || 'en';

            let rendered: string;
            if (format === 'html') {
              rendered = visualizer.renderHTML(graph, lang);
            } else if (format === 'mermaid') {
              rendered = visualizer.renderMermaid(graph);
            } else {
              rendered = visualizer.renderASCII(graph);
            }

            return textResult(redactText(rendered));
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Graph Generation Error: ${redactText(err.message)}` }],
            };
          }
        }

        case 'workflow_script_check': {
          try {
            const scriptPath = path.resolve(process.cwd(), String(args?.scriptPath ?? ''));
            const text = fs.readFileSync(scriptPath, 'utf8');
            const analysis = analyzeFacadeScript(text);
            return jsonResult({
              ok: analysis.ok,
              phases: analysis.phases,
              actors: analysis.actors,
              /** world.run command set the user is approving. */
              commands: analysis.commands,
              siteCount: analysis.sites.length,
              diagnostics: analysis.diagnostics,
            });
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Script Check Error: ${redactText(err.message)}` }],
            };
          }
        }

        case 'workflow_script_run': {
          try {
            const scriptPath = path.resolve(process.cwd(), String(args?.scriptPath ?? ''));
            const cwd = args?.cwd ? path.resolve(process.cwd(), String(args.cwd)) : process.cwd();
            const rawArgs = args?.args;
            const scriptArgs = (typeof rawArgs === 'string'
              ? (JSON.parse(rawArgs) as unknown)
              : rawArgs) as Record<string, unknown> | undefined;
            const result = await runFacadeScript({
              scriptPath,
              cwd,
              args: scriptArgs,
              resumeRunId: args?.resumeRunId ? String(args.resumeRunId) : undefined,
              dbPath: args?.dbPath ? String(args.dbPath) : undefined,
              runTimeoutMs: typeof args?.runTimeoutMs === 'number' ? args.runTimeoutMs : undefined,
            });
            return jsonResult({
              runId: result.runId,
              status: result.status,
              value: result.value ?? null,
              error: result.error,
              stats: result.stats,
              resumeHint:
                result.status === 'completed'
                  ? `re-run with resumeRunId "${result.runId}" to replay completed nodes at zero provider calls`
                  : result.status === 'failed'
                    ? `fix the script and re-run with resumeRunId "${result.runId}" — completed nodes replay from the journal`
                    : undefined,
            });
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Script Run Error: ${redactText(err.message)}` }],
            };
          }
        }

        // -------------------------------------------------------------------
        // Facade-script tool face — zod-validated inputs,
        // tagged error bodies, journal-sourced projections.
        // -------------------------------------------------------------------

        case 'workflow_run_script': {
          const parsed = RunScriptArgs.safeParse(args ?? {});
          if (!parsed.success) return taggedErrorResult(zodArgsError(parsed.error));
          const input = parsed.data;
          try {
            const cwd = input.cwd ? path.resolve(process.cwd(), input.cwd) : process.cwd();
            const dbPath = input.dbPath;
            const events: Array<{ type: string; data: Record<string, unknown> }> = [];
            // Same assembly the CLI run-script command performs: scriptPath is
            // resolved against the workspace by the runner itself; args pass
            // through as the script's `args`; the journal path resolution is
            // shared (`resolveDwfJournalPath`).
            const result = await runFacadeScript({
              scriptPath: input.scriptPath,
              args: input.args,
              cwd,
              dbPath,
              runTimeoutMs: input.runTimeoutMs,
              onEvent: (e) => events.push(e),
            });
            const journalPath = resolveDwfJournalPath(cwd, dbPath);
            const { sites, sitesError } = await readRunSites(journalPath, result.runId);
            return jsonResult({
              runId: result.runId,
              status: result.status,
              value: result.value ?? null,
              error: result.error,
              diagnostics: result.diagnostics,
              amendedFrom: result.amendedFrom,
              parkedAt: result.parkedAt,
              stats: result.stats,
              sites,
              ...(sitesError !== undefined ? { sitesError } : {}),
              resumeHint:
                result.status === 'completed'
                  ? `re-run with resumeRunId "${result.runId}" to replay completed nodes at zero provider calls`
                  : result.status === 'failed'
                    ? `fix the script and re-run with resumeRunId "${result.runId}" — completed nodes replay from the journal`
                    : undefined,
              // quiet (default) keeps the response lean; the journal keeps every event.
              ...(input.quiet === false
                ? { events: { total: events.length, recent: events.slice(-MAX_EVENT_SUMMARIES) } }
                : {}),
            });
          } catch (err: unknown) {
            return taggedErrorResult(err);
          }
        }

        case 'workflow_inspect_run': {
          const parsed = InspectRunArgs.safeParse(args ?? {});
          if (!parsed.success) return taggedErrorResult(zodArgsError(parsed.error));
          const { runId, dbPath } = parsed.data;
          const journalPath = resolveDwfJournalPath(process.cwd(), dbPath);
          const store = new SQLiteStateStore(journalPath);
          try {
            const run = await store.getDwfRun(runId);
            if (!run) {
              return taggedErrorResult(
                domainError('StorageError', `run "${runId}" not found in journal ${journalPath}`),
              );
            }
            const nodes = await store.getDwfNodes(runId);
            const evidence = await store.getDwfEvidence(runId);
            const summary = summarizeEvidence({ runId, entries: evidence });
            return jsonResult({
              run: {
                runId: run.runId,
                scriptHash: run.scriptHash,
                scriptPath: run.scriptPath,
                argsJson: run.argsJson,
                status: run.status,
                parentRunId: run.parentRunId,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
              },
              nodes: nodes.map((n) => ({
                siteId: n.siteId,
                ordinal: n.ordinal,
                kind: n.kind,
                status: n.status,
                durationMs: n.durationMs ?? 0,
                completedAt: n.completedAt,
                result: parseMaybeJson(n.resultJson),
                error: n.errorText,
              })),
              evidence: {
                ...summary,
                latest: evidence.slice(-LATEST_EVIDENCE_COUNT),
              },
            });
          } catch (err: unknown) {
            return taggedErrorResult(err);
          } finally {
            store.close();
          }
        }

        case 'workflow_get_run': {
          const parsed = GetRunArgs.safeParse(args ?? {});
          if (!parsed.success) return taggedErrorResult(zodArgsError(parsed.error));
          const { runId, dbPath } = parsed.data;
          const journalPath = resolveDwfJournalPath(process.cwd(), dbPath);
          const store = new SQLiteStateStore(journalPath);
          try {
            const run = await store.getDwfRun(runId);
            if (!run) {
              return taggedErrorResult(
                domainError('StorageError', `run "${runId}" not found in journal ${journalPath}`),
              );
            }
            const events = await store.getEvents(runId);
            // Same accounting as the runner stats (asks from dwf_ask_start,
            // replayHits from dwf_replay_hit — see runInner / renderRunViewHtml),
            // aggregated over the run's whole journal across resumes.
            return jsonResult({
              runId,
              status: run.status,
              stats: {
                asks: countEvents(events, 'dwf_ask_start'),
                replayHits: countEvents(events, 'dwf_replay_hit'),
                amendHits: countEvents(events, 'dwf_amend_hit'),
                diverged: countEvents(events, 'dwf_amend_diverged'),
                worldRuns: countEvents(events, 'dwf_world_run'),
              },
            });
          } catch (err: unknown) {
            return taggedErrorResult(err);
          } finally {
            store.close();
          }
        }

        default:
          throw new Error(`Unknown MCP tool: ${name}`);
      }
    });
  }

  public async start(transport?: Transport): Promise<void> {
    const serverTransport = transport ?? new StdioServerTransport();
    await this.server.connect(serverTransport);
  }
}
