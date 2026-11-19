# AI-Workflow Kiro 深度集成与黑客松合规指南

> **AWS Kiroween 2026 黑客松（Skeleton Crew 赛道）官方集成指南**  
> *Git 追踪配置 · 形式化规格 · 生命周期钩子 · 转向指导规则 · MCP 协议 · PBT 不变量证明 · Skeleton Crew 花名册*

> **[历史存档]** 本篇为 2026-11-03 黑客松版本的中文原文存档，不再随主文档演进；现行权威内容以 `docs/KIRO_INTEGRATION.md` 为准（Issue #60 登记）。

---

## 1. 概述与赛道契合

**AWS Kiroween 2026** 设立了 **Skeleton Crew（骨架团队）** 赛道，专注于打造*“灵活、干净的结构化代码模板”*，旨在消除无序的提示词追逐，赋予多智能体系统工业级的工程确定性。

AI-Workflow 通过根目录的 `/.kiro/` 治理体系与 **Kiro** 进行原生融合，且该目录**完全受 Git 版本控制追踪**。我们拒绝将智能体当作不可控的自然语言聊天机器人，而是深度利用 Kiro 的形式化规格、生命周期钩子、带 Frontmatter 的转向指导规则以及基于属性的测试（PBT），确保工作流的确定性执行、安全合规与可复现性。

```
AI-workflow/
└── .kiro/                          # 需求 R3：根目录 Kiro 强制规范（GIT 完整追踪）
    ├── specs/                      # 形式化规格与 JSON Schema 模式
    │   ├── workflow-engine-spec.md
    │   ├── typed-rpc-schemas.json
    │   ├── state-replay-invariants.md
    │   └── ui-presentation-spec.md
    ├── hooks/                      # Kiro 生命周期钩子与确定性门禁脚本
    │   ├── lifecycle.json          # 按 trigger 绑定各 .js 门禁（Kiro 原生 schema）
    │   ├── pre-workflow-gate.js    # SessionStart — 确定性环境探测
    │   ├── pre-step-gate.js        # PreToolUse — 破坏性命令拦截（stdin JSON 协议）
    │   ├── post-step-audit.js      # PostToolUse — 产物哈希审计（journal 才是权威审计流）
    │   └── stop-workflow-gate.js   # Stop — 输出 Kiro stop 决策 JSON
    ├── steering/                   # Frontmatter 驱动的转向指导准则（inclusion: always）
    │   ├── guidelines.md
    │   ├── policy-guardrails.md
    │   ├── workflow-conventions.md
    │   └── bilingual-presentation.md
    ├── mcp/                        # MCP 模型上下文协议配置
    │   └── mcp-server.json
    ├── pbt/                        # 基于 fast-check 的基于属性测试套件
    │   └── engine-invariants.test.ts
    └── crew/                       # Skeleton Crew 团队花名册与最小权限配置
        ├── team.json
        └── permissions.json
```

---

## 2. 形式化规格子系统 (`/.kiro/specs/`)

`specs/` 目录定义了约束动态工作流引擎的形式化与机器可读规格：

### 2.1 `workflow-engine-spec.md`
定义 `/workflow` 斜杠命令的执行语义：
- **状态机模型**：
  $$\text{INITIALIZING} \longrightarrow \text{PROBING} \longrightarrow \text{SCHEDULED} \longrightarrow \text{EXECUTING\_STEP} \longleftrightarrow \text{VALIDATING\_GATE} \longrightarrow \text{COMPLETED} \ (\text{或 } \text{FAILED})$$
- **RPC 契约**：所有智能体交互必须遵守 `agent(name).ask<T>(prompt, schema)`，返回具有运行时强类型校验的 JSON 数据。
- **依赖图不变量**：工作流有向图 $G = (V, E)$ 必须在编译期通过 Kahn 算法证明为严格有向无环图（DAG）。

### 2.2 `typed-rpc-schemas.json`
提供标准智能体 RPC 请求、响应及结构化错误包（`WorkflowError`, `SchemaValidationError`, `GateFailureError`）的机器可读 JSON Schema。

### 2.3 `state-replay-invariants.md`
持久化状态重放的数学证明：
$$\forall k \in [0, N], \quad \text{State}(k) = \text{Fold}(\text{Events}[0..k])$$
形式化规定前缀缓存契约：从第 $m > k$ 步断点恢复时，前 $0..k$ 步的输出直接复用历史快照，**加载耗时为 0 毫秒，重算 Token 消耗严格为 0**。

### 2.4 `ui-presentation-spec.md`
对齐 ZCode 动态时间轴看板的视觉规范：
- 步骤间连接线的三次贝塞尔曲线公式：
  $$C(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3$$
- 角色拓扑角标视觉定义（`inspector`, `worker`, `reviewer`, `gate`, `coordinator`）。
- Kanban 产物看板状态规范（`Discovered`, `In-Progress`, `Verified`, `Committed`）。

---

## 3. Kiro 生命周期钩子子系统 (`/.kiro/hooks/`)

Kiro 原生支持 4 类生命周期事件，AI-Workflow 据此实现确定性门禁自动化：

| 钩子事件 | 在 AI-Workflow 中的职责 | 调用脚本 | 退出码语义与行为 |
|---|---|---|---|
| `SessionStart` | 确定性环境探测 | `pre-workflow-gate` | 采集系统、Git 与脱敏环境指标，注入上下文 |
| `PreToolUse` | 拦截高危或破坏性工具调用 | `pre-step-gate` | 读取 stdin JSON 协议（`tool_input.command`），拦截 `rm -rf`、磁盘格式化或泄露凭据（**退出码 2 执行阻断**） |
| `PostToolUse` | 产物审计 | `post-step-audit` | 每步对 `artifacts/` 文件做 SHA-256 哈希记录；不做事件序列校验——SQLite journal / `events.jsonl` 才是权威审计流 |
| `Stop` | 会话完成门 | `stop-workflow-gate` | 输出 Kiro stop 决策 JSON；自动化环境可用 `KIRO_STOP_BLOCK=true` 触发阻断 |

### `lifecycle.json` 官方配置
```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "deterministic-env-probe",
      "trigger": "SessionStart",
      "action": { "type": "command", "command": "node .kiro/hooks/pre-workflow-gate.js" }
    },
    {
      "name": "enforce-tool-gate",
      "trigger": "PreToolUse",
      "matcher": "execute_bash*",
      "action": { "type": "command", "command": "node .kiro/hooks/pre-step-gate.js" }
    },
    {
      "name": "durable-journal-audit",
      "trigger": "PostToolUse",
      "matcher": "*",
      "action": { "type": "command", "command": "node .kiro/hooks/post-step-audit.js" }
    },
    {
      "name": "workflow-completion-gate",
      "trigger": "Stop",
      "action": { "type": "command", "command": "node .kiro/hooks/stop-workflow-gate.js" }
    }
  ]
}
```

---

## 4. 转向指导规则子系统 (`/.kiro/steering/`)

指导文档通过 YAML Frontmatter 中的 `inclusion: always` 机制，成为 Kiro 智能体的常驻工程法则：

1. **`guidelines.md`**：工程哲学：坚持“代码即流程，而非对话猜测”，强制强类型 RPC 契约，杜绝无校验字符串流转。
2. **`policy-guardrails.md`**：安全红线：严禁执行破坏性 Shell 指令（如 `DROP DATABASE`, `rm -rf /`），自动脱敏 AWS 与 GitHub 访问凭据。
3. **`workflow-conventions.md`**：工作流规范：步骤执行器保持纯函数设计、确定性 Shell 门禁验收、Kahn 算法 DAG 无环校验。
4. **`bilingual-presentation.md`**：双语呈现规范：代码使用标准英文，CLI 输出、Web UI 与文档保持中英双语同步支持。

---

## 5. 模型上下文协议 (MCP) 集成 (`/.kiro/mcp/`)

AI-Workflow 通过 `mcp-server.json` 将引擎核心能力开放给 Kiro 宿主：

```json
{
  "mcpServers": {
    "ai-workflow-engine": {
      "command": "node",
      "args": ["dist/src/mcp/server.js"],
      "env": {
        "AI_WORKFLOW_ENV": "production"
      }
    }
  }
}
```

### 开放的 5 项核心 MCP 工具
1. `workflow_run`：执行动态工作流并管理持久化状态。
2. `workflow_probe`：执行确定性系统、Git 与工具链依赖探测。
3. `workflow_replay`：基于历史检查点执行断点续跑与历史重放。
4. `workflow_render_dag`：将工作流图编译为独立的交互式 HTML/SVG。
5. `workflow_list_artifacts`：实时查询 Kanban 产物看板指标。

---

## 6. 基于属性的测试 (PBT) 子系统 (`/.kiro/pbt/`)

使用 `fast-check` 工具库，PBT 测试套件对以下 5 大数学不变量进行每项 1,000 次随机用例的严格形式化证明：

```bash
npm run test:pbt
```

### 5 大形式化证明的不变量
1. **DAG 无环性与拓扑排序定理**：针对任意随机生成的有向图，Kahn 算法要么返回有效的拓扑执行顺序，要么精准抛出 `CircularDependencyError`。
2. **幂等状态重放定理**：重放前缀步骤产生的系统状态与原生执行严格等价，不产生二次副作用且重算 Token 消耗为 0。
3. **强类型 RPC 契约可靠性**：针对任意随机生成的 JSON 载荷，`agent.ask<T>` 仅返回符合模式 $T$ 的合法对象或类型化的 `SchemaValidationError`，绝不抛出非受检运行时崩溃。
4. **事件流日志单调递增性**：`events.jsonl` 中所有事件的序列号严格满足 $S_{i+1} > S_i$。
5. **凭据脱敏不变量**：任何注入 AWS 密钥 (`AKIA[0-9A-Z]{16}`) 或 JWT 的字符串，在持久化日志中均被强制脱敏为 `***REDACTED***`。

---

## 7. Skeleton Crew 团队花名册与权限治理 (`/.kiro/crew/`)

紧扣 **Skeleton Crew** 赛道主题，`crew/` 目录构建了角色化多智能体拓扑与最小特权能力上限：

### 7.1 智能体花名册 (`team.json`)
- **`Conductor（指挥官）`**：负责 DAG 图编译、阶段编排调度与事件流广播。
- **`Prober（探测员）`**：负责执行底层系统环境发现与敏感凭据脱敏。
- **`Worker（执行员）`**：负责领域代码重构、AST 解析与补丁生成。
- **`Reviewer（审查员）`**：对拟执行补丁进行安全性审计与架构合规校验。
- **`GateKeeper（守门员）`**：专门负责驱动并校验跨平台 Shell 验收脚本门禁。

### 7.2 最小特权权限上限 (`permissions.json`)
- `Prober`：仅拥有只读文件系统权限，严禁发起外部网络调用。
- `Worker`：拥有工作区受限写入权限，严禁调用未经审核的破坏性 Shell 指令。
- `Reviewer`：仅拥有拟变更补丁与 AST 树的只读审查权限。
- `GateKeeper`：Shell 命令执行权限被严格限制在 `gates/` 目录下的指定测试脚本。

---

## 8. Git 版本追踪合规性

根据需求 R3 的硬性指标，`/.kiro` **必须受 Git 完整版本追踪，绝不能被 gitignore 忽略**。根目录 `.gitignore` 明确声明如下规则：

```gitignore
# 严禁忽略 .kiro 目录！AWS Kiroween 2026 黑客松官方提交规范
!/.kiro/
!/.kiro/**

# 仅忽略临时会话锁文件与调试日志
/.kiro/**/*.lock
/.kiro/**/*.tmp
/.kiro/logs/
```

可随时通过以下命令验证 Git 追踪状态：
```bash
git status --porcelain .kiro/
```