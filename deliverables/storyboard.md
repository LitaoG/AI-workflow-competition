# AI-Workflow: Visual Storyboard & Production Blueprint

**Target Deliverable**: `deliverables/storyboard.md`  
**Video Specifications**: 1920x1080 / 2560x1440 2K QHD, 60 FPS, 16:9 Aspect Ratio  
**Master Video Deliverable**: [`AI_Workflow_Video.mp4`](AI_Workflow_Video.mp4) (1m 52s Master Cut)  
**Total Running Time**: Strict 180 seconds (0:00 to 3:00)  
**Target Category**: AWS Kiroween 2026 Hackathon (Skeleton Crew)  
**Author**: Litao Gong (龚立涛) | Devpost: `1842043669` | Email: `1842043669@qq.com`  

---

## Color Palette & Visual Style Guide

- **Background Canvas**: Deep Space Navy `#090D16` / Obsidian Slate `#0F172A`
- **Card Backgrounds**: Subsystem Card Surface `#131B2E`
- **Border Lines**: Subtle Grid Border `#1E293B`
- **Primary Cyber Accent**: Electric Cyan `#38BDF8` (Active flows & links)
- **Status Green**: Verified Emerald `#10B981` (Completed steps & passed gates)
- **Status Amber**: Active Processing `#F59E0B` (Running agents & fan-out workers)
- **Status Red**: Error / Crash Indicator `#EF4444` (Simulated failure & trip limits)
- **Gate Purple**: Deterministic Shell Gate `#8B5CF6` (Recovery gates & verification)
- **Typography**: Clean monospace & neo-grotesque font stack (`JetBrains Mono`, `Inter`, system UI font)

---

## Scene-by-Scene Production Storyboard

### Scene 1: The Prompt Fragility Crisis & ZCode Philosophy
- **Timecode**: `0:00 - 0:25` (25s)
- **Canvas Resolution**: 1920x1080 @ 60fps
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------+
  |  HEADER: THE CONVERSATION CRISIS                                        |
  +------------------------------------+------------------------------------+
  | LEFT PANE: 45% (The Chatbot Chaos) | RIGHT PANE: 55% (The ZCode Solution|
  | - Multi-turn conversational loop   | - Dark CLI Terminal: /workflow run |
  | - 128k Context Token Blowout       | - Timeline DAG with Bézier curves  |
  | - Hallucination cascades           | - Deterministic execution graph    |
  | - Red Alert: [429 Rate Limit]      | - "CODE, NOT CONVERSATION"         |
  +------------------------------------+------------------------------------+
  | FOOTER BANNER: ZCode Principle #1: Dynamic Workflows are Executable Code|
  +-------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `0:00 - 0:08`: Wide static shot of left pane. Camera slowly dollies forward toward the exploding red token counter and hallucination loop.
  - `0:08 - 0:12`: High-speed horizontal whip-pan rightward, pivoting focus onto the crisp right pane.
  - `0:12 - 0:25`: Smooth tracking zoom into the `/workflow` slash command prompt, pulling back slightly to reveal the glowing teal timeline DAG.
- **Visual Elements**:
  - Left pane: Shaky text rendering, flickering amber/red warning banners, red exclamation badges, scrolling chat messages.
  - Right pane: Clean vector DAG nodes with rounded corners, smooth animated SVG cubic Bézier curves pulsing with teal light.
  - Center divider: Vertical neon laser line that sweeps across the screen at 0:10.
- **Transition Out**: Cross-dissolve into 3D isometric plane (0.5s duration).

---

### Scene 2: Core Architecture: The Three Pillars of Rigor
- **Timecode**: `0:25 - 0:55` (30s)
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------+
  |  HEADER: SYSTEM ARCHITECTURE — THREE PILLARS OF DETERMINISTIC RIGOR     |
  +--------------------+---------------------+------------------------------+
  | PILLAR 1: PROBER   | PILLAR 2: TYPED RPC | PILLAR 3: PERSISTENCE        |
  | - Node 22 / Git    | - agent.ask<T>()    | - events.jsonl append log    |
  | - Toolchain check  | - Zod runtime check | - SQLite WAL Checkpoints     |
  | - Secret Redaction | - Auto-repair loop  | - Zero-token state replay    |
  +--------------------+---------------------+------------------------------+
  | LOWER THIRD: Zero Hallucinated Assumptions · Runtime Schema Invariants   |
  +-------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `0:25 - 0:35`: Camera centers on Pillar 1 (Prober). Terminal view expands showing real-time regex redaction of AWS keys (`AKIA...` -> `[REDACTED]`).
  - `0:35 - 0:45`: Smooth camera truck right to Pillar 2 (Typed RPC). Animated TypeScript schema window highlights incoming JSON, showing instant Zod parsing.
  - `0:45 - 0:55`: Camera trucks right to Pillar 3 (Dual-Layer Persistence). A split-view wireframe shows incoming events written to `events.jsonl` while SQLite WAL commits atomic state snapshots.
- **Visual Elements**:
  - Glowing isometric cubes representing architectural modules.
  - Animated data packets traveling through typed conduits.
  - Callout pills: `Deterministic Probe`, `Typed RPC`, `SQLite WAL`.
- **Transition Out**: Zoom-in through the SQLite database block into the live terminal environment (0.4s duration).

---

### Scene 3: Demo 1 in Action: Autonomous DevOps Incident Triage
- **Timecode**: `0:55 - 1:35` (40s)
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------+
  |  TOP BAR: DEMO 1 — AUTONOMOUS DEVOPS INCIDENT TRIAGE & REMEDIATION     |
  +------------------------------------+------------------------------------+
  | LEFT HALF: TERMINAL STREAM (50%)   | RIGHT HALF: LIVE TIMELINE DAG (50%)|
  | $ bash scripts/demo.sh (Act 2)     | Phase 1: Detection [Probe]         |
  | [00:00.0] Telemetry: 500 spike 38.5% | Phase 2: Triage [Inspector]      |
  | [00:00.0] Root Cause: DB pool leak | Phase 3: Plan [Fixer + Reviewer]   |
  | [00:01.2] Gate: deterministic check exit 0 | Phase 4: Gate [Shell Check] ⚡ |
  | [00:01.3] Post-Mortem synthesized  | Phase 5: Synthesis [Coordinator]   |
  +------------------------------------+------------------------------------+
  | BOTTOM: LIVE KANBAN DASHBOARD (5 columns: Ingested Alerts & Probes,     |
  | Triage & Root Cause Analysis, Synthesized Runbooks & Safety Audit,      |
  | Execution & Gate Logs, Final Deliverables)                              |
  +-------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `0:55 - 1:10`: Split view tracking terminal execution and Phase 1-2 node activations.
  - `1:10 - 1:22`: Zoom in on Phase 3: Paired Agents. Fixer card outputs proposed pool scaling; Reviewer card attaches safety signature.
  - `1:22 - 1:30`: Tight focus on Phase 4: Deterministic Shell Gate. Diamond node pulses purple, executes its offline mock healthcheck, and turns glowing emerald green on `exit 0`.
  - `1:30 - 1:35`: Camera tilts down to reveal the live Kanban board populating `PostMortem.md` and metrics.
- **Visual Elements**:
  - Node status badges: `pending` (⏳), `running` (amber pulsing ring), `completed` (green ✔ with duration e.g. `412ms`).
  - Bézier curves light up with animated energy pulses as step inputs pass to downstream nodes.
  - Real-time elapsed timer in the top-right corner (`0.0s -> ~2s`).
- **Transition Out**: Horizontal push wipe to the right (0.3s duration).

---

### Scene 4: Demo 2 in Action: AWS SDK v2->v3 Migration & Crash Resumption
- **Timecode**: `1:35 - 2:15` (40s)
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------+
  |  TOP BAR: DEMO 2 — MULTI-AGENT REPO MIGRATION & DURABLE CRASH REPLAY    |
  +-------------------------------------------------------------------------+
  | PHASE 1: Baseline Gate (Verified Clean Repo)                            |
  | PHASE 2: AST Scan (Discovered S3, DynamoDB, SQS v2 client imports)      |
  | PHASE 3: PARALLEL FAN-OUT WORKERS (Promise.all)                         |
  |   +--- Worker 1: S3 Transform -------> Reviewer 1: S3 Code Review       |
  |   +--- Worker 2: DynamoDB Transform --> Reviewer 2: Dynamo Review [CRASH]|
  |   +--- Worker 3: SQS Transform ------> Reviewer 3: SQS Code Review      |
  | [SIMULATED CRASH] -> /workflow replay -> RESUMED FROM SQLITE (0 TOKENS) |
  | PHASE 4: Compiler Gate (tsc exit 0) -> PHASE 5: PR Generated            |
  +-------------------------------------------------------------------------+
  | STATUS: 4 steps skipped from cache · 0ms latency · 0 tokens re-expended |
  +-------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `1:35 - 1:50`: Wide view showing the single graph splitting into three horizontal parallel tracks (S3, DynamoDB, SQS). Camera slowly dollies right following the parallel progress.
  - `1:50 - 1:56`: Dramatic zoom onto DynamoDB Reviewer card. Sudden screen flicker / glitch effect representing the simulated crash (`SIGINT`). Terminal displays red halt message.
  - `1:56 - 2:05`: Terminal types `/workflow replay <run-id>`. Camera zooms onto the timeline DAG as completed steps instantaneously illuminate in bright cyan with `[CACHED_REPLAY]` badges in 0 milliseconds.
  - `2:05 - 2:15`: Smooth pan across Phase 4 compiler gate to Phase 5: GitHub Pull Request badge (`PULL_REQUEST.md`).
- **Visual Elements**:
  - Multi-lane parallel swimlanes animating simultaneously.
  - Crash glitch overlay (CRT scanlines, red vignette).
  - Cyan replay aura on cached nodes with instant checkmarks.
- **Transition Out**: Iris zoom out into 3D directory tree (0.4s duration).

---

### Scene 5: Mandatory Kiro Integration & The Skeleton Crew
- **Timecode**: `2:15 - 2:45` (30s)
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------------+
  |  TOP BAR: MANDATORY KIRO INTEGRATION — ROOT /.kiro CONFIGURATION              |
  +-------------------------------------------------------------------------------+
  |  ROOT /.kiro/ (100% GIT TRACKED — NOT IN .gitignore)                          |
  |  ├── specs/    : Formal State Machine & Zod Schema Contracts                  |
  |  ├── hooks/    : lifecycle.json (SessionStart, PreToolUse, PostToolUse, Stop) |
  |  ├── steering/ : Always-on Security Guardrails & Exfiltration Bans            |
  |  ├── mcp/      : 10 Engine Tools (5 legacy + 5 facade script tools)           |
  |  ├── pbt/      : Fast-Check Property Tests (18 tests / 8-3,000 runs)          |
  |  └── crew/     : Skeleton Crew Roster & Principle of Least Privilege          |
  +-------------------------------------------------------------------------------+
  | LOWER OVERLAY: Terminal running `git status` + `npm run test:pbt` PASS        |
  +-------------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `2:15 - 2:25`: 3D isometric camera flies through the 6 directory branches of `/.kiro/`. Each folder illuminates as the narrator introduces its role.
  - `2:25 - 2:35`: Camera drops into the terminal running `npm run test:pbt`. Counter spins rapidly through the 18-test suite (8–3,000 randomized cases per property), flashing green: `✔ 18 tests, 0 fail`.
  - `2:35 - 2:45`: Camera pivots to `crew/permissions.json` showing least-privilege tool ceilings for the Skeleton Crew.
- **Visual Elements**:
  - High-res vector icons for Specs (📜), Hooks (🪝), Steering (🛡️), MCP (🔌), PBT (🧪), and Skeleton Crew (💀).
  - Terminal output highlighting `!/.kiro/` and `!/.kiro/**` in `.gitignore`.
- **Transition Out**: Seamless blend into hero sign-off title card (0.5s duration).

---

### Scene 6: Conclusion, Open-Source Release & Hackathon Sign-Off
- **Timecode**: `2:45 - 3:00` (15s)
- **Screen Layout / Wireframe**:
  ```
  +-------------------------------------------------------------------------+
  |                                                                         |
  |                      AI-WORKFLOW                                        |
  |               "Code, Not Conversation"                                  |
  |                                                                         |
  |  AWS Kiroween 2026 Hackathon Submission · Skeleton Crew Category       |
  |                                                                         |
  |  +-------------------------------------------------------------------+  |
  |  | Author: Litao Gong (龚立涛)     Devpost ID: 1842043669            |  |
  |  | Email: 1842043669@qq.com        License: Apache License 2.0       |  |
  |  | GitHub: https://github.com/LitaoG/AI-workflow-competition             |  |
  |  +-------------------------------------------------------------------+  |
  |                                                                         |
  |  [Node.js 22 LTS] [TypeScript 5] [Kiro Compliant] [Bilingual EN/ZH]     |
  +-------------------------------------------------------------------------+
  ```
- **Camera Focus & Motion**:
  - `2:45 - 2:56`: Static cinematic wide shot. Logo glows with subtle breathing pulse. Badges fade in sequentially.
  - `2:56 - 3:00`: Gradual cinematic fade to black, reaching 100% black at exactly `03:00.00`.
- **Visual Elements**:
  - Glowing 3D AI-Workflow brand mark.
  - Verification badges: Apache 2.0, AWS Kiroween 2026, Skeleton Crew, 100% Tests Passed.
  - Submitter metadata card.
- **Transition Out**: Fade to black at 3:00.00.
