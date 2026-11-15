# AI-Workflow 开发者实用指南

> **强类型、确定性与高韧性动态工作流编写实操手册**  
> *AWS Kiroween 2026 黑客松（Skeleton Crew 赛道）*

> **[历史存档]** 本篇为 2026-11-03 黑客松版本的中文原文存档，不再随主文档演进；现行权威内容以 `docs/DEVELOPER_GUIDE.md` 为准（Issue #60 登记）。

---

## 1. 简介

欢迎查阅 **AI-Workflow 开发者实用指南**。本手册旨在帮助开发者快速掌握如何使用 AI-Workflow 的可扩展 TypeScript 动态工作流引擎构建工业级多智能体自动化流程。

阅读本手册后，您将能够：
- 使用声明式依赖语法定义多阶段动态工作流。
- 基于 Zod 运行时强类型模式与自愈修复循环调用强类型智能体 RPC。
- 使用确定性环境探测器（Prober）采集真实系统与代码仓库状态。
- 使用跨平台 Shell 脚本门禁拦截并校验智能体输出。
- 使用内置脚手架快速初始化新项目，并在离线 Mock 模式下进行毫秒级端到端测试。

---

## 2. 快速脚手架：创建第一个工作流工程

使用 `workflow init` 命令可以一键生成初始化模板：

```bash
# 生成基础工作流模板
node bin/workflow.js init basic my-first-workflow

# 或生成包含结对审查与脚本门禁的高级多智能体模板
node bin/workflow.js init multi-agent my-agent-pipeline

cd my-agent-pipeline
npm install
npm test
```

### 脚手架项目目录结构
```
my-agent-pipeline/
├── package.json
├── tsconfig.json
├── README.md
├── workflow.ts             # 核心工作流定义文件
└── gates/
    ├── test-gate.cmd       # Windows 确定性脚本门禁
    └── test-gate.sh        # Linux / macOS 确定性脚本门禁
```

---

## 3. 编写动态工作流

开发者可以使用声明式 `defineWorkflow` 辅助函数或面向对象的 `new Workflow()` 类 API 编排流程。

### 3.1 声明式工作流编写示例 (`defineWorkflow`)
以下展示了一个包含确定性探测、强类型智能体 RPC 和跨平台测试门禁的完整生产级工作流：

```typescript
import { z } from 'zod';
import { defineWorkflow } from 'ai-workflow';

// 1. 定义 Zod 运行时强类型校验模式
const CodeAuditSchema = z.object({
  issuesFound: z.number(),
  vulnerabilities: z.array(z.string()),
  recommendedAction: z.enum(['APPROVE', 'REFACTOR', 'BLOCK']),
  patchContent: z.string().optional(),
});
type CodeAudit = z.infer<typeof CodeAuditSchema>;

// 2. 声明工作流
export default defineWorkflow({
  name: 'security-audit-and-patch',
  description: '探测代码仓库、执行强类型安全审计并通过脚本门禁验证修复补丁',
  phases: [
    { id: 'discovery', name: '环境探测与基线发现' },
    { id: 'audit', name: '多智能体代码安全审计' },
    { id: 'verification', name: '编译器与单元测试验收门禁' },
  ],
  steps: [
    // 步骤一：确定性环境探测
    {
      id: 'step-1-probe',
      name: '探测仓库与 Git 状态',
      phaseId: 'discovery',
      role: 'inspector',
      execute: async (ctx) => {
        const probeResult = await ctx.probe();
        ctx.set('gitCommit', probeResult.git.commitShort);
        return { isDirty: probeResult.git.isDirty, branch: probeResult.git.branch };
      },
    },

    // 步骤二：强类型智能体 RPC 调用
    {
      id: 'step-2-auditor',
      name: '安全审计智能体',
      phaseId: 'audit',
      role: 'worker',
      dependsOn: ['step-1-probe'],
      execute: async (ctx) => {
        const branch = ctx.get('branch', 'main');
        
        // 强类型 RPC 调用，内置自愈修复重试循环
        const audit = await ctx.agent('SecurityAuditor').ask<CodeAudit>(
          `针对分支 "${branch}" 的代码库进行安全审计，排查潜在 CVE 或 SQL 注入漏洞。`,
          CodeAuditSchema,
          {
            temperature: 0.1,
            maxRetries: 3,
            mockResponse: {
              issuesFound: 1,
              vulnerabilities: ['CWE-89: 认证路由存在拼接 SQL 风险'],
              recommendedAction: 'REFACTOR',
              patchContent: 'const query = db.prepare("SELECT * FROM users WHERE id = ?");',
            },
          }
        );

        ctx.set('auditResult', audit);
        return audit;
      },
    },

    // 步骤三：确定性 Shell 脚本验收门禁
    {
      id: 'step-3-gate',
      name: '编译与测试验收门禁',
      phaseId: 'verification',
      role: 'gate',
      dependsOn: ['step-2-auditor'],
      execute: async (ctx) => {
        const audit = ctx.get<CodeAudit>('auditResult');
        if (audit.recommendedAction === 'BLOCK') {
          throw new Error('审计未通过：发现阻断性高危漏洞。');
        }

        // 调用本地真实测试门禁
        const gateResult = await ctx.gate('npm test');
        if (!gateResult.passed) {
          throw new Error(`门禁校验未通过，退出码 ${gateResult.exitCode}：${gateResult.stderr}`);
        }

        await ctx.recordArtifact(
          'AUDIT_REPORT.md',
          `# 安全审计复盘报告\n决策建议: ${audit.recommendedAction}\n问题数: ${audit.issuesFound}`
        );

        return { verified: true, durationMs: gateResult.durationMs };
      },
    },
  ],
});
```

---

## 4. 强类型智能体 RPC 最佳实践

### 4.1 严密的 Zod 模式设计
始终使用限制性字段定义模式：
```typescript
const TriageSchema = z.object({
  severity: z.enum(['P1', 'P2', 'P3', 'P4']),
  rootCause: z.string().min(5),
  confidenceScore: z.number().min(0).max(1),
  affectedServices: z.array(z.string()).nonempty(),
  recommendedAction: z.string(),
});
```

### 4.2 自愈修复与确定性 Mock
当模型返回格式破损的 JSON 时，框架会自动将 Zod 报错错误栈以对话形式回传模型让其修正，最大重试次数为 `maxRetries`。在单测环境中，可直接注入 `mockResponse` 实现离线即时测试：
```typescript
const result = await ctx.agent('TriageAgent').ask(prompt, TriageSchema, {
  mockResponse: ctx.isMock ? defaultMockTriage : undefined,
  maxRetries: 3,
});
```

---

## 5. 编写确定性脚本门禁 (Deterministic Gates)

门禁是穿插在概率性 AI 步骤之间的绝对物理定律。

### 5.1 进程退出码语义
- **退出码 `0`**：门禁通过，下游后继步骤获准继续执行。
- **非零退出码**：门禁失败，当前步骤抛出 `GateFailureError`，工作流暂停或自动回滚。

### 5.2 编写跨平台门禁脚本
建议在 `gates/` 目录下放置针对不同操作系统的脚本文件：
- Windows: `gates/verify-build.cmd`
- Linux / macOS: `gates/verify-build.sh`

```batch
@echo off
REM gates/verify-build.cmd
echo [GATE] 正在执行类型检查与基线单元测试...
call npx tsc --noEmit
if %errorlevel% neq 0 (
  echo [GATE-ERROR] TypeScript 编译失败！
  exit /b 1
)
call npm test
if %errorlevel% neq 0 (
  echo [GATE-ERROR] 单元测试未全部通过！
  exit /b 1
)
echo [GATE-SUCCESS] 所有确定性门禁检查通过。
exit /b 0
```

---

## 6. 持久化存储与零 Token 重放实操

每个步骤的输入与输出会自动写入 SQLite (`checkpoints.db`) 与事件流 (`events.jsonl`)。

### 6.1 从中断步骤断点续跑
若工作流在第 4 步因网络原因中断，修复外部问题后无需重新执行第 1-3 步：
```bash
node bin/workflow.js run workflow.ts --resume-from-failed <runId>
```
引擎将在 **0 毫秒** 内将已完成步骤的缓存注入上下文，**模型重算 Token 消耗为 0**，仅从失败步骤处继续执行。

---

## 7. 自动化单元与集成测试

推荐使用 Node.js 22 内置测试套件编写确定性测试用例：

```typescript
// tests/my-workflow.test.ts
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import myWorkflow from '../workflow.js';

test('工作流在离线 Mock 模式下顺利端到端跑通', async () => {
  const result = await myWorkflow.run({
    mockMode: true,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.failedSteps.length, 0);
  assert.ok(result.durationMs < 2000, '离线执行耗时应严格小于 2 秒');
});
```

执行测试命令：
```bash
node --experimental-strip-types --test tests/my-workflow.test.ts
```