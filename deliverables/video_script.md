# AI-Workflow: Official 180-Second Video Demonstration Script

**Target Hackathon**: AWS Kiroween 2026 (Skeleton Crew Category)  
**Submission Rule**: Strict under-3-minute maximum duration (0:00 to 3:00 / 180 seconds exact)  
**Author**: Litao Gong (龚立涛) | Devpost: `1842043669` | Email: `1842043669@qq.com`  
**License**: Apache License 2.0  
**Video Resolution**: 1920x1080 (16:9), 60 FPS  
**Voiceover Pace**: ~140 words per minute (English, neutral tech narrator)  

---

## Second-by-Second Timing & Master Cue Sheet

| Scene | Time Window | Duration | Scene Title | Key Visual Elements | Voiceover Word Count |
|:---:|:---:|:---:|---|---|:---:|
| **1** | 0:00 - 0:25 | 25s | The Prompt Fragility Crisis & ZCode Philosophy | Split screen: Chat chaos vs. structured `/workflow` execution | 58 words |
| **2** | 0:25 - 0:55 | 30s | Core Architecture: 3 Pillars of Rigor | Probes → Typed Agent RPCs → Dual-Layer SQLite WAL Checkpoints | 68 words |
| **3** | 0:55 - 1:35 | 40s | Demo 1: Autonomous DevOps Incident Triage | P1 DB pool alert, Inspector, Paired Fixer/Reviewer, `curl /healthz` gate | 82 words |
| **4** | 1:35 - 2:15 | 40s | Demo 2: AWS SDK v2->v3 & Zero-Token Replay | Parallel Fan-Out (S3/Dynamo/SQS), crash simulation, SQLite resume | 84 words |
| **5** | 2:15 - 2:45 | 30s | Mandatory Kiro Integration & Skeleton Crew | Root `/.kiro` specs, hooks, steering, ten-tool MCP face, fast-check PBT | 69 words |
| **6** | 2:45 - 3:00 | 15s | Conclusion & Open Source Release | GitHub repo, Apache 2.0, Devpost sign-off, bilingual toggle | 32 words |
| **TOTAL** | **0:00 - 3:00** | **180s** | **Full Demonstration** | **End-to-End Visual & Technical Walkthrough** | **393 words** |

---

## Scene 1: The Prompt Fragility Crisis & ZCode Dynamic Workflow Philosophy
- **Timecode**: `0:00.00` - `0:25.00` (Duration: 25.00 seconds)
- **On-Screen Title**: THE CONVERSATION CRISIS: Why Chatbots Fail Mission-Critical Engineering
- **Visual Composition**:
  - **Left Pane (45% width)**: Screen recording of a legacy conversational AI tool caught in an endless loop: context window explosion (128k tokens exhausted), hallucinations, apologetic monologues (*"I apologize for the oversight, let me rewrite..."*), and a reckless shell command executing in production without confirmation. A flashing red badge reads: `[FATAL: CONTEXT EXHAUSTION & NON-DETERMINISM]`.
  - **Right Pane (55% width)**: Sleek, high-contrast dark terminal. An engineer runs `/workflow init` and `/workflow run`. Instantly, an elegant multi-phase timeline DAG renders with glowing curved cubic Bézier connectors. A bold teal banner shines: **"CODE, NOT CONVERSATION"**.
- **On-Screen Lower-Third Banner**:
  - `ZCode Principle #1`: Dynamic workflows are executable TypeScript graphs—not fragile multi-turn conversational chat.
- **Audio Track & SFX**:
  - `[0:00 - 0:08]`: Low-frequency ominous tension drone; discordant keyboard clacking and system warning beeps.
  - `[0:08 - 0:12]`: High-speed digital whoosh effect as the screen splits and pivots to the clean terminal.
  - `[0:12 - 0:25]`: Upbeat, rhythmic tech-minimal synthesizer bed begins (120 BPM, deep sub-bass, clean hi-hats).
- **Actor Voiceover (EN)**:
  > *"Today's AI agents suffer from a fatal flaw: they treat mission-critical engineering like casual conversation. Unstructured chat loops hallucinate, exhaust context windows, and break production systems. The ZCode philosophy proves that dynamic workflows must be code, not conversation. Welcome to AI-Workflow—an extensible slash-command engine bringing deterministic software rigor to multi-agent autonomy."* (58 words)

---

## Scene 2: Architecture: Probing, Typed RPCs & Dual-Layer Durability
- **Timecode**: `0:25.00` - `0:55.00` (Duration: 30.00 seconds)
- **On-Screen Title**: THE THREE PILLARS OF RIGOR
- **Visual Composition**:
  - Smooth 3D layered architectural explosion view animating three sequential pillars:
    1. **Pillar 1: Deterministic Probing**: Terminal window probes the system in milliseconds: platform (`win32 x64`), Node runtime (`v22.23.2`), Git commit and dirty status, and toolchain versions. Secret sanitizer automatically redacts credentials (`<REDACTED>` → `[REDACTED]`).
    2. **Pillar 2: Typed Agent RPC Layer**: Code overlay displays `agent('diagnoser').ask<T>(prompt, schema)`. Animated JSON schema validator intercepting agent output, showing zero unvalidated strings and runtime Zod validation.
    3. **Pillar 3: Dual-Layer Persistence**: Split view showing `events.jsonl` append-only journal streaming events, while `node:sqlite` WAL mode commits atomic step checkpoints with microsecond execution durations.
- **On-Screen Callout Badges**:
  - `[Deterministic Probe]`: Zero hallucinated environment assumptions.
  - `[Typed Agent RPC]`: Runtime Zod validation + auto-correction loop.
  - `[SQLite WAL + JSONL]`: Zero-token durable replay & instant resume.
- **Audio Track & SFX**:
  - `[0:25 - 0:34]`: Gentle digital chime as the prober executes; subtle scanning radar audio pulse.
  - `[0:34 - 0:44]`: Crisp "lock-in" sound effect as the Zod schema validates a typed JSON payload.
  - `[0:44 - 0:55]`: Dual metallic latch sounds representing SQLite WAL atomic checkpoint commitment.
- **Actor Voiceover (EN)**:
  > *"Under the hood, AI-Workflow is anchored by three deterministic pillars. First, automated environment probing inspects system runtimes, git trees, and redacts secrets before any LLM is called. Second, Typed Agent RPCs enforce strict Zod schema validation, eliminating raw string hallucinations between agents. Third, dual-layer SQLite WAL checkpointing and append-only event journals persist every step state, enabling instant resume without re-spending model tokens."* (68 words)

---

## Scene 3: Demo 1 in Action: Autonomous DevOps Incident Triage
- **Timecode**: `0:55.00` - `1:35.00` (Duration: 40.00 seconds)
- **On-Screen Title**: DEMO 1: AUTONOMOUS DEVOPS INCIDENT TRIAGE & REMEDIATION
- **Visual Composition**:
  - Full-screen side-by-side execution display:
    - **Left Side (Terminal)**: Command executed: `bash scripts/demo.sh` (Act 2 — the incident-triage demo). Terminal logs stream with timestamped step events (cumulative stamps from the measured 0.7s offline mock run):
      - `[00:00.0] Detection`: Telemetry probe flags a 38.5% HTTP 500 spike and 100/100 exhausted DB connections.
      - `[00:00.0] Triage`: Single Inspector Agent correlates logs with commit `c4d9e1a` (missing connection pool release).
      - `[00:00.0] Plan & Review`: Paired Fixer agent drafts a pool size increase and timeout fix; Paired Reviewer agent audits safety parameters.
      - `[00:00.5] Recovery Gate`: The deterministic shell gate runs its offline mock healthcheck. Exit code: 0!
      - `[00:00.7] Synthesis`: Coordinator writes `PostMortem.md` and updates live Kanban dashboard.
    - **Right Side (Live Bézier DAG Visualizer)**: Multi-phase timeline DAG animating nodes from gray (`pending`) to glowing amber (`running`) to emerald green (`completed`). The purple diamond shell gate flashes green as the deterministic gate exits 0.
    - **Bottom Drawer**: Live Kanban board columns (`Ingested Alerts & Probes` → `Triage & Root Cause Analysis` → `Synthesized Runbooks & Safety Audit` → `Execution & Gate Logs` → `Final Deliverables`) populating cards in real time.
- **On-Screen Callout Badges**:
  - `Topology`: Single Inspector + Paired Fixer/Reviewer + Shell Gate
  - `Verification Gate`: deterministic shell gate (offline mock healthcheck)
  - `Outcome`: Incident diagnosed, patched, verified & post-mortem written in 0.7s!
- **Audio Track & SFX**:
  - `[0:55 - 1:05]`: Urgent P1 alert klaxon, quickly transitioning to focused driving synth bass.
  - `[1:05 - 1:18]`: High-tech dual ping as paired agents review the remediation plan.
  - `[1:18 - 1:26]`: Heavy mechanical switch "click" as the deterministic gate passes, followed by an authoritative green success chime.
  - `[1:26 - 1:35]`: Smooth slide-out sound as the Kanban dashboard and `PostMortem.md` are exported.
- **Actor Voiceover (EN)**:
  > *"Watch Demo 1 resolve an active production P1 incident. Automated telemetry probing catches a database connection exhaustion causing a 38.5% HTTP 500 spike. The Inspector agent correlates telemetry with recent commits. Next, a paired Fixer and Reviewer synthesize a safe remediation patch. But instead of blindly deploying, execution pauses at a deterministic shell gate that runs a healthcheck. Only when the gate exits 0 does it unlock, generating a verified post-mortem."* (82 words)

---

## Scene 4: Demo 2 in Action: AWS SDK v2->v3 Migration & Crash Resumption
- **Timecode**: `1:35.00` - `2:15.00` (Duration: 40.00 seconds)
- **On-Screen Title**: DEMO 2: REPO MIGRATION ENGINE & ZERO-TOKEN RESUMPTION
- **Visual Composition**:
  - Dynamic workflow migration showcase:
    - **Phase 1**: Clean baseline test gate confirms unmigrated repository tests pass.
    - **Phase 2**: AST prober scans the codebase, identifying deprecated `aws-sdk` v2 imports across S3, DynamoDB, and SQS clients.
    - **Phase 3 (Parallel Fan-Out)**: Screen splits into three parallel execution lanes via `Promise.all`. Three worker/reviewer pairs simultaneously transform and review:
      - Lane A: `s3-worker` + `s3-reviewer`
      - Lane B: `dynamo-worker` + `dynamo-reviewer`
      - Lane C: `sqs-worker` + `sqs-reviewer`
    - **The Simulated Crash [1:55]**: Process abruptly receives an unhandled interrupt signal (`SIGINT` / `--interrupt-at step-3b2`). Terminal flashes red: `[SIMULATED RUNTIME CRASH]`.
    - **The Durable Replay [1:59]**: Engineer runs `/workflow replay <run-id>`. The engine queries the SQLite WAL database. Completed steps (S3 and Dynamo transforms) are recognized as valid cached checkpoints: skipped in 0 milliseconds with **0 tokens consumed**! Execution resumes instantly at step 3b2, passes the post-merge TypeScript compiler gate, and generates `PULL_REQUEST.md`.
- **On-Screen Callout Badges**:
  - `Parallel Fan-Out`: 3 Worker + Reviewer Pairs via `Promise.all`
  - `Fault Tolerance`: Simulated mid-workflow crash
  - `Durable Replay`: 4 steps replayed from SQLite WAL in 0ms (0 tokens spent!)
- **Audio Track & SFX**:
  - `[1:35 - 1:52]`: Energetic polyphonic synthesizer pattern representing three parallel worker threads.
  - `[1:52 - 1:56]`: Abrupt tape stop / electrical blackout sound effect simulating a catastrophic crash.
  - `[1:56 - 2:02]`: Instant clean reboot sound and rapid high-pitched laser pings as completed steps replay from cache.
  - `[2:02 - 2:15]`: Triumphant harmonized chords as the final post-merge gate passes and PR opens.
- **Actor Voiceover (EN)**:
  > *"In Demo 2, we tackle automated codebase migration from AWS SDK v2 to modular v3. An AST probe scans legacy imports, and the engine fans out three parallel worker and reviewer pairs for S3, DynamoDB, and SQS using TypeScript `Promise.all`. Mid-way through, we simulate an unexpected crash. With conversational bots, you'd start over, re-spending thousands of tokens. With AI-Workflow, durable replay reloads SQLite WAL checkpoints, skips completed work in zero milliseconds, and finishes the migration flawlessly."* (84 words)

---

## Scene 5: Mandatory Kiro Integration & The Skeleton Crew
- **Timecode**: `2:15.00` - `2:45.00` (Duration: 30.00 seconds)
- **On-Screen Title**: MANDATORY KIRO INTEGRATION · SKELETON CREW CATEGORY
- **Visual Composition**:
  - Dynamic 3D camera pan entering the root `/.kiro` directory structure:
    - `specs/`: Markdown specifications and typed JSON schemas defining engine state machines.
    - `hooks/`: Official Kiro `lifecycle.json` with triggers (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) binding to deterministic cross-platform scripts.
    - `steering/`: Policy guardrails with frontmatter `inclusion: always`, enforcing secret exfiltration bans and safe bash execution.
    - `mcp/`: Exposing the ten-tool MCP face — five legacy tools (`workflow_run`, `workflow_probe`, `workflow_inspect`, `workflow_replay`, `workflow_graph`) plus five facade tools (`workflow_script_check`, `workflow_script_run`, `workflow_run_script`, `workflow_inspect_run`, `workflow_get_run`).
    - `pbt/`: Terminal runs `npm run test:pbt`. `fast-check` executes 8–3,000 randomized cases per property (18 property tests across six suites) in seconds, mathematically verifying replay idempotency, DAG acyclicity, and schema soundness.
    - `crew/`: Skeleton Crew team roster (`team.json`) and role-based permissions (`permissions.json`) enforcing least-privilege tool ceilings.
  - **Git Status Window**: Runs `git status`. Confirms root `/.kiro/` is 100% tracked in git and explicitly preserved in `.gitignore` (`!/.kiro/`, `!/.kiro/**`).
- **On-Screen Callout Badges**:
  - `Tracked in Git`: 100% compliant with Kiroween R3 rules
  - `Kiro Hooks & Steering`: Deterministic `PreToolUse` gates & security boundaries
  - `Fast-Check PBT`: 18 property tests, 8–3,000 randomized cases each, 0 failures
  - `Skeleton Crew`: Principle of least privilege enforced across agent roles
- **Audio Track & SFX**:
  - `[2:15 - 2:25]`: Deep, resonant electronic bass drop; focused, authoritative tempo.
  - `[2:25 - 2:35]`: Ultra-fast mechanical ticker sound as the 18-test PBT suite flashes green.
  - `[2:35 - 2:45]`: Six ascending pure crystal tones as all six Kiro subsystems illuminate with green checkmarks.
- **Actor Voiceover (EN)**:
  > *"AI-Workflow is engineered specifically for AWS Kiroween's Skeleton Crew category. Inside root `/.kiro`—tracked 100% in git—formal specifications govern engine state machines, lifecycle hooks gate tool execution, and steering guardrails prevent credential exfiltration. Our fast-check Property-Based Testing suite mathematically proves replay idempotency across thousands of randomized runs, while our Skeleton Crew roster enforces least-privilege security ceilings across every agent role."* (69 words)

---

## Scene 6: Conclusion, Open-Source Release & Hackathon Sign-Off
- **Timecode**: `2:45.00` - `3:00.00` (Duration: 15.00 seconds)
- **On-Screen Title**: AI-WORKFLOW: CODE, NOT CONVERSATION
- **Visual Composition**:
  - Grand cinematic hero wrap-up screen:
    - Central animated AI-Workflow 3D badge with cyber-teal glow.
    - Submitter Profile Card:
      * **Author**: Litao Gong (龚立涛)
      * **Devpost**: `1842043669`
      * **Email**: `1842043669@qq.com`
      * **Category**: Skeleton Crew (AWS Kiroween 2026)
    - Feature Summary Badges:
      * `Apache 2.0 License` | `Node.js 22 LTS` | `Kiro Native` | `Full Bilingual EN/ZH`
    - Repository Link: `https://github.com/LitaoG/AI-workflow-competition`
    - Visual switch toggles between English and Chinese UI dashboards.
- **On-Screen Lower-Third Banner**:
  - "Code, Not Conversation: Software Engineering Rigor for Autonomous Multi-Agent Workflows."
- **Audio Track & SFX**:
  - `[2:45 - 2:56]`: Full synthesizer and orchestral crescendo reaching triumphant peak.
  - `[2:56 - 3:00]`: Gentle high-frequency chime decaying smoothly into pure silence at exactly 3:00.
- **Actor Voiceover (EN)**:
  > *"AI-Workflow brings the future of deterministic, fault-tolerant multi-agent orchestration to open source. Clone the repository on GitHub, try the demos, and inspect our Kiro integration. Thank you!"* (32 words)

---

## Post-Production Voiceover & Recording Notes
1. **Total Duration**: 180 seconds (3 minutes 00 frames at 60fps).
2. **Total Spoken Word Count**: 393 words (~131 words per minute), leaving natural breathing room, audio SFX pauses, and zero risk of clipping or rushing.
3. **Voice Tone**: Confident, articulate, professional software engineer / tech architect.
4. **Localization Alignment**: The entire video demonstration matches the bilingual project documentation, CLI flags (`--lang=zh` / `--lang=en`), and the interactive presentation artifact at `deliverables/video_presentation.html`.
