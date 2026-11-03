## 2026-11-01T02:24:16Z
sender=7ee7fb2a-aab3-4205-815e-8f9c7f740947 priority=MESSAGE_PRIORITY_HIGH
content=You are teamwork_spec_miner.
Your working directory is: .agents\teamwork\spec_miner_survey_1

MANDATORY: Read the original request at:
.agents\teamwork\ORIGINAL_REQUEST.md

Task Objective:
Investigate the reference project at: `%USERPROFILE%\Desktop\Top Gainers List Model`
Examine its formal development workflow and multi-agent governance architecture. In particular:
1. Examine the root agent-conduct guide, `docs/WORKFLOW.md`, `docs/`, `.agents/`, and any process guides or checklists.
2. Extract the complete lifecycle and rules:
   - Documentation consultation first (查阅文档优先)
   - Discipline and anti-pitfall rules (明确纪律与防踩坑)
   - Task initiation and scoping (任务立项)
   - Branch / Git worktree isolation rules (分支/worktree 隔离规范)
   - Local test & verification gates (本机测试与门禁验证)
   - Code review, auditing, and merging (审查合入规范)
3. Distinguish clearly between:
   - Universal multi-agent development workflow mechanisms (to be adapted into AI-workflow)
   - Domain-specific logic (e.g. stock/crypto/trading algorithms, financial APIs) which MUST NOT be copied into AI-workflow.
4. Provide structured recommendations for adapting this workflow framework into `AI-workflow`.

Deliverables:
- Write your complete findings and analysis to: `.agents\teamwork\spec_miner_survey_1\handoff.md`
- Maintain your heartbeat in: `.agents\teamwork\spec_miner_survey_1\progress.md`
- When finished, send a message to caller (the orchestrator) with a summary and the path to your handoff file.
