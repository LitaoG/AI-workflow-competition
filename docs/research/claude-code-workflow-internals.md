# Claude Code Workflow 引擎完整逆向（2.1.316 win32-x64 深度提取）

> 方法升级：不再只做标记扫描——定位 workflow 模块边界（0x12337a83..0x12347d6c，连续 66KB），
> 整段 dump + js-beautify（5437 行）逐函数精读。产物：`workflow-module-pretty.js`（研究目录，勿分发）。
> 配套：`claude-code-binary-reverse.md`（首轮证据）；ZCode 侧为官方开源已精读。

## 1. 重放键（比官方文档深一层的机制）

Claude 的重放键是 **AsyncLocalStorage 结构调用路径哈希**，不是简单的 prompt 序列：

```
function Xn(prev, label, event):        // sha256 链
  update(prev) \0 update(label) \0
  event: number  → "slot:${n}"          // parallel/pipeline 的槽位
         : "fork"                       // 结构分叉
         : "join" + 每个子键 \0          // 栅栏（吸收全部槽键）
         : "replaced"                   // （Fo：prompt 替换键）
```

- 根：`{prev: ""}`，`Ee(label)` fork 时 `prev = Xn(prev, label, "fork")`
- `parallel`：每槽 `inSlot(i, fn)` → 键 `Xn(prev, label, i)`，槽内 agent 用该 prev + prompt 算最终键；
  `join()` 后 `prev = Xn(prev, label, [全部槽键])`
- **重放命中**：`results.get(key)` 命中即返回缓存（"j?.results.get(ve)"）
- **重试永不命中**：stall 重试的 prompt 加 " (retry N)" 后缀 → 键变 → 必然实跑（设计意图）

对比本引擎：`(siteId, ordinal, inputHash)`。Claude 的结构哈希对"代码挪位置"更鲁棒（结构不变则键不变）；
我们的显式键支持 amend **局部**失效 + inputHash 大声失败。两者重放语义等价，amend 能力我们更强。

## 2. parallel / pipeline（逐字还原）

```
parallel(thunks):
  - 参数必须是 THUNK 数组；传 promise 直接 TypeError：
    "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)"
  - 每槽经 inSlot(i) 进入（并发由 agent 门管）；Promise.allSettled → 失败映射为 null（绝不 reject）
  - WorkflowBudgetExceededError 的槽 → null + 汇总行
    "parallel: N slots dropped — token budget exceeded"
  - 其他失败 → log "parallel[i] failed: msg" → null

pipeline(items, ...stages):
  - 每项独立流过全部 stage（无全局栅栏）；`if (value === null) break` — null 截断该项下游
  - 同 allSettled→null + budget 丢弃计数
```

本引擎已实现同语义的 `fanout.parallel/pipeline`（realm 内建，父端席位门+AIMD 管并发）。

## 3. 预算（硬执行，精确到文案）

- `budget` 以 **frozen 快照** 注入 VM：`vmBudget(total, spent, remaining) => freeze({…})` ——
  VM 内只读。`total` 来自 run 配置（本引擎允许脚本内设置，差异已记录）。
- 双错误：`WorkflowAgentCapError`（1000 调用上限，防死循环文案）与
  `WorkflowBudgetExceededError`（"Stopping further agent() calls. In-flight agents will
  complete; their results are preserved."）——在 agent() 调用粒度检查 `getTurnSpent() >= total`。
- parallel/pipeline 对 budget 丢弃槽**计数并汇总**（不逐条报错）。
- 本引擎已实现同语义 + 同文案（差异：budget.total 可脚本内设置）。

## 4. agent() 停滞/重试（精确循环）

```
首次 429/throttle → await 45s → 重发 "(throttle-retry)"；再退化 → 放弃 throttle 退避
stall 循环: for (re = 1; stalled && re <= 5; re++):
  - 记录 reason（stalled / reply lost / user-retry）
  - StructuredOutput 校验失败数 + 最后输入(≤300 字符)进日志
  - 重发 "${label} (retry ${re})" —— 故意改 prompt 使重放键失效
  - 5 次后按 reason 抛不同的 abandon 文案
结果态: skipped | stalled_after_throttle | retries_exhausted | api_error | completed
ask 内部结果契约: {structured, text, agentMessages, tokens, toolCalls, stalled,
  stalledReason, replyLost, skipped, durationMs, stopReason, outputTokens,
  structuredOutputAttempts, lastStructuredOutputInput}
```

本引擎等价物：原子 provider 调用 + attempt-classifier（429→指数退避、transient→快重试）
—— 无流式停滞概念，语义覆盖等价。

## 5. 执行架构

- **脚本在 VM 内**：`vm.createContext` + **`codeGeneration: {strings: false, wasm: false}`**
  （禁 eval/Function 字符串编译与 wasm —— 本引擎已补齐同款加固）
- `bindVMAwait`（跨 realm await 绑定）/ `sanitizeVMValue`（跨界值消毒）/ `withLanesInert` /
  `sealSyncHooksInVM`（hooks 在 VM 内封印）
- 结果跨 realm：`ce = async (U) => ({v: await U})` 包装 + schema WeakMap 缓存
- agent 系统提示：固定前缀 "You are a subagent spawned by a workflow orchestration script."
- **workflow() 组合**：`workflow(name | {scriptPath})` 加载子脚本（meta.name + body）；
  **嵌套限一层**："nesting is limited to one level. Inline the inner script or call its
  agents directly."；子脚本独立 VM 上下文，log 前缀 "[childName] "

## 6. 并发治理（精确公式）

- `Aa(limit, fn)` = 信号量包装器，三个实例：
  - agent 门：`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS ?? min(16, max(2, cores - 2))`
    （ZCode 公式 `max(4, min(16, cores - 2))` 几乎相同——两引擎独立趋同）
  - fan-out 槽门：`Si = 50`（parallel/pipeline 槽上限）
  - worktree 单飞：`Aa(1, …)`
- 无 env 时 `inSlot`/`join` 直通（`ue` no-op gate）
- 前缀缓存 stagger：`DISABLE_PROMPT_CACHING ? 0 : CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`

## 7. 本引擎已补齐（本轮）

1. `fanout.parallel/pipeline` —— Claude 逐字语义（thunk 校验、null 映射、budget 丢弃汇总、
   pipeline 逐项流转 + null 截断）
2. VM `codeGeneration: {strings:false, wasm:false}` 加固
3. 默认并发公式对齐 `min(16, max(2, cores-2))`
4. 证据文件（本文件）+ `claude-code-binary-reverse.md`（首轮）

## 8. 不实现（有意，理由）

- frozen budget（允许脚本内设 total 更灵活，已记录差异）
- 流式 stall 重启（原子调用 + attempt-classifier 覆盖等价场景）
- prompt 链哈希重放键（显式 (siteId, ordinal, inputHash) 支持 amend 局部失效，更强）
- workflow() 子脚本组合（P2 剩余：saved workflows 已提供等价复用；一层嵌套限制反而更严）

## 9. 2026-11-02 TX 对齐复核（Issue #47）

> 方法：官方 `workflow-module-pretty.js` / `runner-context.txt` 定点精读 + 官方 Dynamic
> Workflow 实机探针（5 个 agent 调用，含 1 个不可满足 Schema 拦截探针）+ 本仓代码与门禁实测。
> 以下均为 `[已验证]`，行号以官方 2.1.316 解包件与本仓 `main@c56da8c` 为准。

### 9.1 官方探针实测（真实运行，非推断）

| 探针 | 官方实际行为 |
|---|---|
| VM 全局 | `process`/`require`/`fetch`/`queueMicrotask` 均 `undefined`；`log`/`console`/`setTimeout` 存在 |
| `budget` | `Object.isFrozen(budget) === true`，原型为 `null`，`total === null`（未设预算） |
| 纯度 | `Date.now()` / `Math.random()` 在脚本内直接抛错（破坏重放确定性） |
| 不可满足 Schema | 派发前抛错：`agent({schema}) received an unusable JSON Schema — no output can satisfy this schema... The subagent was not started` |
| `parallel` 异常语义 | thunk 抛错 → 该槽 `null`，其余槽正常完成 |
| 脚本静态门 | 工作流脚本中出现 `Date.now`/`Math.random` 会被运行前拒绝（本会话首次探针即被拒） |

### 9.2 全维度对照与结论

| 维度 | 官方 | 本仓现状 | 判定 |
|---|---|---|---|
| 控制流/DSL | JS VM async/await + AST 预检 | TS facade 编译期类型检查 + 降级为 VM JS；`codeGeneration` 加固 | 等价，无差距 |
| 线程上下文 | per-host 前缀 warm gate（`markWarm`，TTL 270s）+ 交错启动 | **持久 actor 会话**：`history` 跨 ask 复用（`engine.ts:102-103,371-372,447-453`） | 本仓更强；缺缓存标记 → 本 PR 补 |
| 并发/竞速 | 并发门 + `parallel` | 席位门 + AIMD + `waitAny`/`cancel`；**无自动斩败者** | P1 → 本 PR 补 `sessions.race` |
| 预算/配额 | 只读 frozen budget；usage-limit `resetsAt` 自动挂起（最多 2 次，24h 视界） | `budget` 为 run 级注入的 frozen 对象（Issue #73）；quota reset 在整跑 deadline 内最多等 2 次 | 已对齐（有界等待）；24h 无界等待仍为有意差异，见 §9.3 |
| Schema | 派发前 `lRt()` 结构化 lint（`pretty.js:2139-2148`） | 编译期 synthesis 保证形状；运行期无预检，`json-schema-zod` 会静默接受不可满足 Schema | P1 → 本 PR 补 |
| 工具黑白名单 | `disallowedTools` / `bashCommandClamp` 递归过滤工具池 | `LLMRequest` 无 tools 字段，provider 仅文本生成 | 结构性不适用，不移植 |
| 状态持久化 | 内存状态机 + 进程内事件流 | SQLite WAL + journal + `inputHash` 短路 + amend 温缓存 | 本仓优势 |
| 可观测性 | TUI 单行进度 + phase 日志 | `live.ts` HTTP 实时投影 + `view.ts` 阶段分组 + DAG 可视 | 本仓优势（修正 TX 任务书「缺少实时 DAG」的旧判断） |
| 错误代数 | Tagged 错误 + 多级降级 | 同名 Tagged Error Algebra + failover + circuit breaker | 等价 |

### 9.3 有意保留的差异（不是缺陷）

1. **`budget` 只读（已对齐，Issue #73）**：预算改为 run 级注入（`--budget-total` / MCP `budgetTotal`），
   沙箱内为 `Object.freeze(Object.create(null))` 的只读对象；脚本赋值在编译期被拒。
   这是破坏性契约变更，已在 Issue #73 与本文留痕。
2. **usage-limit 等待有界（Issue #73）**：provider 429 的 `retry-after` / 结构化
   `quotaLimits.resetsAt` 会触发同一 provider 的重试；仅在整跑 deadline 内、且每个 ask 最多 2 次；
   超出 deadline 仍回到 G7 policy-stop。官方 24h 无界等待仍为有意差异（本仓默认 10 分钟整跑超时）。
3. **失败节点确定性重放**：`--resume` 重放同一失败而非重试，是既有确定性契约（`engine.ts:1035-1040`
   与 `tests/integration/dwf-failed-node.test.ts` 锁死）；重试须 amend 或新 run。
   **取消是例外**（Issue #49）：`AbortError` 不落 failed 节点、不记 failed evidence，resume 重新执行；
   实时事件仍以 `cancelled:true` 可见。
4. **工具黑白名单**：当前子代理没有工具循环，移植会得到永远不生效的死配置。

### 9.4 本 PR（Issue #47）落地的三项

- `sessions.race(turns, {timeoutMs})`：首个 **fulfilled** 获胜，自动 cancel 其余未决 turn；
  全败/超时同样级联取消（`child-main.ts` BOOTSTRAP、`facade-dts.ts`、`lower.ts`）。
- `src/dwf/schema-lint.ts` + `engine.ts` 派发前调用：区分 invalid / unsatisfiable，命中即抛
  `SchemaValidationError`，不发起任何 provider 请求。
- `AnthropicProvider` 顶层 `cache_control:{type:'ephemeral'}`（默认开启，`cacheControl:false` 可关）：
  让持久 actor 会话的稳定前缀命中 Anthropic 自动提示缓存。

### 9.5 Issue #49 取消语义修正

`sessions.cancel` 的公开契约是「取消的 turn 不落 journal，重放如未发生」。此前 `journalled()` 会把
`AbortError` 落成 failed 节点，导致 `--resume` 重放幻影失败。现改为：

- `AbortError` 直接重抛，**不** `saveDwfNode`、**不** `recordEvidence`；
- 仍 emit `dwf_node_failed`，data 带 `cancelled:true`，供实时视图结算与 runner 释放 in-flight 计数；
- 回归测试锁定：取消后无 failed 行；resume 时被取消的 ask 重新 `dwf_ask_start`，已完成胜者走
  `dwf_replay_hit`（零 provider 调用）。
- 未新增持久 `cancelled` 节点状态（避免 DwfNode schema 与全部渲染器泛化）；事件层已可区分。

### 9.6 Issue #73 攻坚三：只读预算 + 配额 reset 有界等待

- `budget` 由 run 配置注入（CLI `--budget-total`、MCP `budgetTotal`、`RunFacadeOptions.budgetTotal`），
  沙箱内为 `Object.freeze(Object.create(null))` 的只读对象；`budget.total` 赋值在编译期被 TypeScript
  拒绝，运行期对象也冻结。子工作流继承父 run 的剩余预算。
- 429/配额错误：`AgentProviderError.details.resetAtMs`（由 Anthropic/OpenAI `retry-after` 解析）或
  `details.quotaLimits = {status:'rejected', resetsAt}` 触发同一 provider 的重试；每 ask 最多 2 次，
  且等待不超过 runner 传入的 `deadlineMs`；超限仍走既有 policy-stop。等待用 abort-aware sleep，
  `sessions.cancel` 仍按 Issue #49 的取消语义处理。
- 官方 24h 无界等待未照搬（本仓默认 10 分钟整跑超时），差异保留并记录。
