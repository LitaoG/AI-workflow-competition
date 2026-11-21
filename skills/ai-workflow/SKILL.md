---
name: ai-workflow
description: >-
  Author and run deterministic dynamic-workflow scripts with the AI-Workflow
  engine: compile-checked facade scripts (agent().ask<T>, phases, fan-outs,
  shell gates, artifacts) executed in a sandbox with a journal that replays
  completed work at zero provider calls. Use for multi-step tasks that need
  real orchestration — coverage loops, parallel reviews with verification,
  migration pipelines, anything where "the plan" must live in code, not in
  one agent's context window. Not for single delegated lookups (use your
  normal task tool instead).
---

# AI-Workflow — deterministic dynamic workflows from any host

You are orchestrating work through the **AI-Workflow engine**: you write a
TypeScript **facade script**, the engine compile-checks it, runs it in a
sandbox, and journals every node so a re-run replays completed work at zero
cost. Control flow is your code; every side effect goes through the facade.

## The authoring loop (every time, in order)

1. **Write** the script to the target workspace (e.g. `./<task>.facade.ts`).
2. **Check** — never skip: `workflow check <script>`. It must print
   `✔ facade script compiled clean (N sites)`. Fix diagnostics before running;
   uncompilable scripts never reach a run.
3. **Run** — `workflow run <script>` (auto-detects facade scripts; `workflow
   run-script <script>` is the explicit alias). Pass input via one of:
   - `--set key=value` (repeatable, type-inferred) — the PowerShell-safe
     default, no quote escaping required;
   - `--args-file <file.json>` (file 直传, zero escaping);
   - `--args '<json>'` (single-quoted JSON; PowerShell may swallow the quotes —
     prefer `--set` / `--args-file` on Windows).
   Use `--cwd <dir>` when the script's workspace root differs from where you
   invoke. Parse the final `result:` JSON line and the stats line
   (`asks: N (replayed from journal: M)`).
4. **Resume on failure** — a failed run keeps every completed node. Fix the
   script and re-run with `--resume <runId>`: completed asks/world reads/gates
   replay from the journal at zero provider calls; execution continues from
   the failure point. Inputs that changed fail loudly (hash mismatch) instead
   of silently reusing stale results.

MCP hosts can use the same loop through tools: `workflow_script_check` and
`workflow_script_run` (the run tool's result includes a `resumeHint`).

## The facade (the ONLY APIs a script may use)

```ts
// subagents — one conversation per agent(); ask returns one turn's answer
const reviewer = agent('code-reviewer');
const verdict = await reviewer.ask<Review>('review this diff: ...'); // typed → JSON-schema validated
const note = await agent('scout').ask('summarize in prose');          // untyped → text/object

// phases group the progress view; titles are compile-time literals
phase('Review');

// progress + narration
log('12 files scanned'); report({ files: 12 });

// read-only world (journalled — replays for free)
const files = await files.glob('src/**/*.ts');               // workspace-relative
const hits  = await files.grep('TODO', 'src/**/*.ts');       // {path, line, text}[]
const src   = await files.read('src/index.ts');
const changed = await git.changedFiles('origin/main');        // also git.diff / git.status / git.log

// deterministic shell gate — command must be a string literal; args carry values
const gate = await world.run('node', ['--experimental-strip-types', 'tests/x.test.ts'], { timeoutMs: 60_000 });
if (gate.exitCode !== 0) throw new Error(`gate failed: ${gate.stderr}`);

// user-facing artifacts
await artifact.markdown('report', '# Findings\n...', { title: 'Review report' });
await artifact.file('profile', 'out/profile.html', { title: 'Profile' });

// adjust the live plan graph mid-run: new pending boxes + edges render
// immediately in graph.html; ids are runtime values, edges may point at real site ids
plan({
  nodes: [{ id: 'deep-dive', name: 'Deep-dive root cause', phase: 'Deep-dive' }],
  edges: [{ from: 'ask#3', to: 'deep-dive' }],
});

// input, passed via --set key=value | --args-file <file.json> | --args '<json>'
const question = (args.question as string | undefined) ?? 'default';

// top-level await + top-level return (the returned value is the run result)
return { answer: verdict };
```

### Hard rules (the compiler enforces them)

- **Determinism**: `Date.now()`, `Math.random()`, `new Date()` are banned —
  pass timestamps through `--args`.
- **Closed world**: no `import`, no `process`/`fs`/`fetch` — the facade is the
  entire surface; shadowing facade names is a diagnostic.
- **Literal rules**: `phase()` titles and `world.run` command names must be
  string literals (the command set is shown for approval); runtime values go
  in the args array.
- **Fan out with native code**: `Promise.all` / loops / `if` are the
  orchestration — the engine intercepts only facade calls.
- **Sized asks**: give `ask<T>` an interface with JSDoc per field (field docs
  become the schema description the worker sees); keep results narrow — pass
  paths, not file contents.
- **Fresh eyes**: the agent that wrote a plan must not be the one that
  approves it — pair a worker `ask` with a separate reviewer `ask`.

## Worked example

See [`examples/review.facade.ts`](./examples/review.facade.ts) — scan →
parallel typed reviews → adversarial verify → gate → report. Run it:

```bash
# run from the repo root — examples/review.facade.ts is relative to it
# (use an explicit path otherwise); --cwd points the script's workspace
# root at <workspace>, which may differ from the repo root
workflow run examples/review.facade.ts --cwd <workspace> --set glob=src/**/*.ts
```

## Live progress in the harness (`--progress`)

Run facade scripts with `--progress` and the run prints one grep-able
`[wf]` line per journal event instead of the human chatter:

```bash
workflow run examples/review.facade.ts --cwd <workspace> --progress
# [wf] PLAN ◇ 6 sites · 2 phases (graph.html live)
# [wf] PHASE 1 · Scan
# [wf] AGENT + inspector
# [wf] ASK ▶ coordinator (ask#27)
# [wf] REPLAY ⚡ ask#27#1 (0 provider calls)
# [wf] GATE $ npm test
# [wf] ARTIFACT ■ postmortem (569 bytes)
# [wf] DONE ✔ run completed
```

As the driving agent, mirror that stream into your own progress surface
instead of making the user watch a dashboard. The opening
`[wf] PLAN ◇ N sites · M phases (graph.html live)` line announces the whole
plan and where the live graph is: point the user at that `graph.html` path —
it exists from the run's first moment as the full pending plan and lights up
node by node as execution proceeds. Start with one todo item per
`[wf] PHASE` line, tick items off as later phases appear, and paste
`FAIL ✖` / `QUESTION ❓` / `HOLE ⌘` lines into the conversation the moment
they print — those are the only three kinds that need a human decision.
While the run is live, the graph.html watch view plus this channel ARE the
workflow view; the Studio remains the post-run deep dive.

## When NOT to reach for this

A single delegated lookup, a small diff review, or anything one reply covers —
use your normal task tool. The workflow earns its cost when the *plan* must
survive across many agents: fixed worklists, coverage you can prove, verdicts
that need independent confirmation, or runs you may need to resume.
