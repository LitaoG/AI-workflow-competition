# 全自动云原生故障自愈与智能分诊引擎 (Demo 1)

> **AI-Workflow 核心旗舰示范应用**  
> *AWS Kiroween 2026 Hackathon (Skeleton Crew 赛道)*

---

## 🚀 概述

现代云原生微服务经常遭遇 P1/P2 级突发故障（如数据库连接池耗尽、新版本代码回归崩溃、内存泄漏 GC 停顿等）。传统运维流程中，值班工程师需要人工查询监控指标、翻阅海量日志、对比 Git 提交历史，并在极大的心理压力下查找 Runbook 执行修复。在高压状态下，人工误操作极易导致故障扩散（例如误删生产数据库）。

**AI-Workflow Demo 1** 是一个工业级全自动 DevOps 故障分诊与自愈引擎。其核心坚守 **"代码编排，拒绝随意漫谈" (Code, not conversation)** 哲学：
- 将多智能体系统从不可控的自然语言聊天循环中解放出来；
- 采用强类型 RPC 管道 (`ctx.agent(role).ask<T>(prompt, schema)`)；
- 在大模型推理前由确定性探测器收集基准指标；
- 引入方案策划与安全审查双智能体配对 (Planner + Safety Reviewer)；
- 通过真实的 Shell 脚本门禁节点验证恢复结果，验证失败立即执行回滚。

---

## 📊 架构拓扑与 ZCode UI 对齐

工作流严格分为 **5 个执行阶段**，并提供与 ZCode 动态工作流完全一致的可视化体验：

```
=====================================================================================================
 AI-Workflow: incident-triage-remediation (运行编号: run-1730419200)
 运行状态: 5 个阶段 · 3 个智能体并行执行中
=====================================================================================================

┌── 阶段 1: 异常检测与遥测探测 (Detection & Probing) ────────────────┐
│  └── [✔] ⚡ 门禁: 确定性指标与 Git Diff 采集门禁 (42ms)               │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── 阶段 2: 故障分诊与根因分析 (Triage & RCA) ───────────────────────┐
│  └── [✔] 🤖 巡检员: IncidentInspectorAgent (120ms)                  │
│          诊断结论: P1 级 数据库连接池耗尽 (置信度: 0.98)             │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── 阶段 3: 自愈策略生成与配对安全审查 (Plan & Safety Review) ──────┐
│  ├── [✔] 🤖 策划员: RemediationPlannerAgent (140ms)                │
│  │       处置策略: EXPAND_CONNECTION_POOL (生成 3 项运维动作)       │
│  └── [✔] 🛡️ 审查员: SafetyReviewerAgent (95ms)                     │
│          审查结论: 审查通过 (安全评分: 0.98, 高危指令检出: 0)       │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── 阶段 4: 修复执行与恢复验证门禁 (Execution & Health Gate) ────────┐
│  └── [✔] ⚡ 门禁: 确定性 Shell /healthz 探测恢复门禁 (35ms)         │
│          验证结果: HTTP/1.1 200 OK, 500 错误率恢复至 0.02%          │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌── 阶段 5: 复盘报告合成与交付看板导出 (Post-Mortem & Kanban) ───────┐
│  └── [✔] 📦 协调员: PostMortemSynthesizer (110ms)                  │
│          交付物: artifacts/PostMortem.md 与 artifacts/kanban.json   │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🧪 真实生产故障场景集

Demo 1 在 `scenarios/` 目录下内置了 3 组工业级真实故障场景定义：

| 场景编号 | 严重度 | 故障根因 | 模拟故障指标 | 自动修复方案 |
| :--- | :---: | :--- | :--- | :--- |
| `p1_db_pool_exhaustion` | **P1** | 数据库连接池耗尽 | 100/100 满载，HTTP 500 错误率突增至 38.5% | `EXPAND_CONNECTION_POOL` (扩容连接池至 250 并滚动重启) |
| `p1_bad_deploy_regression`| **P1** | 代码发布空指针崩溃 | v2.4.12 发布后 /checkout 错误率达 65.4% | `GIT_ROLLBACK` (回滚 Kubernetes 镜像并 Revert 故障提交) |
| `p2_high_latency_leak` | **P2** | 本地查询缓存内存泄漏 | 堆内存占用 96.8%，GC 停顿 3.2s，P99 达 4.2s | `RESTART_PODS` & 副本扩容至 12 |

---

## ⚡ 快速开始

### 0. 运行 Facade 脚本版（推荐）
```bash
# 运行完整的 5 阶段故障排查工作流，带确定性日志与零令牌重放 (<2s)
node bin/workflow.js run-script apps/incident-triage-remediation/facade.workflow.ts \
  --cwd apps/incident-triage-remediation --args '{"scenario":"p1_db_pool_exhaustion"}'

# 零成本重放已完成运行：
node bin/workflow.js run-script apps/incident-triage-remediation/facade.workflow.ts \
  --cwd apps/incident-triage-remediation --args '{"scenario":"p1_db_pool_exhaustion"}' --resume <runId>
```

### 1. 在离线模拟模式下运行默认场景 (<2秒极速执行)
```bash
node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock
```

### 2. 指定不同场景运行
```bash
# Windows PowerShell
$env:SCENARIO="p1_bad_deploy_regression"; node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock

# Linux / macOS
SCENARIO=p1_bad_deploy_regression node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock
```

### 3. 启用中文多语言界面 (`--lang zh`)
```bash
node bin/workflow.js run apps/incident-triage-remediation/workflow.ts --mock --lang zh
```

### 4. 运行全量自动化集成测试 (<4秒)
```bash
node --experimental-strip-types tests/integration/demo-incident.test.ts
```

---

## 📦 生成交付物

每次运行都会在 `artifacts/`（及 `.workflow/runs/<runId>/`）生成完整的审计交付物：
1. **`artifacts/incident_dag.html`**: 独立零依赖的 SVG 三次贝塞尔曲线时间线 DAG，支持平移缩放、节点点击抽屉审查。
2. **`artifacts/kanban.json`**: 对齐 ZCode "夜班清扫看板" 的 5 列实时交付物看板数据。
3. **`artifacts/PostMortem.md`**: 符合 SRE 标准的事故复盘报告，含故障时间线、5-Whys 根因分析、修复指标对比及后续改进清单。
4. **`checkpoints.db`**: SQLite 快照数据库，记录每个步骤的持久化状态。
5. **`events.jsonl`**: 只追加日志文件，记录全生命周期事件。

---

## 🛡️ Kiro 安全护栏与合规保障

- **双智能体配对审计**: 策划智能体生成的运维指令必须通过安全审查智能体核验。
- **确定性正则黑名单**: 针对 `DROP`、`TRUNCATE`、`rm -rf` 等破坏性指令，代码级门禁直接抛出 `GateFailureError` 中断执行。
- **自动回滚闭环**: 若阶段 4 健康检查失败，系统立即自动执行预制的 `rollbackCommand`。

> 上述两条守卫在 facade 脚本版（`facade.workflow.ts`，即 `scripts/demo.sh` 与 `workflow demo`
> 实跑的版本）中同等生效：安全评审通过后，以纯代码按确定性黑名单（`DROP`、`TRUNCATE`、
> `rm -rf`、`mkfs`、`format C:`、`DELETE FROM`）复筛模型产出的每条命令（计划步骤与推荐动作），
> 命中即在任何执行前中断，且内置拦截自检（参考 `DROP TABLE` 样本每次运行必被拦截 ✔）；
> 修复动作以可逆的 apply/undo 落地——每次运行都有回滚演练（验证探针失败 → 自动 undo →
> 先前状态恢复 ✔），阶段 4 验证门真实失败时同样先自动回滚、随后运行才失败。
