# 测试基础设施：AI-Workflow 测试体系

## 测试哲学
- 黑盒（Opaque-box）、需求驱动：不依赖任何内部实现设计。
- 方法论：类别划分（Category-Partition）+ 边界值分析 + 成对组合（Pairwise）+ 真实负载测试。

## 分层目录结构与验证命令

测试代码位于 `tests/`，PBT 套件位于 `tests/pbt/`。各层与 `package.json` scripts 的对应关系：

| 层 | 目录 | 运行命令 |
|---|---|---|
| 单元测试 | `tests/unit/`（agent / cli / context / core / dwf / execution / state / visualizer 等子目录；保持纯隔离语义，禁止 async 子进程树——Issue #198） | `npm.cmd run test:unit` |
| 集成测试（预算、failover、replay、MCP 等花钱与恢复路径；runner 级真实子进程树/进程守护用例） | `tests/integration/`（串行 `--test-concurrency=1`） | `npm.cmd run test:integration` |
| 基于属性的测试（PBT） | `tests/pbt/` | `npm.cmd run test:pbt` |
| E2E 场景测试 | `tests/e2e/`（`runner.ts` + `helpers/` + tier1～tier4 四层） | `npm.cmd run test:e2e`（即 `node --experimental-strip-types tests/e2e/runner.ts`） |
| 对抗性测试 | `tests/adversarial/` | `npm.cmd run test:adversarial` |
| 跨引擎回归 | `tests/cross-engine/` | 纳入全量门禁执行 |
| 治理规则锁死测试 | `tests/unit/workflow-governance.test.ts` | `npm.cmd run test:governance` |
| 覆盖率统计 | c8，行覆盖率阈值 84%（`package.json` 的 `c8` 配置） | `npm.cmd run coverage` |
| 全量门禁 | build + 上述各层串联 | `npm.cmd run gate` |

## E2E 特性清单与测试映射（F1–F9）

整个 E2E 套件通过独立主运行器执行：`node --experimental-strip-types tests/e2e/runner.ts`，
也可按层单独运行（`--test tests/e2e/tier1-features/*.test.ts` 等）。100% 自包含运行于离线 mock 模式（`--mock`），零外部网络调用、零 LLM API Key。

| # | 特性 | 范围 / 来源 | Tier 1 | Tier 2 | Tier 3 组合 | Tier 4 场景 |
|---|---------|---------------|:------:|:------:|:---------------:|:----------------:|
| **F1** | 强类型 Agent RPC（`agent.ask<T>`） | 核心架构 | ✓ | ✓ | P1, P2, P3, P4 | S1, S2, S3, S6 |
| **F2** | 确定性探测（`prober`） | 核心架构 | ✓ | ✓ | P1, P5, P6 | S1, S2 |
| **F3** | 持久化状态与重放（`state`） | 核心架构 | ✓ | ✓ | P2, P5, P7, P11, P14 | S1, S2, S3 |
| **F4** | 动态时间轴 DAG 可视化（`dag`） | 可视化架构 | ✓ | ✓ | P3, P8, P12 | S1, S2, S4 |
| **F5** | MCP 工具集成（`mcp`） | 核心架构 | ✓ | ✓ | P4, P9, P13 | S2 |
| **F6** | 斜杠命令 CLI（`/workflow`） | 核心需求 | ✓ | ✓ | P6, P7, P8, P9, P10, P15 | S1, S2, S3, S4, S6 |
| **F7** | 脚手架模板（`init`） | 脚手架场景 | ✓ | ✓ | P10 | S4 |
| **F8** | 示例 1：事故分诊与修复 | 示例应用 | ✓ | ✓（替身） | P11, P12 | S1, S6 |
| **F9** | 示例 2：仓库迁移引擎 | 示例应用 | ✓ | ✓（替身） | P13, P14 | S2, S6 |

> 注（Issue #120）：F8/F9 的 E2E 覆盖跑的是 `tests/e2e/helpers/fixtures.ts` 内的结构化**替身**剧本（与真身同名的 5 步简化版，`SAMPLE_DEMO1_INCIDENT_WORKFLOW` / `SAMPLE_DEMO2_MIGRATION_WORKFLOW`）；apps 真身由集成层（`demo-incident.test.ts` / `demo-migration.test.ts`）与对抗层（`demo1-dag-stress.js` 等）直接运行覆盖，替身与真身的步骤面并不逐字相同。

## E2E 分层结构

| 层 | 名称 | 覆盖对象 | 目录 |
| :---: | :--- | :--- | :--- |
| **Tier 1** | 特性覆盖 | 每项引擎特性一组功能用例 | `tests/e2e/tier1-features/` |
| **Tier 2** | 边界与角落用例 | 每项引擎特性一组边界用例 | `tests/e2e/tier2-boundaries/` |
| **Tier 3** | 跨特性组合 | 特性两两组合（pairwise） | `tests/e2e/tier3-combinations/` |
| **Tier 4** | 真实应用场景 | 端到端工作负载 | `tests/e2e/tier4-scenarios/` |

`tests/e2e/` 目录骨架：

```
tests/e2e/
├── runner.ts                     # 主测试运行器，输出汇总报告
├── helpers/                      # cli / env / fixtures / mock-engine / assertions
├── tier1-features/               # F1–F9 每项一个套件（t1-01 … t1-09）
├── tier2-boundaries/             # F1–F9 每项一个边界套件（t2-01 … t2-09）
├── tier3-combinations/           # t3-pairwise.test.ts
└── tier4-scenarios/              # t4-01 … t4-04、t4-06（对应 S1–S4、S6）
```

## 真实应用场景（Tier 4）

| # | 场景 | 覆盖特性 | 可观察产物 / 行为 |
|---|---------------|--------------------|----------------------------|
| **S1** | 完整 DevOps 事故分诊与自动恢复（含 Shell 门禁校验） | F1, F2, F3, F4, F6, F8 | `events.jsonl`、`checkpoints.db`、`dag.html` |
| **S2** | 多智能体 AWS SDK v2→v3 代码库迁移（AST 探测 + MCP 工具） | F1, F2, F3, F4, F5, F6, F9 | `events.jsonl`、`checkpoints.db`、`dag.html` |
| **S3** | 模拟工作流中途崩溃，经 `--resume-from-failed` 零 Token 恢复 | F1, F3, F6 | 先提交初始失败，再续跑完成步骤 1-3 |
| **S4** | 绿地脚手架初始化、自定义工作流创建与 DAG 可视化 | F4, F6, F7 | 生成脚手架项目并完成工作流运行，产出 `workflow-dag.html` |
| **S6** | 离线快速评估：全量示例工作流 4 秒内跑完且零 API Key | F1, F6, F8, F9 | 两个示例工作流均在无外部 API Key 条件下完成 |

## 测试架构与通过语义
- **E2E 主运行器**：`node --experimental-strip-types tests/e2e/runner.ts`（输出分层汇总报告）；
  治理规则锁死测试单独作为门禁运行：`node --experimental-strip-types tests/unit/workflow-governance.test.ts`。
- **通过/失败语义**：全部断言通过、退出码 0。
- **治理核验命令**（治理纪律自身的验证手段）：
  - `git worktree list` → 可见 worktree 路径与对应特性分支（`<type>/issue-<num>-<slug>` 命名规范）；
  - worktree 内 `git status --porcelain` → 工作区干净。

> 防腐规则：本文件不硬编码任何一次运行的实际用例数、通过率与耗时；
> 当前真实数字一律以最新一次全量运行的输出为准（执行上文分层表中的验证命令即可获取）。
