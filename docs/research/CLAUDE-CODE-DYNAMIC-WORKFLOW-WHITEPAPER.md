# Claude Code 官方 Dynamic Workflow / Ultracode 逆向剖析与 AI-workflow 实测对标白皮书

> **版本**：1.0（2026-11-02）
> **研究基准**：Claude Code `@anthropic-ai/claude-code@2.1.316`（win32-x64 解包件）
> **对标对象**：本仓 `AI-workflow`（DWF facade 引擎 + MCP Facade + SQLite journal）
> **证据等级**：全文结论按 `[已验证]` / `[推断]` / `[未知]` 标注；无证据的推断不写成事实。
> **清洁室声明**：本文只记录**行为、接口契约、常量与设计思想**，不复制官方闭源实现代码。落地代码按本仓架构独立实现。
> **清洁室修订（2026-11-21，本仓 Issue #190 批次）**：官方 minified 符号名一律改写为行为级描述；官方 unpacked 产物行号表一律移除，改以语义锚描述。

---

## 0. 执行摘要

本轮研究在 Claude Code 原生运行时中完成了三件事：

1. **逆向**：对官方 2.1.316 workflow 模块（`workflow-module-pretty.js`，5437 行）做逐函数精读，提取重放键、VM 沙箱、纯度封印、并发门、Prompt Cache 预热门、停滞重试状态机、预算与子工作流组合的精确契约。
2. **实机**：用官方 Workflow 运行时跑了 4 组黑盒探针（VM 全局、预算、并行/流水线语义、Schema 预检、嵌套限制、纯度封印与构造器链边界），全部拿到可复现输出。
3. **对标与反哺**：把本仓引擎挂到 MCP 上做同路径实跑，发现并修复了一个官方已封印、本仓仍存在的 **Date 纯度后门**（两条路径均可读取真实墙钟时间），以私有仓 Issue #55 / PR #56 落地，并补齐真实 child-main spawn 回归测试。

核心结论：

- 官方在**流式停滞判定、同前缀 Prompt Cache 预热门、VM 纯度封印**三处做得比本仓深；本仓在**确定性局部重放（amend）、SQLite 证据账本、实时 DAG/观测、进程监管与对抗测试矩阵**四处更强。
- 官方明文限制 `workflow()` **单层嵌套**；本仓当前同样限制单层（`src/dwf/engine.ts:174-176`），这是一个**双方都存在的架构天花板**，本白皮书将其列为后续可超越项，而不是已交付能力。
- 本仓 Date 影子的两条构造器链绕过路径已被实测复现并封死；修复后 `Object.getPrototypeOf(Date).now()` 与 `new Date(0).constructor.now()` 均无法再返回真实时间。进一步实测发现 `Intl.DateTimeFormat` 无参 `format()/formatToParts()` 是**官方与本仓共有的墙钟旁路**；本仓已额外封印，显式日期格式化保持确定性。

---

## 1. 研究方法与证据边界

### 1.1 证据来源

| 来源 | 位置 | 用途 |
|---|---|---|
| 官方解包模块 | `<workspace>-research/claude-code-pkg/workflow-module-pretty.js` | 逐函数逆向、常量与错误文案 |
| 官方二进制标记 | 同目录 `markers-report.txt` | 环境变量、Ultrareview 云边界 |
| 官方运行时 | 本会话 Workflow 工具（真实执行） | 黑盒语义实测 |
| 本仓源码 | `src/dwf/*.ts`、`src/agent/*.ts`、`src/mcp/*.ts` | 对标与修复 |
| 本仓测试 | `tests/unit`、`tests/integration`、`tests/adversarial`、`tests/e2e` | A 类验证 |
| 前序研究 | `docs/research/WORKFLOW-GAP-MATRIX.md`、`PENETRATION-AND-SECURITY-AUDIT.md`、`ZCODE-BENCHMARK-REPORT.md` | 避免重复；核对陈旧结论 |

### 1.2 证据分档

- `[已验证]`：本轮有命令、runId 或源码行号，可第三方复跑。
- `[推断]`：由已验证事实推出，文中给出推断链。
- `[未知]`：缺访问权限或缺少实测条件，明确写出缺什么。

### 1.3 清洁室与安全边界

- 官方闭源二进制的反编译产物仅用于**内部技术对标**；本仓落地代码按自身架构重写，不 copy-paste。
- 红蓝对抗仅针对**本机、本会话、自有代码与自有运行时**；不针对第三方服务，不做凭据探测。
- 所有密钥、Token、私有配置均未进入本文或提交。

---

## 2. 官方 Dynamic Workflow 架构逆向

### 2.1 执行模型与门面 API

官方工作流脚本是**在 VM realm 内执行的 async 函数体**，门面只暴露：

- `agent(prompt, opts?) -> Promise<result>`：每次调用创建一个子代理；`opts` 支持 `schema`、`model`、`effort`、`isolation`、`agentType`、`disallowedTools`、`bashCommandClamp`。
- `parallel(thunks)`：参数必须是 **thunk 数组**；`Promise.allSettled` 语义，失败槽映射为 `null`。
- `pipeline(items, ...stages)`：每项独立流过全部 stage，`null` 截断该项下游。
- `budget`：`freeze({ __proto__: null, total, spent, remaining })`，脚本只读。
- `phase()` / `log()` / `console` / `setTimeout` / `clearTimeout`：可用。
- `workflow(name | {scriptPath})`：组合另一个已注册/可读脚本；**子脚本内的 `workflow` 被替换为拒绝 stub**。

`[已验证]` 官方解包件的预算对象构造为 `freeze({ __proto__: null, total, spent, remaining })`；`[已验证]` 实机 `Object.isFrozen(budget) === true`、`Object.getPrototypeOf(budget) === null`、`budget.total === null`、`Reflect.set(budget,'total',12345) === false`、严格模式下赋值抛 `TypeError: Attempted to assign to readonly property.`。

**任务书校正 ①**：A.md 阶段 2 的示例 `export default workflow("official-bench", async ({ parallel, ... }) => {...})` 不是本会话真实 Workflow 工具 API。真实 API 是 `export const meta = {...}` + 脚本体直接 `await agent(...)`；`budget` 也不是脚本可写对象。`[已验证]` 严格模式下对 `budget.total` 赋值直接抛错。

### 2.2 重放键：AsyncLocalStorage 结构哈希

官方重放键不是 prompt 字符串，而是**调用链结构哈希**：

```text
官方的阶段推进函数（传入前一状态、阶段标签与事件）:
  key = sha256(prev \0 label \0 event)
  event = "slot:${n}" | "fork" | "join" + 每个子键 | "replaced"
```

- `parallel` 的每个槽进入槽作用域（第 i 槽），键为「prev + 阶段标签 + slot:i」再逐级哈希；
- `join()` 吸收全部槽键，形成栅栏；
- 重试 prompt 加 `(retry N)` 后缀，**故意让键失效**，保证重试必然实跑；
- 以键查缓存表，命中即返回缓存。

`[已验证]` 官方解包件（语义锚：重放键结构哈希实现段）。

**评价**：结构哈希对“代码挪位置”鲁棒（结构不变则键不变），但**缺乏局部 amend**：前序步骤微调会导致后续链式键全部失效。本仓的 `(siteId, ordinal, inputHash)` 显式键在 amend 场景可以做到局部失效与原地重放，这是本仓的结构性优势 `[已验证]`（见 `docs/research/WORKFLOW-GAP-MATRIX.md` 与 `tests/integration/dwf-run.test.ts` 的 replay/amend 断言）。

### 2.3 VM 沙箱与纯度封印

官方 VM 的边界由多层构成：

1. `vm.createContext` + `codeGeneration: { strings: false, wasm: false }`：禁 `eval`/`Function` 字符串编译与 wasm。
2. 入站只传字符串（args 以 JSON 字符串注入、realm 内重建）；宿主通信与定时器等能力“即捕即删”，不长期挂在 globalThis。
3. 纯度封印：`Math.random`、`Date.now()`、无参 `new Date()` 均抛固定错误；官方的 Date 影子构造器显式复制 `now`（抛错）/`parse`/`UTC`，并执行：
   - 影子构造器的 prototype 指向原生 Date 的 prototype
   - 原生 Date.prototype.constructor 改指影子构造器
   - 对原生 Date 构造器执行 Object.freeze
   从而封死 `(new Date(x)).constructor.now()` 与 `Object.getPrototypeOf(Date).now()` 两条构造器链回退路径。
4. 值消毒：跨界值消毒、跨 realm await 绑定、VM 内同步钩子封印、lanes 惰性化（行为级描述，内部符号名不录）。

`[已验证]` 官方解包件（语义锚：纯度封印段、VM `codeGeneration` 配置段、子脚本 `workflow` 拒绝 stub 段）。

**实机验证** `[已验证]`（official-purity-escape-probe）：

| 探针 | 结果 |
|---|---|
| `typeof process` / `require` / `fetch` / `queueMicrotask` / `WebAssembly` / `Buffer` | 全部 `undefined` |
| `Date.now()`（动态属性访问） | 抛固定错误（文案说明工作流脚本内禁用 `Date.now()`/`new Date()`，因其破坏 resume） |
| `Math.random()`（动态属性访问） | 抛固定错误（文案说明工作流脚本内禁用 `Math.random()`，因其破坏 resume） |
| `globalThis.constructor.constructor('return typeof process')()` | 抛 `EvalError: Code generation from strings disallowed for this context` |
| `args.constructor` | `undefined`（args 无构造器链） |
| `eval('1+1')` | 抛 `EvalError: Code generation from strings disallowed for this context` |

### 2.4 并发、扇出与 Prompt Cache 预热门

- **Agent 并发门**：`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS ?? min(16, max(2, cores-2))`。
- **Fan-out 槽门**：官方默认 50（`parallel`/`pipeline` 的槽上限）。
- **Worktree 单飞**：`isolation:'worktree'` 的代理串行创建 worktree。
- **Prompt Cache 预热门（官方所称 “prefix stagger”）**：
  - 不是固定延迟，而是**同前缀兄弟等待首个响应**的门；
  - 键由模型、推理档位、agent 类型、工具名集合、Schema 哈希与工作目录等请求语义字段以换行拼接而成；
  - 首个调用者是 leader，其余调用者等待 leader 的就绪信号，等待上限默认 5000ms；
  - 首个响应到达时该前缀即被标记为 warm，TTL 270000ms；
  - 默认等待上限 5000ms；`DISABLE_PROMPT_CACHING` 关闭；`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` 覆盖；
  - 等待日志：说明该 agent 因同前缀兄弟的首个响应而等待了 Nms（prompt-cache warm-up 语义）。

`[已验证]` 官方解包件（语义锚：预算账本类与默认值段、缓存键构造与日志入口段、50 槽门常量、agent 门公式）。

**评价**：官方钥匙包含 model/effort/agentType/tools/schema/cwd，**不包含 prompt 正文**；因此同一 run 内不同 prompt 的兄弟也会被 stagger，共享的稳定前缀（系统提示+工具）得以先写缓存。本仓的 actor 系统提示包含 agent 名（`You are specialized agent "name".`），不同 actor 的前缀从第 27 个字符起就分叉，**直接照搬 warm gate 收益有限**。本白皮书把它列为“需先统一系统提示前缀再评估”的候选，而非本轮落地项 `[推断]`（推断链：官方键不含 prompt → 官方系统提示固定 → 本仓系统提示按 actor 名变化 → 同 run 多 actor 前缀不共享）。

### 2.5 停滞/限流/重试状态机

官方对失败做了极细的分类：

- **429/throttle**：先等待约 45s，重发 `${label} (throttle-retry)`；再退化则放弃 throttle 退避。
- **停滞（stalled）**：90000ms 无进展 → 判定 stalled；重发 `${label} (retry N)`，最多 5 次。
- **回复丢失（reply lost）**：响应流静默结束、Claude Code 放弃等待 → 与 stalled 分开文案。
- **用户重试（user-retry）**：用户显式要求。
- **StructuredOutput 重试上限**：`MAX_STRUCTURED_OUTPUT_RETRIES`（默认值由模块常量给出），超限抛专用错误。
- **Usage-limit 自动等待**：基于结构化 `quotaLimits.resetsAt`，最多等待 2 次（两个独立上限共同限定），超过则 decline/abort。

`[已验证]` 官方解包件（语义锚：结构化输出重试上限与停滞超时常量、throttle/retry/abandon 文案段、usage-limit 等待段）。

**本仓现状**：`src/agent/rpc.ts:67-78` 支持 `stallMs` 竞速超时；`src/dwf/attempt-classifier.ts:28-30` 识别 `StallError`；但 `src/dwf/engine.ts` 的 ask 调度**没有传 `stallMs`**，因此该能力目前是“有实现、未接线” `[已验证]`。这与官方 90s 停滞判定存在真实差距，列为后续 P2（需先评估非流式 provider 下 90s 是否会误杀长调用）。

### 2.6 预算与 Agent 调用上限

- `budget` 冻结注入，`total` 来自 run 配置；脚本只读。
- `WorkflowBudgetExceededError`：在 `agent()` 调用粒度检查 `spent >= total`，文案明确：在飞 agent 会完成、其结果保留。
- `WorkflowAgentCapError`：1000 次调用上限，防 `budget.remaining() === Infinity` 的死循环。
- `parallel`/`pipeline` 对预算丢弃槽计数并汇总，不逐条报错。

`[已验证]` 官方解包件（语义锚：预算对象构造段；上限异常类型名 `WorkflowBudgetExceededError`/`WorkflowAgentCapError` 为公开异常类名）。

**本仓现状**：同语义（错误文案为本仓自有措辞）；**私有仓 Issue #73（2026-11-03）已改为官方同款只读注入**（`--budget-total` / MCP `budgetTotal`），脚本内对 `budget.total` 的赋值在编译期被拒。旧的可写设计保留为历史记录。

### 2.7 子工作流组合与单层嵌套

官方 `workflow(name | {scriptPath})` 在父上下文可用；子脚本上下文把 `workflow` 绑定替换为拒绝 stub：报错文案说明 `workflow()` 不能在子工作流内调用——嵌套限一层，建议内联内层脚本或直接调用其 agent。

`[已验证]` 官方解包件（语义锚：子脚本 `workflow` 拒绝 stub 段）；实机 child 脚本尝试组合 grandchild，返回同一拒绝文案（official-nesting-probe）。

**本仓现状**：`src/dwf/engine.ts:168-200` 已实现 `workflow()` 组合（子 run 有独立 runId、lineage、独立沙箱），但同样在 `workflowDepth >= 1` 时拒绝。即：**双方都只支持单层组合** `[已验证]`（`tests/integration/dwf-composition.test.ts:61-68`）。任务书把“官方单层嵌套”列为我方超越点，但当前代码尚未超越；本白皮书将其列为待立项的 D 类建议，而不是已交付能力。

### 2.8 官方设计优劣总结

**值得吸收** `[已验证]`：

1. **Prompt Cache 预热门**：用“首个响应”而非固定 sleep 做 warm 屏障，节省重复前缀上传；对本仓的价值取决于系统提示是否统一。
2. **停滞三态**：throttle / stalled / reply-lost 分开判定与不同文案，重试 prompt 故意加后缀。
3. **纯度封印的构造器链闭合**：不仅替换全局 `Date`，还改写 `prototype.constructor` 并冻结原生构造器。
4. **Schema 预检**：不可满足 Schema 在派发前拒绝，零 token 成本。
5. **极简 Facade**：thunk 校验、allSettled→null、预算冻结注入，API 面小且行为可预测。

**官方硬伤** `[已验证]`：

1. **重放键链式雪崩**：结构哈希使前序微调导致后续全量失效，缺少本仓的局部 amend。
2. **单层嵌套**：`workflow()` 在子上下文被硬拒绝。
3. **本地证据账本缺失**：官方重放依赖进程内/云端状态，缺少本仓 SQLite WAL + journal 的离线可审计性。
4. **形式化验证盲区**：官方生态未见 PBT/状态机代数级验证；本仓有 `test:pbt` 与 43 条 goal-PoC 对抗测试。

---

## 3. 官方实机黑盒实测

### 3.1 探针矩阵

| # | 探针 | 官方实际行为 | 证据 |
|---|---|---|---|
| 1 | VM 全局 | `process/require/fetch/queueMicrotask/WebAssembly/Buffer` 均 `undefined`；`setTimeout/console/log/globalThis/args` 存在 | official-runtime-probe |
| 2 | 预算 | `isFrozen=true`、`proto=null`、`total=null`、`Reflect.set=false`；严格赋值抛 `TypeError` | official-runtime-probe / official-nesting-probe |
| 3 | `parallel([Promise])` | 抛 `TypeError`（官方文案提示 thunk 包装写法；本仓自有措辞实现同语义） | official-runtime-probe |
| 4 | `parallel` thunk 抛错 | 该槽 `null`，其余槽正常完成（`[null, 42]`） | official-runtime-probe |
| 5 | `pipeline` null 截断 | `pipeline([1,null,3], x=>x*2)` → `[2,null,6]`；null 项下游不执行 | official-runtime-probe |
| 6 | `pipeline` 非函数 stage | 抛 `TypeError`（说明 stages 必须全为函数） | official-runtime-probe |
| 7 | 不可满足 Schema | 派发前抛错（遥测安全包装），文案说明 subagent 未启动 | official-runtime-probe / official-nesting-probe |
| 8 | 子工作流嵌套 | 子脚本内 `workflow()` 报错说明嵌套限一层 | official-nesting-probe |
| 9 | 非法 `workflow(123)` | 抛 `TypeError`（说明只接受工作流名（string）或 `{scriptPath}` 形态） | official-runtime-probe |
| 10 | Date/Math 纯度 | 动态访问仍抛固定错误 | official-purity-escape-probe |
| 11 | 构造器链逃逸 | `globalThis.constructor.constructor(...)` → `EvalError: Code generation from strings disallowed` | official-purity-escape-probe |
| 12 | args 构造器链 | `args.constructor` 为 `undefined` | official-purity-escape-probe |

### 3.2 结果解读

- 官方的**静态门 + 运行期封印**是双层的：脚本里直接写 `Date.now` 会被运行前静态门拒绝；即使动态绕过静态门，运行期仍抛错。`[已验证]`
- 官方的 **args 无构造器链**（实测 `args.constructor === undefined`；官方对 args 的封装层会 `setPrototypeOf(null)` 并删除 `constructor`），比“realm Object + codeGeneration 兜底”更彻底。`[已验证]`
- 官方的 **Schema 预检**区分“invalid”与“unsatisfiable”：空 enum 归为 invalid，`minLength > maxLength` 归为 unsatisfiable；两者都在派发前拒绝。`[已验证]`

### 3.3 未能实测的部分

- **Ultracode / `/ultrareview` 云端协同**：官方二进制字符串明确写着 `/ultrareview` 运行在 Anthropic 云端（见 `markers-report.txt` 扫描报告），本地模块不含其实现；需要 claude.ai 账号与云端权限，本轮无法进入。`[未知]`（C 类）。
- **真实模型下的 token/成本/延迟对比**：本仓本轮使用 mock provider 做结构对标，未用真实 API Key 跑双轨基准，避免凭据与费用风险。`[未知]`（C/E 类）。
- **官方 Agent 并发上限的实机精确值**：源码公式已确认，但未用 20+ 子代理做时序测量；`[推断]` 公式与实际一致。

---

## 4. AI-workflow 挂载与同台对标

### 4.1 挂载路径

| 途径 | 命令/配置 | 实测结果 |
|---|---|---|
| MCP Facade（推荐） | `node bin/workflow.js mcp serve` | 成功握手，列出 10 个工具：`workflow_run/probe/inspect/replay/graph/script_check/script_run/run_script/inspect_run/get_run` `[已验证]` |
| 直接 dist | `node dist/src/mcp/server.js` | 需由 CLI 的 `mcp serve` 启动；单独 spawn 不响应握手（无 main guard）`[已验证]` |
| A.md 原配置 | `node --experimental-strip-types src/mcp/server.ts` | **失败**：`ERR_MODULE_NOT_FOUND src/core/workflow.js`（源码 import `.js`，仅 dist 存在）`[已验证]` |
| CLI | `node bin/workflow.js run-script <facade.ts>` | 已有 e2e/集成覆盖，离线 mock 可跑 `[已验证]` |

**任务书校正 ②**：A.md §3.1 途径 A 的 MCP 配置指向 `src/mcp/server.ts` 并加 `--experimental-strip-types`，在本仓当前构建布局下**不可用**；应使用 `node <repo>/bin/workflow.js mcp serve`（或先 `npm.cmd run build` 后指向 `dist/src/mcp/server.js` 并确保 CLI 入口负责 `start()`）。

### 4.2 我方 Facade 实跑

通过 MCP `workflow_script_check` + `workflow_script_run`：

- `check` 返回 `ok:true`、`phases:["Inspect"]`、`actors:["inspector"]`、`siteCount:4`、`diagnostics:[]`。
- `run` 返回 `status:"completed"`、`value:{healthStatus:"HEALTHY"}`、`stats.asks:1`、`replayHits:0`。
- `resumeHint` 明确给出 zero-cost resume 的 runId。

`[已验证]`（runId `dwfrun-mvz91ovi-3482d5`）。

并行/流水线语义对照（我方 facade，MCP 实跑）：

| 探针 | 我方结果 | 官方结果 | 判定 |
|---|---|---|---|
| `parallel([1,2])` | `TypeError`（官方文案提示 thunk 包装写法；本仓自有措辞实现同语义） | 同语义 | 语义一致 `[已验证]` |
| thunk 抛错 | `[42,"NULL"]` | `["NULL",42]`（顺序按数组） | 语义一致 |
| `pipeline` null | `[2,null,6]` | `[2,null,6]` | 逐字一致 |
| `budget` | `total:null, spent:0, remaining:null, frozen:false, protoNull:false` | frozen, null-proto | 私有仓 Issue #73 已对齐（只读注入） |

### 4.3 双向对标矩阵

| 维度 | 官方 | 本仓 | 判定 |
|---|---|---|---|
| 执行/DSL | VM 内 async 函数 + AST 预检 | TS facade 编译期类型检查 + 降级 VM JS + `codeGeneration` 加固 | 等价 |
| 重放键 | 结构哈希（slot/fork/join/replaced） | `(siteId, ordinal, inputHash)` + amend 温缓存 | 本仓更强（局部失效） |
| 持久化 | 进程内/云端 | SQLite WAL + journal + 事件流 | 本仓更强（离线可审计） |
| 并发热门 | agent 门 + 50 槽门 + warm gate | 席位门 + AIMD + `sessions.race/waitAny` | 本仓并发控制更细；warm gate 缺失 |
| 停滞重试 | 90s + 5 次 + 三态文案 | `stallMs` 有实现但未接线；分类器已识别 | 官方更强（需接线） |
| 纯度封印 | Date 构造器链 + freeze + null-proto args；Intl 无参未封 | 本轮前有 Date 两条构造器链后门；已修复；并额外封印 Intl 无参 format/formatToParts | 本仓更强（Intl 超越官方；args 仍为 realm Object，codeGeneration 兜底） |
| 预算 | 只读冻结 | 私有仓 Issue #73 已对齐（run 级只读注入） | 一致 |
| 子工作流 | 单层硬拒绝；子结果由运行期状态承接 `[推断]` | 单层硬拒绝；子 run 结果未入父 journal（resume 重跑） | 双方同限；本仓另有 resume 成本待补 |
| 可观测性 | TUI 单行 + phase 日志 | live HTTP + view + DAG + MCP inspect | 本仓更强 |
| 对抗测试 | 未见公开矩阵 | 43 条 goal-PoC + 158 条 JS 压力测试全绿 | 本仓更强 |
| 云端协同 | `/ultrareview` 云端多代理 | 无云端实现 | 官方独有（C 类） |

### 4.4 双方优势清单

**官方优势（应吸收）**：

1. Prompt Cache 预热门（同前缀兄弟等待首个响应，TTL 270s）。
2. 停滞三态与重试 prompt 后缀（throttle/stalled/reply-lost）。
3. 纯度封印的构造器链闭合 + args null-prototype。
4. Schema 派发前预检（invalid/unsatisfiable 分型）。
5. 极简 Facade 与 allSettled→null 的稳定语义。

**本仓优势（应保持）**：

1. 局部 amend 与 `inputHash` 大声失败（官方结构哈希会链式雪崩）。
2. SQLite WAL + journal + 离线重放账本（官方依赖进程内/云端）。
3. `sessions.race/waitAny/cancel` 的竞速取消与零成本 resume。
4. 实时 live/view/DAG 与 MCP 10 工具观测面。
5. 进程监管、零孤儿、帧预算与 43 条对抗测试的工程防线。

---

## 5. 红蓝对抗与安全审计

### 5.1 官方 VM 边界实测

见 §2.3 与 §3.1。结论：官方在**本轮探针覆盖的向量**上边界成立 `[已验证]`：

- 直接/动态 `Date.now`、`Math.random` 均被运行期封印；
- `globalThis.constructor.constructor` 与 `eval` 均被 `codeGeneration` 拒绝；
- `args` 无构造器链；
- `process/require/fetch/WebAssembly/Buffer/queueMicrotask` 不可达。

未覆盖：V8 未来版本新增内建、`Intl`/`Temporal` 等侧信道、云端 Ultrareview 边界。`[未知]`

### 5.2 本仓对抗测试结果

| 套件 | 结果 | 证据 |
|---|---|---|
| `npm.cmd run test:adversarial`（JS 压力/PoC） | **158 tests / 158 pass / 0 fail / 0 skipped** | `/tmp/mission-a-adversarial.log` 指纹（临时日志，已清理） |
| `node --experimental-strip-types --test tests/adversarial/goal-adv*.test.ts` | **43 tests / 43 pass / 0 fail / 0 skipped** | 临时日志指纹（已清理） |

覆盖向量包括：跨 realm Function（PoC2）、构造器链/原型链（PoC1/3）、microtask 伪造 done 帧（PoC4）、16MB 畸形帧、glob 炸弹、agent storm、proto pollution、world.run 侧信道等。`[已验证]`

### 5.3 新发现：Date / Intl 纯度后门（私有仓 Issue #55）

**缺陷 A（Date 构造器链）**：本仓 `src/dwf/child-main.ts` 的 Date 影子有两条构造器链回退路径：

1. `Object.setPrototypeOf(__SafeDate, __NativeDate)` → `Object.getPrototypeOf(Date)` 直接返回原生 Date 构造器；调用 `.now()` 得到真实墙钟。
2. 未改写 `__NativeDate.prototype.constructor` → `new Date(0).constructor` 仍是原生 Date；调用 `.now()` 同上。

**实测（修复前，main）** `[已验证]`：

```text
runId dwfrun-mvz994ke-400d94
Object.getPrototypeOf(Date).now()        -> 1793623721142
new Date(0)["constructor"].now()         -> 1793623721142
```

**缺陷 B（Intl 无参格式化）**：即使 Date 封印完成，`Intl.DateTimeFormat#format()` / `formatToParts()` 在**不传日期**时按规范回退到 `%Date.now%`，绕开 Date 封印读取真实墙钟。

**实测（Date 封印后、Intl 封印前）** `[已验证]`：

```text
runId dwfrun-mvzacn0c-36e44a
new Intl.DateTimeFormat('en-US',{timeZone:'UTC',hour:'2-digit',...}).format()          -> "01:19:24 PM"
...format(0)                                                                           -> "12:00:00 AM"（确定性）
...formatToParts()                                                                     -> hour=01,minute=19,second=24（真实时间）
```

**官方同样存在缺陷 B** `[已验证]`（official-intl-probe）：官方 2.1.316 运行时 `format()` 返回 `"01:20:03 PM"`、`formatToParts()` 返回当前时分秒；官方模块（语义锚：纯度封印段）只封印 Date，没有 Intl 封印。因此本轮对 Intl 的封印是**有意超越官方**的确定性加固，而不是官方对齐项。

**边界**：这两条都不是沙箱逃逸或任意代码执行；脚本仍拿不到 `process`/`require`。它们破坏的是**确定性重放契约**——脚本可读取真实时间，导致同脚本重跑产生不同输入。

### 5.4 帧协议/孤儿/资源耗尽覆盖

本仓已有：

- `tests/adversarial/goal-adv3-oversize-frames.test.ts`（16MB 畸形帧）
- `tests/adversarial/goal-adv3-agent-storm.test.ts`（agent 风暴）
- `tests/adversarial/concurrency-stress.test.js`（并发/重放压力）
- `src/process-supervision.ts` 与 runner 的进程树 kill / 零孤儿逻辑
- `AI-PITFALLS.md` P-TEST-3 的竞速超时与 not-ok 失败命名门禁

本轮全量对抗套件 158+43 全绿，未发现新的可复现逃逸。`[已验证]`

---

## 6. 反哺落地：Date / Intl 纯度封印（私有仓 Issue #55 / PR #56）

### 6.1 根因

本仓把“禁止脚本读时间”实现为**替换全局 `Date`**，但保留了两条通往原生构造器的对象图路径；同时没有覆盖 `Intl.DateTimeFormat` 的**无参默认日期**路径。官方把 Date 边界放在**构造器链**上，而不是只放在全局绑定上；但官方同样没有覆盖 Intl 无参路径（实测见 §5.3）。

### 6.2 官方修复模式（行为契约，非代码复制）

- 显式复制 `now`（抛错）/`parse`/`UTC`，不通过 `setPrototypeOf` 继承；
- 影子构造器的 prototype 指向原生 Date 的 prototype；
- 原生 Date.prototype.constructor 改指影子构造器；
- 原生 `now` 也替换为抛错；
- 对原生 Date 构造器执行 `Object.freeze`。

Intl 部分官方未封印；本仓按同一“纯度违约”语义补上：

- `Intl.DateTimeFormat.prototype.format` 的 getter 返回包装函数：无参或 `undefined` 日期 → 抛 `CompileError`；
- `Intl.DateTimeFormat.prototype.formatToParts` 同样包装；
- 显式传日期（含 `0`）保持原行为。

### 6.3 本仓实现

`src/dwf/child-main.ts`：

- 删除 `Object.setPrototypeOf(__SafeDate, __NativeDate)`；
- 新增 `__purityNow`，同时赋给 `__SafeDate.now` 与 `__NativeDate.now`；
- `__SafeDate.prototype = __NativeDate.prototype`；
- `__NativeDate.prototype.constructor = __SafeDate`；
- `Object.freeze(__NativeDate)`；
- 保存 `Intl.DateTimeFormat.prototype.format` 原 getter 与 `formatToParts`，用 purity 包装替换；无参/`undefined` 抛 `CompileError`，显式日期原样透传。

### 6.4 修复前后证据

| 探针 | 修复前 | 修复后 |
|---|---|---|
| `Object.getPrototypeOf(Date).now()` | `1793623721142` | `status failed: "parent.now is not a function"` |
| `new Date(0).constructor.now()` | `1793623721142` | `status failed: "Purity violation: Date.now() is banned..."` |
| 直接 `Date.now()` | 编译期 9002 | 编译期 9002（不变） |
| `Intl.DateTimeFormat.format()`（无参） | `"01:19:24 PM"` | `status failed: "Purity violation: Intl.DateTimeFormat.format()..."` |
| `Intl.DateTimeFormat.formatToParts()`（无参） | 当前时分秒 | `status failed: "Purity violation: Intl.DateTimeFormat.formatToParts()..."` |
| `Intl.DateTimeFormat.format(0)` | `"12:00:00 AM"` | `"12:00:00 AM"`（不变） |

`[已验证]` 修复后 runId：`dwfrun-mvz9mxg6-4aa780`、`dwfrun-mvz9nidw-806767`、`dwfrun-mvzaes4i-8c8489`；Intl 修复前 runId：`dwfrun-mvzacn0c-36e44a`。

### 6.5 测试与门禁指纹

- 定向回归：`dwf-error-algebra.test.js` → `# tests 10 / # pass 10 / # fail 0`（含 Date 与 Intl 两组私有仓 Issue #55 测试）。
- 全量单元：`# tests 256 / # pass 256 / # fail 0`。
- PBT：`# tests 5 / # pass 5 / # fail 0`。
- E2E：`Total Test Cases Executed: 121 / Passed: 121 / Failed: 0`。
- 治理：`# tests 24 / # pass 24 / # fail 0`。
- 洁净度：`[门禁通过] 工作区彻底干净`。

### 6.6 2026-11-02 后续补强（私有仓 Issue #57 / #59 + REA）

- **多级 `workflow()` 组合（私有仓 #57）**：以 `workflowAncestry` 做环检测、最多 5 个 saved workflow；子 run 继承父 workspace，嵌套 registry 可解析；3 级成功、A→B→A 环、第 6 层深度上限均有测试。官方 2.1.316 仍硬拒绝单层以上，本仓为有意扩展。
- **`stallMs` 接线（私有仓 #59）**：`rpc.ts` 的 stall 竞速定时器现在总会 `clearTimeout` + `unref`；engine/runner 传递 `stallMs`（显式 > `AI_WORKFLOW_STALL_MS` > 90000ms，`0` 关闭）；`StallError` 重试时在最后一条 user 消息追加 `(Retry N after no progress ...)`，不累积。单元 + facade 集成测试覆盖。
- **REA 实操**：宿主机新装 Node v26.13.0（`C:\Program Files\nodejs`），满足 REA `^22.23.4 || ^24.22.1 || >=26.12.1`；`rea doctor` 的 Node 检查为 healthy。`rea analyze-javascript-application` 对官方解包 package 完成静态分析：4 文件、7477 AST 节点、121 findings、0 parse failures（evidence bundle 1.7MB）。
- **REA 原生分析（私有仓 Issue #82）**：安装官方 Ghidra 12.2（`ghidra_12.2_PUBLIC_20261016.zip`，SHA256 `2c2cd776...a7be67` 与 GitHub digest 一致）与 Amazon Corretto JDK 25；`rea doctor` 的 `ghidra` / `ghidra-platform` / `ghidra-architecture` / `ghidra-installation` / `ghidra-version` / `ghidra-headless` / `ghidra-native_decompiler` / `ghidra-java` 全部 healthy。小 PE `notepad.exe` 的 `rea inspect --provider ghidra` 成功：10 segments / 853 procedures / 638 strings，222s。
- **claude.exe**：335MB PE32+ x64，`rea inspect --provider ghidra` 在 3,600,208ms（1h）预算内返回 `provider_timeout`；Ghidra auto-analysis 未完成，**未确认 OOM**（输出不完整）；target SHA256 `e896a9d8da519353a49bf69ca4a695ba7e09067752687c675b3969041e632d52`、provider 12.2、ephemeral project 已清理。小 PE `notepad.exe` 成功（10 segments / 853 procedures / 638 strings，222s），证明 provider 链路可用；335MB Bun 单文件的默认 auto-analysis 需要更长预算或 `REA_GHIDRA_DISABLED_ANALYZERS` 降低覆盖。

---

## 7. 架构建议与后续路线

### 7.1 已吸收（本轮）

- Date/Intl 构造器链与无参格式化封印（私有仓 Issue #55，A 类）。
- 多级 `workflow()` 组合（私有仓 Issue #57，A 类）。
- `stallMs` 接线与 `(Retry N)` 重试提示（私有仓 Issue #59，A 类）。

### 7.2 建议吸收（按优先级）

| 优先级 | 建议 | 理由 | 前置条件 |
|---|---|---|---|
| ✅ 私有仓 #57 | 多级 `workflow()` 组合（有界深度 + 环检测） | 已落地：5 层上限、A→B→A 环检测、3 级成功/环/深度测试 | — |
| P1 | 子工作流结果入父 journal（resume 零重跑） | `composeWorkflow` 目前不落节点：父 run resume 会重新创建并执行子 run，重复消耗 provider 调用 | 设计 child node 键、lineage 重放与 `dwf_child_workflow` 结算测试 |
| ✅ 私有仓 #59 | 接线 `stallMs`（默认 90s，可配置） | 已落地：`AI_WORKFLOW_STALL_MS`、0 关闭、Retry N 提示、定时器清理、单元+集成测试 | — |
| P2 | 统一 `workflow({scriptPath})` 契约 | `facade-dts.ts:98-105` JSDoc 声称支持 `{scriptPath}`，但声明与 engine 只接受 saved name | 二选一：实现 `{scriptPath}` 或收窄文档与类型 |
| P2 | Prompt Cache 预热门 | 官方省重复前缀上传；本仓需先统一系统提示前缀 | 统一 actor 系统提示 + provider 能力标记 |
| P2 | `args` null-prototype | 官方 `args.constructor` 不存在；本仓仍为 realm Object（codeGeneration 兜底） | 评估脚本对 `hasOwnProperty` 等原型方法的依赖 |
| P3 | 真实模型双轨基准 | 本轮 mock/结构对标，缺 token/延迟/成本数据 | 需要受控 API Key 与费用预算 |

### 7.3 官方硬伤与我方机会

- **重放链式雪崩** → 本仓局部 amend 已是优势；可继续强化 `(siteId, ordinal, inputHash)` 的可视化与 amend 命中率指标。
- **单层嵌套** → 多级组合是明确的差异化机会（需有界深度与环检测）。
- **本地账本缺失** → 本仓 SQLite/journal 已是优势；可补“离线证据包导出”。
- **形式化验证盲区** → 本仓 PBT + 43 条对抗测试已是优势；可继续扩展状态机代数不变量。

### 7.4 不建议照搬

- 官方 frozen budget：私有仓 Issue #73 已对齐；预算改为 run 级只读注入，旧的脚本可写设计已移除。
- 官方 usage-limit 自动等待：私有仓 Issue #73 已实现有界版本（整跑 deadline 内、每 ask 最多 2 次）；24h 无界等待仍不照搬（与 10 分钟整跑超时冲突）。
- 官方工具黑白名单：本仓子代理没有工具循环，移植会得到永远不生效的死配置。

### 7.5 交付成果 A–E 分档

| 分类 | 交付物 | 状态与判据 |
|---|---|---|
| **A 类：已完成且通过全量验证** | 本白皮书 + 门禁 私有仓 PR #56/#58/#60/#62/#66 + 真实模型基准 私有仓 PR #69/#71/#74/#77/#79/#81（详见 benchmark report §2-§4） | build/unit/PBT/E2E/governance/对抗全绿；基准双方均正确 |
| **B 类：已实施但尚未充分验证** | 官方运行时黑盒探针矩阵（§3.1）、Date/Intl 绕过 PoC（§5.3）、REA JS 静态分析、REA Ghidra 小 PE（notepad 853 procedures） | 已执行并记录 runId/evidence；一次性探针未入库（AGENTS §1.5） |
| **C 类：未完成或阻塞** | Ultracode/`/ultrareview` 云端协同；跨云/跨租户多仓；claude.exe 335MB Ghidra 1h timeout | 需云端权限/远端 CI；REA 需更长预算或禁用 analyzer；未确认 OOM |
| **D 类：仅建议未修改** | 子 run 结果入 journal、Prompt Cache 预热门、`args` null-proto、`{scriptPath}` 契约统一 | 设计建议与优先级见 §7.2；未在本轮改代码 |
| **E 类：剩余风险与盲区** | 真实模型成本、V8 未来内建、第三方 provider 缓存差异、子工作流 resume 成本、`{scriptPath}` 契约漂移 | 见 §8 |

---

## 8. 剩余风险与测试盲区（E 类）

1. **真实模型成本/延迟**：未跑真实 LLM 双轨基准；token 节省与延迟数据缺失。
2. **Ultracode 云端**：`/ultrareview` 的云端多代理协议、鉴权、上下文摘要策略未知。
3. **V8 未来内建与静态策略差异**：Date 构造器链与 Intl 无参格式化已封印；未来 V8 新增的 `Temporal`/`performance` 等时间入口尚未逐一审计 `[未知]`。本仓编译器额外禁止 `Date.parse()`（9002 purity-ban）；官方影子 Date 构造器暴露 `parse`，但其静态门是否额外拦截未单独实测 `[未知]`。`Date.UTC`/`toISOString()` 已验证正常（`Date.UTC(1970,0,1)===0`）。
4. **多级组合**：已在私有仓 #57 落地（5 层上限 + 环检测 + 3 级测试）；官方仍为单层。剩余风险是深层链的 provider 成本与子 run 未入父 journal（见第 7 条）。
5. **Prompt Cache 收益**：本仓系统提示按 actor 名分叉，warm gate 直接照搬可能无效；需先做前缀统一实验。
6. **第三方 provider 差异**：Anthropic 之外的 provider 是否支持 `cache_control`/前缀缓存，未验证。
7. **子工作流 resume 成本**：父 run resume 会重新执行子 run（子结果未入父 journal），重复 provider 调用；本轮未测其成本量级。
8. **`{scriptPath}` 契约漂移**：`facade-dts.ts` 的 JSDoc 与声明/引擎实现不一致；调用方若按 JSDoc 传 `{scriptPath}` 会被当作未知名字拒绝。

---

## 9. 复现命令

```bash
# 官方探针（本会话 Workflow 工具）
# 见 official-runtime-probe / official-nesting-probe / official-purity-escape-probe 脚本

# 本仓 MCP 挂载
node bin/workflow.js mcp serve

# 本仓 facade 实跑（mock）
node bin/workflow.js run-script <facade.ts> --cwd <dir>

# 全量门禁（2026-11-02 修复时的 worktree ../AI-workflow-worktrees/issue-55-date-purity-seal，现已删除；复现步骤如下）
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:pbt
node --experimental-strip-types tests/e2e/runner.ts
node --experimental-strip-types tests/unit/workflow-governance.test.ts
node --experimental-strip-types --test tests/adversarial/goal-adv*.test.ts
git restore tests/unit/fixtures/
node --experimental-strip-types scripts/pr_review_gate.mjs --check-clean
```

---

## 10. 附录：证据索引

### 10.1 官方解包件语义锚（行号自清洁室修订起不录）

| 主题 | 语义锚（行为级定位） |
|---|---|
| 纯度封印 | `Date.now`/`Math.random` 抛错、影子构造器复制 `now`/`parse`/`UTC` 并闭合构造器链、冻结原生构造器的实现段 |
| 预算冻结 | `freeze({ __proto__: null, total, spent, remaining })` 预算对象构造段 |
| 子脚本 `workflow` 拒绝 stub | 子上下文内以拒绝 stub 替换 `workflow` 的段 |
| `codeGeneration` | VM 上下文禁字符串编译与 wasm 的配置段 |
| 重放键结构哈希 | prevKey + 结构标签 + 结构事件逐级 sha256 的实现段 |
| 并发门公式 | `min(16, max(2, cores-2))` 默认并发公式段 |
| Fan-out 槽门（50） | `parallel`/`pipeline` 50 槽上限常量段 |
| Warm gate | 同前缀兄弟等待首个响应的 stagger 门实现段 |
| Warm 默认等待 5000ms / TTL 270000ms | stagger 等待上限与 warm TTL 常量段 |
| Warm 键构造 | 模型/推理档位/agent 类型/工具名/Schema/工作目录拼接键的段 |
| Warm 进入与日志 | 首个响应标记 warm 与等待日志（held Nms 语义）段 |
| 停滞 90000ms / 重试上限 5 次 | 停滞判定与重试上限常量段 |
| throttle/retry/abandon | throttle 等待、`(retry N)` 重发与放弃文案段 |
| Schema 预检 | 派发前 invalid/unsatisfiable 分型拒绝段 |
| 子工作流嵌套 | 子上下文拒绝嵌套的文案段 |

### 10.2 本仓源码行号

| 主题 | 位置 |
|---|---|
| Date 纯度封印 | `src/dwf/child-main.ts:386-416` |
| ask 调度/预算/重试 | `src/dwf/engine.ts:274-470` |
| ask 席位门 | `src/dwf/engine.ts:484-495` |
| `workflow()` 组合 | `src/dwf/engine.ts:168-200` |
| AIMD governor | `src/dwf/governor.ts:1-140` |
| 重试分类 | `src/dwf/attempt-classifier.ts:28-45` |
| 门面契约 | `src/dwf/facade-dts.ts:58-125` |
| MCP 工具面 | `src/mcp/server.ts:101-210` |
| Anthropic `cache_control` | `src/agent/anthropic-provider.ts:110-115` |

### 10.3 本轮实跑 runId

| 用途 | runId |
|---|---|
| MCP facade 基础跑 | `dwfrun-mvz91ovi-3482d5` |
| 修复前 Date 绕过 A | `dwfrun-mvz98e0i-f63b70` |
| 修复前 Date 绕过 B | `dwfrun-mvz994ke-400d94` |
| 修复后 proto 路径 | `dwfrun-mvz9mxg6-4aa780` |
| 修复后 instance 路径 | `dwfrun-mvz9nidw-806767` |
| Intl 泄漏（修复前） | `dwfrun-mvzacn0c-36e44a` |
| Intl 封印（修复后） | `dwfrun-mvzaes4i-8c8489` |

### 10.4 任务书事实校正汇总

| # | A.md 原文 | 实测事实 | 证据 |
|---|---|---|---|
| ① | 阶段 2 示例 `export default workflow(...)` + 脚本内 `budget.total = 100000` | 真实 API 为 `export const meta` + 脚本体；`budget` 冻结只读，严格赋值抛 `TypeError` | official-runtime-probe / official-nesting-probe |
| ② | 阶段 3 途径 A 指向 `src/mcp/server.ts` + `--experimental-strip-types` | 该入口 import `.js` 路径，源码目录无 `.js`，直接运行 `ERR_MODULE_NOT_FOUND`；应使用 `bin/workflow.js mcp serve` 或 dist | MCP 挂载实测 |
| ③ | 阶段 3 场景 4 暗示我方已支持多级嵌套 | 本仓当前 `workflowDepth >= 1` 即拒绝，与官方同为单层 | `src/dwf/engine.ts:174-176`、`tests/integration/dwf-composition.test.ts:61-68` |