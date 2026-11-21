/**
 * Built-in AI-Workflow MCP server: exposes the legacy workflow tool face plus the
 * facade-script (dwf) tool face (GOAL.md 阶段 7.2 — server side aligned with the
 * live engine).
 *
 * Two invariants hold for every tool in this file:
 * 1. Every response crosses the irreversible redaction boundary (`redactValue` /
 *    `redactText` from `src/dwf/redact.ts`) BEFORE serialization — GOAL.md 铁律 2.
 * 2. New-tool error responses speak the domain error algebra: a JSON body
 *    `{ tag, message, details? }` produced by `toSerializableError` (项 5 serialization).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
import { redactText } from '../dwf/redact.js';
import {
  domainError,
} from '../domain/errors.js';
import { summarizeEvidence, ledgerFromEntries } from '../domain/evidence.js';
import { DwfJournalStore } from '../types.js';
import { TOOL_CATALOG, facadeSchemas } from './tool-catalog.js';
import { jsonResult, taggedErrorResult, textResult, resolveScriptInsideCwd, zodArgsError, parseMaybeJson, readRunSites, countEvents } from './tool-helpers.js';

// Historical import surface: the catalog and its descriptor type resolve from
// the server module (tests, export-schema CLI).
export { TOOL_CATALOG } from './tool-catalog.js';
export type { McpToolDescriptor } from './tool-catalog.js';

/** Server name used as the registry namespace and the MCP server info. */
const SERVER_NAME = 'ai-workflow-server';

/** Max recent events carried by a non-quiet `workflow_run_script` response. */
const MAX_EVENT_SUMMARIES = 50;
/** How many of the latest evidence entries `workflow_inspect_run` returns. */
const LATEST_EVIDENCE_COUNT = 5;

/**
 * Load and validate a workflow module for the workflow_run / workflow_graph tool
 * cases (Issue #102: single source — the two cases must not drift on path
 * resolution, import, or instance validation).
 */
async function loadWorkflowModule(
  rawPath: string
): Promise<{ ok: true; wf: Workflow } | { ok: false; text: string }> {
  const resolvedPath = path.resolve(process.cwd(), rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, text: `Workflow file not found: ${resolvedPath}` };
  }

  let mod: any;
  try {
    const fileUrl = pathToFileURL(resolvedPath).href;
    mod = await import(fileUrl);
  } catch (err: any) {
    return { ok: false, text: `Failed to load workflow module: ${redactText(err.message)}` };
  }

  let wf = mod.default ?? mod.workflow;
  if (wf && !(wf instanceof Workflow) && (wf.steps || wf.phases)) {
    wf = defineWorkflow(wf);
  }

  if (!wf || !(wf instanceof Workflow)) {
    return { ok: false, text: `Module "${rawPath}" does not export a valid Workflow instance.` };
  }

  return { ok: true, wf };
}

// ---------------------------------------------------------------------------
// The facade-tool zod schemas live in tool-catalog.ts (single source: the
// catalog derives the documented JSON Schemas from them). Aliased here for
// the CallTool validation path.
const RunScriptArgs = facadeSchemas.RunScriptArgs;
const InspectRunArgs = facadeSchemas.InspectRunArgs;
const GetRunArgs = facadeSchemas.GetRunArgs;



export class BuiltinWorkflowMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
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
          const loaded = await loadWorkflowModule(rawPath);
          if (!loaded.ok) {
            return { isError: true, content: [{ type: 'text', text: loaded.text }] };
          }
          const wf = loaded.wf;

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
            // Facade-journal branch (gap-matrix D2): dwf runs live in
            // dwf_runs/dwf_nodes, never in checkpoints — without this branch a
            // facade runId passed with its journal dbPath is invisible here.
            // Builder runs answer null and fall through with zero behavior change.
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
          const loaded = await loadWorkflowModule(rawPath);
          if (!loaded.ok) {
            return { isError: true, content: [{ type: 'text', text: loaded.text }] };
          }
          const wf = loaded.wf;

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
            // Issue #194 P2: the check face reads files, so it must run inside
            // the same cwd boundary as the execute face — resolveScriptInsideCwd
            // (same pattern as workflow_script_run) keeps TS diagnostics and
            // path-existence oracles from reading arbitrary machine paths.
            const cwd = args?.cwd ? path.resolve(process.cwd(), String(args.cwd)) : process.cwd();
            const scriptPath = resolveScriptInsideCwd(String(args?.scriptPath ?? ''), cwd);
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
            const cwd = args?.cwd ? path.resolve(process.cwd(), String(args.cwd)) : process.cwd();
            const scriptPath = resolveScriptInsideCwd(String(args?.scriptPath ?? ''), cwd);
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
              budgetTotal: typeof args?.budgetTotal === 'number' ? args.budgetTotal : undefined,
              approvedCommands: Array.isArray(args?.approvedCommands)
                ? (args.approvedCommands as unknown[]).filter((c): c is string => typeof c === 'string')
                : undefined,
            });
            return jsonResult({
              runId: result.runId,
              status: result.status,
              value: result.value ?? null,
              error: result.error,
              stats: result.stats,
              // Live plan/execution graph path (Issue #168): the watch view is
              // on by default, so the host can point the user at the file that
              // lights up while the run goes.
              graphPath: result.graphPath,
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
        // Facade-script tool face (GOAL.md 阶段 7.2) — zod-validated inputs,
        // tagged error bodies, journal-sourced projections.
        // -------------------------------------------------------------------

        case 'workflow_run_script': {
          const parsed = RunScriptArgs.safeParse(args ?? {});
          if (!parsed.success) return taggedErrorResult(zodArgsError(parsed.error));
          const input = parsed.data;
          try {
            const cwd = input.cwd ? path.resolve(process.cwd(), input.cwd) : process.cwd();
            const guardedScriptPath = resolveScriptInsideCwd(input.scriptPath, cwd);
            const dbPath = input.dbPath;
            const events: Array<{ type: string; data: Record<string, unknown> }> = [];
            // Same assembly the CLI run-script command performs: scriptPath is
            // resolved against the workspace by the runner itself; args pass
            // through as the script's `args`; the journal path resolution is
            // shared (`resolveDwfJournalPath`).
            const result = await runFacadeScript({
              scriptPath: guardedScriptPath,
              args: input.args,
              cwd,
              dbPath,
              // Issue #142: honor resumeRunId so the resumeHint emitted below is
              // actionable on this very face (previously zod stripped the key and
              // the run silently started fresh at full price).
              resumeRunId: input.resumeRunId,
              runTimeoutMs: input.runTimeoutMs,
              budgetTotal: input.budgetTotal,
              approvedCommands: input.approvedCommands,
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
              // Live plan/execution graph path (Issue #168) — same default-on
              // watch view as the legacy face above.
              graphPath: result.graphPath,
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
            const summary = summarizeEvidence(ledgerFromEntries(runId, evidence));
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
