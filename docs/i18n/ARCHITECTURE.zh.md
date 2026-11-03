# AI-Workflow 系统架构与技术深度设计

> **“代码即流程，而非对话猜测”：构建高韧性、强类型与确定性多智能体工作流**  
> *AWS Kiroween 2026 黑客松（Skeleton Crew 赛道）*

---

## 1. 核心设计哲学与架构概述

当今大多数智能体系统主要依赖于非结构化的“对话式多智能体循环”——即多个 LLM 智能体在一个无约束的聊天室内互相传递自然语言消息。虽然对话式智能体在开放式头脑风暴场景表现良好，但在处理软件工程任务（如生产故障排查、大规模代码重构、合规性审计）时，常常面临致命缺陷。

### 对话式循环的四大结构性缺陷
1. **上下文压缩与失忆（Context Compaction Amnesia）**：随着对话轮次增加，上下文窗口达到上限，触发有损总结。关键的技术参数（如数据库连接数阈值、Git Commit SHA、端口号）会被静默丢弃。
2. **流程幻觉与控制流失效（Hallucinated Control Flow）**：自然语言无法提供可靠的条件分支、循环与并发聚合原语。LLM 会产生“任务已完成”的幻觉、跳过安全校验门禁，或陷入死循环。
3. **脆弱的字符串传递（Fragile String Parsing）**：智能体之间传递无类型校验的 JSON 或 Markdown 文本，一旦模型改变字段名或忘记闭合括号，便会导致级联崩溃。
4. **非确定性恢复（Non-Deterministic Resumption）**：当 10 步流程中的第 9 步发生网络抖动时，整个对话必须从头重启，重新耗费数万 Token 且无法保证决策的一致性。

### ZCode 动态工作流范式：“代码即流程，而非对话猜测”
**AI-Workflow** 深度吸纳 **ZCode 动态工作流** 的工程设计精髓：
- **工作流即原生代码**：控制流、分支判断、循环迭代及并发调用（`Promise.all`）全部由编译型 TypeScript 驱动，并在执行前经过 Kahn 拓扑排序算法进行有向无环图（DAG）验证。
- **智能体即强类型 RPC 微服务**：调用智能体就如调用类型安全的远程服务：`agent(name).ask<T>(prompt, schema)`。
- **确定性环境探测**：在智能体推理前采集真实的系统底层、Git 状态与工具链指标，拒绝让模型凭空猜测。
- **双层持久化与零重算重放**：执行状态持久化至 SQLite（WAL 模式）与只追加的 `events.jsonl` 事件流，支持 `--resume-from-failed` 毫秒级断点续跑。
- **100% 还原 ZCode UI 视觉规范**：自动导出零外部依赖的单文件 HTML/SVG 动态时间轴，支持三次贝塞尔曲线连接、抽屉式节点检查与实时看板。

---

## 2. 多阶段 DAG 编译器与生命周期

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            工作流执行生命周期                               │
└─────────────────────────────────────────────────────────────────────────────┘
  1. 声明定义    ──►  2. 图校验与编译 ──►  3. 确定性探测  ──►  4. 执行与门禁校验 ──►  5. 持久化与重放
  (阶段与步骤)       (Kahn 拓扑排序)      (系统/Git/环境)      (强类型 RPC/脚本门禁)   (SQLite WAL/JSONL)
```

### 2.1 图结构形式化与拓扑排序
工作流被建模为有向无环图 $G = (V, E)$，其中节点 $V$ 表示离散执行步骤，有向边 $E = \{(u, v) \mid v \text{ 依赖于 } u\}$ 表示数据依赖或执行次序。

在步骤执行前，编译器运行 **Kahn 拓扑排序算法**：
1. 计算图中所有步骤 $v \in V$ 的入度 $\text{deg}^-(v)$。
2. 将所有入度为 0 的起始节点推入执行队列。
3. 依次弹出节点，递减其后继节点的入度。
4. 若遍历完毕后访问的节点数严格小于 $|V|$，编译器立即阻断执行并抛出 `CircularDependencyError`，精准指出循环依赖节点。
5. 若某步骤声明了不存在的依赖标识符，编译器抛出 `MissingDependencyError`。

### 2.2 阶段边界与步骤类型
工作流步骤被划分至按序执行的**阶段（Phase）**中：
- `probe`：安全、只读的主机与依赖遥测。
- `agent`：强类型 LLM 结构化推理与代码生成。
- `gate`：确定性跨平台 Shell 脚本验收门禁。
- `fanout`：在分片数据上基于 `Promise.all` 并发运行同构智能体。
- `action`：对文件系统、Git 或外部环境产生状态变更的操作。

---

## 3. 强类型智能体 RPC 通信层

强类型智能体 RPC 层将非结构化模型调用完全封装在运行时类型契约之后：

```typescript
export interface AgentRPCClient {
  readonly name: string;
  ask<T>(prompt: string, schema: z.ZodType<T>, options?: AgentCallOptions): Promise<T>;
}
```

### 3.1 执行流水线
当开发者调用 `agent(name).ask<T>(prompt, schema)` 时：
1. **系统提示词强制约束**：注入强制性系统级约束，要求模型仅输出与模式 $T$ 完全吻合的单一体 JSON 对象，严禁任何前导解释或 Markdown 寒暄。
2. **Provider 调度**：将载荷分发至注册的模型提供者（AWS Bedrock Claude 3.5 Sonnet、Claude 3.5 Haiku 或确定性离线 Mock Provider）。
3. **弹性 JSON 提取**：通过贪心括号扫描算法，即使输出包含在 ````json ... ```` 标记中或被前后杂质文本包裹，亦能精准抽取 JSON 字符串。
4. **启发式语法自愈**：若 `JSON.parse` 因尾随逗号、键名未加双引号等语法缺陷失败，执行 `repairJsonString()` 进行结构修复。
5. **运行时 Zod 校验**：执行 `schema.safeParse(parsedJson)`。
   - 校验成功：返回强类型数据对象 $T$。
   - 校验失败：自动进入**多轮模式自愈重试循环**。

### 3.2 多轮模式自愈重试循环
RPC 客户端不会直接崩溃抛错，而是将具体的 Zod 校验失败项（字段路径、期望类型、实际接收值）格式化为针对性的修复提示词：

```typescript
messages.push({ role: 'assistant', content: response.content });
messages.push({
  role: 'user',
  content: [
    'Your JSON response failed runtime schema validation with the following errors:',
    formatZodErrors(lastIssues),
    'Please correct these specific fields and return the updated JSON object.',
  ].join('\n'),
});
```

模型最多获得 `maxRetries`（默认 3 次）的自动纠错机会。若重试均告失败，抛出结构化 `SchemaValidationError`，完整保留原始输出与校验问题以供离线审计。

---

## 4. 确定性环境探测引擎

智能体绝不能基于虚假假设猜测外部状态。`Prober` 子系统在执行前捕获系统真实底线：

```typescript
export interface ProberResult {
  timestamp: string;
  system: SystemProbe;
  git: GitProbe;
  toolchain: ToolchainProbe;
  env: Record<string, string>;
}
```

### 探测维度与安全脱敏
1. **系统底层指标**：操作系统平台（`win32`, `linux`, `darwin`）、CPU 架构、核心数、物理内存总额与可用额度（MB）、系统运行时间。
2. **Git 仓库基线**：仓库有效性校验、当前分支、完整 Commit SHA、短 SHA、未提交文件数量及远程跟踪地址。
3. **工具链版本**：探测并记录本地 `node`, `npm`, `git`, `python`, `tsc`, `docker` 等执行文件的具体版本。
4. **环境变量脱敏与凭据清洗**：
   - 关键词匹配：清洗包含 `key`, `token`, `secret`, `password`, `auth`, `credential`, `private` 的键名。
   - 正则值匹配：识别 JWT Token (`ey...`)、AWS 访问密钥 (`AKIA[0-9A-Z]{16}`)、GitHub Token (`ghp_...`) 等高敏感字符模式。
   - URI 凭据清洗：将 `https://user:password@host` 转换为 `https://***:***@host`。
   - 统一脱敏为 `***REDACTED***`，严防凭据外泄至事件日志或模型上下文。

---

## 5. 双层持久化与零重算状态重放引擎

### 5.1 存储分层架构
AI-Workflow 采用事务快照库与顺序日志流并行的双层存储架构：

1. **事务性 SQLite 状态存储（基于 Node.js 22 内置 `node:sqlite`）**：
   - 启用 `PRAGMA journal_mode = WAL;` 与 `PRAGMA synchronous = NORMAL;`。
   - 维护 `runs`, `events`, `checkpoints`, `artifacts` 关系表。
   - 存储每个步骤的执行状态、输入输出载荷、执行耗时、消耗 Token 以及产物元数据。
2. **只追加事件日志流（`events.jsonl`）**：
   - 以换行符分割的高吞吐 JSON 流日志。
   - 实时记录每一个生命周期事件：`workflow_start`, `step_start`, `agent_rpc_request`, `agent_rpc_response`, `gate_eval`, `step_complete`, `workflow_complete`。
   - 即使发生系统崩溃或强行中止进程，日志亦不会损坏。

### 5.2 状态重放的数学定理
步骤 $k$ 的执行上下文状态是历史事件集合的确定性折叠：
$$\text{State}(k) = \text{Fold}(\text{Events}[0..k])$$

当使用 `--resume-from-failed <runId>` 执行断点续跑时：
1. `ReplayEngine` 检索该次运行在 SQLite 快照中的所有检查点。
2. 步骤被精准划分为两组：
   - 跳过步骤集：$\text{Steps}_{\text{skip}} = \{v \in V \mid \text{Checkpoint}(v).\text{status} = \text{'completed'} \land \text{Order}(v) < \text{Order}(\text{firstFailedStep})\}$
   - 执行步骤集：$\text{Steps}_{\text{exec}} = \{v \in V \mid v \notin \text{Steps}_{\text{skip}}\}$
3. 对于所有属于 $\text{Steps}_{\text{skip}}$ 的步骤，历史产出以 **0 毫秒**延迟直接载入上下文，**重算 Token 消耗严格为 0**。
4. 调度器仅从首个失败或未完成的步骤处唤醒执行。

---

## 6. ZCode SVG 贝塞尔时间轴可视化引擎

AI-Workflow 完全复刻了 ZCode 动态时间轴看板的视觉表现力：

### 6.1 三次贝塞尔曲线连接几何计算
依赖步骤间的连接线采用 SVG 三次贝塞尔曲线（Cubic Bézier Curve）平滑绘制：
$$C(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3, \quad t \in [0, 1]$$

几何锚点计算如下：
- 起点 $P_0 = (x_1, y_1)$：上游步骤卡片右侧中心锚点 $(x_{\text{src}} + w_{\text{src}}, y_{\text{src}} + h_{\text{src}} / 2)$。
- 终点 $P_3 = (x_2, y_2)$：下游步骤卡片左侧中心锚点 $(x_{\text{dst}}, y_{\text{dst}} + h_{\text{dst}} / 2)$。
- 水平控制偏移量：$\Delta x = \max(0.5 \cdot |x_2 - x_1|, 40)$。
- 控制点：$P_1 = (x_1 + \Delta x, y_1)$， $P_2 = (x_2 - \Delta x, y_2)$。

### 6.2 交互式画布与产物看板
- **平移与缩放**：原生 CSS 矩阵变换，支持鼠标拖拽平移与滚轮平滑缩放。
- **节点状态检查抽屉**：点击任何步骤节点即可滑出侧边栏，实时审视步骤输入参数、输出结构、耗时、执行角色及错误堆栈。
- **实时 Kanban 产物看板 (`artifacts/kanban.json`)**：复刻 ZCode 看板，追踪产物在 `Discovered`、`In-Progress`、`Verified`、`Committed` 四大生命周期阶段的状态。
- **多格式导出**：一键导出零外部依赖的单文件 HTML/SVG，Mermaid 流程图与终端 ASCII 字符树。

---

## 7. 模型上下文协议 (MCP) 架构整合

AI-Workflow 基于官方 `@modelcontextprotocol/sdk` 实现双向互联：

### 7.1 MCP 客户端集成
工作流可在步骤内随时调用外部 MCP 服务提供的标准工具：
```typescript
const result = await ctx.mcp?.callTool('aws-cloudwatch', 'query_metrics', {
  namespace: 'AWS/RDS',
  metric: 'DatabaseConnections',
});
```

### 7.2 内置 MCP 服务端 (`workflow mcp serve`)
引擎通过 stdio 对外提供 5 项标准 MCP 工具：
1. `workflow_run`：执行动态工作流并管理持久化状态。
2. `workflow_probe`：执行确定性环境指标与依赖探测。
3. `workflow_replay`：针对指定运行历史执行断点重放。
4. `workflow_render_dag`：将工作流图结构渲染为交互式 HTML/SVG。
5. `workflow_list_artifacts`：查询实时 Kanban 产物看板指标。