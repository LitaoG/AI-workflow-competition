# 多智能体代码库全自动迁移与架构升级引擎 (Demo 2)

> **AI-Workflow 核心旗舰示范应用**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew 赛道)*

---

## 🚀 概述

在大中型企业代码库中升级底层核心库（例如将单体 AWS SDK v2 升级到模块化 AWS SDK v3、Express 迁移至 Hono、CommonJS 转为 ESM）是业界公认的高成本、高风险工程任务。传统对话式 AI 在此类任务中往往失败：
1. **上下文溢出与遗忘**: 面对几十个文件的代码库，漫谈式上下文快速耗尽；
2. **进程崩溃与 Token 浪费**: 迁移到第 8 个文件时若遭遇限流或网络中断，全盘进度丢失，不得不从头重新消耗 Token；
3. **缺乏确定性编译器校验**: 聊天智能体经常“声称代码已修改无误”，但实际运行或类型检查时报错频出。

**AI-Workflow Demo 2** 坚守 **"代码编排，拒绝随意漫谈" (Code, not conversation)** 哲学：
- **可恢复持久化与零 Token 断点续跑**: 每个文件的转换结果即时写入 `.workflow/journal.jsonl` 与 SQLite 快照。遭遇中断后通过 `--resume-from-failed` 恢复，已完成文件 0 毫秒跳过，0 Token 额外开销！
- **并行扇出工作者与配对审查员**: 通过 `Promise.all` 并发迁移 S3、DynamoDB、SQS 等子服务，且每个文件均有独立的配对代码审查智能体进行安全核验。
- **真实确定性 Shell 编译器门禁**: 严密执行 `tsc --noEmit` 和 `npm test` 真实测试门禁，确保合入代码 100% 编译通过。
- **ZCode 动态工作流 UI 对齐**: 导出原生平滑贝塞尔曲线时间线 DAG 与 5 列实时交付物看板。

---

## 📊 架构拓扑与 ZCode UI 对齐

```
===================================================================================================================
 [AI-WORKFLOW] 5 个阶段 · 4 个智能体活跃中 | 阶段 3: 并行扇出多智能体代码迁移与成对代码审查 ⏳
===================================================================================================================

阶段 1: 基线测试门禁          阶段 2: 架构扫描规划         阶段 3: 并行扇出工作流与成对代码审查
┌───────────────────────┐    ┌─────────────────────┐      ┌─────────────────────────┐    ┌────────────────────────┐
│ [✔] step-1-baseline   │───►│ [✔] step-2-architect│──┬──►│ [✔] step-3a-worker-s3   │───►│ [✔] step-3a-review-s3  │──┐
│     (基线测试 npm test)│    │ (AST 扫描与 MCP 规则)│  │   │     (S3Client v3 补丁)  │    │ (安全审查通过: 0.98)   │  │
└───────────────────────┘    └─────────────────────┘  │   └─────────────────────────┘    └────────────────────────┘  │
                                                      │   ┌─────────────────────────┐    ┌────────────────────────┐  │
                                                      ├──►│ [✔] step-3b-worker-ddb  │───►│ [✔] step-3b-review-ddb │──┼──┐
                                                      │   │     (LibDynamoDB 补丁)  │    │ (安全审查通过: 0.96)   │  │  │
                                                      │   └─────────────────────────┘    └────────────────────────┘  │  │
                                                      │   ┌─────────────────────────┐    ┌────────────────────────┐  │  │
                                                      └──►│ [✔] step-3c-worker-sqs  │───►│ [✔] step-3c-review-sqs │──┘  │
                                                          │     (SQSClient v3 补丁) │    │ (安全审查通过: 0.97)   │     │
                                                          └─────────────────────────┘    └────────────────────────┘     │
                                                                                                                        │
阶段 4: 编译器合入门禁                                    阶段 5: PR 交付物生成                                        │
┌──────────────────────────────────────────────────┐      ┌────────────────────────────────────────────────────────┐   │
│ [✔] step-4-post-merge-gate                       │◄─────┴────────────────────────────────────────────────────────┘   │
│     (tsc --noEmit && npm test 全量校验)          │                                                                   │
└──────────────────────────────────────────────────┘                                                                   │
                         │                                                                                             │
                         ▼                                                                                             │
┌──────────────────────────────────────────────────┐                                                                   │
│ [✔] step-5-summary                               │◄──────────────────────────────────────────────────────────────────┘
│     (生成 PULL_REQUEST.md 与 kanban.json)        │
└──────────────────────────────────────────────────┘
```

---

## ⚡ 快速开始指南

### 0. 运行 Facade 脚本版（推荐）
```bash
# 运行完整的 5 阶段迁移工作流，带确定性日志与零令牌重放 (<4秒)
node bin/workflow.js run-script apps/repo-migration-engine/facade.workflow.ts --cwd apps/repo-migration-engine

# 零成本重放已完成运行：
node bin/workflow.js run-script apps/repo-migration-engine/facade.workflow.ts --cwd apps/repo-migration-engine --resume <runId>
```

### 1. 在离线模拟模式下极速运行全量迁移 (<4秒)
```bash
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock
```

### 2. 启用全中文多语言界面 (`--lang zh`)
```bash
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --lang zh
```

### 3. 实操：零 Token 故障断点续跑验证
```bash
# 步骤 1: 模拟在迁移第 2 个文件后遭遇网络中断/系统异常
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --interrupt-at 2 --output-dir .workflow/runs/run-demo-resume

# 步骤 2: 使用 --resume-from-failed 恢复执行
# 引擎自动读取 checkpoints.db，文件 1 和文件 2 命中缓存（0 毫秒跳过，0 Token 消耗），
# 仅执行文件 3 及后续阶段 4 门禁与阶段 5 PR 生成，极速完成！
node bin/workflow.js run apps/repo-migration-engine/workflow.ts --mock --resume-from-failed run-demo-resume
```

### 4. 毫秒级历史执行重放 (<1秒)
```bash
node bin/workflow.js replay run-demo-resume
```

### 5. 执行全套自动化集成测试 (<4秒)
```bash
node --experimental-strip-types tests/integration/demo-migration.test.ts
```

---

## 📦 生成交付物

每次运行都会在 `artifacts/`（及 `.workflow/runs/<runId>/`）生成完整的审计交付物：
1. **`artifacts/PULL_REQUEST.md`**: 符合生产级标准的 GitHub PR 描述，包含模块映射对比表、差异统计与回滚指南。
2. **`artifacts/migration_dag.html`**: 独立 SVG 平滑贝塞尔曲线时间线 DAG，支持缩放、平移与节点点击抽屉审查。
3. **`artifacts/kanban.json`**: 5 列实时交付物看板数据，全面覆盖扫描、规划、补丁、门禁与交付物。
4. **`checkpoints.db` 与 `events.jsonl`**: 支持零 Token 断点续跑的只追加事件日志与快照数据库。
