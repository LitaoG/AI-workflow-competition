# 吸收能力与决策账本（Absorbed Capabilities Ledger）

> 本文件记录 Project Y 中每一项外部能力的**吸收或拒收决策**：来源、原理、四级过滤（T1–T4）结论、落地模块、对应 Issue / PR 与验证证据。
>
> - **勘误注记（Issue #147）**：下方快照中出现的 `tests/pbt/…` 是 2026-11-15 目录搬迁前的历史命令记录（当时真实路径），现行 PBT 套件位于 `.kiro/pbt/`——历史证据保持原样不回写。
>
> - **四大技术谱系来源**：
>   1. **ZCode 官方 Dynamic Workflow**：动态 LLM DAG 编排与类型推导；
>   2. **Claude Code 原生 Dynamic Workflow**：VM 沙箱纯度封印与上下文预算硬约束；
>   3. **morluto/rea**：向内依赖架构、证据凭证法则与 Tagged Error 代数；
>   4. **Google Antigravity 原生动态工作流**：双进程物理隔离、FD 劫持干净 RPC 管道、未 Await 挂起 Promise 自动审计防御、双模态 Agent 析构与弱引用协同。
> - **只增不删**：决策被推翻时追加新条目，并在旧条目标注「已被 CAP-xxx 取代」，不删除旧条目。
> - **证据是快照**：「验证证据」记录的是条目落地当时、在指定基线上运行命令的输出，属于审计快照；现行数值以重新运行同一命令为准（遵循 `docs/README.md` 的「动态数据不硬编码」规则）。
> - **四级过滤**：T1 解决真实问题；T2 符合向内依赖架构，错误走 Tagged Error 代数；T3 控制流是确定性的 TypeScript 代码；T4 能被 `node:test` / `fast-check` / E2E 机械验证。四级全过才吸收。

---

## 一、已吸收（Absorbed）

### [CAP-001] 运行级 MCP 连接池：按需连接 + 单次握手 + 零残留收口

- **汲取来源**：
  - Claude Code 项目级 MCP 配置约定：项目根 `.mcp.json` 的 `mcpServers`、`${VAR}` / `${VAR:-default}` 环境变量展开、stdio 服务器环境里的 `CLAUDE_PROJECT_DIR`（[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)「Option 3: Add a local stdio server」与「Environment variable expansion in .mcp.json」两节）。
  - MCP TypeScript SDK 的 `StdioClientTransport`：`cwd`、环境变量合并与 `pid`（版本以 `package-lock.json` 为准）。
  - 单飞（single-flight）请求合并：同一个键的并发请求共享一次执行（[golang.org/x/sync/singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight)）。
  - 本仓 `docs/AI-PITFALLS.md` P-TEST-3：stdio `connect` 没有内置超时，负载下会挂起。
- **原理解析**：
  1. 旧实现每次 `ctx.mcp.callTool` 都新建一个从未连接的客户端，真实模式下必然报 `MCP Server "x" is not connected`（Issue #106）。
  2. 新实现每次 run 只有一个 `MCPClientManager`，在根上下文构造时创建（无 I/O），子上下文经原型链共享它。
  3. 首次调用某个服务器时才解析配置并握手。配置只来自显式来源：`WorkflowOptions.mcpServers`，或一个显式指定的可信 `.mcp.json`（`WorkflowOptions.mcpConfigPath`，缺省读环境变量 `AI_WORKFLOW_MCP_CONFIG`）。工作目录里的 `.mcp.json` 从不被隐式读取。
  4. 同一服务器的并发首次调用共享同一个握手 Promise，只启动一个 stdio 子进程。
  5. 握手与超时竞速（默认 20 s，可用 `WorkflowOptions.mcpConnectTimeoutMs` 或环境变量 `AI_WORKFLOW_MCP_CONNECT_TIMEOUT_MS` 调大；非法值在启动任何进程之前报 `MCP_CONFIG_INVALID`；超时错误会写明这两个开关）；失败或超时都会关闭传输。失败在本次 run 内缓存：之后对该服务器的调用立即返回同一个错误、不再握手，坏服务器只付一次超时；显式 `connectServer` 成功会清除缓存。
  6. `.mcp.json` 里的服务器在该文件所在目录启动，环境里带 `CLAUDE_PROJECT_DIR`（等于该目录，条目自带的优先），因此不依赖 run 的工作目录。握手失败的原因先经 `redactText` 脱敏，再进入错误与事件。
  7. `Workflow.run()` 在 `finally` 里调用 `disposeMcp()`：先等在途握手落地，再关闭全部连接。之后的调用返回 `MCP_CLIENT_CLOSED`，不会再启动无人回收的子进程。
  8. 工具执行失败按失败处理：MCP 把工具失败写在结果里（`isError: true`），不会抛错。`callTool` 遇到它就抛 `McpToolError`（`MCP_TOOL_FAILED`；错误文本先经 `redactText` 脱敏，再截断到 500 字符），步骤因此失败或按重试策略重试，不会把错误文本当成输出交给下游。需要原始结果的调用方传 `{ allowToolError: true }`。
- **与来源的刻意差异**：
  - Claude Code 在交互会话里会先请用户批准项目级 `.mcp.json`，才启用其中的服务器；本引擎没有交互批准环节，因此只读显式指定的配置文件（Issue #106 预审 F1）。
  - Claude Code 遇到「未设置且无默认值」的 `${VAR}` 仍会加载配置，并把 `${VAR}` 原文传下去；本引擎改为失败即关闭，抛 `MCP_CONFIG_INVALID`，避免服务器带着占位符启动。
  - 空字符串算「已设置」，`${VAR:-default}` 不取默认值，与 Claude Code 一致。
  - 只支持 `stdio` / `sse` 两种传输（与既有 `MCPServerConfig` 一致）；其他 `type` 报 `MCP_CONFIG_INVALID`。
  - `.mcp.json` 解析失败时，错误信息不引用文件原文，因为原文可能含密钥。
- **4-Tier 评估**：T1: PASS, T2: PASS, T3: PASS, T4: PASS
  - T1：真实模式下 `ctx.mcp.callTool` 每次都失败（Issue #106 复现输出）。预审又指出两个新问题：隐式读取工作目录的 `.mcp.json` 会执行不可信仓库配置的命令；坏服务器每次调用都要等一次超时。复核再指出两个：握手超时无法调大，慢启动的服务器次次失败；工具执行失败（`isError: true`）会被当成成功写进步骤输出。四点都已修正。
  - T2：配置解析与连接逻辑留在适配层 `src/mcp/`；领域类型只增加可选成员（`MCPServerConfig.cwd`、`WorkflowOptions.mcpServers`、`WorkflowOptions.mcpConfigPath`、`WorkflowOptions.mcpConnectTimeoutMs`，以及 `ctx.mcp.callTool` 的可选参数 `McpCallOptions`）；5 个新错误都是 `WorkflowError` 子类，`tag: 'McpError'`，不使用裸 `new Error`。
  - T3：按需连接、单飞、失败缓存、超时、工具失败判定与收口全是确定性的原生 TypeScript 控制流，不经过 LLM；配置来源顺序固定。
  - T4：单元测试（含 2 例真实 stdio 子进程的退出校验）与 `fast-check` 性质测试锁死，见下方证据。
- **已知盲区（E 类风险）**：
  - 宿主进程被强杀时 `finally` 不执行；SDK 用普通 `spawn` 启动 stdio 子进程，不在 #98 的 Job Object 里，Windows 上可能留下孤儿进程（预审 F3，刻意不在本次修改，跟进 #117）。
  - builder 引擎（`src/core` / `src/state`）把每步的 input / output 原样写进 SQLite 和事件，没有脱敏（`src/state/sqlite-store.ts` 写检查点处）。这是既有缺口；本能力合入后，真实 MCP 工具的成功结果第一次走上这条路径（复核 F5，跟进 #112）。工具失败文本进入错误之前已经脱敏。
  - `npm run test:integration` 不在 CI 里（复核 F8，跟进 #113）；本能力相关的集成用例只在本机跑过，见下方证据。
  - 步骤配了 `retryPolicy` 时，`McpToolError` 这类确定性错误也会让整个步骤重跑：`withRetry`（`src/core/error.ts`）只看 `retryableErrorFilter`，不看 `isRecoverable`，步骤里排在前面的 agent 调用每次都重新付费（PR 审查 F9，跟进 #120）。**已由 CAP-002 修复（#120）。**
  - 并行步骤用 `Promise.all` 执行（`src/core/workflow.ts` 的 `executePhaseSteps`），一个步骤失败就 reject；`Workflow.run()` 的 `finally` 随即关闭全部 MCP 连接，兄弟步骤正在执行的工具调用（包括写类工具）可能只做了一半，兄弟步骤的模型调用也会继续花钱（PR 审查 F10，跟进 #120）。**已由 CAP-002 修复（#120）。**
- **落地模块**：`src/mcp/client.ts`、`src/core/context.ts`、`src/core/workflow.ts`、`src/core/error.ts`、`src/domain/workflow-types.ts`、`src/index.ts`；测试 `tests/unit/mcp-lazy-connect.test.ts`、`.kiro/pbt/mcp-lazy-connect.test.ts`。
- **对应 Issue & PR**：私有仓 Issue #106（含预审、复核与 PR 审查意见 F1–F10）；跟进私有仓 Issue #112、#113、#117、#120；私有仓 PR #119（分支 `fix/issue-106-mcp-real-connect` → `main`）。
- **验证证据**（审计快照，2026-11-06，基线 `bbd26ff`，Windows / Node 26.13.0）：
  - 第 1 个提交 `c786dda`（预审前）：
    - `npm.cmd run build` → exit 0
    - `node --test dist/tests/unit/mcp-lazy-connect.test.js` → `tests 10, pass 10, fail 0`
    - `node --test tests/pbt/mcp-lazy-connect.test.ts` → `tests 2, pass 2, fail 0`
    - 单元全集 `node --test --test-concurrency=1 "dist/tests/unit/**/*.test.js"` → `tests 360, pass 360, fail 0`（与 `npm.cmd run test:unit` 同一批文件；为适应宿主机内存改为串行）
    - PBT 全集 `node --test --test-concurrency=1 "tests/pbt/**/*.test.ts"` → `tests 7, pass 7, fail 0`
    - 治理锁死 `node --experimental-strip-types tests/unit/workflow-governance.test.ts` → `tests 24, pass 24, fail 0`
    - E2E：`tests/e2e/runner.ts` 本身**未运行**（宿主机可用内存不足 2.5 GB；串行时第 1、2 组各超过 runner 每组 60 s 的上限）。改用同样的 4 组测试文件与同样的参数（`--experimental-strip-types --test --test-reporter=tap`，另加 `--test-concurrency=1`），按 runner 的同一计数正则统计：50/50、50/50、15/15、6/6，合计 `pass 121, fail 0`。
    - 洁净度 `scripts/pr_review_gate.mjs --check-clean`（提交后）→ `[门禁通过] 工作区彻底干净`，exit 0。
  - 预审修正（第 2 个提交）：
    - `npm.cmd run build` → exit 0
    - `node --test dist/tests/unit/mcp-lazy-connect.test.js` → `tests 13, pass 13, fail 0`
    - `node --test tests/pbt/mcp-lazy-connect.test.ts` → `tests 2, pass 2, fail 0`
    - 单元全集 `node --test --test-concurrency=1 "dist/tests/unit/**/*.test.js"` → `tests 363, pass 363, fail 0`
    - PBT 全集 `node --test --test-concurrency=1 "tests/pbt/**/*.test.ts"` → `tests 7, pass 7, fail 0`
    - 治理锁死 `node --experimental-strip-types tests/unit/workflow-governance.test.ts` → `tests 24, pass 24, fail 0`
    - E2E（提交后在 `4c6da3a` 上运行）：`tests/e2e/runner.ts` 本身仍未运行（原因同上）。按同样的文件、参数与计数正则串行运行：50/50、50/50、15/15、6/6，合计 `pass 121, fail 0`。此前 3 次尝试因可用内存低于 1.2 GB 下限而跳过（979 / 787 / 934 MB）。合入前仍建议在内存充足的机器或 CI 上跑一次原版 runner。
    - 洁净度 `scripts/pr_review_gate.mjs --check-clean`（提交 `4c6da3a` 后）→ `[门禁通过] 工作区彻底干净`，exit 0。
  - 复核修正（第 4 个提交，F5–F8）：
    - `npm.cmd run build` → exit 0
    - `node --test dist/tests/unit/mcp-lazy-connect.test.js` → `tests 17, pass 17, fail 0`
    - `node --test tests/pbt/mcp-lazy-connect.test.ts` → `tests 2, pass 2, fail 0`
    - 单元全集 `node --test --test-concurrency=1 "dist/tests/unit/**/*.test.js"` → `tests 367, pass 367, fail 0`
    - 集成全集 `node --test --test-concurrency=1 "dist/tests/integration/**/*.test.js"`（与 `npm.cmd run test:integration` 同一批文件）→ `tests 122, pass 122, fail 0`；其中 `mcp.test` 与 `workflow.test` 两个文件单独运行 → `tests 10, pass 10, fail 0`。第一次全集运行有 3 个迁移 demo 用例失败：worktree 没有跑过 postinstall 的 `scripts/bootstrap-fixtures.mjs`，fixture 缺离线 SDK 桩（`ERR_MODULE_NOT_FOUND: aws-sdk`）。补跑该脚本后全部通过，与本次改动无关。
    - PBT 全集 `node --test --test-concurrency=1 "tests/pbt/**/*.test.ts"` → `tests 7, pass 7, fail 0`
    - 治理锁死 `node --experimental-strip-types tests/unit/workflow-governance.test.ts` → `tests 24, pass 24, fail 0`
    - E2E（串行等价运行，方法同上）：50/50、50/50、15/15、6/6，合计 `pass 121, fail 0`

### [CAP-002] 并行步骤的结构化并发（errgroup 式取消 + 等收尾）与按错误分类重试

- **汲取来源**：
  - Go `errgroup.WithContext`：同组里第一个返回错误的任务会取消派生的 Context；`Wait` 等全部任务返回后，再交出第一个错误（[golang.org/x/sync/errgroup](https://pkg.go.dev/golang.org/x/sync/errgroup)）。
  - Temporal 的不可重试错误（Non-Retryable Errors）：永久性失败直接上报、不重试；实现方可以把错误标成不可重试（[Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)）。
  - Issue #120（监督席审查 PR #119 时提出的 F9、F10）。
- **原理解析**：
  1. 同一批就绪步骤共用一个 `AbortController`。第一个失败的步骤先 abort 这个信号，再去落盘和发事件。
  2. 每个步骤的上下文带着这个信号（`ctx.signal`）。信号触发后，`ctx.agent().ask` 不再发起模型调用，在途的模型请求也会中止；`ctx.mcp.callTool` 和 `ctx.gate()` 不再开始新的调用（报 `WorkflowAbortedError`），但已经在途的工具调用和命令不打断，避免写类操作只做一半。
  3. 用 `Promise.allSettled` 等同批全部步骤结束，再抛出第一个失败的 `StepExecutionError`。`Workflow.run()` 的 `finally` 因此总在所有步骤结束之后才关闭 MCP 连接。
  4. `withRetry` 默认不重试 `isRecoverable === false` 的错误（如 `McpToolError`、`GateFailureError`、`WorkflowAbortedError`）；配了 `retryableErrorFilter` 时由过滤器决定。批次信号触发后不再重试，退避等待提前结束。
- **与来源的刻意差异**：
  - Temporal 里实现方标成不可重试的错误，调用方的重试策略也改不了；本引擎沿用既有的 `retryableErrorFilter`，由调用方最终决定，保持向后兼容（例如想重试偶发失败的 gate，可以显式放行）。
  - errgroup 依赖任务自己响应 Context；本引擎在 `agent`、`mcp`、`gate` 三个入口统一检查信号，现有步骤代码不用改。自定义的长时间计算可以自己读 `ctx.signal`。
  - 只中止在途的模型请求（没有外部副作用），不中止在途的 MCP 工具调用和 gate 命令。
- **4-Tier 评估**：T1: PASS, T2: PASS, T3: PASS, T4: PASS
  - T1：修复前，配 `retryPolicy` 的步骤遇到确定性错误会整步重跑（复现：3 次模型调用，应为 1 次）；并行步骤一个失败后，兄弟步骤仍会调用模型（复现：1 次，应为 0）；`run()` 还会在兄弟步骤的 3 s 工具调用中途关闭 MCP 连接（复现：`MCP error -32000: Connection closed`）。
  - T2：改动集中在 `src/core`（调度、上下文、重试）与 `src/agent/rpc.ts`（合并取消信号）；领域类型只增加可选成员（`ExecutionContext.signal`、`createChildContext` 的可选 `signal` 参数）；取消沿用既有的 `WorkflowAbortedError`。
  - T3：取消、等待与重试判定都是确定性的 TypeScript 控制流，不经过 LLM。
  - T4：单元测试（含 1 例真实 stdio 子进程）与 `fast-check` 性质测试锁死，见下方证据。
- **已知盲区（E 类风险）**：
  - `agent().ask` 的 schema 校验失败目前抛普通对象，没有 `isRecoverable`，配了 `retryPolicy` 时仍会重试（#110 跟踪）。
  - dwf runner 的同类问题不在本能力范围（#107 跟踪）。
  - 只等不杀：在途的长工具调用或长命令会拖慢失败的上报。
- **落地模块**：`src/core/workflow.ts`、`src/core/context.ts`、`src/core/error.ts`、`src/agent/rpc.ts`、`src/domain/workflow-types.ts`；测试 `tests/unit/step-failure-paths.test.ts`、`.kiro/pbt/retry-classification.test.ts`。
- **对应 Issue & PR**：私有仓 Issue #120；私有仓 PR 由分支 `fix/issue-120-retry-sibling-cancel` 发往 `main`（编号以 GitHub 为准）。
- **验证证据**（审计快照，2026-11-06，基线 `c969216`，Windows / Node 26.13.0）：
  - 修复前（只加测试、未改代码）：`node --test --test-reporter=tap dist/tests/unit/step-failure-paths.test.js` → `tests 5, pass 2, fail 3`：
    - `not ok 1 - #120 A: a step with a retryPolicy does not rerun on a non-recoverable error (McpToolError)`（实际 3 次模型调用）
    - `not ok 4 - #120 B: when a parallel sibling fails, the other step makes no further model calls`（实际 1 次）
    - `not ok 5 - #120 B: a sibling failure lets an in-flight MCP call finish, starts no new one, and the run waits before closing MCP`（实际 `slow failed: MCP error -32000: Connection closed`）
  - 修复后，同一文件 → `tests 8, pass 8, fail 0`
  - `npm.cmd run build` → exit 0
  - 单元全集 `node --test --test-concurrency=1 "dist/tests/unit/**/*.test.js"` → `tests 375, pass 375, fail 0`
  - 集成全集 `node --test --test-concurrency=1 "dist/tests/integration/**/*.test.js"` → `tests 122, pass 122, fail 0`
  - PBT 全集 `node --test --test-concurrency=1 "tests/pbt/**/*.test.ts"` → `tests 8, pass 8, fail 0`（新增的 `retry-classification` 性质：150 组随机错误序列）
  - 治理锁死 `node --experimental-strip-types tests/unit/workflow-governance.test.ts` → `tests 24, pass 24, fail 0`
  - E2E（串行等价运行，方法同 CAP-001）→ 50/50、50/50、15/15、6/6，合计 `pass 121, fail 0`

### [CAP-003] 蜂群派发策略与 Git Worktree 物理隔离（swarm dispatcher + worktree pool）

- **汲取来源**：官方 runner-core 并发窗口公式 `min(16, max(2, cores−2))` 与 agent cap 1000 熔断；官方子代理 worktree 契约「无变更自动清理、有变更保留待审 + worktreePath/Branch 回传」（语义锚：官方解包件 worktree 管理段）；UltraCode detached worktree@HEAD 与 runtime.js 窗口/预算参数。
- **原理解析**：每任务一棵独立分支+物理工作区（同级目录纪律），干净树释放即删（零残留）、脏树保留并回传路径/分支/状态供人审；并发窗口单一来源化（option > env > 公式，非法覆盖回退防 NaN 毒化座位门）；token 预算超限在 `__swarm` 侧落 null（drop-slot，运行级事实不连坐任务）。
- **4-Tier 评估**：T1: PASS（千级并发底座 + 物理隔离杜绝脏工作区），T2: PASS（`src/execution/` 独立模块，向内依赖），T3: PASS（纯 TypeScript 控制流），T4: PASS（生命周期/并发窗口/预算 drop-slot 全测试锁死）。
- **落地模块**：`src/execution/{worktree-pool,swarm-dispatcher}.ts`；测试 `tests/unit/execution/`、`tests/unit/dwf/dwf-swarm-budget.test.ts`。
- **对应 Issue & PR**：私有仓 Issue #140（Part of 私有仓 #88）；私有仓 PR #150。
- **验证证据**（审计快照，2026-11-07，head `d3734b1`，Windows / Node 26）：build exit 0；unit `tests 448, pass 448, fail 0`（438→448）；PBT 9/9；E2E `pass 121, fail 0`；governance 24/24；check-clean 通过。并发 4 任务各写不同文件→逐个 mergeIntoBase→`git worktree list` 只剩主树（零残留断言）。
- **定位披露（Issue #123）**：**worktree-pool 未接线 swarm 主链路**——dwf swarm 消费的仅是 swarm-dispatcher 的窗口公式；per-task worktree 物理隔离止于本模块与其单测，而 facade 公开契约（`src/dwf/facade-dts.ts` swarm()）明文写 "All tasks share this run's working tree (no per-task worktree)"。本条 T1 的「物理隔离」语义**仅在该模块自身验证范围内成立**，不适用于主引擎 swarm 路径。接线或退役为后续拍板项。

### [CAP-004] 任务属性双轨模型路由 + Plan/Build/YOLO 三档权限 + 门禁监督化（Phase 6 三件套）

- **汲取来源**：ZCode 双轨路由（Thinking/Flash 分层于可靠性链之上，F.md §5.6）；官方 AgentInput mode 权限档语义（sdk-tools.d.ts:775-816，取三档子集）；world.run 安全边界（编译期命令审批 + spawnSupervised + env 白名单 + redactText）反向统一旧引擎。
- **原理解析**：router 只决定 failover 链头（显式 provider > tier 字面量 > schema/提示尺寸属性 > registry default 未配置即无操作），不替换 governor/重试链；权限走 Phase 3 预留 `PermissionGate` 接缝（Plan=readOnly 才放行、Build=写操作带结构化确认挂起标记、YOLO=迁移前逐字行为）；gateStep/ctx.gate 从裸 execAsync 迁到监督化 spawn（无 shell argv 解析、控制语法响亮拒绝、整树超时击杀、输出不可逆脱敏）。
- **4-Tier 评估**：T1: PASS（消除一产品两档子进程安全分叉；预算化路由降本），T2: PASS（permissions/ 独立目录，gate 迁移就地改），T3: PASS（全确定性控制流），T4: PASS（router 5 例 + permissions 5 例 + tier 贯通 4 例 + 监督 gate 5 例）。
- **落地模块**：`src/agent/model-router.ts`、`src/core/permissions/{modes,permission-manager}.ts`、`src/core/{step,context,agent-loop,query-engine}.ts`、`src/process-supervision.ts`（SPAWN_ENV_ALLOWLIST 共享）、`src/dwf/{facade-dts,compile,lower,protocol,child-main,runner,engine}.ts`（tier 贯通）。
- **对应 Issue & PR**：私有仓 Issue #151（Part of 私有仓 #88）；私有仓 PR #158。
- **验证证据**（审计快照，2026-11-07，head `fabd080`）：build exit 0；unit `tests 457, pass 457, fail 0`（452→457）；PBT 9/9；E2E `pass 121, fail 0`；governance 24/24；check-clean 通过。既有 gate 测试（core.test.ts / step-failure-paths.test.ts）不改编全绿。
- **定位披露（Issue #123）**：**src/core 的 ReAct 循环子系统（agent-loop/query-engine/compaction/permissions，约 1408 行）生产不可达**——全仓唯一消费是 `tests/unit/core/{query-engine,permissions}.test.ts`（831 行）；生产 ask 链路走 `src/agent/rpc.ts`（builder 步骤）与 `src/dwf/ask-executor.ts`（主引擎，自带 RetryOrchestrator + governor AIMD + failover），两套为平行实现（共享 attempt-classifier 原语）。保留为能力吸收演示资产；退役（净减约 2200 行含测试）或提供真实入口为后续拍板项。

### [CAP-005] AST 符号图上下文索引与预算化切片（Repomap，支柱二）

- **汲取来源**：Aider Repomap 思路（符号依赖图决定向 LLM 投递哪些代码切片）；实现走 TypeScript 编译器 API 纯语法树（零新依赖，供应链红线不引 tree-sitter）。
- **原理解析**：逐文件顶层导出符号表 + 相对导入边（按真实标识符使用次数加权）→ 目标文件的「导入方 ∪ 被导入」邻域按权重排名；切片保留相关声明优先、其余补位，硬字符预算封顶且截断标记计入预算内（文本永不超限、截断必带内声明）。经 facade 只读口 `files.map(target)` 暴露，journal 可重放。
- **4-Tier 评估**：T1: PASS（上下文预算的机械化为支柱二核心目标物），T2: PASS（`src/context/` 新域，仅依赖 ts+node），T3: PASS（确定性建图），T4: PASS（真实临时工作区符号图/切片预算/引擎端到端 4 例）。
- **落地模块**：`src/context/{repomap,slice}.ts`；`src/dwf/{facade-dts,compile,engine}.ts` 接线；测试 `tests/unit/context/repomap.test.ts`。
- **对应 Issue & PR**：私有仓 Issue #157（y.md 支柱二）；私有仓 PR #160。
- **验证证据**（审计快照，2026-11-07，head `499a886`）：build exit 0；unit `tests 452, pass 452, fail 0`（448→452）；PBT 9/9；E2E `pass 121, fail 0`；governance 24/24；check-clean 通过。

### [CAP-006] Studio 双语表面 + stdio 看门狗收养 + world.run 外部审批（第三波三件）

- **汲取来源**：双语——仓库自有 steering 规则（bilingual-presentation）落地为渲染层字典注入；看门狗——经典 orphan-watchdog 模式（OpenProcess 双等，宿主死 → TerminateProcess）适配 MCP SDK 的 blind-spawn 边界；外部审批——Claude Code 逐条确认语义反推到 world.run 面。
- **原理解析**：① STUDIO_I18N 单表驱动服务端模板与客户端注入（占位符精确上下文替换，避免 token/属性名同名的 /g 自伤）；② SDK 在 StdioClientTransport 内部 blind-spawn —— spawnJobGuarded 不可见，改 watch-and-adopt（helper 双等宿主与子，宿主死 → TerminateProcess；**刻意不用嵌套 kill-on-close job**：与 SDK 子进程生命周期管理碰撞有 #120 B bisect 实证）；③ 审批三源（显式列表 ∪ 项目 allowlist ∪ 交互 y/N 持久化）pre-flight 于引擎存在之前，拒绝即零子进程。
- **4-Tier 评估**：T1: PASS（双语=演示分；孤儿=宿主强杀零残留；审批=堵提示注入执行链），T2: PASS（各自落在所属层），T3: PASS（确定性控制流），T4: PASS（双语 3 例 / adopt 真机收割 2 例 / 审批 6 例；#120 B 真实 stdio 家族 12/12 回归）。
- **落地模块**：`src/visualizer/studio-renderer.ts`、`scripts/win32-jobhelper.cs`（adopt 模式）+ `src/process-supervision.ts`（adoptPidIntoJobGuard）+ `src/mcp/client.ts`；world.run 外部审批就地落在引擎主链——`src/dwf/engine.ts`（`worldRun` 逐调用三源授权：explicit / allowlist / tty，事件 `dwf_world_run_auth` 落账）、`src/dwf/runner.ts`（`--approve-cmd` 显式批准与项目 allowlist `.workflow/approved-commands.json` 合并）、`src/dwf/diagnostics.ts`（编译期审批命令集）+ CLI/MCP 接线。
- **对应 Issue & PR**：私有仓 #128→私有仓 PR #187；私有仓 #117→私有仓 PR #189；私有仓 #127 方向 2+3→私有仓 PR #191（已合入）；方向 1→私有仓 PR #197（已撤回未合入；全量 unit 套件挂死根因随后由 unit 纯隔离语义门禁收口，见 `docs/AI-PITFALLS.md` P-TEST-5）。
- **验证证据**（2026-11-08）：双语 unit 548/548 + CLI 冒烟全中文；adopt 真机收割 2/2 + #120 B 12/12；审批模块/runner 6/6（未批准→零子进程预检拒绝、批准→命令真执行、allowlist 持久化）。

### [CAP-007] 动态工作流未 Await 挂起 Promise / Agent 自动审计防御（Unawaited Promise & Agent Leak Audit）

- **汲取来源**：
  - Google Antigravity 原生动态工作流（run-workflow Prelude 注入运行时，语义锚：在途注册表与终态审计段）中的 `_tracked` 与 `_agents` 扫描器；
  - 详见权威对标白皮书 [ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md](research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md) §2.5 与 §4.1。
- **原理解析**（实现以本节为准，随 Issue #279 修正登记与实现的脱节）：
  1. 在动态代码编排（Code as Workflow）中，LLM 或开发者书写异步脚本时极易遗漏 `await`（如写出裸 `agent(...).ask(...)`）。标准 Node.js / V8 事件循环不会将未等待的 Promise 视为致命语法错误，任务结果被静默丢弃，导致工作流在结果未被消费的情况下报出 `dwf_done`（假绿，Fake Green）；
  2. 沙箱 realm 内（`src/dwf/child-bootstrap.ts`）为每个非 fire-and-forget 门面调用（`enterPhase`/`log`/`report`/`declareArtifact` 四个白名单算子刻意豁免——丢弃日志/上报属合法松散风格）登记消费描述符 `{siteId, op, awaited}`；脚本经 `then`/`catch`/`finally`（含 `await` 降联）消费返回 Promise 时置 `awaited=true`，**仅结算（ok 帧到达）不清除标记**；
  3. 在脚本主入口执行完毕、即将派发完成帧之前（`src/dwf/child-main.ts` 终态审计），双网检查：先查消费网 `getUnawaited()`（抓「已结算但结果被丢弃」），再查在途网 `getPending()`（抓 done 时刻仍在等回复的调用）；任一非空即拦截 `dwf_done`，向事件流派发携带 `taggedError` 的失败事件并抛出结构化具名错误 `WorkflowUnawaitedPromiseError`（真实登记于 `src/domain/errors.ts` 闭集第十成员，details 含 `siteId`/`op`/`fixSuggestion` 修复建议）；
  4. 杜绝漏写 await 导致的「结果被丢弃却报成功」假绿现象。
- **与来源的刻意差异**：
  - Antigravity 运行在 Python 解释器环境，使用弱引用（`weakref`）和 `__await__` 特殊方法扫描；本仓基于 TypeScript / Node.js 异步执行沙箱，在 realm 内以受控 Promise 子类（消费即标记）+ 宿主终态双网扫描实现确定性校验；
  - **边界（明确未实现）**：「悬挂 Agent 审计拦截」未落地——`getActorUsage()`（创建/使用登记）仅为诊断出口，生产链路无消费者；Agent 泄漏拦截需独立立项，本文不宣称已实现（Issue #279 F2 修正）。
- **4-Tier 评估**：T1: PASS, T2: PASS, T3: PASS, T4: PASS
  - T1：解决大模型生成动态工作流脚本时漏写 await 导致的假绿放行顽疾；
  - T2：向内依赖架构，错误派发为领域层 Tagged Error 代数具名成员；
  - T3：检查为确定性的消费标记 + 集合扫描断言，不经过任何 LLM 不确定性推断；
  - T4：单测机械验证——未 await 脚本（含「已结算但被丢弃」形态）必须 `failed` 且错误精准命中丢弃调用（`tests/unit/dwf/unawaited-promise.test.ts`）。
- **落地模块**：`src/dwf/child-bootstrap.ts`（消费描述符与受控 Promise 子类）、`src/dwf/child-main.ts`（终态双网审计）、`src/domain/errors.ts`（具名错误成员）；白皮书 [docs/research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md](research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md) §4.1。
- **对应 Issue & PR**：私有仓 Issue #274（初版在途哨兵）；私有仓 Issue #279（消费语义修正 + 具名错误落地 + 登记校准）。
- **验证证据**：见 [docs/research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md](research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md) §2.5 与 §5；脚本 B 对照（丢弃 + 后续 await）实测 `failed`。

---

## 二、已拒收（Rejected）

### [REJ-001] MCP 工具检索与 Schema 懒加载（Tool Search / Deferred Loading）

- **汲取来源**：Anthropic 的工具检索与延迟加载思路；社区代理 [KGT24k/mcp-tool-search](https://github.com/KGT24k/mcp-tool-search)（通过懒加载与模糊检索减少注入提示词的工具 Schema）。
- **拒收理由**：T1: FAIL。本仓是「代码即工作流」，步骤按显式名字调用工具；没有任何代码把工具 Schema 注入 LLM 提示词（`toolRegistry` 只在 `src/mcp/server.ts` 注册时写入，没有读取方把它交给模型）。该能力目前不解决任何真实问题。
- **重新评估条件**：出现「把 MCP 工具目录交给模型自主挑选」的步骤类型时。

### [REJ-002] 引入外部 Python 解释器作为默认工作流执行宿主（Python Subprocess as Default Host）

- **汲取来源**：Google Antigravity run_workflow 的 Python 3.8+ 架构。
- **拒收理由**：T1: FAIL / T2: FAIL。
  1. 本仓 AI-workflow 核心定位是为 Node.js / TypeScript 生态打造的开箱即用「代码即工作流」引擎；
  2. 引入外部 Python 依赖将违背 P-BUILD-1 供应链红线，显著增加环境碎片（PATH、virtualenv、Python 版本冲突）与跨平台排障复杂度；
  3. 本仓基于 TypeScript 编译器 API（`ts.TypeChecker`）做强类型 Schema 擦除与 AST 纯度检查具有结构性优势。仅吸收其 FD 隔离与 Promise 泄漏审计思想，不引入 Python 运行时。
- **重新评估条件**：未来若立项官方多语言工作流 SDK（如独立 Python Facade 绑定）时。
