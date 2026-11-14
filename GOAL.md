# AI-Workflow 演进蓝图与技术路线

> **文档属性**：引擎演进蓝图与技术路线（现状收敛版，2026-11-09）
> **定位**：回答「引擎从哪里来、现在长什么样、接下来往哪走」；架构细节以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为权威，测试体系以 [TEST_INFRA.md](TEST_INFRA.md) 为权威。
> **历史说明**：本文原为项目立项时的 Codex 重构任务书，其八阶段路线（阶段 0–8）已全部落地交付，原文可查本文件在 2026-11-09 之前的 git 历史；现收敛为现状蓝图。
> **锚点纪律**：本文 §1 愿景条目与 §6 工程铁律的编号被源码注释（如 `src/process-supervision.ts`）与审计文档引用，调整编号或语义前必须全仓检索确认。

---

## 1. 核心使命与架构哲学（North Star Philosophy）

主流多智能体框架把执行逻辑交给自然语言提示词驱动，存在四类致命缺陷：

* **控制流幻觉与发散**：分支、循环由模型即兴决定，同一任务两次运行走出不同路径，极易死循环、状态丢失或上下文截断。
* **非类型化数据传递**：步骤之间仅传递自由文本字符串，没有任何运行时 Schema 校验。
* **环境感知盲目**：在调用大模型之前，对执行机硬件、Git 状态、工具链、环境变量一无所知。
* **脆弱的状态管理**：遇到异常直接崩溃或全量重新执行，极度浪费 Token 且无法做到零损耗断点续跑。

**终极愿景（融合三大参考源之长）**：

1. **代码即工作流（Code, Not Conversation）**：工作流本身就是一段经过静态沙箱隔离、AST 安全授权检查的纯 TypeScript 脚本。分支、循环、并发全由原生代码语义承载，拒绝提示词控制流。
2. **证据驱动与向内依赖架构（Evidence-Driven & Inward Architecture）**：严格区分 **事实观察（Observation）**、**推导事实（Derivation）**、**智能体推论（Inference）** 与 **未知状态（Unknown）**；错误以具名判别联合（Tagged Error）跨边界传递，未经类型化的异常严禁穿透边界。
3. **类型化 Agent RPC（Typed Agent RPCs）**：智能体如同带类型签名的微服务，`agent(name).ask<T>(prompt)` 在编译期从 TS 类型合成 JSON Schema，运行时逐字段校验并内置自愈反思纠错循环（Self-Healing Loop）。
4. **确定性物理探针（Deterministic Probing）**：执行前通过 OS/Git/Toolchain 探针获取绝对客观事实，对环境变量施行不可逆的安全脱敏。
5. **事件溯源与无损重放（Durable Event Sourcing & Replay）**：双持久化引擎（SQLite WAL 快照 + append-only `events.jsonl`），配合 `(siteId, ordinal, inputHash)` journal 短路键实现 `--resume` / `--amend` / `--resume-from-failed` 零 Token 增量恢复。
6. **全生命周期进程安全（Process Group Supervision）**：Windows Job Objects + Unix Process Group 原生监管，超时强杀、内存封顶、绝对杜绝孤儿进程与环境泄露。

---

## 2. 技术谱系：三大参考源

本引擎的确定性内核不是凭空设计，而是对业界最强生产级实现的逐机制精读与同语义再推导，全部证据链沉淀于 [docs/research/](docs/research/)：

| 参考源 | 汲取要点 | 深度证据 |
|---|---|---|
| **ZCode 官方 Dynamic Workflow** | 代码即流程内核：Facade 纯度契约与 AST 黑名单、`ts.TypeChecker` 类型擦除与运行时 Schema 合成、NDJSON 单行 IPC 协议、Kahn 拓扑排序与环检测、确定性重放键 | [workflow-reverse-engineering.md](docs/research/workflow-reverse-engineering.md)、[ZCODE-DEEP-REVERSE-v2.md](docs/research/ZCODE-DEEP-REVERSE-v2.md) |
| **Claude Code / Claude Dynamic Workflow** | 多智能体协同：动态子任务分发、Schema 自愈反思闭环、双向 MCP 互通、上下文预算硬执行、停滞三态状态机、持久 Actor 会话 | [CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md](docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md) |
| **morluto/rea** | 工业级工程规范：向内依赖流动（Domain 零基础设施依赖）、证据凭证法则（Provenance/Coverage/Limitations）、Tagged Error 代数与 `Result<T, E>`、进程组监管与无残留清理、上下文预算纪律 | 能力吸收决策逐项登记于 [docs/absorbed-capabilities.md](docs/absorbed-capabilities.md) |

安全判定与红蓝攻防实测见 [PENETRATION-AND-SECURITY-AUDIT.md](docs/research/PENETRATION-AND-SECURITY-AUDIT.md)；开放缺口的**唯一状态登记处**为 [WORKFLOW-GAP-MATRIX.md](docs/research/WORKFLOW-GAP-MATRIX.md)（D#/R#/GAP-# 条目号）。

---

## 3. 已落地架构现状

任务书所绘「目标架构」已全部落地为现实。实际 `src/` 布局如下（模块职责详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：

```text
src/
├── domain/                   # 纯领域模型：事件定义、类型契约（零基础设施依赖）
├── dwf/                      # 动态工作流内核：Facade 编译器（AST 纯度门禁 + Schema 合成）、
│                             #   VM realm 沙箱执行器、NDJSON 协议、journal 重放、脱敏
├── core/                     # Builder 工作流引擎（defineWorkflow 声明图、步骤编排）
├── agent/                    # Provider 六族（mock/Bedrock/Anthropic/OpenAI/CLI 代理/HTTP）与 RPC
├── execution/ · context/     # 执行编排与运行时上下文
├── state/                    # 双持久化：SQLite WAL 快照 + events.jsonl 只追加事件流
├── dag/ · visualizer/        # DAG 可视化：SVG 画布、Mermaid、ASCII、看板与 Studio
├── prober/                   # 确定性物理探针：OS / Git / 工具链 / 环境变量脱敏
├── process-supervision.ts    # 进程树监管：Win32 Job Object / POSIX 进程组、活性探针
├── mcp/                      # MCP 客户端与服务端（stdio）
└── cli/                      # workflow CLI 命令族（run / check / inspect / serve / setup …）
```

---

## 4. 里程碑：阶段 0–8 已全部落地

原始任务书的八阶段重构路线于 2026-11 全部交付，各阶段与验收锚点：

| 阶段 | 内容 | 状态 | 验收锚点 |
|---|---|---|---|
| 0 | 参考源逆向探查与基线盘点 | ✅ | [docs/research/](docs/research/) 逆向文档群 |
| 1 | 领域模型与基础设施（事件、类型契约） | ✅ | `src/domain/`、单元测试 |
| 2 | Facade 编译器与 Schema 合成（AST 纯度门禁 9002/9003/9014/9005/9015） | ✅ | `src/dwf/`、编译器测试 |
| 3 | 工业级进程安全沙箱（Job Object / pgid / NDJSON IPC） | ✅ | `src/dwf/runner.ts`、`tests/adversarial/` |
| 4 | Kahn 拓扑调度与 DAG 引擎 | ✅ | Builder/Facade 双引擎、环检测测试 |
| 5 | 类型化 Agent RPC 与自愈闭环、Provider 六族 | ✅ | `src/agent/`、集成测试 |
| 6 | 双持久化与断点恢复（journal 短路、零 Token 重放） | ✅ | `src/state/`、重放集成测试 |
| 7 | 确定性探针、双向 MCP 与可视化（Studio 看板） | ✅ | `src/prober/`、`src/mcp/`、E2E |
| 8 | 全方位测试与质量门禁（unit/integration/PBT/adversarial/E2E/governance） | ✅ | [TEST_INFRA.md](TEST_INFRA.md)、`npm run gate` |

---

## 5. 后续演进方向

开放项的**唯一状态登记处**是 [docs/research/WORKFLOW-GAP-MATRIX.md](docs/research/WORKFLOW-GAP-MATRIX.md)（D#/R#/GAP-# 条目号，逐项立项推进），此处只列主线方向、不复制状态：

1. **D1 沙箱深度隔离**（安全最高优先）：VM realm 预Seed 宿主对象图注入的根因级消除；
2. **D4 协议健壮性**：NDJSON 帧字节预算、畸形帧处理、EPIPE 竞态与洪泛防线的残余收口，skip 状态对抗测试转正；
3. **D8 官方对齐 backlog**：per-actor 具名缓存、cell 停滞检测、三层限流四层纪律、facade 原语补全（多天工程，逐项立项）；
4. **D5 停靠语义**：parked 终态事件统计甄别、escalate 快路径；
5. **R4 未入册残余**：退避抖动、host 错误线形态、PoC4 microtask 伪造 done 帧防线。

---

## 6. 工程铁律（Non-Negotiable Constraints）

1. **类型完备性**：`tsconfig.json` 必须开启 `strict: true`, `noImplicitAny: true`。严禁在生产代码中滥用 `any`（仅在与非受控底层库交互处做最小化类型断言）。
2. **零凭证泄漏**：任何日志、错误堆栈、持久化 JSONL 或 SQLite 数据库中，绝对不允许出现明文 API Key、密码或私钥。
3. **零孤儿进程**：不论工作流遭遇异常、超时或用户强制中断（SIGINT/SIGTERM），所有派生的子进程、测试沙箱必须保证 100% 被清理干净。
4. **代码整洁与可读性**：所有公共类、函数、接口均需编写符合 TSDoc/JSDoc 标准的详细注释，指明方法意图、参数限制与返回值语义。
5. **向后兼容与平滑替换**：既有的 CLI 命令（`run`, `replay`, `graph`, `probe`, `init`）在任何演进后必须保持更流畅、更健壮的体验，不得破坏已有旗舰 Demo。
