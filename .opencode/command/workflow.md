---
description: Run an AI-Workflow facade script (check → run → resume loop)
agent: workflow-runner
---

Run the AI-Workflow loop for: $ARGUMENTS

1. If no script path was given, ask for one (or author a new facade script for
   the task with the facade surface: agent/phase/files/git/world.run/artifact).
2. `workflow check <script>` — fix every diagnostic before running.
3. `workflow run <script> --set key=value --cwd <workspace>` (use `--args-file`
   for JSON input files; `--args '<json>'` works but is not PowerShell-safe).
4. Parse the final `result:` JSON line + stats line. On failure re-run with
   `--resume <runId>`; on an open escalation use `workflow answer <runId>
   <questionId> "<text>"`; for a hole use `workflow fill <runId> <name> <bodyFile>`.
5. Report the run id, the result value and where the journal lives
   (.workflow/dwf.sqlite).
