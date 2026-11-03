import { Command } from 'commander';
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
import { executeDoctor } from './commands/doctor.js';
import { executeWorkflowsList, executeWorkflowsRun } from './commands/workflows.js';

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
    .version('ai-workflow 1.0.0')
    .option('-l, --lang <lang>', dict.OPT_LANG, 'en')
    .addHelpText(
      'after',
      `
Commands:
  run <file>               Execute dynamic workflow (builder mode)
  check <file>             Compile-check a facade script and print its phase graph
  run-script <file>        Execute a facade script in the sandbox (journal replay on --resume)
  replay <run-id>          Replay or resume workflow execution
  graph <file>             Generate DAG visualization (html, mermaid, ascii)
  probe                    Inspect host environment and toolchains
`
    )
    .exitOverride();

  let exitCode = 0;

  program
    .command('run <file>')
    .description(dict.CMD_RUN_DESC)
    .option('-r, --resume-from-failed <runId>', dict.OPT_RESUME_FAILED)
    .option('-m, --mock', dict.OPT_MOCK)
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .option('-o, --out <dir>', dict.OPT_OUTPUT)
    .option('--output-dir <dir>', dict.OPT_OUTPUT)
    .option('--dry-run', 'Validate workflow without executing')
    .option('-v, --verbose', dict.OPT_VERBOSE)
    .action(async (file, opts) => {
      const out = opts.out ?? opts.outputDir;
      exitCode = await executeRun(file, { ...opts, out, lang: opts.lang ?? program.opts().lang ?? lang });
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
    .command('run-script <file>')
    .description(dict.CMD_RUN_SCRIPT_DESC)
    .option('-a, --args <json>', 'Script input as JSON (available as `args`)')
    .option('-r, --resume <runId>', 'Resume a prior run: completed nodes replay from the journal at zero model calls (script must be byte-identical)')
    .option('-m, --amend <runId>', 'Amend a prior run: fork a new run with an edited script; unchanged nodes replay from the warm cache')
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-c, --max-concurrency <n>', 'Max concurrent subagent asks (default 4)')
    .option('--failover <ids>', 'Comma-separated failover provider ids for actor asks (e.g. mock,gemini-cli)')
    .option('--live <path>', 'Write a self-refreshing HTML execution view while the run goes')
    .option('--watch-graph', 'Rewrite the run dir graph.html after every event (same journal projection as `workflow graph` cold replay)')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (file, opts) => {
      exitCode = await executeRunScript(file, {
        ...opts,
        argsJson: opts.args,
        dbPath: opts.db,
        liveHtmlPath: opts.live,
        failoverProviders: typeof opts.failover === 'string' ? opts.failover.split(',').map((x: string) => x.trim()).filter(Boolean) : undefined,
        lang: opts.lang ?? program.opts().lang ?? lang,
      });
    });

  program
    .command('serve <runId>')
    .description(dict.CMD_SERVE_DESC)
    .option('--db <path>', 'Journal database path (default .workflow/dwf.sqlite)')
    .option('-p, --port <n>', 'HTTP port (default 4649)')
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
    .action(async (runId, questionId, text, opts) => {
      exitCode = await executeAnswer(runId, questionId, text, { ...opts, dbPath: opts.db, lang: opts.lang ?? program.opts().lang ?? lang });
    });

  program
    .command('doctor')
    .description('Check facade-script readiness: runtime, compiler, git, journal storage, sandbox child, providers')
    .option('-j, --json', 'Output as JSON')
    .option('-l, --lang <lang>', dict.OPT_LANG)
    .action(async (opts) => {
      exitCode = await executeDoctor({ ...opts, lang: opts.lang ?? program.opts().lang ?? lang });
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
