import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSlashArgs } from './slash-parser.js';
import { getDictionary, resolveLang } from './i18n/index.js';
import { configureCliProvidersFromEnv } from '../agent/cli-providers.js';
import { configureHttpProvidersFromEnv } from '../agent/http-providers.js';
import { executeRun } from './commands/run.js';
import { executeReplay } from './commands/replay.js';
import { executeGraph } from './commands/graph.js';
import { executeProbe } from './commands/probe.js';
import { executeList } from './commands/list.js';
import { executeInspect } from './commands/inspect.js';
import { executeInit } from './commands/init.js';
import { executeMCPList, executeMCPCall, executeMCPServe } from './commands/mcp.js';
import { executeView } from './commands/view.js';
import { executeServe } from './commands/serve.js';
import { executeStop } from './commands/stop.js';
import { executeCheck } from './commands/check.js';
import { executeRunScript } from './commands/run-script.js';
import { executeFill } from './commands/fill.js';
import { executeAnswer } from './commands/answer.js';
import { executeAuthor } from './commands/author.js';
import { executeDoctor } from './commands/doctor.js';
import { executeWorkflowsList, executeWorkflowsRun } from './commands/workflows.js';
import { executeUltracode } from './commands/ultracode.js';
import { executeSetup } from './commands/setup-interop.js';
import { executeExportSchema } from './commands/export-schema.js';
import { executeDemo } from './commands/demo.js';
import { executeNew } from './commands/new.js';
import { looksLikeFacadeScript } from './commands/script-detect.js';
import { composeScriptArgs } from './args-input.js';

/** Commander collector for repeatable `--set key=value` pairs. */
function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Shared facade-run option face for `run` and `run-script` (Issue #104): one
 * registration so the two entries cannot drift. Per-command extras stay with
 * their own command (`--watch`/`--progress` on run; `--rerun`/`--from`/
 * `--approve-cmd` on run-script), and the --resume/--amend short flags stay
 * per-command too — `-r`/`-m` are already taken by run's
 * --resume-from-failed/--mock.
 */
function registerFacadeRunOptions(cmd: Command): Command {
  return cmd
    .option('-a, --args <json>', 'Script input as JSON (available as `args`)')
    .option('--args-file <file>', 'Read script input from a JSON file (PowerShell-safe, zero escaping)')
    .option('--set <pair>', 'Set a script arg key=value with type inference (repeatable)', collect, [])
    .option('--cwd <path>', 'Workspace the run executes in (journal resolution + sandbox child cwd)')
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-c, --max-concurrency <n>', 'Max concurrent subagent asks (default 4)')
    .option('--budget-total <n>', 'Output-token budget for the run (read-only inside the script)')
    .option('--failover <ids>', 'Comma-separated failover provider ids for actor asks (e.g. mock,gemini-cli)')
    .option('--live <path>', 'Write a self-refreshing HTML execution view while the run goes')
    .option('--watch-graph', 'Rewrite the run dir graph.html after every event (same journal projection as `workflow graph` cold replay; ON by default — the graph opens as the full pending plan, Issue #168)')
    .option('--no-watch-graph', 'Disable the live graph.html watch view for this run')
    .option('--ui', 'When the run settles, serve the AI-Workflow Studio (SSE + A2UI resume) and open the browser')
    .option('--run-timeout <ms>', 'Whole-run wall clock in ms (default 600000; env AI_WORKFLOW_RUN_TIMEOUT_MS)');
}

/**
 * The CLI banner version, read from the package manifest so the published
 * tarball, the docs and `workflow --version` can never drift apart (they used
 * to: the hardcoded literal said 1.0.0 while package.json said 2.0.0).
 * Dist layout resolves three levels up; strip-types source runs two up.
 */
function cliVersion(): string {
  for (const rel of ['../../../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version) return `ai-workflow ${pkg.version}`;
    } catch {
      // try the next candidate layout
    }
  }
  return 'ai-workflow';
}

export async function runCLI(rawArgv: string[] = process.argv): Promise<number> {
  // Route worker asks through an external agent CLI when configured
  // (AI_WORKFLOW_PROVIDER=codex|gemini|opencode); mock stays the default.
  configureCliProvidersFromEnv(process.env);
  // Register native HTTP providers strictly on explicit env credentials
  // (ANTHROPIC_API_KEY / OPENAI_API_KEY); mock stays the default, no auto-dial.
  // Adapter modules load lazily — nothing extra is imported when unconfigured.
  await configureHttpProvidersFromEnv(process.env);
  const argv = normalizeSlashArgs(rawArgv);

  // Check if lang flag was passed in argv
  let langArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang' || argv[i] === '-l') {
      langArg = argv[i + 1];
      break;
    }
  }

  const lang = resolveLang(langArg);
  const dict = getDictionary(lang);

  const program = new Command();
  program
    .name('workflow')
    .description(dict.CLI_DESCRIPTION)
    .usage(dict.CLI_USAGE)
    .version(cliVersion())
    .option('-l, --lang <lang>', dict.OPT_LANG, 'en')
    .addHelpText(
      'after',
      `
Commands:
  run <file>               Execute a workflow — auto-detects facade scripts (DWF sandbox) or builder definitions
  check <file>             Compile-check a facade script and print its phase graph
  run-script <file>        Execute a facade script in the sandbox (journal replay on --resume)
  demo                     One-second offline flagship demo + Studio dashboard in your browser
  new <name>               Scaffold a facade workflow from a template (code-review, incident-triage, …)
  replay <run-id>          Replay or resume workflow execution
  graph <file>             Generate DAG visualization (html, mermaid, ascii)
  serve <run-id>           Live Studio dashboard for a run (SSE + inline A2UI resume)
  view <run-id>            Export the Studio dashboard as a standalone HTML page
  setup                    Generate Claude Code / OpenCode / Codex / ZCode interop configs
  export-schema            Export the engine tool face as an OpenAI function-calling schema
  probe                    Inspect host environment and toolchains
`
    )
    .exitOverride();

  let exitCode = 0;

  const runCmd = program
    .command('run <file>')
    .description(dict.CMD_RUN_DESC)
    .option('-r, --resume-from-failed <runId>', dict.OPT_RESUME_FAILED)
    .option('-m, --mock', dict.OPT_MOCK)
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('-o, --out <dir>', dict.OPT_OUTPUT)
    .option('--output-dir <dir>', dict.OPT_OUTPUT)
    .option('--dry-run', 'Validate workflow without executing')
    // Demo workflows (apps/repo-migration-engine) read this from argv
    // directly; registered so commander does not reject the documented
    // resumption walkthrough (2026-11-14 round 2).
    .option('--interrupt-at <n>', 'Demo resumption hook: stop the workflow after N steps (read by demo workflows from argv)')
    .option('-v, --verbose', dict.OPT_VERBOSE);
  // Facade-script face: `run` auto-detects facade traits (static scan — never
  // an import() probe, facade scripts have a top-level `return`) and forwards
  // transparently to the DWF sandbox runner. Builder definitions keep the
  // legacy behavior below.
  registerFacadeRunOptions(runCmd)
    .option('--resume <runId>', 'Resume a prior run: completed nodes replay from the journal at zero model calls (script must be byte-identical)')
    .option('--amend <runId>', 'Amend a prior run: fork a new run with an edited script; unchanged nodes replay from the warm cache')
    .option('--watch', 'Alias of --watch-graph: rewrite the run dir graph.html after every event')
    .option('--progress', 'Structured [wf] progress lines on stdout for harness agents to mirror into their todo list')
    .action(async (file, opts) => {
      const effectiveLang = opts.lang ?? program.opts().lang ?? lang;
      // Facade scripts may be spelled relative to --cwd; fall back to that
      // workspace when the invocation-cwd path does not exist.
      let scriptPath = file;
      if (opts.cwd && !looksLikeFacadeScript(scriptPath)) {
        const candidate = path.join(opts.cwd, file);
        if (looksLikeFacadeScript(candidate)) scriptPath = candidate;
      }
      if (looksLikeFacadeScript(scriptPath)) {
        const composed = composeScriptArgs({ argsJson: opts.args, argsFile: opts.argsFile, setPairs: opts.set });
        if (composed.error) {
          console.error(`Error: ${composed.error}`);
          exitCode = 1;
          return;
        }
        exitCode = await executeRunScript(scriptPath, {
          argsJson: JSON.stringify(composed.args ?? {}),
          resume: opts.resume,
          amend: opts.amend,
          mock: opts.mock,
          dbPath: opts.db,
          maxConcurrency: opts.maxConcurrency,
          budgetTotal: opts.budgetTotal,
          failoverProviders:
            typeof opts.failover === 'string'
              ? opts.failover.split(',').map((x: string) => x.trim()).filter(Boolean)
              : undefined,
          live: opts.live,
          // Issue #168: opts.watchGraph is three-state (undefined = default ON,
          // false = --no-watch-graph, true = explicit) — `||` would collapse the
          // explicit false back into the default. The --watch alias only ever
          // turns the view ON.
          watchGraph: opts.watch ? true : opts.watchGraph,
          progress: opts.progress,
          ui: opts.ui,
          runTimeoutMs: opts.runTimeout,
          cwd: opts.cwd,
          lang: effectiveLang,
        });
        return;
      }
      if (opts.args || opts.argsFile || (Array.isArray(opts.set) && opts.set.length > 0)) {
        console.error('Note: --args/--args-file/--set apply to facade scripts; this file was treated as a builder workflow and they were ignored.');
      }
      if (opts.resume || opts.amend) {
        console.error('Note: --resume/--amend apply to facade scripts; use --resume-from-failed for builder workflows.');
      }
      const out = opts.out ?? opts.outputDir;
      exitCode = await executeRun(file, { ...opts, out, lang: effectiveLang });
    });

  program
    .command('replay <runId>')
    .description(dict.CMD_REPLAY_DESC)
    .option('-s, --step <stepId>', dict.OPT_STEP)
    .option('-r, --resume-from-failed [runId]', dict.OPT_RESUME_FAILED)
    .option('-m, --mock', dict.OPT_MOCK)
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('--file <path>', dict.OPT_FILE)
    .option('-f, --force-recompute', 'Force recomputation of downstream steps')
    .action(async (runId, opts) => {
      exitCode = await executeReplay(runId, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('graph <file>')
    .description(dict.CMD_GRAPH_DESC)
    .option('-f, --format <format>', dict.OPT_FORMAT, 'ascii')
    .option('-o, --output <path>', dict.OPT_OUTPUT)
    .option('--db <path>', 'Journal database path (positional arg is a facade runId)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (file, opts) => {
      exitCode = await executeGraph(file, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('probe [targetDir]')
    .description(dict.CMD_PROBE_DESC)
    .allowUnknownOption(true)
    .option('-o, --output <format>', 'Output format (json | text)', 'text')
    .option('-j, --json', 'Output as JSON')
    .option('-s, --strict', dict.OPT_STRICT)
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (targetDir, opts) => {
      const format = opts.json ? 'json' : (opts.output ?? 'text');
      exitCode = await executeProbe(targetDir, { ...opts, output: format, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('list')
    .description(dict.CMD_LIST_DESC)
    .option('-n, --limit <number>', 'Maximum runs to list', '10')
    .option('-s, --status <status>', 'Filter by run status')
    .option('-j, --json', 'Output as JSON')
    .option('--db <path>', 'Journal database path (facade runs)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (opts) => {
      exitCode = await executeList({ ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('inspect <runId>')
    .description(dict.CMD_INSPECT_DESC)
    .option('-s, --step <stepId>', dict.OPT_STEP)
    .option('-e, --events', 'Include full event journal stream')
    .option('-j, --json', 'Output as JSON')
    .option('--db <path>', 'Journal database path (facade runs)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (runId, opts) => {
      exitCode = await executeInspect(runId, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('init <template> [dir]')
    .description(dict.CMD_INIT_DESC)
    .option('-d, --dir <path>', 'Destination directory')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('--force', 'Overwrite existing files')
    .action(async (template, dir, opts) => {
      const options = typeof dir === 'object' && dir !== null && !opts ? dir : (opts ?? {});
      const effectiveDir = typeof dir === 'string' ? dir : options.dir;
      exitCode = await executeInit(template, { ...options, dir: effectiveDir, lang: options.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('check <file>')
    .description(dict.CMD_CHECK_DESC)
    .option('-j, --json', 'Output analysis as JSON')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (file, opts) => {
      exitCode = await executeCheck(file, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('author <intent...>')
    .description('Author a facade script from one natural-language sentence: generate, compile-check, self-heal (max 3 attempts), write — never run')
    .option('-o, --out <path>', 'Output script path (default ./authored.workflow.ts)')
    .option('--force', 'Overwrite an existing output file')
    .option('--provider <id>', 'Provider id to author with (default: registry default)')
    .option('--model <model>', 'Model override forwarded to the provider')
    .option('--max-tokens <n>', 'Output token ceiling per generation attempt (default 8192)')
    .action(async (intent, opts) => {
      exitCode = await executeAuthor(intent, {
        out: opts.out,
        force: opts.force,
        provider: opts.provider,
        model: opts.model,
        maxTokens: opts.maxTokens === undefined ? undefined : Number(opts.maxTokens),
      });
    });

  const runScriptCmd = program
    .command('run-script <file>')
    .description(dict.CMD_RUN_SCRIPT_DESC)
    .option('--rerun <runId>', 'Rerun a prior run with the same script from --from <siteId>: earlier sites replay from the warm cache, that site and later ones run live')
    .option('--from <siteId>', 'Site id where a --rerun starts executing live (`workflow check <file>` lists the site table)')
    .option('--approve-cmd <name>', 'Authorize a world.run command for this run (repeatable; the script own list no longer authorizes - Issue #127)', collect, [])
    .option('--mock', 'Force tier routing to the built-in mock provider (offline, 0 tokens; overrides AI_WORKFLOW_*_PROVIDER tier routing)')
    .option('-l, --lang <lang>', dict.OPT_LANG);
  registerFacadeRunOptions(runScriptCmd)
    .option('-r, --resume <runId>', 'Resume a prior run: completed nodes replay from the journal at zero model calls (script must be byte-identical)')
    .option('-m, --amend <runId>', 'Amend a prior run: fork a new run with an edited script; unchanged nodes replay from the warm cache')
    .action(async (file, opts) => {
      const composed = composeScriptArgs({ argsJson: opts.args, argsFile: opts.argsFile, setPairs: opts.set });
      if (composed.error) {
        console.error(`Error: ${composed.error}`);
        exitCode = 1;
        return;
      }
      exitCode = await executeRunScript(file, {
        ...opts,
        argsJson: JSON.stringify(composed.args ?? {}),
        cwd: opts.cwd,
        dbPath: opts.db,
        liveHtmlPath: opts.live,
        runTimeoutMs: opts.runTimeout,
        failoverProviders: typeof opts.failover === 'string' ? opts.failover.split(',').map((x: string) => x.trim()).filter(Boolean) : undefined,
        lang: opts.lang ?? program.opts().lang ?? lang,
      });
    });

  program
    .command('serve <runId>')
    .description(dict.CMD_SERVE_DESC)
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-p, --port <n>', 'HTTP port (default 4649)')
    .option('--studio', 'SVG canvas + WebSocket push + time travel (default off — legacy SSE view)')
    .option('--no-open', 'Do not raise the default browser')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (runId, opts) => {
      exitCode = await executeServe(runId, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('stop <runId>')
    .description('Stop a running facade-script run (kills the owning process tree) and unlock resume/amend/fill')
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (runId, opts) => {
      exitCode = await executeStop(runId, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('view <runId>')
    .description(dict.CMD_VIEW_DESC)
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-o, --out <path>', 'Output HTML path (default .workflow/views/<runId>.html)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (runId, opts) => {
      exitCode = await executeView(runId, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('fill <runId> <holeName> [bodyFile]')
    .description('Fill a hole a facade-script run is parked at; the run forks as an amend and continues')
    .option('-b, --body <statements>', 'Inline fill body (alternative to a body file)')
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-c, --max-concurrency <n>', 'Max concurrent subagent asks (default 4)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (runId, holeName, bodyFile, opts) => {
      exitCode = await executeFill(runId, holeName, bodyFile, { ...opts, dbPath: opts.db, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('answer <runId> <questionId> <text...>')
    .description('Answer an escalation a facade-script run is parked at; the run resumes and the ask resolves to the answer')
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('--approve-cmd <name>', 'Authorize a world.run command for the resumed run (repeatable - Issue #127)', collect, [])

    .action(async (runId, questionId, text, opts) => {
      exitCode = await executeAnswer(runId, questionId, text, { ...opts, approvedCommands: opts.approveCmd, dbPath: opts.db, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('doctor')
    .description('Check facade-script readiness: runtime, compiler, git, journal storage, sandbox child, providers')
    .option('-j, --json', 'Output as JSON')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (opts) => {
      exitCode = await executeDoctor({ ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('ultracode <task>')
    .description(dict.CMD_ULTRACODE_DESC)
    .option('--save <name>', 'Fixpoint the synthesized workflow into the project registry (.workflow/workflows)')
    .option('--mock', 'Trial-run the synthesized script in deterministic offline mock mode')
    .option('--run', 'Trial-run the synthesized script for real (uses the configured provider)')
    .option('--provider <id>', 'Provider id for the synthesis ask')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (task, opts) => {
      exitCode = await executeUltracode(task, { ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  const workflowsCommand = program.command('workflows').description('Saved facade-script workflows (registry in .workflow/workflows/)');

  workflowsCommand
    .command('list')
    .description('List saved workflows (project shadows global)')
    .option('-j, --json', 'Output as JSON')
    .action(async (opts) => {
      exitCode = await executeWorkflowsList(opts);
    });

  workflowsCommand
    .command('run <name>')
    .description('Run a saved workflow by name, with arg validation and defaults')
    .option('-a, --args <json>', 'Call args as JSON (validated against the frontmatter declarations)')
    .option('-r, --resume <runId>', 'Resume a prior run of this workflow')
    .option('--db <path>', 'Journal database path')
    .option('--live <path>', 'Write a self-refreshing HTML execution view while the run goes')
    .action(async (name, opts) => {
      exitCode = await executeWorkflowsRun(name, opts);
    });

  const mcpCommand = program.command('mcp').description(dict.CMD_MCP_DESC);
  mcpCommand
    .command('list')
    .description('List configured MCP tools')
    .option('-j, --json', 'Output as JSON')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('-m, --mock', 'Use mock client')
    .action(async (opts) => {
      exitCode = await executeMCPList(opts);
    });

  mcpCommand
    .command('call [serverOrTool] [tool] [argsJson]')
    .description('Invoke an MCP tool call')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('-m, --mock', 'Use mock client')
    .action(async (serverOrTool, tool, argsJson, opts) => {
      exitCode = await executeMCPCall(serverOrTool, tool, argsJson, opts);
    });

  mcpCommand
    .command('serve')
    .description('Launch built-in AI-Workflow MCP Server over stdio')
    .action(async () => {
      exitCode = await executeMCPServe();
    });

  program
    .command('demo')
    .description('Run the flagship incident-triage demo offline (deterministic mock) and open the AI-Workflow Studio')
    .option('--no-open', 'Do not raise the default browser')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (opts) => {
      exitCode = await executeDemo({ ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('new <name>')
    .description('Scaffold a compile-clean facade workflow from a built-in template (code-review | incident-triage | repo-migration | multi-agent)')
    .option('-t, --template <template>', 'Template key (interactive picker when omitted on a TTY)')
    .option('-d, --dir <path>', 'Destination directory (default: current directory)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (name, opts) => {
      exitCode = await executeNew(name, opts);
    });

  program
    .command('setup')
    .description('Generate coding-assistant interop configs (Claude Code / OpenCode / Codex) in the current project')
    .option('-t, --target <target>', 'claude | opencode | codex | all (default all)')
    .option('-d, --dir <path>', 'Destination project root (default: current directory)')
    .action(async (opts) => {
      exitCode = await executeSetup(opts);
    });

  program
    .command('export-schema')
    .description('Export the built-in engine tool face as an OpenAI function-calling JSON schema')
    .option('-f, --format <format>', 'Schema format (default: openai)', 'openai')
    .option('-o, --out <path>', 'Write to a file instead of stdout')
    .action(async (opts) => {
      exitCode = await executeExportSchema(opts);
    });

  try {
    // If no subcommand was passed (e.g. `node bin/workflow.js` or `/workflow`)
    if (argv.length <= 2) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(argv);
    return exitCode;
  } catch (err: any) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return 0;
    }
    if (err.code === 'commander.unknownCommand') {
      console.error(`Error: Unknown command "${argv[2] || ''}". Run workflow --help for usage.`);
      return 1;
    }
    if (err.code === 'commander.missingArgument') {
      const msg = err.message || '';
      if (msg.includes("'file'")) {
        console.error('Error: Workflow file required');
      } else if (msg.includes("'runId'")) {
        console.error('Error: run-id required');
      } else if (msg.includes("'template'")) {
        console.error('Error: Invalid template "undefined". Available templates: basic, multi-agent');
      } else {
        console.error(msg);
      }
      return 1;
    }
    console.error(err.message);
    return 1;
  }
}
