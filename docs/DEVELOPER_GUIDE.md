# AI-Workflow 开发者指南

> **强类型、确定性、可持久重放的动态工作流编写实操手册**
> 本文件是开发者指南主题的单一事实源：模块二次开发、自定义 Agent/Step、Facade DSL 编写规范（编译期禁忌与 AST 约束）、沙箱测试、调试排障、测试分层与门禁。
> 全文与 `main` 分支真实代码对齐（代码优先于文档）：CLI 选项以 `src/cli/index.ts` 为准，脚本表面以 `src/dwf/facade-dts.ts` 为准，测试门禁以 `package.json` 为准。
> 架构原理（编译器、沙箱、journal 内核、持久化）见 `docs/ARCHITECTURE.md`；改码流程与提交纪律见 `docs/WORKFLOW.md`。

---

## 1. 两种编写面与阅读路线

本引擎提供两种互不替代的编写面：

| | Facade 脚本引擎（`src/dwf`，主推） | 核心构建器引擎（`src/core`） |
|---|---|---|
| 编写形态 | 单文件 TypeScript 脚本，只见封闭原语面 | `defineWorkflow` 对象清单或 `new Workflow()` 流式 API |
| 执行方式 | 编译 → 降级 → `node:vm` 沙箱子进程 + NDJSON 协议 | 进程内直接执行步骤执行器 |
| 确定性保证 | journal 内核：`(runId, siteId, ordinal)` + `inputHash`，逐节点零成本重放 | inputHash 绑定的步骤检查点，失败步骤后零 Token 续跑 |
| 控制流 | 原生 TypeScript（无阶段依赖 DAG，`phase()` 仅是展示标记） | 声明式 `dependsOn` 依赖图 + Kahn 拓扑校验 |
| 适用场景 | 需要沙箱隔离、逐站点审批、amend/续跑、零 Token 重放的模型编排 | 需要声明式依赖图、确定性 shell 门禁、传统单测组合的长流程 |

推荐路径：新项目一律从 **Facade 脚本**起步（§3）；与既有 `defineWorkflow` 生态集成或需要声明式门禁图时用核心构建器（§4）。

---

## 2. 快速上手：脚手架与 CLI

### 2.1 创建第一个工程

```bash
# 基础模板：探测 → 智能体 → 产物
node bin/workflow.js init basic my-first-workflow

# 多智能体模板：结对审查 + 脚本门禁
node bin/workflow.js init multi-agent my-agent-pipeline

cd my-agent-pipeline
npm install
npm test
```

脚手架目录结构：

```
my-agent-pipeline/
├── package.json            # 最小包描述（type: module）
├── tsconfig.json           # ES2022 + NodeNext
├── README.md               # 运行说明（workflow run workflow.ts --mock）
├── workflow.ts             # 核心工作流定义（defineWorkflow）
└── .gitignore              # node_modules/、.workflow/、dist/
```

### 2.2 CLI 命令速查

`node bin/workflow.js --help` 查看全集。按用途分组（与 `src/cli/index.ts` 一致）：

- **运行与编排**：`run <file>`（核心构建器）、`run-script <file>`（Facade 脚本，§3.1）、`demo`（旗舰事故分诊一键演示：离线 mock + Studio 看板）、`replay <runId>`（统一续跑/重放入口，§6.3）、`author <intent...>`（意图生成脚本）、`check <file>`（编译期自检，§5.1）
- **检视与观测**：`inspect <runId>`、`graph <file> --format html|mermaid|ascii`、`probe [targetDir]`、`list`、`view <runId>`（渲染 Studio 单页）、`serve <runId>`（Studio 实时服务）、`stop <runId>`、`doctor`（环境自检）
- **人工介入**：`fill <runId> <holeName> [bodyFile]`（补 hole）、`answer <runId> <questionId> <text...>`（答 escalate 提问）——两者都只接受 `parked` 状态的运行
- **注册表与集成**：`workflows list|run`（已保存脚本注册表，`.workflow/workflows/`）、`mcp list|call|serve`、`setup`（互通配置）、`new <name>`、`export-schema`、`ultracode <task>`

### 2.3 CLI 全量命令手册（自 README 迁入）

以下命令面以 `src/cli/index.ts` 与 `src/cli/commands/*.ts` 的现行实现为准。

| 分组 | 命令 | 用途 | 关键选项 |
|------|------|------|---------|
| **执行** | `run <file>` | 统一执行入口，自动识别 Facade 脚本与 Builder 定义 | `-m --mock`、`--set <k=v>`（可重复）、`--args-file <file>`、`-a --args <json>`、`--resume <runId>`、`--amend <runId>`、`--ui`、`--live <path>`、`--watch-graph`（默认开启，Issue #168）、`--no-watch-graph`、`--cwd <path>`、`-c --max-concurrency <n>`、`--budget-total <n>`、`--run-timeout <ms>`、`--failover <ids>`、`-r --resume-from-failed <runId>`（Builder）、`--dry-run`、`-o --out <dir>`、`-l --lang en\|zh` |
| | `check <file>` | 编译检查 Facade 脚本，打印诊断、阶段图与站点表（不执行） | `-j --json` |
| | `run-script <file>` | 以沙箱引擎执行 Facade 脚本（journal 重放） | `run` 全部 Facade 选项，另加 `--rerun <runId> --from <siteId>`、`--approve-cmd <name>`（可重复） |
| | `demo` | 一键旗舰演示：离线 mock 运行 incident-triage facade、渲染 Studio 看板并打开浏览器 | `--lang en\|zh`、`--no-open`、`--open` |
| | `replay <runId>` | 重放或恢复 Builder 工作流执行 | `-s --step <stepId>`、`-f --force-recompute`、`-r --resume-from-failed`、`-m --mock`、`--file <path>` |
| | `stop <runId>` | 强杀运行中的 Facade 进程树，解锁 resume / amend / fill | `--db <path>` |
| **观测** | `list` | 历史运行列表 | `-n --limit`、`-s --status`、`-j --json`、`--db <path>` |
| | `inspect <runId>` | 节点级遥测、检查点与事件流 | `-e --events`、`-s --step`、`-j --json` |
| | `graph <file>` | DAG 可视化 | `-f --format html\|mermaid\|ascii`、`-o --output <path>` |
| | `serve <runId>` | 实时 Studio 看板（SSE / WebSocket 推送） | `--studio`（SVG 画布 + 时间旅行）、`-p --port`（默认 4649）、`--no-open`、`--db <path>`（journal 路径，默认 `.workflow/dwf.sqlite`） |
| | `view <runId>` | 导出独立 HTML 运行报告 | `-o --out <path>`（默认 `.workflow/views/<runId>.html`） |
| **人机协作** | `fill <runId> <holeName> [bodyFile]` | 为停靠的 hole 补洞，分叉续跑 | `-b --body <statements>` |
| | `answer <runId> <questionId> <text...>` | 回答停靠的 escalate 提问并恢复运行 | `--approve-cmd <name>`（可重复） |
| **创作** | `new <name>` | 按模板脚手架 Facade 工作流（`code-review` / `incident-triage` / `repo-migration` / `multi-agent`） | `-t --template`、`-d --dir` |
| | `init <template> [dir]` | Builder 工作流建项（`basic` / `multi-agent`） | `-d --dir`、`--force` |
| | `author <intent...>` | 一句自然语言生成 Facade 脚本：生成 → 编译检查 → 自愈（至多 3 次）→ 落盘，**从不执行** | `-o --out`、`--provider`、`--model`、`--max-tokens` |
| | `ultracode <task>` | 从任务描述合成工作流脚本并可试运行 | `--save <name>`、`--mock`、`--run`、`--provider` |
| **环境** | `doctor` | 七项就绪度体检（runtime / compiler / git / journal / sandbox child / install integrity / providers） | `-j --json` |
| | `probe [targetDir]` | 主机环境与工具链确定性探测 | `-o --output json\|text`、`-j --json`、`-s --strict` |
| **注册表与互通** | `workflows list` / `workflows run <name>` | 已保存工作流注册表（项目覆盖全局） | `-a --args <json>`、`-r --resume`、`--live <path>` |
| | `setup` | 生成编码助手互通配置 | `-t --target claude\|opencode\|codex\|zcode\|all`、`-d --dir` |
| | `export-schema` | 导出引擎工具面为 OpenAI function-calling JSON Schema | `-f --format`、`-o --out <path>` |
| | `mcp list` / `mcp call` / `mcp serve` | MCP 工具列举、调用与 stdio 服务端 | `-j --json`、`-m --mock` |

通用选项：`-l --lang <en|zh>` 控制界面语言（亦可经 `AI_WORKFLOW_LANG` 设置）；`--db <path>` 指定 journal 数据库路径（默认 `.workflow/dwf.sqlite`）。

### 2.4 常用环境变量

| 变量 | 作用 |
|------|------|
| `AI_WORKFLOW_PROVIDER` | 将 worker ask 路由到外部智能体 CLI（`codex` / `gemini` / `opencode`） |
| `AI_WORKFLOW_FAST_PROVIDER` / `AI_WORKFLOW_DEEP_PROVIDER` | `fast` / `deep` tier 的默认 Provider |
| `AI_WORKFLOW_STALL_MS` | 每 ask 停滞时钟（默认 90000，`0` 关闭） |
| `AI_WORKFLOW_MAX_CONCURRENT_AGENTS` | 并发 ask 上限覆盖：未设置时（CLI 选项亦未传入）取默认公式 `min(16, max(2, availableParallelism() - 2))`；显式 `--max-concurrency` 选项优先于本变量 |
| `AI_WORKFLOW_SANDBOX_MAX_OLD_SPACE_MB` | 沙箱子进程内存上限 |
| `AI_WORKFLOW_LANG` | 默认界面语言 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 显式配置时才注册 HTTP Provider，绝不自动拨号 |
| `AI_WORKFLOW_ANTHROPIC_CACHE` | Anthropic 提示缓存开关（`1`/`0`）；未设置时官方端点默认开、自定义 `ANTHROPIC_BASE_URL` 默认关（代理可能拒绝该字段） |

### 2.5 MCP 工具面（10 个工具）

`node bin/workflow.js mcp serve` 以 stdio 启动内置 MCP 服务端（亦可通过 `setup` 生成的项目级配置接入 Claude Code 等客户端）。工具目录以 `src/mcp/tool-catalog.ts` 的 `TOOL_CATALOG` 为准（`server.ts` 再导出），共 10 个：

**Facade 工具（推荐，5 个）**

| 工具 | 用途 |
|------|------|
| `workflow_script_check` | 编译检查 Facade 脚本，返回诊断、阶段图与站点表，不执行 |
| `workflow_script_run` | 沙箱执行 Facade 脚本（确定性 journal；`resumeRunId` 重放零 Provider 调用），返回 runId、状态、结果与统计 |
| `workflow_run_script` | 经沙箱引擎执行并返回逐站点摘要（siteId / ordinal / status / durationMs），受 `runTimeoutMs` 约束；`resumeRunId` 重放零 Provider 调用 |
| `workflow_inspect_run` | 检查 journal：`dwf_runs` 状态行、脱敏后的 `dwf_nodes` 逐站点表与证据账本摘要 |
| `workflow_get_run` | 获取 journal 短路统计：总 ask 数、重放命中、amend 命中、分叉数与 `world.run` 执行数 |

**Legacy 工具（已标 deprecated，5 个）**

| 工具 | 用途 | 替代 |
|------|------|------|
| `workflow_run` | 按文件路径执行 Builder 工作流 | `workflow_script_run` |
| `workflow_probe` | 确定性环境探测（含脱敏） | `workflow_script_*` 面 + `probe` |
| `workflow_inspect` | 从 SQLite 存储检查运行 | `workflow_inspect_run` |
| `workflow_replay` | 从失败处重放 | `workflow_script_run`（`resumeRunId`） |
| `workflow_graph` | 静态 DAG 可视化 | `workflow_script_*` 面 + `graph` |

所有工具响应在跨出脱敏边界前统一经 `redactValue` 掩码，凭据形状规则（AWS、OpenAI、GitHub、Slack、JWT 等）内建于 `src/dwf/redact.ts`。

---

## 3. Facade 脚本编写规范（主推面）

### 3.1 最小示例与运行

```typescript
// workflow.ts —— 只使用 facade 原语，import 任何 Node API 都是编译错误
interface Report { issues: string[]; summary: string }

phase('调研');

const inspector = agent('Inspector', { provider: 'mock' });
const report = await inspector.ask<Report>('审查仓库健康度，列出发现的问题');
log(`发现问题：${report.issues.length}`);

phase('验证');
const result = await world.run('npx', ['tsc', '--noEmit']);
if (result.exitCode !== 0) throw new Error('类型检查未通过');

report({ summary: '完成', issues: report.issues });
```

```bash
node bin/workflow.js run-script workflow.ts --args '{"repo":"."}'
```

`run-script` 常用选项（`src/cli/index.ts`）：

| 选项 | 说明 |
|---|---|
| `-a, --args <json>` / `--args-file <file>` / `--set <k=v>` | 脚本输入（脚本内 `args`）；`--args-file` 为 PowerShell 安全的零转义方案，`--set` 可重复并带类型推断 |
| `-r, --resume <runId>` | 续跑：已完成节点按 journal 零模型调用重放（脚本必须字节一致） |
| `-m, --amend <runId>` | 修订：用编辑后的脚本分叉新运行，未变更节点从暖缓存重放 |
| `--rerun <runId> --from <siteId>` | 同一脚本从指定站点起重新执行：更早站点走暖缓存，该站点起真实执行（站点表见 `workflow check` 输出） |
| `-c, --max-concurrency <n>` | 子代理 ask 并发上限（显式传入即钉死该值；未配置——选项与环境变量均未设置——时默认取 `min(16, max(2, availableParallelism() - 2))`） |
| `--budget-total <n>` | 运行的输出 Token 预算（脚本内只读） |
| `--approve-cmd <name>` | 为本次运行批准一条 `world.run` 命令（可重复；脚本自带清单不再自行授权） |
| `--failover <ids>` | ask 失败时的换道 Provider 链（逗号分隔，如 `mock,gemini-cli`） |
| `--live <path>` / `--watch-graph` / `--no-watch-graph` / `--ui` | 运行中自刷新 HTML / 每事件重写 run 目录 graph.html（**默认开启**：run 启动即写出全量 pending 计划骨架 `dwf_plan`，随执行实时点亮，冷回放与活跑字节一致，Issue #168）/ 显式关闭 watch 视图 / 落定后启动 Studio 并开浏览器 |
| `--db <path>` | journal 数据库路径（默认 `.workflow/dwf.sqlite`） |

### 3.2 Facade 原语全景（`src/dwf/facade-dts.ts`）

脚本作者**只见以下原语**，其余 Node/Web ambient API（`process`、`fetch`、`fs`…）在类型检查阶段即被拒绝：

| 原语 | 签名（摘要） | 语义 |
|---|---|---|
| `agent(name, opts?)` | `opts?: { provider?; tier?; model?: ModelRef \| string }` | 创建子代理（一次调用一个新会话；共享返回值即共享会话）。`ask #2` 承接 `ask #1` 上下文；忙碌时新 ask 按 FIFO 等待。`model` 绑定优先于 provider/tier |
| `p.ask<T>(instructions)` | `Node<T>` | 带类型参数时按编译期合成的 JSON Schema 校验答案；无类型参数时返回最终回复文本 |
| `phase(name)` | 字面量必填 | 标记阶段起点（展示标记；无依赖语义） |
| `log(message)` / `report(item)` / `report(item, presetId)` | | 进度消息 / 发布中间结果 / 带标签的中间结果（喂给已声明的 preset；标签必须指向已声明的 chart/table/metrics/board id） |
| `plan(update)` | `update?: { nodes?: [{ id; name?; phase? }]; edges?: [{ from; to }] }` | **mid-run 计划图演进（Issue #171）**：实时给 graph.html 加框（pending 计划节点，id 为脚本自选运行时值）加线（任意依赖边，可连真实 siteId——端点未出现时先缓冲、出现即显形）；重复 id 幂等；从不执行的节点保持 pending，与启动骨架同语义 |
| `args` | `Record<string, unknown>` | 运行输入（来自 `--args`），编译期未知，使用前先收窄 |
| `run` | `{ id; resumedFrom? }` | 运行身份（落款产物与账目；`resumedFrom` 指向 amend 的父运行） |
| `budget` | `{ total; spent(); remaining() }` | 输出 Token 预算，**只读**（运行配置注入，脚本不能自抬上限） |
| `artifact.file(id, path)` / `artifact.markdown(id, content)` | | 发布用户保留的文件或 markdown（内容族：效应，可捕获拒绝） |
| `artifact.chart/table/metrics/board(id, spec)` | spec 形状见 facade d.ts | **声明族**：同步、void、一次写——由 `report(item, id)` 供数；同 id 幂等、异 spec/越权 primary/第 33 个 id 整个 run 失败；声明必须位于顶层（循环/回调/条件内禁止） |
| `model("id")` | 仅限 agent opts.model 位置 | 将 actor 绑定到模型（`"modelId"` / `"providerId/modelId"`，可带 `"$level"` 后缀）；按 run 的 modelDirectory 解析，未解析的 id 在 actor 创建即失败 |
| `hole<T>(name, prompt?)` | 字面量名必填 | 类型化空位：运行到未填充的 hole 时挂起（`parked`），用 `workflow fill` 补齐后分叉 amend 继续 |
| `escalate(question)` | | 阻塞式人工提问：运行挂起，用 `workflow answer` 回答（回答入账后续跑） |
| `workflow(name)` | 注册表名 | 把已保存工作流作为子运行编排；链最多 5 层且名字不得重复（成环即报错并点名全路径） |
| `fanout.parallel(thunks)` / `fanout.pipeline(items, ...stages)` | 传 thunk 而非 promise | 并行（失败槽位变 `null`，绝不 reject）/ 流水线（逐项独立流过各阶段，`null` 截断该项下游） |
| `swarm<T>(agents, tasks)` | | 任务 i 给 `agents[i % agents.length]`；并发受 `maxConcurrency` 约束；预算超支槽位落 `null`，其余首败拒绝整个 swarm |
| `sessions.waitAny/race/cancel` | | 持久会话工作器：任一落定 / 竞速（落定即取消其余） / 取消在途 turn |
| `channel<T>()` / `future<T>()` | | 脚本内并发协调：无界缓冲 FIFO 通道（纯 cell，不入 journal）/ 一次性单值信箱 |
| `files.glob/read/grep/map` | | 工作区只读视图：glob 超 2000 文件拒绝；`grep` 匹配上限 2000；`map` 返回预算内的 AST 符号地图（500 文件上限） |
| `git.changedFiles/diff/status/log` | | 工作树只读视图；仓库外一律拒绝 |
| `world.run(cmd, args?, opts?)` | 命令名必须编译期字面量 | 固定 argv、从不进 shell；非零退出也是 resolve，仅 spawn 失败或超时 reject（默认 300000 ms） |

### 3.3 编译期禁忌与 AST 约束（写脚本前必读）

编译器（`src/dwf/compile.ts`）强制**脚本必须是 (脚本源码, args) 的纯函数**。禁令按诊断码分组：

**9002 纯度禁令——标识符**：`eval`、`Function`、`globalThis`（造码与越权求值）、`process`、`require`（进程/模块/环境权威）、`fetch`、`Buffer`（未经授权面的网络与字节出口）、`setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`（带外调度，破坏线性站点序与重放确定性）。

**9002 纯度禁令——成员**：`Date.now`、`Date.parse`、无参 `new Date()`（墙钟）、`Math.random`（熵源）。合法的时间与随机性只能经 `args` 注入；`Date`/`Math` 标识符本身合法（成员粒度最小约束，注入的时间戳可正常取值与格式化）。

**9002 原型链禁令**：`constructor`、`__proto__`、`prototype` 的点号与字符串字面量下标双语法一律拒收（`({}).constructor.constructor` 即零 import 逃逸的梯子）；初始化位同样在管辖内——`const e = eval`、`const g = globalThis` 命中 9002。

**9003 字面量规则**：`phase()` 名、`hole()` 名、`world.run` 命令名必须是编译期字符串字面量（审批图与命令清单由它们画出）。

**9014 facade 误用**：`agent()` 的 `provider`/`tier` 必须是编译期字面量（路由是"已审批运行形态"的一部分）；包裹式调用 `(agent)("x")` 按 fail-closed 拒绝。

**9005 / 9015 schema 合成上限**：`ask<T>` 类型参数合成深度上限 8（超限报 9005）；真递归类型报 9015 并点名站点与类型名。

**其余约束**：脚本内禁止遮蔽 facade 标识符（`agent`、`phase`、`files`、`git`、`world` 等）；facade 函数只能以直接调用的形式出现（`agent("x")` 合法，别名赋值后调用拒收）。诊断行号始终回映射到你的原始行号。

自检方式：`node bin/workflow.js check workflow.ts` 返回诊断、阶段与站点表（site table），不执行任何东西。

### 3.4 断点续跑、amend 与 rerun

- **`--resume <runId>`**：脚本字节一致时，已完成节点从 journal 零 Provider 调用重放，失败节点真实重执行；宿主崩溃留下的陈旧 `running` 行会被接管（pid 存活探针）。
- **`--amend <runId>`**：编辑脚本后分叉新运行；`run.resumedFrom` 指向父运行；未变更节点（`inputHash` 一致）从暖缓存零成本重放，输入分歧的节点当场分叉为真实执行（事件 `dwf_amend_diverged`）。
- **`--rerun <runId> --from <siteId>`**：同一脚本从指定站点起重来；更早站点走暖缓存。站点 ID 以 `workflow check <file>` 输出的站点表为准。
- **运行终态**：`completed` / `failed` / `compile_failed` / `parked` / `stopped`。`parked`（hole 或 escalate 等待中）不是失败——用 `fill` / `answer` 恢复。

### 3.5 并发原语的使用边界

- `fanout.parallel`/`pipeline`/`swarm` 都收 **thunk**（`() => agent(...)`），不是 promise——提前创建的 promise 不受并发治理与取消语义约束；
- `channel`/`future` 是纯 cell：不入 journal、不跨运行边界，仅用于单次运行内的并发协调；关闭后的 `send` 抛出可捕获的 `ChannelClosed`，无人可达的挂起接收者以 `ChannelDeadlock` 拒绝；
- `sessions.race` 的输家 turn 会被真实取消（Provider 调止中止），但被取消的 turn 重放时按"从未发生"处理——请传裸 `agent(...).ask(...)` turn 而非包装 promise。

### 3.6 world.run 授权与预算

- 脚本内 `world.run('npx', [...])` 的命令名必须是字面量；运行前命令集展示给运行所有者审批，运行时授权来源（`explicit` / `allowlist` / `tty`）逐条落账（事件 `dwf_world_run_auth`）；
- 预算以 `agent()` 调用粒度执行输出 Token 上限：超支阻止**后续** `agent()` 调用（`WorkflowBudgetExceededError`），在途 ask 完成且结果保留；`budget.remaining()` 判终止的循环永远等不到 0——防死循环靠 `AGENT_CALL_CAP`（1000 次硬熔断）。

---

## 4. 核心构建器编写（`defineWorkflow`）

### 4.1 声明式定义完整示例

`defineWorkflow` 接受宽容写法：`phases` 可以是字符串数组或 `{id, name}` 对象数组；步骤的 `phase`/`phaseId`、`dependencies`/`dependsOn` 双写法等价；`role` 缺省为 `worker`（`inspector` → probe 节点、`gate` → gate 节点、其余 → action 节点）。以下示例覆盖探测、强类型 RPC 与确定性门禁三类步骤：

```typescript
import { z } from 'zod';
import { defineWorkflow } from 'ai-workflow';

// 1. 定义 Zod 运行时校验模式
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
  description: '探测仓库、执行强类型安全审计并通过脚本门禁验证',
  phases: [
    { id: 'discovery', name: '环境探测' },
    { id: 'audit', name: '多智能体安全审计' },
    { id: 'verification', name: '编译与测试验收' },
  ],
  steps: [
    {
      id: 'step-1-probe',
      name: '探测仓库与 Git 状态',
      phaseId: 'discovery',
      role: 'inspector',
      execute: async (ctx) => {
        const probe = await ctx.probe();
        ctx.set('gitCommit', probe.git.commitShort);
        return { isDirty: probe.git.isDirty, branch: probe.git.branch };
      },
    },
    {
      id: 'step-2-auditor',
      name: '安全审计智能体',
      phaseId: 'audit',
      role: 'worker',
      dependsOn: ['step-1-probe'],
      execute: async (ctx) => {
        const branch = ctx.get<string>('branch', 'main');
        const audit = await ctx.agent('SecurityAuditor').ask<CodeAudit>(
          `针对分支 "${branch}" 审计潜在 CVE 与 SQL 注入风险。`,
          CodeAuditSchema,
          {
            temperature: 0.1,
            maxRetries: 3,
            mockResponse: {   // 离线 mock 模式的确定性响应
              issuesFound: 1,
              vulnerabilities: ['CWE-89: 认证路由存在拼接 SQL 风险'],
              recommendedAction: 'REFACTOR',
              patchContent: 'const query = db.prepare("SELECT * FROM users WHERE id = ?");',
            },
          },
        );
        ctx.set('auditResult', audit);
        return audit;
      },
    },
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
        const gate = await ctx.gate('npm test');
        if (!gate.passed) {
          throw new Error(`门禁未通过，退出码 ${gate.exitCode}：${gate.stderr}`);
        }
        await ctx.recordArtifact('AUDIT_REPORT.md', `# 审计报告\n建议: ${audit.recommendedAction}`);
        return { verified: true, durationMs: gate.durationMs };
      },
    },
  ],
});
```

### 4.2 `ExecutionContext` 能力面（`src/core/context.ts`）

步骤执行器收到的 `ctx` 提供：

- `ctx.probe(options?)`：确定性环境探测（结果同时落入探测快照）；
- `ctx.agent(name).ask<T>(prompt, schema, options?)`：强类型 RPC（自愈重试循环见 `docs/ARCHITECTURE.md` §6）；
- `ctx.gate(command, { cwd?, timeoutMs? })`：确定性 shell 门禁；
- `ctx.set(key, value)` / `ctx.get<T>(key, default?)` / `ctx.has(key)`：运行内变量；
- `ctx.getOutput<T>(stepId)` / `ctx.setOutput`：按步骤 ID 读取上游输出（`defineWorkflow` 会自动把上游输出喂给下游 runner）；
- `ctx.recordArtifact(name, content, type?, stepId?)`：登记产物；
- `ctx.mcp.callTool(server, tool, args?)`：MCP 工具调用（懒连接；`disposeMcp()` 之后调用抛 `McpClientClosedError`）；
- `ctx.log(message)`、`ctx.signal?.aborted`：进度输出与取消信号（并行失败时自定义代码应尽早退出）。

### 4.3 强类型 Agent RPC 最佳实践

**Schema 设计从严**：字段约束越明确，自愈循环收敛越快：

```typescript
const TriageSchema = z.object({
  severity: z.enum(['P1', 'P2', 'P3', 'P4']),
  rootCause: z.string().min(5),
  confidenceScore: z.number().min(0).max(1),
  affectedServices: z.array(z.string()).nonempty(),
  recommendedAction: z.string(),
});
```

**确定性测试**：mock 模式下经 `mockResponse` 注入固定响应，单测毫秒级完成且不花钱。注入值与生产路径同受 schema 契约约束——zod/结构化校验器走 `parse`，纯 JSON-Schema 形状也会经 `zodFromJsonSchema` 校验，违规抛 `SchemaValidationError`（Issue #53），桩值无法再伪装成 completed：

```typescript
const result = await ctx.agent('TriageAgent').ask(prompt, TriageSchema, {
  mockResponse: ctx.isMock ? defaultMockTriage : undefined,
  maxRetries: 3,
});
```

### 4.4 确定性脚本门禁

门禁是穿插在概率性 AI 步骤之间的"物理定律"。退出码语义：

- **退出码 `0`**：门禁通过，下游依赖步骤放行；
- **非零退出码**：抛出 `GateFailureError`，默认立即失败（该错误标记 `isRecoverable: false`，见 §4.5）。

跨平台脚本放 `gates/` 目录（Windows `.cmd` / POSIX `.sh`）：

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

### 4.5 重试与不稳定门禁

步骤的 `retryPolicy`（`maxRetries`、`initialDelayMs`、`backoffFactor`）在失败后整步重跑，但只针对重试可能改变结果的错误：

- 未配置 `retryableErrorFilter` 时，标记 `isRecoverable: false` 的错误不重试——`GateFailureError`、`McpToolError`、`SchemaValidationError`、`WorkflowAbortedError` 都属此类，门禁失败默认立即失败；未打此标记的错误照常重试；
- 要重试不稳定门禁（偶发失败的测试或网络检查），显式放行。配置了过滤器时由过滤器单独决定：

```typescript
import { gateStep, GateFailureError } from 'ai-workflow';

const smoke = {
  ...gateStep({ id: 'smoke', name: 'Smoke test', phaseId: 'verify', command: 'npm run smoke' }),
  retryPolicy: {
    maxRetries: 2,
    initialDelayMs: 1000,
    retryableErrorFilter: (err: Error) => err instanceof GateFailureError,
  },
};
```

### 4.6 并行步骤失败时

同时就绪的步骤并行执行。其中一个失败时：

1. 兄弟步骤经 `ctx.signal` 被取消：不再发起新的 `agent().ask`、`mcp.callTool` 或 `gate()` 调用（均抛 `WorkflowAbortedError`），在途模型请求一并中止；
2. 已在执行的工具调用与门禁命令**不会被打断**——写操作绝不半途而废，运行等待它们到各自的超时；
3. 运行上报第一个失败；被取消的兄弟步骤记为失败，其 `step_failed` 事件带 `cancelled: true` 与 `cancelledBy: "<步骤 id>"`，`--resume-from-failed` 会真实重执行它。

耗时较长的自定义代码应轮询 `ctx.signal?.aborted` 并提前返回。

---

## 5. 沙箱与安全测试

### 5.1 编译期自检：`workflow check`

沙箱的静态防线全部前移到了编译期（详见 `docs/ARCHITECTURE.md` §4）。提交运行前先自检：

```bash
node bin/workflow.js check workflow.ts
# 输出：诊断（9002/9003/9014/9005/9015…）、阶段列表、站点表（每个 agent/ask/hole/world.run 调用点）
```

站点表同时是 `--rerun --from <siteId>` 的寻址依据。运行期防线（`node:vm` realm + PreSeed + 帧预算 + Job Object 监管）无需脚本作者配置，行为规格见架构文档 §5。

### 5.2 脱敏与环境白名单

- journal 落盘前 journalled 值必过 `redactValue`：AWS/GitHub/OpenAI/Slack/JWT 等值形状掩码为 `***REDACTED***`；错误路径另有 KV 与 URI 形状掩码；
- 子进程环境采用白名单制（`SPAWN_ENV_ALLOWLIST` + `buildSanitizedEnv`）：shell 里的 API Key、Token 不会泄入派生命令或沙箱；
- 残余风险如实声明：运行输入 `args_json` 目前明文存储（GAP-MATRIX R2）——不要把密钥放进 `--args`。

### 5.3 对抗与压力测试

`tests/adversarial/` 收录全部渗透 PoC 回归与压力套件（沙箱逃逸夹具、超大帧、并发风暴、门禁边界完整性等），经 `npm run test:adversarial` 执行。新增对抗用例时保持"PoC 可复跑"纪律（见 `docs/AI-EVIDENCE-STANDARD.md`）。

---

## 6. 调试与排障

### 6.1 常用命令

```bash
node bin/workflow.js doctor                      # 环境自检（Node 版本、工具链、配置）
node bin/workflow.js check workflow.ts           # 编译期诊断 + 站点表
node bin/workflow.js probe <dir>                 # 只跑环境探测（含脱敏预览）
node bin/workflow.js inspect <runId>             # 检查点、事件、产物
node bin/workflow.js view <runId>                # 渲染 Studio 单页（离线可看）
node bin/workflow.js serve <runId>               # Studio 实时服务（时间旅行）
node bin/workflow.js stop <runId>                # 停止在途运行
```

### 6.2 运行数据在哪

`.workflow/` 是 gitignore 的运行时状态目录：journal 库 `dwf.sqlite`、逐运行目录下的 `events.jsonl` 与检查点。**不要提交它，也不要删除可能还要续跑的运行**——`run-script --resume <runId>` 依赖 journal 完整。事件流（`workflow_start`、`dwf_ask_complete`、`dwf_replay_hit`、`dwf_failover`…）是排障第一现场；事件词汇表见 `docs/ARCHITECTURE.md` §8.2。

### 6.3 统一续跑/重放入口：`workflow replay <runId>`

`replay` 是两套引擎共用的前台：从持久化存储判别运行种类再分发——Facade 脚本运行委托 `run-script --resume`（journal 短路 + 陈旧行接管 + 脚本哈希绑定）；核心构建器运行从随运行持久化的字节副本重建定义后对原存储真实执行（已完成步骤经 inputHash 绑定的检查点零成本短路）。定义/脚本无法重建时以 `[StorageError]` 非零退出——**绝不伪造成功**。

```bash
node bin/workflow.js run workflow.ts --resume-from-failed <runId>   # 核心引擎：跳过 1-3 步，0 Token 续跑
node bin/workflow.js replay <runId>                                  # 两种运行通用
```

### 6.4 常见失败与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| 诊断码 9002 | 脚本触到纯度禁令（`process`/`Date.now`/原型链…） | 按诊断行号改写；时间与随机性经 `args` 注入 |
| 诊断码 9003/9014 | 非字面量实参（`phase()`/`hole()`/`world.run` 命令、`provider`/`tier`） | 改为编译期字符串字面量 |
| 诊断码 9005/9015 | `ask<T>` 类型过深（>8）或递归 | 拍平类型或显式收敛递归 |
| `WorkflowAgentCapError` | 1000 次 ask 熔断（通常是 `budget.remaining()` 判终止的死循环） | 改用计数上限或 `--from` 重跑 |
| `WorkflowBudgetExceededError` | 输出 Token 预算用尽 | 调大 `--budget-total` 或削减 ask 数量；在途结果已保留 |
| `WorkflowAbortedError` | 并行兄弟步骤失败触发取消 | 查首个失败步骤（`cancelledBy` 字段），修复后 `--resume-from-failed` |
| `[StorageError]`（replay） | 运行目录被清理或脚本不可读 | 从源码重建运行；不要删除 `.workflow/` |
| `files.glob` 超限拒绝 | 匹配超过 2000 文件 | 收窄 glob 模式（结构化拒绝，可捕获） |

---

## 7. 测试分层与本仓开发门禁

以下门禁治理**本仓库（引擎本体）**的改动，不适用于脚手架生成的项目。

**先构建后测试。** `npm test` 执行 `dist/` 下的编译产物——不先 `npm run build` 就是在测旧代码。`bin/workflow.js` 同样优先加载 `dist/`，CLI 与源码会漂移。拿不准就先 `npm run build`。

### 7.1 门禁命令表（`package.json`）

| 命令 | 内容 | 说明 |
|---|---|---|
| `npm run build` | `tsc`（strict） | 产出 `dist/`；全新安装时 `postinstall` 还会自链接 + 引导 fixture SDK 桩 |
| `npm test` | `node --test` 跑 `dist/tests/` 的 unit + integration | 必须先构建 |
| `npm run test:unit` / `test:integration` | 单层执行 | integration 固定 `--test-concurrency=1`（含预算、failover、replay、MCP 等花钱与恢复路径） |
| `npm run test:e2e` | 分层 E2E runner（`tests/e2e/runner.ts`） | type-stripping 直接跑 TS；Tier1 功能 → Tier2 边界 → Tier3 组合 → Tier4 场景 |
| `npm run test:adversarial` | Tier-5 对抗压力套件（`tests/adversarial/`） | 含渗透 PoC 回归与演示压力脚本 |
| `npm run test:pbt` | fast-check 性质测试（`.kiro/pbt/`） | DAG 拓扑、引擎不变式、NDJSON 往返、脱敏差分、重试分类 |
| `npm run test:governance` | 治理锁死测试（`tests/unit/workflow-governance.test.ts`） | 锁死文档措辞与流程要素 |
| `npm run gate` | build → capture-failure-names → e2e → adversarial → pbt → governance | 一键合入门禁：退出码 0 即全绿 |
| `npm run coverage` | `c8` 覆盖 `npm test` | HTML 报告在 `coverage/`（gitignore）；关键模块设有逐文件 84% 行覆盖下限——只许上调不许下调 |

### 7.2 `tests/` 目录结构

```
tests/
├── unit/           # 单元（含 dwf/ 编译器·journal·监管、fixtures/ 受控夹具）
├── integration/    # 集成：预算、failover、replay、MCP、hole/escalate、composition
├── adversarial/    # Tier-5：渗透 PoC 回归与压力
├── cross-engine/   # 跨引擎一致性
└── e2e/            # 分层场景：tier1-features / tier2-boundaries / tier3-combinations / tier4-scenarios
```

改动触及 `src/dwf`、`src/mcp`、`src/cli/commands`、`src/state` 或对应 `tests/integration/**` 时，`npm run test:integration` **必跑**（完整门禁矩阵见 `AGENTS.md` §四）。

### 7.3 测试写法（Node.js 22 内置 runner）

```typescript
// tests/my-workflow.test.ts
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import myWorkflow from '../workflow.js';

test('工作流在离线 Mock 模式下端到端跑通', async () => {
  const result = await myWorkflow.run({ mockMode: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.failedSteps.length, 0);
  assert.ok(result.durationMs < 2000, '离线执行耗时应严格小于 2 秒');
});
```

```bash
node --experimental-strip-types --test tests/my-workflow.test.ts
```

### 7.4 副产物还原（强制）

单元测试输出自 Issue #54/#86 起写 `os.tmpdir()` 并自清理；对抗套件会重写被跟踪的 `tests/adversarial/fixtures/` 模板，手工演示链会重写 `artifacts/`——跑完必须还原，保证 `git status --porcelain` 干净：

```bash
git restore tests/ artifacts/
```

改码全流程（Issue → worktree → 门禁 → PR 指纹）见 `docs/WORKFLOW.md`；PR 提交模板与自检清单见 `.github/PULL_REQUEST_TEMPLATE.md`。

---

## 8. 特性矩阵与验证锚点（自 README 迁入）

| # | 特性 | 说明 | 验证锚点 |
|---|------|------|---------|
| 1 | **强类型 Agent RPC** | `agent(name).ask<T>()` 返回值按接口逐字段校验，Schema 自愈重试循环内置 | 单元 + E2E（`tests/unit`、`tests/e2e`） |
| 2 | **确定性物理探针** | 采集 OS、Git 状态、工具链与脱敏环境变量（`***REDACTED***`），先探测后推理 | 单元 + E2E |
| 3 | **双持久化状态机** | SQLite WAL 快照 + `events.jsonl` 事件流，七张状态表全覆盖 | 集成（`tests/integration`） |
| 4 | **零 Token 断点重放** | journal 短路 `(siteId, ordinal, inputHash)`；`--resume` / `--amend` / `--rerun` 三种续跑形态，测试按 Provider 调用次数断言零重放成本 | 集成 + E2E |
| 5 | **DAG 时序可视化** | Studio 交互式 SVG 画布（贝塞尔连线、缩放平移、时间旅行）、`graph` 输出 html / mermaid / ascii、四列看板（probe / patch / gate / deliverable） | 单元 + E2E |
| 6 | **MCP 原生客户端与服务端** | 服务端暴露 10 个工具（5 个 Facade 工具 + 5 个 legacy 工具），客户端支持工具发现与 stdio 调用 | 单元 + E2E |
| 7 | **进程组物理监管** | Win32 Job Object（`KILL_ON_JOB_CLOSE`）/ POSIX `pgid` 树级强杀、超时强杀、孤儿进程零残留 | 集成 + 对抗 |
| 8 | **VM 沙箱与编译期纯度门禁** | `node:vm` realm 硬化 + AST 禁忌（9002 / 9003 / 9014 / 9005 / 9015），逃逸链在进入沙箱前即死 | 对抗（`tests/adversarial`） |
| 9 | **Provider 六族与分层路由** | mock / Bedrock / Anthropic / OpenAI / CLI 代理 / HTTP + `fast` / `deep` tier 路由 + failover 链 | 单元 + 集成 |
| 10 | **人机协作门** | `hole<T>()` 结构化补洞、`escalate()` 阻塞式提问，运行停靠可续（`fill` / `answer` 命令） | 单元 + E2E |
| 11 | **脚手架与工具互通** | `new` / `init` 模板化建项、`setup` 生成编码助手互通配置、`export-schema` 导出 OpenAI function-calling Schema | E2E |

---

## 附：相关文档

- 架构规约（编译器/沙箱/journal/持久化原理）：`docs/ARCHITECTURE.md`
- 文档总索引：`docs/README.md`；一分钟上手：`QUICKSTART.md`
- 集成到既有 MCP 宿主：`docs/INTEGRATION.md`
- 历史教训（写代码前必读）：`docs/AI-PITFALLS.md`
