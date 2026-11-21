# AI-Workflow 系统架构规约

> **"代码即流程，而非对话猜测"：构建高韧性、强类型、确定性重放的多智能体工作流引擎**
> 本文件是架构主题的单一事实源：核心分层架构、RPC 契约、DAG 调度、沙箱隔离、SQLite WAL + JSONL 双持久化与重放机制。
> 全文与 `main` 分支真实代码对齐（代码优先于文档）；若文档与代码冲突，以代码为准并回改本文（见 `docs/README.md` 防腐规则）。
> 编写侧实操请配合《开发者指南》：`docs/DEVELOPER_GUIDE.md`。

---

## 1. 设计哲学与架构概述

当今多数智能体系统依赖"对话式多智能体循环"——多个 LLM 智能体在一个无约束的聊天室里互传自由格式的自然语言消息。对话式智能体擅长开放式头脑风暴，但用在任务关键型软件工程（生产故障排查、大规模重构、合规审计）时存在四类致命缺陷：

1. **上下文压缩失忆（Context Compaction Amnesia）**：对话变长后触发有损摘要，中间执行参数（数据库连接数、Git SHA、端口号）被静默丢弃。
2. **控制流幻觉（Hallucinated Control Flow）**：自然语言没有原生的分支、循环与并发原语。模型会幻觉出"已完成"状态、跳过校验步骤，或无限空转。
3. **脆弱的字符串传递（Fragile String Parsing）**：智能体之间传递未经校验的 JSON 或正则解析的字符串，一旦模型改动字段名、夹带 markdown 问候语、漏写闭合括号，就会级联崩溃。
4. **非确定性恢复（Non-Deterministic Resumption）**：10 步对话在第 9 步遭遇网络失败时，只能从第 1 步重启整段对话，重烧数千 Token 且决策可能不同。

### 1.1 ZCode 动态工作流范式：AI-Workflow 的答案

> **核心机制一句话：TypeScript 脚本死控并发与流水线，子 Agent 之间互不聊天，只向宿主交付强类型结构化结果。**

AI-Workflow 采用 **ZCode 动态工作流** 的架构范式——**"代码即流程"**：

- **工作流是可执行的 TypeScript 程序**：控制流、条件分支、循环与并发扇出（`Promise.all`）由编译后的代码治理，而非提示词引导。
- **智能体是强类型 RPC 微服务**：调用智能体与调用类型化的远程过程完全一致——`agent(name).ask<T>(prompt, schema)`。
- **确定性环境探测**：模型生成由真实的系统与仓库遥测数据落地（grounding），拒绝对话式猜测。
- **双层持久化**：执行状态快照进 SQLite（WAL 模式），事件流入只追加的 JSONL 日志，支撑零 Token 的前缀重放与断点续跑。
- **可视化时间轴 DAG**：每次运行生成交互式单文件 HTML/SVG 时间轴（三次贝塞尔连接线、节点检查抽屉、Studio 实时看板）。

---

## 2. 总体架构与模块地图

引擎按"领域内聚、依赖向内"组织（Clean Inward：`src/domain` 与 `src/types` 不依赖任何上层，只允许被引入）。模块与真实目录一一对应：

| 模块（src/ 下） | 职责 | 关键文件 |
|---|---|---|
| `domain/` | 领域词汇：错误代数、事件常量表、证据账目、结果类型 | `events.ts`（`WORKFLOW_EVENT`）、`errors.ts`、`evidence.ts` |
| `types.ts` | 跨模块共享契约：`StateStore`、`DwfJournalStore`、`WorkflowEvent` 等 | `src/types.ts` |
| `core/` | 核心构建器引擎：`Workflow`/`defineWorkflow`、Kahn 校验、步骤执行、重试 | `workflow.ts`、`step.ts`、`context.ts`、`error.ts` |
| `dwf/` | Facade 脚本引擎（主推面）：编译、降级、沙箱子进程、NDJSON 协议、journal 内核 | `compile.ts`（编译编排）、`ast-codemod.ts`（前置 AST 改写与自愈）、`compile-rules.ts`（规则词库）、`lower.ts`、`runner.ts`（启动编排+settle 状态机）、`run-lineage.ts`、`run-events.ts`、`frame-pump.ts`、`sandbox-launch.ts`、`author-position.ts`、`fill-hole.ts`、`engine.ts`（外观+journal 主链）、`replay-pool.ts`、`ask-executor.ts`、`budget-ledger.ts`、`host-boundary-dispatcher.ts`、`artifact-ledger.ts`、`evidence-ledger.ts`、`child-main.ts`（沙箱宿主侧）、`child-bootstrap.ts`（realm 引导程序）、`governor.ts`、`redact.ts`、`schema-synth.ts`、`facade-dts.ts` |
| `agent/` | Provider 抽象与 RPC：mock/Bedrock/Anthropic/OpenAI/CLI/HTTP 提供方、模型路由、JSON 修复 | `rpc.ts`、`provider.ts`、`model-router.ts`、`schema.ts` |
| `prober/` | 确定性环境探测：系统、Git、工具链、环境变量脱敏 | `index.ts`、`system.ts`、`git.ts`、`toolchain.ts`、`sanitizer.ts` |
| `state/` | 持久化：SQLite 存储（WAL）、JSONL 事件日志、ReplayEngine | `sqlite-store.ts`、`event-log.ts`、`replay.ts` |
| `dag/` | DAG 渲染：HTML（贝塞尔时间轴）、Mermaid、ASCII、journal 事件投影 | `html-renderer.ts`、`journal-projection.ts`、`mermaid-renderer.ts`、`ascii-renderer.ts` |
| `visualizer/` | AI-Workflow Studio：单文件 SPA 渲染与 WebSocket 实时推送/时间旅行 | `studio-renderer.ts`（渲染逻辑）、`studio-template.ts`（页面模板+i18n）、`studio-server.ts`（Studio 协议）、`ws-endpoint.ts`（RFC 6455 内核）、`studio-page.ts`（页面外壳）、`svg-canvas.ts` |
| `mcp/` | MCP 客户端注册表与服务端（stdio 工具目录） | `client.ts`、`registry.ts`、`server.ts` |
| `execution/` | 并发调度：ask 并发解析、swarm 分发、worktree 池 | `swarm-dispatcher.ts`、`worktree-pool.ts` |
| `context/` | 仓库上下文切片：`files.map` 的 AST 符号地图与预算内切片 | `repomap.ts`、`slice.ts` |
| `cli/` | CLI 命令面（commander）、双语 i18n（en/zh）、脚手架模板 | `index.ts`、`commands/`、`i18n/`、`scaffolding/` |
| `process-supervision.ts` | OS 层进程监管：POSIX 进程组 / Windows Job Object、环境白名单 | `src/process-supervision.ts` |
| `index.ts` | 包出口：`Workflow`、`defineWorkflow`、DAG、MCP 等公共导出 | `src/index.ts` |

对外包出口由 `package.json` 的 `exports` 声明：`"."`（根）、`"./core"`、`"./agent"`、`"./dag"`、`"./mcp"`，类型与实现指向 `dist/` 下对应文件。

### 2.1 总体架构图

自 README 迁入的完整分层拓扑（虚线为监管/环境注入关系，非调用流）：

```mermaid
flowchart TB
    subgraph ENTRY["入口层"]
        CLI["workflow CLI（统一 run 入口）"]
        MCPC["MCP 客户端 / 服务端（stdio）"]
        STUDIO["AI-Workflow Studio 看板"]
    end

    subgraph COMPILE["编译层（宿主进程内，先于一切执行）"]
        AST["Facade 编译器<br/>严格 TS 类型检查 + AST 纯度门禁<br/>9002 / 9003 / 9014 / 9005 / 9015"]
        KAHN["Builder 编译器<br/>defineWorkflow 声明图<br/>Kahn 拓扑排序 · 环检测 · 阶段分组"]
    end

    subgraph SANDBOX["执行层（node:vm 沙箱子进程）"]
        VM["VM Realm<br/>codeGeneration 禁用<br/>PreSeed 单一入站通道"]
        FACE["能力面<br/>agent().ask · phase · files · git<br/>world.run 门禁 · hole / escalate"]
        GATE["确定性脚本门禁<br/>退出码裁决 · 失败回滚"]
    end

    subgraph STATE["双持久化状态层"]
        SQLITE[("SQLite WAL<br/>runs · events · checkpoints · artifacts<br/>dwf_runs · dwf_nodes · dwf_evidence")]
        JSONL[("events.jsonl<br/>只追加事件流")]
    end

    subgraph SUPERVISE["物理监管层"]
        JOB["Win32 Job Object（KILL_ON_JOB_CLOSE）<br/>POSIX 进程组树级 SIGKILL"]
        ENV["白名单脱敏环境<br/>buildSanitizedEnv"]
    end

    subgraph RUNTIME["模型运行时"]
        ROUTER["model-router<br/>fast / deep 分层路由 + failover 链"]
        PROV["mock · Bedrock · Anthropic · OpenAI · CLI 代理 · HTTP"]
    end

    CLI -- "run facade / run-script" --> AST
    CLI -- "run builder" --> KAHN
    MCPC --> AST
    AST --> VM
    VM --> FACE
    KAHN --> CORE_RUNNER["Core In-Process Runner<br/>(宿主进程直接执行)"]
    CORE_RUNNER --> SQLITE
    CORE_RUNNER --> ROUTER
    FACE --> GATE
    FACE --> ROUTER
    ROUTER --> PROV
    JOB -.进程树监管.-> SANDBOX
    ENV -.子进程环境.-> SANDBOX
    FACE --> SQLITE
    GATE --> SQLITE
    SQLITE --> JSONL
    SQLITE --> STUDIO
    SQLITE -- "--resume / --amend 零 Token 重放" --> VM
```

分层要点与上表模块一一对应：编译层先于一切执行（§4）；Facade 脚本执行层运行在 `node:vm` 沙箱子进程中（受物理监管层托管），而声明式 Core 构建器工作流在宿主进程中依据 Kahn 拓扑排序直接执行；全部状态经双持久化状态层落库（§8），并以此支撑 `--resume` / `--amend` 零 Token 重放（§3.3、§8.3）；模型运行时的分层路由与 failover 见 §6.3–§6.4。

---

## 3. 双引擎执行模型

本仓库同时承载**两套执行引擎**，面向两种编写面，生命周期如下：

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                            工作流执行生命周期                                    │
└────────────────────────────────────────────────────────────────────────────────┘
  1. 编写          ──►  2. 编译与校验      ──►  3. 探测        ──►  4. 执行与门禁   ──►  5. 持久化与重放
  (facade 脚本 /        (TS 编译期禁令 /        (系统/Git/          (Agent RPC /         (SQLite WAL +
   defineWorkflow)       Kahn 拓扑校验)          工具链遥测)         确定性 shell 门禁)     JSONL 双写)
```

### 3.1 核心构建器引擎（`src/core`）

声明式编写面：`defineWorkflow` 对象清单或 `new Workflow()` 流式 API（`addPhase`/`addStep`）。步骤分组进有序**阶段（Phase）**，每个步骤带角色（`role`：`inspector` 只读探测 / `worker` 业务执行 / `gate` 确定性门禁；内部映射为 `probe`/`action`/`gate` 三类节点类型）。

**图结构与 Kahn 拓扑校验**：工作流被建模为有向无环图 $G = (V, E)$，节点 $V$ 是离散执行步骤，有向边 $E = \{(u, v) \mid v \text{ 依赖 } u\}$ 表达数据或次序依赖。执行任何步骤前，`Workflow.validate()`（`src/core/workflow.ts`）运行 **Kahn 算法**：

1. 统计每个步骤 $v \in V$ 的入度 $\text{deg}^-(v)$；
2. 入度为 0 的步骤入队；
3. 依次出队，递减后继节点的入度；
4. 若访问节点数严格小于 $|V|$，立即阻断并抛出 `CircularDependencyError`，点名成环节点；
5. 若某步骤引用了不存在的依赖 ID，抛出 `MissingDependencyError`。

`defineWorkflow` 在入口做了一层宽容归一化：`phases` 接受字符串数组或 `{id, name}` 对象，步骤的 `phase`/`phaseId`、`dependencies`/`dependsOn` 双写法等价，缺省阶段归入 `Phase 1`，缺省角色为 `worker`。

**检查点绑定哈希**：核心引擎的每个检查点以 `sha256(stableStringify(stepHashDescriptor(step)) ␀ stableStringify(redactValue(input)))` 绑定"（步骤定义， 输入）"对——键控的是落盘后的脱敏形态（幂等脱敏保证运行时与重放时摘要一致），仅改步骤函数体不会使检查点失效；整脚本级身份绑定由 facade 引擎的 `scriptHash` 负责。

### 3.2 Facade 脚本引擎（`src/dwf`，主推编写面）

脚本作者只看到一个封闭原语面（`src/dwf/facade-dts.ts` 声明的 `agent`/`phase`/`log`/`report`/`args`/`budget`/`run`/`artifact`/`hole`/`escalate`/`workflow`/`fanout`/`swarm`/`sessions`/`channel`/`future`/`files`/`git`/`world`），执行链路为：

1. **编译**（`compile.ts`）：进程内 TypeScript Compiler API 对全虚拟 CompilerHost 做一次 `noEmit`、`strict`、`types: []` 检查，同步产出站点表（site table）、各 ask 的 JSON Schema 与降级脚本、`scriptHash`（详见 §4）。
2. **降级**（`lower.ts`）：编译期改写——`agent()` → `__host.createActor`、`p.ask<T>()` → `__host.ask`、`files.*`/`git.*`/`world.run` → 对应 `__host.worldRead`/`worldRun` 调用；编排控制流保持原生 TypeScript，引擎只在边界调用处拦截。
3. **沙箱子进程**（`child-main.ts` + `runner.ts`）：降级脚本在 `node:vm` realm 内执行，仅 facade 宿主可达；父子之间走 NDJSON 帧协议（详见 §5）。
4. **journal 内核**（`engine.ts`）：实例身份 = `siteId × ordinal`；每次边界调用先查 journal——命中则零模型调用重放，`inputHash` 不匹配则响亮失败（详见 §6.5、§8）。

**关键设计差异**：facade 引擎**刻意没有阶段依赖 DAG**。`phase()` 只是展示标记（发出 `dwf_phase` 事件，别无他用），编排控制流就是编译后脚本的原生 TypeScript——引擎只拦截边界调用。Kahn 式依赖校验与环拒绝属于核心构建器引擎（§3.1），两套引擎各司其职。

一次运行的终态五选一：`completed` / `failed` / `compile_failed` / `parked` / `stopped`。其中 `parked`（挂起）是一等终态，与 `failed` 严格隔离（私有仓 Issue #35）：脚本调用 `hole<T>()` 或 `escalate()` 时引擎开启站点并让分支停在永不落定的 promise 上，全部剩余分支都停稳后运行落为 `parked` 并发出独立终态事件 `dwf_parked`——事件统计永远不会把挂起计为失败；两个人工入口（`workflow fill` 与 `workflow answer`）只接受挂起运行。

### 3.3 统一重放前台

`workflow replay <runId>` 是两套引擎共用的重放/续跑入口：它**从持久化存储判别运行种类**（绝不按 runId 形态猜测）再分发——

- **Facade 脚本运行**（`.workflow/dwf.sqlite` 中的 `dwf_runs` 行）：命令是 `run-script --resume` 的纯入口适配器；journal 短路、陈旧 `running` 行的接管（stale-pid takeover）、脚本哈希绑定都活在 runner 里，此处零重复实现。
- **核心构建器运行**（`workflow run` 记录的检查点）：从随运行持久化的字节副本重建工作流定义（可用 `--file` 覆盖），对原存储真实执行——已完成步骤经 inputHash 绑定的检查点零成本短路，失败步骤真实重执行其执行器。

`replay` 绝不伪造成功：定义/脚本无法重建（运行目录被清理、脚本不可读）时以显式 `[StorageError]` 非零退出。facade 直连入口保留为 `workflow run-script <file> --resume <runId>`；`--amend` 将修改后的脚本分叉为新运行，`--rerun` 对同一脚本从指定站点起全新执行。用户侧语义详见 `docs/DEVELOPER_GUIDE.md` §7。

---

## 4. Facade 编译器与纯度契约（`src/dwf/compile.ts`）

编译器的设计镜像 ZCode 官方 `packages/dynamic-workflow/src/compiler/compile.ts`：

- 脚本被包裹进 `async function __workflowScript__() { ... }`，使顶层 `await`/`return` 在普通函数体内合法；
- 虚拟 CompilerHost 从内存映射供应脚本、facade `d.ts` 与 lib 文件；`types: []`——不加载任何 ambient @types，**纯度契约从编译期开始**（`process`/`fetch` 直接是编译错误）；
- `noUncheckedIndexedAccess` 刻意关闭：模型编写的 TS 默认不假设它，开启会在上游产生大量 undefined 族误报；
- 诊断行号回映射到作者原始行号（扣除一行前奏），绝不以未映射形态示人。

一条硬契约贯穿全部编译期禁令——**脚本必须是 (脚本源码, args) 的纯函数**：

**9002 纯度禁令**（标识符半边）清单即"逃出封闭世界的每一条已知出口"的枚举：
- 造码与越权求值：`eval`、`Function`、`globalThis`（全局对象是一切的入口；eval/Function 直接把字符串变代码）；
- 环境权威：`process`、`require`（进程控制、模块系统、环境变量与密钥全在）；
- 网络与裸字节：`fetch`、`Buffer`（不经 facade 授权面的网络出口与字节原语）；
- 带外调度：`setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`（把工作排到引擎可见调用序列之外，执行次序脱离降级铺设的线性站点序，从根上破坏重放确定性）。

**9002 成员禁令**（成员粒度的最小约束）：墙钟（`Date.now`/`Date.parse`/无参 `new Date()`）、熵源（`Math.random`）与原型链属性被拒。动机是重放的字节级一致性：journal 以 `(runId, siteId, ordinal)` + `inputHash` 键控，两次执行一旦各自读钟/掷骰，同一 run 的重放即静默分叉。合法的时间与随机性只能经 `args` 注入；`Date`/`Math` 标识符本身合法——禁令是最小成员约束，注入的时间戳仍可正常取值与格式化。

**9002 原型链禁令**（`PROTOTYPE_CHAIN_PROPS`）：`constructor`/`__proto__`/`prototype` 是从任意对象爬升到 realm `Function` 的梯子，`({}).constructor.constructor` 即零 import 逃逸。点号与字符串字面量下标双语法在 AST 层一并拒收；静态语法通道枚举不了的计算型键（`a[v]`）交给 `child-main.ts` 的运行时 realm 兜底（§5.1）。`isReference` 位置判定只豁免声明名位置——初始化位同样是引用，`const e = eval`/`const g = globalThis` 一并命中 9002（私有仓 Issue #40 闭合 GAP-MATRIX D3，测试锁定于 `tests/unit/dwf/dwf-compiler.test.ts`）。

**9003 字面量规则**：`phase()` 名、`hole()` 名、`world.run` 命令名等必须是编译期字符串字面量——审批图与命令清单由它们画出，运行期才出现的命令名无从审批。

**9014 facade 误用**：`agent()` 的 `provider`/`tier` 选项必须是编译期字面量（路由是"已审批运行形态"的一部分）；包裹式调用（`(agent)("x")`）按 fail-closed 拒绝。

**Schema 合成**（`schema-synth.ts`）：`ask<T>` 的类型参数在编译期合成为 JSON Schema（属性上的 JSDoc 变成字段描述）。深度上限 `MAX_DEPTH = 8`，超限报 `schema-synth(9005)`；真递归（环而非深）报精确诊断 `9015`——点名站点与类型名。

**站点表（site table）**：编译同时捕获 `actor`/`phase`/`hole`/`ask`/`worldRun` 等调用点为站点（`siteId`），它是重放键控（§6.5）、审批面（§5.3）与 `workflow check` 输出的共同基础。

**前置 AST Codemod 与解构自愈**（`src/dwf/ast-codemod.ts`）：大模型动态生成脚本时常习惯性写出命名空间解构（`const { glob, read } = files`）或 Agent 方法解构（`const { ask } = agent('foo')`），直接分析会因提取中间变量而触发 9001 误用拦截，增加反思延迟与 Token 成本。编译器流水线在 `compileFacadeScript` 入口引入轻量 AST Codemod 变换：
- 语法分析前将常见解构自动改写为符合规范的直接属性调用（`files.glob(...)`、`agent('foo').ask(...)`）并移除中间解构声明；
- 具备严格的作用域感知与遮蔽保护（不误伤局部同名变量或对象属性），且保留原始注释与线性结构；
- 已合规脚本无损零改动（`modified: false`），透明提升首次编译成功率。

---

## 5. VM 沙箱与进程组监管

### 5.1 沙箱子进程与 PreSeed 纪律（`src/dwf/child-main.ts`）

隔离目标是**故障隔离与确定性，而非安全边界**（与官方引擎同一立场）：子进程是一次性进程，realm 从构造上就没有 `process`、`require`、`fetch`，脚本无法触达宿主模块系统与 Node API。本项目不把这句话当挡箭牌——下方每条 PreSeed 规则都对应一次被实际利用过的攻破（PoC 记录见 `docs/research/PENETRATION-AND-SECURITY-AUDIT.md` 与 `docs/AI-PITFALLS.md` P-SEC-2）：

- **背景**：PoC2b（跨 realm `Function` 逃逸）证明，宿主 realm 解析并注入整个对象图时，`args.constructor.constructor("return process")()` 会沿宿主原型链拿到宿主 `Function` 与真实 `process`，进而 `process.binding('spawn_sync')` 任意命令执行——且运行以 0 退出、表面完全健康。`codeGeneration:{strings:false}` 拦不住它：V8 按创建被调函数的 realm 校验造码许可，宿主 `Function` 在宿主 realm 的 unrestricted 政策下编译字符串（探针实测）。
- **根因控制——仅原语跨界**：跨信任边界的入站数据只有原语字符串 `__argsJson`；BOOTSTRAP 在 realm **内部**执行 `Object.freeze(JSON.parse(...))`，args 的原型链因此是 context-native 的，`args.constructor.constructor` 落在 realm `Function` 上，被 `codeGeneration:{strings:false, wasm:false}` 以 `EvalError` 拒绝。
- **能力立即回收**：`__send`（向真实 stdout 写一行）与 `__timer`（waitAny 超时）被 BOOTSTRAP 捕获进闭包后立刻从 globalThis 删除，脚本不留任何可达宿主函数；入站 `__deliver` 由宿主私有持有为 `runInContext` 完成值——从不挂到 globalThis，脚本无法伪造 ok/err 响应或重放预算帧。
- **其余入站**均为无 realm 原语：NDJSON 行字符串、预算种子 `__budgetTotal`（number-or-null 原语，父进程控制的输出 Token 上限）。

**协议与资源防线**（`src/dwf/protocol.ts`、`runner.ts`、`engine.ts`）：
- NDJSON 帧预算：单帧 16 MB、分帧缓冲 32 MB（`MAX_CHILD_FRAME_CHARS`/`MAX_CHILD_FRAME_BUFFER_CHARS`），泵按每事件循环 tick 512 行让出（`CHILD_FRAME_LINES_PER_TICK`）；不可解析帧计数上报（`dwf_frame_malformed`），撕裂/垃圾绝不静默丢弃；
- 子端出站预算（队列 + 单帧，`child-main.ts` `writeOutboundLine` 唯一咽喉点）：子进程每条出站帧（宿主 done/scriptError 与 realm 全部 `__emit` 帧——bootstrap 捕获的 `__send` 能力与宿主帧共用同一出口）写入 pipe 前检查 `stdout.writableLength`（>16 MB 队列预算）与**单帧行长**（>16 MB 单帧预算，镜像父端 `frame-pump.ts` `MAX_CHILD_FRAME_CHARS`），任一越限即**当场同步终止脚本**：终态 `ChildFrameLimitExceeded` scriptError 帧经 fd 1 直写落内核（前导换行兜住在途撕裂帧）后立即 exit(1)，流队列中已排队的洪泛帧随流丢弃、realm 侧同步洪泛循环当场打断；fd 1 投递失败或部分写（libuv 非阻塞写可 EAGAIN——内核管道恰好刚满，或 EPIPE）时终态帧镜像写 fd 2，`runner.ts` close 路径把 stderr 尾 800 字带进错误文本，失败在任何投递结局下都有名。仅约束写队列不够（CI 实测：2000 帧 ≈1 GiB 洪泛在 realm 的 JSON.stringify 处 V8 OOM——不 yield 的循环里写完成回调拦不住、经 `__call` promise executor 向 realm 抛错也只拒绝对应的 fire-and-forget promise），巨帧的序列化放大另由 bootstrap `__host.log` 源串预闸前置拦截（>16 MB 同步 throw 展开脚本循环，`__emit` stringify 不再发生），且不再补发 done 帧（一次终态帧）；realm 路径覆盖为 Issue #58 修复，此前 realm 帧绕过 `sendToParent` 直写 stdout，测试锁定 `tests/unit/dwf/dwf-child-outbound-budget.test.ts`（含 15.7 MB 正例：合法输出永不误杀）；
- 沙箱堆上限默认 512 MB（`DEFAULT_SANDBOX_MAX_OLD_SPACE_MB`，可用环境变量覆盖）。

### 5.2 OS 层进程监管（`src/process-supervision.ts`）

引擎与 runner 派生的每个进程都是受监管单元：

- **POSIX**：子进程获得独立进程组（`detached: true`），终止即组杀 `process.kill(-pid, 'SIGKILL')`——派生了孙进程的命令无法活过自己的超时；
- **Windows**：传统路径走 `taskkill /PID <pid> /T /F`（`/T` 遍历进程树）；在此之上已实现 **Win32 Job Object 监管**（私有仓 Issue #98 Phase 2）：一个极小的 C# 助手（`scripts/win32-jobhelper.cs`，由 Windows 内置 csc.exe 惰性编译进 gitignore 缓存）担任受监管命令的**直接父进程**，持有 `KILL_ON_JOB_CLOSE` 的 Job Object（可选逐进程内存 commit 上限）。`killTree()` 杀助手 pid 即关闭 job 句柄、内核回收整棵树；宿主 Node 崩溃时助手自身的 wait 分支也会终结进程树。降级链（非 win32 / 缺 csc / 编译失败 / 启动失败）按进程记忆化一次，可经 `queryJobGuardStatus()` 观察（`job-object` | `fallback-taskkill` 两态，事件 `dwf_job_guard`），降级仅损失内存上限与崩溃保险，功能零缺失；
- **环境白名单**：子进程绝不继承父进程完整环境。组装最小平台关键基座 + 显式白名单（`SPAWN_ENV_ALLOWLIST`/`buildSanitizedEnv`），调用方 shell 里的凭据（API Key、Token）无法泄漏进派生命令或沙箱；`world.run` 的孙进程另有第二层白名单（`engine.spawnCaptured` 的 `envAllowlist`）。这是 OS 级生命周期与泄漏约束，不是安全沙箱。

### 5.3 `world.run` 授权面（私有仓 Issue #127）

脚本的命令集在编译期收集为字面量清单，运行前向运行所有者展示审批。运行时每条 `world.run` 的授权来源（`explicit` 显式批准 / `allowlist` 白名单命中 / `tty`）作为独立事件 `dwf_world_run_auth` 落账；脚本自带的命令清单**不再**自行授权，必须经 `--approve-cmd` 显式批准。

---

## 6. 强类型 Agent RPC 与并发治理

### 6.1 核心引擎的 RPC 契约（`src/agent/rpc.ts`）

强类型 RPC 层把非结构化模型调用完全封装进运行时类型契约之后：

```typescript
export interface AgentRPCClient {
  readonly name: string;
  ask<T>(prompt: string, schema: z.ZodType<T>, options?: AgentCallOptions): Promise<T>;
}
```

调用 `agent(name).ask<T>(prompt, schema)` 时的执行流水线：

1. **系统提示词强制约束**：注入严格的系统边界，要求纯 JSON 输出且与 schema $T$ 完全吻合，明令禁止对话寒暄与 markdown 围栏；
2. **Provider 调度**：载荷分发到注册的模型提供方（`src/agent/` 下的 mock、Bedrock、Anthropic、OpenAI、CLI、HTTP 系列提供方，经 `model-router.ts` 路由）；
3. **弹性 JSON 提取**（`extractJson`）：即使输出被 ````json ... ```` 包裹或前后夹带杂质文本，贪心括号扫描也能抽出 JSON 载荷；
4. **启发式语法修复**（`repairJsonString`）：`JSON.parse` 因尾随逗号、键名缺双引号、单引号失败时先修复再解析；
5. **运行时 Zod 校验**：`schema.safeParse(parsedJson)` 成功则返回强类型 $T$；失败则进入**自动 Schema 自愈循环**。

### 6.2 自动 Schema 自愈循环

RPC 客户端不直接崩溃，而是把 Zod 校验失败项（字段路径、期望类型、实际值）编译为定向纠错提示词回传模型：

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

模型最多获得 `maxRetries`（默认 3）次自纠机会；全部失败则抛出结构化 `SchemaValidationError`，保留原始模型输出与完整 Zod issue 列表供离线审计。在途失败还会经 `attempt-classifier.ts` 分类（可重试/不可重试、可否换道），支撑 §6.4 的 failover 链。

### 6.3 Facade 引擎的 ask 与 Provider 路由

facade 面的 `ask<T = string>(instructions: string): Node<T>` 不接收 schema 参数——类型参数 $T$ 的 JSON Schema 在**编译期**从类型合成（§4），运行时按同一 Zod 兼容路径校验（`json-schema-zod.ts`）；无类型参数时答案是子代理的最终回复文本。`Agent` 是**持续会话**：ask #2 承接 ask #1 的上下文；忙碌期间的新 ask 按 FIFO 排队。`agent()` 的 `opts.provider` 指定注册提供方（如 `"mock"`、`"bedrock"`），`opts.tier`（`'fast' | 'deep'`，私有仓 #151 双轨）分别取 `AI_WORKFLOW_FAST_PROVIDER` / `AI_WORKFLOW_DEEP_PROVIDER`，二者都未配置时回落注册表默认；无 tier 时带 schema 或大 prompt 的 ask 自动路由 deep。失败 ask 按 failover 链换道并发出 `dwf_failover`。

### 6.4 统一 Provider 契约与 Thinking 流式事件

Provider 抽象层（`src/agent/provider-contract.ts`）定义了标准统一的模型交互契约：`chat`、`complete`、`stream`、`structured`、`checkHealth`。
- **Thinking 流式增量**：流式通道 `stream` 扩充 `StreamChunk` 联合类型（`{ type: 'content' | 'thinking', delta: string }`），配合 `normalizeStreamChunk` 提供 100% 裸字符串向后兼容能力；
- **深度思考与链式推理**：原生支持现代推理模型（Claude 3.7 Extended Thinking、DeepSeek-R1、OpenAI o-series）在产出答案前流式输出的思考过程（Thinking Tokens），在执行期作为 `dwf_thinking_delta` 领域事件透传；
- **Live 广播**：在 `src/dwf/live.ts` 中打通 `/events` SSE 通道（并下发专有 `thinking` 事件）与 WebSocket `broadcastEvent`，为终端与 Studio 看板提供实时思维链可视化能力。

### 6.5 三层并发治理与硬熔断

- **引擎 ask 闸门**：运行级并发上限，按优先级解析——显式 `maxConcurrency` 选项（钉死为该值）→ 环境变量 `AI_WORKFLOW_MAX_CONCURRENT_AGENTS` → 两者均未设置时取默认公式 `resolveAskConcurrency` = `min(16, max(2, availableParallelism() - 2))`（`src/execution/swarm-dispatcher.ts`）；
- **运行座位闸门**：FIFO 泊车排队；
- **逐 Provider AIMD 进程治理**（`src/dwf/governor.ts`）：失败乘性降 ×0.75，每连续 4 次成功加性升 +1，下限 1，5 分钟空闲重置——一次 429 批次不会永久压垮吞吐。

**硬熔断**：`agent()` 调用数硬上限 `AGENT_CALL_CAP = 1000`（`src/execution/swarm-dispatcher.ts` 的 `SWARM_AGENT_CAP`，与 Claude Code 对齐）；触顶即 `WorkflowAgentCapError`（可捕获，运行存活），附带官方同款反死循环文案——"用 `budget.remaining()` 判终止的循环永远不终止"。该计数随 run 结算落盘（`dwf_runs.executed_asks`，Issue #63），answer/resume/amend/rerun 从行内续算而非归零重发一个新配额——熔断口径与 Token 预算同为**整条 run lineage 连续**。**预算**：`budgetTotal` 以 `agent()` 调用粒度执行输出 Token 预算，超支阻止**后续** `agent()` 调用（`WorkflowBudgetExceededError`），在途 ask 完成且结果保留；脚本内 `budget` 只读（`spent()`/`remaining()`/`total`），`total = null` 表示无限。

### 6.6 确定性键控与 Settle-Order Gate

- **NUL 分隔哈希键**：`inputHash = sha256(kind ␀ siteId ␀ input)`。头两个字段由引擎控制（kind 是封闭枚举、siteId 由编译器生成），永远是真分隔符；NUL 优于任何可打印分隔符，因为 `JSON.stringify` 绝不产出裸 0x00（转义为 `\u0000` 六字符），拼接因此**构造性单射**，不靠字段内容纪律。
- **Settle-Order Gate**（镜像官方引擎，`engine.ts` + `replay-pool.ts` SettlePools）：池化落定值按**首个落定顺序**释放，由 `inputHash` 内容匹配 1:1 消费——而非按到达顺序。扇出到达次序漂移因此不可能错绑 journal 行。
- **重放键对比**：Claude Code 链式 `hash(prevKey, prompt)`、无站点表；本引擎与 ZCode 键控 `(siteId, ordinal, inputHash)`。语义等价，但显式键支持 amend 时局部失效，链式哈希则级联到每个变更点之后。amend 的站点键控缺口由 **per-actor 具名缓存**补齐（私有仓 Issue #39）：ask 行额外携带 `(actorName, actorSeq, contentHash, personaJson)`，amend 按（有效名 + 规范 persona）附着、按位 + 内容哈希 1:1 消费、分歧单调——站点重编号不再打断命中；旧账本（无身份列）继续走站点键控回放，行为不变。

---

## 7. 确定性环境探测引擎（`src/prober`）

智能体绝不猜测执行环境。`Prober` 在工作流执行前采集真实底线：

```typescript
export interface ProberResult {
  timestamp: string;
  system: SystemProbe;
  git: GitProbe;
  toolchain: ToolchainProbe;
  env: Record<string, string>;
}
```

探测维度与安全脱敏：

1. **系统遥测**：OS 平台（`win32`/`linux`/`darwin`）、CPU 架构、核心数、内存总量与可用量（MB）、系统运行时长；
2. **Git 底线**：仓库根校验、当前分支、完整 commit SHA、短 SHA、脏文件计数、跟踪远程 URL；
3. **工具链**：探测并记录 `node`、`npm`、`git`、`python`、`tsc`、`docker` 等二进制的版本；
4. **环境变量脱敏与凭据清洗**（`sanitizer.ts`）：
   - 键名按敏感模式匹配（`key`、`token`、`secret`、`password`、`auth`、`credential`、`private`）；
   - 值按凭据正则匹配（JWT `ey...`、AWS 访问键 `AKIA[0-9A-Z]{16}`、GitHub Token `ghp_...`、十六进制密钥等）；
   - URI 凭据清洗：`https://user:password@host` → `https://***:***@host`；
   - 敏感值统一掩码为 `***REDACTED***`，严防凭据进入事件日志或模型上下文。

---

## 8. 双层持久化与零 Token 重放

### 8.1 存储分层（`src/state`）

引擎把"低延迟事务检查点"与"只追加审计流"分离为双层存储：

1. **事务性 SQLite 检查点存储**（Node.js 22 内置 `node:sqlite`，`sqlite-store.ts`）：
   - `PRAGMA journal_mode = WAL;` 与 `PRAGMA synchronous = NORMAL;`；
   - 同一库承载两类表——核心引擎的 `runs` / `events` / `checkpoints` / `artifacts`（运行、事件、步骤检查点（状态、输入、输出、耗时、Token 计数）与产物），以及 facade 引擎的 journal 表 `dwf_runs` / `dwf_nodes` / `dwf_evidence`；
   - 支撑原子单步状态查询与快速索引。
2. **只追加事件流**（`events.jsonl`，`event-log.ts`）：
   - 高吞吐、人类可读的换行分隔 JSON 日志；
   - 引擎事件的**第二持久化通道**：journalled 节点行经 `store.saveDwfNode` 直写 SQLite；其余事件（phase/log 呈现、重放/amend 命中、hole、escalation、预算遥测）经唯一接缝 `FacadeEngine.emit` 交给 runner 的 emit 闭包**双写**——权威 SQLite `events` 表与 `events.jsonl` 镜像，两者事件 id/sequence 字节一致，可直接比对，续跑在两条流上无缝继续；
   - 即使未处理的 OS 信号终止了 Node 进程，事件流也不损坏（SQLite 保持权威；镜像降级本身也是事件 `dwf_event_log_write_failed`）。

**脱敏边界**：journalled 值落盘前必过 `redactValue`（`src/dwf/redact.ts`）——journal 即脱敏边界，重放确定性继承掩码形态。值形状掩码 `CREDENTIAL_TOKEN_SHAPES` 覆盖 AWS `AKIA…`、GitHub `ghp_`/`github_pat_`、OpenAI `sk-…`、Slack `xox…`、JWT `eyJ…` 等；错误路径另有 KV 形状与 URI 形状掩码（`postgres://***:***@host`），`dwf_failed` 事件不携带裸值。

### 8.2 事件词汇表（`src/domain/events.ts`）

事件类型是**常量映射派生的字面量联合**（`WORKFLOW_EVENT` 常量表 → `WorkflowEventType` 联合），线上字符串与编译期联合永不漂移。核心引擎事件：

`workflow_start` / `phase_start` / `step_start` / `step_complete` / `step_failed` / `step_skipped` / `gate_eval` / `phase_complete` / `workflow_complete` / `workflow_failed` / `workflow_aborted` / `agent_rpc_request` / `agent_rpc_response` / `mcp_tool_call` / `mcp_tool_result` / `artifact_emitted`。

Facade 引擎（`dwf_*`）事件（摘要）：`dwf_plan`（注册计划图：runner 把编译期站点表写入 journal 作为计划先行骨架）、`dwf_plan_update`（中期计划更新：`plan()` 原语调整运行中的计划图）、`dwf_phase`、`dwf_log`、`dwf_report`、`dwf_actor_created`、`dwf_ask_start`、`dwf_ask_complete`、`dwf_replay_hit`、`dwf_amend_hit`、`dwf_amend_diverged`、`dwf_hole_open`、`dwf_escalation_open`、`dwf_budget_spent`、`dwf_size_warning`、`dwf_child_workflow`、`dwf_inflight_abort`、`dwf_failover`、`dwf_world_run`、`dwf_world_run_auth`、`dwf_call_error`、`dwf_node_failed`、`dwf_artifact`、`dwf_completed`、`dwf_failed`、`dwf_parked`、`dwf_resume_takeover`、`dwf_event_log_write_failed`、`dwf_frame_malformed`、`dwf_job_guard`、`dwf_import_cache_closed`。权威全集以 `WORKFLOW_EVENT_TYPES` 为准。

### 8.3 重放的数学表述

步骤 $k$ 的状态是历史事件的确定性折叠：$\text{State}(k) = \text{Fold}(\text{Events}[0..k])$。

以 `--resume-from-failed <runId>` 续跑时（核心引擎，`src/state/replay.ts` 的 `ReplayEngine.analyzeRun`）：

1. `ReplayEngine` 检索该运行在 SQLite 中的全部检查点；
2. 步骤划分为两组：
   - 跳过集 $\text{Steps}_{\text{skip}} = \{v \in V \mid \text{Checkpoint}(v).\text{status} = \text{'completed'} \land \text{Order}(v) < \text{Order}(\text{firstFailedStep})\}$；
   - 执行集 $\text{Steps}_{\text{exec}} = \{v \in V \mid v \notin \text{Steps}_{\text{skip}}\}$；
3. 跳过集的缓存输出以 **0 毫秒**直接注入 `ExecutionContext`，**LLM Token 消耗严格为 0**（估算节省量 `tokensSavedEstimate` 一并给出）；
4. 执行从首个失败步骤处恢复。

facade 引擎的对应物是 journal 短路：身份 = `(runId, siteId, ordinal)` + `inputHash`，命中节点零 Provider 调用零进程派生，`inputHash` 不匹配则响亮失败（绝不静默分叉）；陈旧 `running` 行在宿主 pid 死亡时被 resume 接管（`dwf_resume_takeover`）。统一入口见 §3.3。

---

## 9. 可视化与 AI-Workflow Studio（`src/dag`、`src/visualizer`）

### 9.1 单一投影器与贝塞尔时间轴

`dag/journal-projection.ts` 是**唯一**的事件→图投影器：运行视图、冷重放、Studio 时间旅行共用同一状态机，任何第二实现都无从漂移。

**计划先行骨架（Issue #168）**：facade run 的 fresh stream 启动时，runner 把编译期 site table 作为 `dwf_plan` 事件写入 journal（只携带运行时事件会真正翻转的 ask / hole / escalation 三类站点；worldRead 活跑零事件、worldRun/artifact 按 site-less key `gate:<cmd>`/`artifact:<id>` 动态入图，均不入计划）。投影器把计划折叠为全量 pending 节点，后续运行事件按 siteId 原地翻状态——计划中从未执行的分支节点保持 pending 可见。watch 视图（每事件重写 run 目录 `graph.html`）自此**默认开启**（`--no-watch-graph` 显式关闭），活跑与冷回放的"同一投影、字节一致"不变式由 dwf_plan 作为普通 journal 事件参与折叠而自动保持。

**计划图 mid-run 演进（Issue #171）**：脚本可用一等原语 `plan({ nodes, edges })` 实时调整当前 run 的计划图——新 id 折叠为 pending 节点（默认入当前阶段列，声明新阶段名即建列；重复 id 幂等），`edges` 为任意依赖边（可连真实 siteId）。悬空端点的边**缓冲重放**：投影器逐事件冲刷 pendingEdges，端点出现即显形，mermaid 不产生幽灵隐式节点。引擎侧形状校验响亮失败（PlanUpdateMalformed / PlanCapExceeded），声明环不做检测（渲染器有回边分支，声明环属作者错误、图中可见）。另一条"中途调整方案"原生路径——hole 填充（`fillHoleAndRun`）fork 出的 amend 新 run 是 fresh stream，#168 的重发机制使其 graph.html 天然就是调整后的计划图。

依赖步骤间的连接线以 SVG 三次贝塞尔曲线（cubic Bézier）平滑绘制（`html-renderer.ts`、`visualizer/svg-canvas.ts`）：

$$C(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3, \quad t \in [0, 1]$$

- 起点 $P_0$：上游卡片右侧中点锚 $(x_{\text{src}} + w_{\text{src}},\ y_{\text{src}} + h_{\text{src}}/2)$；
- 终点 $P_3$：下游卡片左侧中点锚 $(x_{\text{dst}},\ y_{\text{dst}} + h_{\text{dst}}/2)$（Studio 画布为底中→顶中锚定）；
- 水平控制偏移 $\Delta x = \max(0.5 \cdot |x_2 - x_1|,\ 40)$，控制点 $P_1 = (x_1 + \Delta x, y_1)$、$P_2 = (x_2 - \Delta x, y_2)$。

```
   上游卡片 [P0] ────────╮
                         │ (三次贝塞尔)
                         ╰────────► 下游卡片 [P3]
```

### 9.2 交互画布与 Studio

- **平移缩放**：纯 CSS/SVG 矩阵变换，滚轮与拖拽导航；
- **节点检查抽屉**：点击步骤滑出抽屉，渲染 JSON 输入输出、运行时长、角色与错误堆栈；
- **AI-Workflow Studio**（`visualizer/studio-renderer.ts` + `studio-server.ts`）：单文件自包含 SPA（AffectUI 风格拓扑画布、抽屉式实时事件终端与节点检查器，`file://` 离线可用；默认 Canvas-First 全屏展示工作流全貌，点击节点或切换按钮平滑展开右侧抽屉；阶段标题自适应换行，卡片采用意图摘要与状态指标多行布局，跨阶段节点以 SVG 贝塞尔带箭头导向连线贯通）。服务端在零 npm 依赖前提下手写 RFC 6455 WebSocket：`broadcastEvent` 向所有连接实时推帧；客户端 `{"op":"seek","ordinal":N}` 触发**时间旅行**——把 `events.jsonl` 前 N 条事件折叠为状态快照回放（复用同一投影器 `projectEventsToGraph`），新连接以全量折叠开场，画布直接落在"现在"；
- **Live SSE 与 Thinking 思考流**（`src/dwf/live.ts`）：除 WebSocket 外，Live 引擎提供标准 `/events` Server-Sent Events 通道，将 raw journal 事件以 `event: event` 实时推流；当推理模型产生思考过程时，专有 `dwf_thinking_delta` 事件同时以 `event: thinking` 频道多路广播，支持 Studio 看板与外部终端低延迟呈现实时思维链；
- **多格式导出**：单文件 HTML/SVG、Mermaid markdown 图、终端 ASCII 树（`workflow graph --format html|mermaid|ascii`）。

---

## 10. Model Context Protocol（MCP）架构（`src/mcp`）

基于官方 `@modelcontextprotocol/sdk` 双向互联：

### 10.1 MCP 客户端

动态工作流可发现并调用外部 MCP 服务器托管的工具（注册表懒连接，首次调用才建立连接）：

```typescript
const result = await ctx.mcp.callTool('aws-cloudwatch', 'query_metrics', {
  namespace: 'AWS/RDS',
  metric: 'DatabaseConnections',
});
```

信任配置来自 `.mcp.json`（路径由 `AI_WORKFLOW_MCP_CONFIG` 指定，从不搜索工作目录）；mock 模式下客户端短路为确定性假响应。

### 10.2 内置 MCP 服务端（`workflow mcp serve`）

引擎经 stdio 暴露 10 项工具（`src/mcp/tool-catalog.ts` 的 `TOOL_CATALOG`，`server.ts` 再导出），分两代：

**Facade 代（现行）**：
1. `workflow_script_check`：编译期检查 facade 脚本（严格 TS、纯度禁令、字面量规则），返回诊断、阶段与站点表——不执行任何东西；
2. `workflow_script_run`：在沙箱中运行 facade 脚本（确定性 journal；resume 零 Provider 调用重放已完成节点），返回 runId、状态、结果与统计（asks/replayHits）；
3. `workflow_run_script`：同一沙箱引擎的等价入口，另返回逐站点摘要（siteId/ordinal/status/durationMs）；同样支持 `resumeRunId` 零 Provider 调用重放；
4. `workflow_inspect_run`：检视 journal 中的运行——`dwf_runs` 状态行、逐站点 `dwf_nodes`（已脱敏）与证据账本摘要；
5. `workflow_get_run`：取一次运行的 journal 短路统计（总 asks、重放/amend 命中、分歧、world.run 执行数）。

**Legacy 代（已标注 `deprecated`，保留兼容）**：`workflow_run`、`workflow_probe`、`workflow_inspect`、`workflow_replay`、`workflow_graph`。

---

## 11. 技术溯源：三条逆向工程脉络

AI-Workflow 的核心机制是有据可查的工程选择，追溯至三条成文的逆向研究脉络。下列每一条主张都以 `docs/research/` 下的研究卷宗为据——带 PoC 夹具与遥测的实测证据，不是口头传说。

### 11.1 ZCode 官方动态工作流（主线）

来源：`docs/research/workflow-reverse-engineering.md`（§2 官方实现）、`docs/research/ZCODE-DEEP-REVERSE-v2.md`（引擎核心子系统）、`docs/research/ZCODE-BENCHMARK-REPORT.md`、`docs/research/OFFICIAL-WORKFLOW-TELEMETRY.md`。dynamic-workflow 包是官方开源；报告逐行阅读了它们，并通过标记计数把发行桌面包（`resources/glm/zcode.cjs`，15.4 MB）与开源树交叉验证——发行二进制即同一实现。

吸收进本引擎的基因：

1. **一次编译流水线**：进程内 TypeScript Compiler API 对全虚拟 CompilerHost 的一遍检查（`noEmit`、`strict`、`types: []`）同时产出站点表、schema、降级脚本与 `scriptHash`。`types: []` 纯度契约让 `process`/`fetch` 在编译期即错误——确定性从编译器开始（镜像于 `src/dwf/compile.ts`）。
2. **站点表 + 降级**：编译期改写（`agent()` → `__host.createActor`、`p.ask<T>()` → `__host.ask`、`files.*`/`world.run` → `__host.worldRead`/`worldRun`）；编排控制流保持原生 TypeScript，引擎只拦截边界调用。
3. **确定性内核与零 Token 重放**：实例身份 = `siteId × ordinal`；每次边界调用先查 journal——命中即零模型调用，`inputHash` 不匹配响亮失败。Settle-Order Gate 按首落定顺序释放池化落定值，扇出到达次序漂移无法错绑（镜像于 `src/dwf/engine.ts`）。
4. **NUL 分隔哈希键**：见 §6.5（`replay-pool.ts` journalInputHash 构造）。
5. **journal 持久化**：官方为同步端口的 SQLite 四表（`dwf_run`/`dwf_actor`/`dwf_node`/`dwf_event`）；同步是刻意的——引擎内引入异步缝会让重放非确定。本引擎同一立场：journal 行同步落 SQLite（`dwf_runs`/`dwf_nodes`/`dwf_evidence`），事件经唯一接缝双写。
6. **Hole——边跑边长的工作流**：编译期 `CompiledHole` 事实 + 引擎 HoleRegistry，文本级 `spliceHoleBody` 拼接、全量再分析与站点稳定性检查，单快照 ≤32 个 hole（`workflow fill` 分叉 amend，已完成节点零成本重放）。
7. **三层并发**：引擎 ask 闸门 → 运行座位闸门（FIFO 泊车）→ 逐 Provider AIMD 进程治理（×0.75 乘性降、每 4 次成功 +1、下限 1、空闲重置）（镜像于 `src/dwf/governor.ts`）。
8. **按错误通道分级的上限**：`report()` 返回 void → 超上限直接判死运行；world-read 返回 promise → 超上限 reject 节点、可捕获——"reject，绝不截断"（如 2000 文件的 glob 上限、2000 条的 `files.grep` 匹配上限 `GREP_MATCH_CAP`）。

注：ZCode 的动态 schema 合成产出的是 JSON Schema 子集，不是 Zod；本引擎在 `json-schema-zod.ts` 中桥接。

### 11.2 Claude Code 2.1.316（闭源二进制对标）

来源：`docs/research/claude-code-binary-reverse.md`、`docs/research/claude-code-workflow-internals.md`、`docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md`。方法：对 win32-x64 平台二进制（335 MB PE32+，Bun 编译、内嵌 JS bundle）做 `npm pack` → 定向标记扫描；不分发任何反编译产物。

吸收的发现：

1. **预算是硬执行而非遥测**：`agent()` 调用硬上限 1000（`WorkflowAgentCapError`，官方反死循环文案）；Token 预算以 `agent()` 调用粒度执行（`WorkflowBudgetExceededError`）。本引擎实现同一上限与同一失败文案（`AGENT_CALL_CAP`，§6.4）。
2. **VM 执行同构**：Claude Code 同样在 VM 中运行工作流脚本（跨 realm await 绑定 + 跨界值消毒）并配 `workflow_phase` 进度投影——与 ZCode 及本引擎沙箱是趋同设计。
3. **重放键设计对比**：见 §6.5。
4. **停顿与重启语义**：90 秒停顿超时、5 次结构化输出重试上限、`stalled`/`replyLost` 区分为独立状态。本引擎的 `ask` 是带超时 + 瞬态重试分类的原子 Provider 调用——覆盖等价，无流式重启概念（停顿行为锁定于 `tests/unit/dwf/dwf-stall.test.ts`）。
5. **环境旋钮对齐**：`AI_WORKFLOW_MAX_CONCURRENT_AGENTS` 镜像 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`。

### 11.3 morluto/rea（逆向方法论）

来源：`docs/research/workflow-reverse-engineering.md` §3（方法论与实测）。

1. **工具**：rea（"Reverse Engineer Anything"，MIT）——面向 Electron/JS 应用的统一 MCP + CLI 静态分析工具集；此处用于静态分析 ZCode 桌面 `app.asar`，全程零代码执行。
2. **实测弧线**：全量 `analyze` → 类型化拒绝 `artifact_integrity_mismatch`（真实打包缺陷：`sharp-win32-x64/lib/libvips-42.dll` 字节与 ASAR 声明的 SHA-256 矛盾）；以 `--integrity-policy record-and-continue` 重跑 → 完整 Evidence（618 MB、27,645 个 JS 文件）；选择性 `--source-path` 分析 → 秒级。整个弧线 rea 未抛出任何裸异常：每个失败都是 `{code, category, message, retryable, remediation, details}` 且带可执行修复项。
3. **吸收**：类型化错误契约形状——机器可读的失败码加可行动 remediation，取代裸异常；以及完整校验纪律（即便选择性分析也清点整个产物）。
4. **OS 级进程树监管**（`src/process-supervision.ts`）：POSIX 子进程独立进程组（`detached: true`，组杀 `process.kill(-pid, 'SIGKILL')`）；Windows 无进程组，传统终止路径走树遍历（`taskkill /PID /T /F`）。原生的 Win32 Job Object 绑定（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + csc 编译助手 + 可选内存上限 + 记忆化降级链）已落地为现行机制（私有仓 Issue #98 Phase 2，见 §5.2）。

---

## 12. 威胁模型、红蓝对抗与沙箱安全边界

本引擎与官方实现都在头注释中声明：vm-realm 隔离的目标是**故障隔离与确定性——不是安全边界**。本项目不拿这句话当挡箭牌：卷宗 `docs/research/PENETRATION-AND-SECURITY-AUDIT.md`（TEST-GOAL 4.1；四案例；全部 PoC 保存于 `tests/adversarial/`）按"能否一条可利用链打穿"的标准攻击本引擎，`docs/research/WORKFLOW-GAP-MATRIX.md` 按 ID（D1-D8、R2-R4）追踪每一条残余缺口。撰写时的实测结果：发现一条完整沙箱逃逸链与一个凭据泄漏面，两者在审计成文时均已被修复关闭；DoS 防线全程守住。

### 12.1 案例 1 —— 沙箱逃逸（跨 realm Function / 构造链 / 原型污染 / 微任务伪造）—— 状态：PARTIAL（根因 D1 未修）

攻击（实测，PEN §2.1-2.2）：降级后的 facade 常量 `args` 曾以宿主域对象注入，`args.constructor.constructor` 抵达宿主 `Function` → 宿主 `process` → `process.binding('spawn_sync')` 任意命令执行（PoC2c 在工作区外写下 `PWNED-SPAWNSYNC-ESCAPE`）；跨 realm 原型污染（PoC3：宿主 `Object.prototype` 被污染并被宿主代码读回）；微任务在脚本返回后伪造 `{t:'done'}` 帧（PoC4：伪造结果 `MT-FORGED-DONE` 被接受）。

既有防线（两个独立层）：

- **AST 9002 原型链静态封印**（`src/dwf/compile.ts`）：`constructor`/`__proto__`/`prototype` 的点号与字符串下标双语法在编译期拒收，类型无关。修复后检查矩阵：全部 10 个逃逸夹具 `ok:false` 拒收——逃逸链在进入沙箱前死亡（PEN §2.6.2-3）；
- **PreSeed BOOTSTRAP 纪律**（§5.1）：入站仅限原语字符串 `__argsJson`，args 在 realm 内冻结为 context-native；`codeGeneration:{strings:false, wasm:false}` 拒绝 realm 造码（EvalError）；`__send`/`__timer` 捕获即删；入站 `__deliver` 宿主私有持有——脚本无法伪造 ok/err 或重放预算帧。

诚实的残余：**D1 根因**（宿主域对象图注入 realm；官方 `child-source.ts:202-206` 的 `__host.args` context-native 化）尚未修复。静态层此前的初始化位缺口（`const e = eval` / `const g = globalThis` —— GAP-MATRIX D3）已闭合：`isReference` 只豁免声明名位置，初始化位命中 9002（私有仓 Issue #40，测试锁定）。按"机制根因消除"标准，本案例为部分守住而非全守（PEN §2.4、§6.4）。

### 12.2 案例 2 —— 协议投毒（NDJSON 帧撕裂 / 注入 / 超大 / 洪泛）—— 状态：审计时 PARTIAL；帧预算已落地

攻击（PEN §3.1）：恶意或故障子进程向父端解析器喂跨 chunk 撕裂的帧、控制字符载荷（315 KB 含 `\r\n`/`\x00`/`\x1f`/`\u2028`/`\u2029`）、伪造的 `{t:"done"}` 终结帧、1 MB / 33 MB 单帧——当时无帧长上限，全部被接受；持续输出洪泛饿死事件循环（10 秒墙钟上界实测跑出 213 秒）。

状态：审计通道致盲（log/report 载荷丢失）已修复并金丝雀端到端验证（PEN §2.6.5）。审计后加固已落地审计要求的帧预算：单帧 16 MB / 分帧缓冲 32 MB、泵按每 tick 512 行让出（`src/dwf/runner.ts`，援引 docs/research/WORKFLOW-GAP-MATRIX.md 缺口 D4 与官方 `PROTOCOL_V4_LIMITS`）；ASCII 超大帧拒绝路径由 `tests/adversarial/goal-adv3-oversize-frames.test.ts` 锁定。针对审计 PoC 的洪泛活性复测未在本文档撰写时重跑。

### 12.3 案例 3 —— DoS 资源炸弹（深递归 / glob 炸弹 / 智能体风暴）—— 状态：HELD

攻击（PEN §4.1）：500 层嵌套 interface 链与真递归类型攻击 schema 合成；3000 文件工作区攻击 `files.glob`；64 并发 mock 智能体 × 1280 次 ask 攻击调度与调用上限。

防线（全部守住；9/9 回归通过，PEN §4.6）：

- Schema 合成：`MAX_DEPTH = 8` → 约 1.2 秒内报 `schema-synth(9005)`；真递归 → `9015` 点名站点与类型（`src/dwf/schema-synth.ts`）；
- Glob 上限：2000 文件；超限为可捕获的结构性拒绝（"files.glob matched more than 2000 files — narrow the pattern"），边界行为在恰好 2000 处验证（`host-boundary-dispatcher.ts` glob 分支）；
- 调用熔断：`AGENT_CALL_CAP = 1000` 硬保险丝——1280 次 ask 的风暴精确停在 1000，`WorkflowAgentCapError` 可捕获、运行存活；未捕获则运行结构性失败；
- 逐 Provider AIMD 治理：×0.75 降、每 4 成功 +1、下限 1、5 分钟空闲重置（`src/dwf/governor.ts`）。

### 12.4 案例 4 —— 凭据外泄（诱饵 Token 三矢量 + 错误路径）—— 状态：HELD（泄漏面已关；残余 R2）

攻击（PEN §5.1）：父 shell 植入诱饵 `GOAL_POC_TOKEN`；矢量：(1) `process.env` 直读；(2) `world.run` 子进程侧信道；(3) `files.grep`/`files.read` 扫描诱饵 `.env`；(4) 错误路径外泄。

防线：

- 编译期：`process` 是禁用标识符（9002）——矢量 1 根本进不了沙箱；
- 环境隔离：最小平台关键环境 + 显式白名单（`buildSanitizedEnv`），`world.run` 孙进程另有第二层白名单（`envAllowlist`）。矢量 2 输出 `TOKEN=***REDACTED***`，诱饵键名不在键清单中；
- **`CREDENTIAL_TOKEN_SHAPES` 值形状掩码**（`src/dwf/redact.ts`）：AWS `AKIA…`、GitHub `ghp_`/`github_pat_`、OpenAI `sk-…`、Slack `xox…`、JWT `eyJ…` 一律掩码为 `***REDACTED***`；journal 持久化落盘前先过 `redactValue`；
- 错误路径：KV 形状与 URI 形状掩码（`postgres://***:***@host`）——`dwf_failed` 事件无裸值。

诚实历史与残余：矢量 3 在审计当时是真实泄漏——原始 `.env`（含 `postgres://app:hunter2@…` URI）落入 CLI 结果与 journal——已通过持久化前 `redactValue` 关闭；被跳过的泄漏测试提升为真断言，5/5 通过（PEN §5.6）。残余：运行输入 `args_json` 仍明文存储（GAP-MATRIX R2）；Windows/libuv 会向显式设置的环境再注入 7 个众所周知键，白名单在 OS 层不是字节精确的（PEN §5.1 注）。

### 12.5 纵深防御模型与红蓝互评结论

单层失守不等于整线失守（PEN §6.2）：

| 层 | 机制 | 审计后状态 |
|---|---|---|
| 静态（编译） | 标识符/文本禁令 + `types: []` 类型检查；`PROTOTYPE_CHAIN_PROPS` 9002 | 逃逸夹具 10/10 拒收；初始化位缺口已闭合（D3，私有仓 Issue #40） |
| 运行时（vm realm） | `codeGeneration:{strings:false, wasm:false}` + PreSeed 仅原语跨界 | 作为静态层之后的纵深防御守住 |
| 资源（上限/超时/保险丝） | 深度 8 / glob 2000 / 1000 次调用保险丝 / 运行超时 | 全程守住（案例 3） |
| 掩码（边界） | 环境白名单、`CREDENTIAL_TOKEN_SHAPES`、journal 前 `redactValue` | 泄漏面已关；残余 R2（`args_json`） |
| 进程（OS 监管） | POSIX 进程组 / Win32 Job Object（`KILL_ON_JOB_CLOSE`）+ 降级链 | 已落地（§5.2），事件 `dwf_job_guard` 可观测 |

对官方实现的红蓝互评（PEN §6.3）：边界值卫生（context-native args）——官方领先；realm 加固（`codeGeneration` 禁令）——本引擎领先；资源防线（深度上限、硬调用保险丝 + Token 预算）——本引擎领先（官方已移除；其哲学是"取消即控制面"）；协议防线（帧上限、逐帧 schema 校验）——官方领先；凭据值形状——官方曾领先，现对齐。

最终结论（PEN §6.4 成文时点）：沙箱逃逸 **partial** / 协议投毒 **partial** / DoS **held** / 凭据外泄 **held**。按优先级排序的加固清单（14 项，D1 居首）见 PEN §7。

---

## 附：相关文档

- 编写实操与命令面：`docs/DEVELOPER_GUIDE.md`
- 文档总索引与防腐规则：`docs/README.md`
- 演进蓝图与缺口矩阵：`GOAL.md`、`docs/research/WORKFLOW-GAP-MATRIX.md`
- 渗透审计卷宗：`docs/research/PENETRATION-AND-SECURITY-AUDIT.md`
