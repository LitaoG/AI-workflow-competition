# ZCODE 官方引擎 × 本仓引擎 七维基准对比报告（TEST-GOAL 4.1）

- **产出**：文档·基准对比报告 子代理 ｜ **日期**：2026-11-01
- **执行环境**：worktree `C:/Users/86183/Desktop/AI-workflow-worktrees/issue-28-goal-e2e-pentest`（分支 `feat/issue-28-goal-e2e-pentest`，HEAD `30eb54f`，2026-11-01 16:32:49 +0800）；主仓 `C:/Users/86183/Desktop/AI-workflow` 只读未动
- **对比对象**：官方 = ZCode 官方 dynamic-workflow 引擎（`apps/zcode-cli/packages/...`，代码不在本仓）；我方 = 本仓 `node bin/workflow.js` 引擎（`src/dwf/`）
- **文档分工（2026-11-01 修订确立）**：本报告只管七维基准对比与证据分级；各子系统的修复/缺口**状态唯一登记处**为同目录 `WORKFLOW-GAP-MATRIX.md`（其 D#/R#/GAP-# 条目号），本文提及状态时引用该矩阵条目，两文冲突时以矩阵为准。
- **行号基准**：正文所引源码行号基于 worktree HEAD `30eb54f`；行号漂移以符号名为准（2026-11-01 修订轮已复核本文 schema-synth/governor/engine/run-script 各行号引用）。
- **修订记录（2026-11-01，修订员）**：§0 边界声明补来源 B 不可本地复核声明；§2 前补「七维=机制存在性 / GAP-MATRIX 切片=纪律完备度」口径声明；§3.4 判定改按口径表述并交叉引用 GAP-MATRIX §3.3；§3.5 事件计数改为引擎 emit 级（18 种）并留映射留白；§4 缺陷①状态对齐 GAP-04（未提交）；AIMD 常量由「四常量」改「五参逐参对齐」；§3.2 typed-ask 留白与 GAP-MATRIX §2.2 交叉引用；「4h14m」统一为「至洞到达（快照时点，非终值）」；无来源的官方运行经验句移出 §3.3 官方静态段并标 `[未知·来源未注明]`；§3.6/§6 amend 留白与 GAP-01 实测交叉引用。未改动任何实测数字与结论归属。

---

## 0. 材料来源与证据分级

| 来源 | 内容 | 本报告标注 |
|---|---|---|
| A | 任务下发·官方静态锚点 27 条（ZCode 官方代码库 7 维机制事实，含 location 与 confidence） | `[官方·静态]` |
| B | 任务下发·官方运行实测 1 份（官方 CreateWorkflow 引擎真实 mission run 的 journal 时点快照） | `[官方·实测]`（不可本地复核，见下边界声明） |
| C | 任务下发·我方实测（基1–基6，本 worktree 引擎 CLI 的 6 组微基准，mock provider） | `[我方·实测]` |
| D | 本报告执行时的抽查复核（本轮实际运行的命令与查询，清单见 §7） | `[已验证·本轮]` |

> **边界声明** `[已验证·本轮]`：本 worktree 内不存在 `apps/` 目录——官方锚点路径出自 ZCode 官方代码库、不在本仓，来源 A 无法本地重读，按材料原样引用；其中 `liveOnly` 条目（官方自己也标注"静态无法复核"）在 §6 留白清单单列。**来源 B 同样无法本地重读**（材料未载 runId、无 journal 导出可核对，§1.1 runId 行已标 `[未知]`），按材料原样引用——B 的 `[官方·实测]` 标注应理解为「官方实测材料的转述」，而非本地可复核事实；复核需任务下发方提供 runId 与 journal 导出。
>
> **三态纪律**：`[已验证]` = 本轮运行过或有命令级出处（D 类为 `[已验证·本轮]`）；`[推断]` = 由已验证事实推演，给出链条；`[未知]` = 信息不足，写明缺什么。严禁把 `[未知]` 脑补成结论。

---

## 1. 运行指纹

### 1.1 官方运行指纹 `[官方·实测]`

读数方法：主代理经 GetWorkflowRun 于洞填充时刻读官方运行 journal（节点计数 / token / 并发为**时点快照，非终值**）。本运行本身即官方 CreateWorkflow 引擎的一次真实执行（含编译期 AST 检查、journal 持久化、断点缓存、hole 停靠-填充、子代理升级问答），可作官方引擎 50+ 节点级持久化与断点行为的实测样本。

| 项 | 值 |
|---|---|
| 启动 / 至洞到达 | 2026-11-01T09:26:03Z 起，实际运行 **4h14m**（洞到达 = 阶段5 门禁全绿落定） |
| 累计 spent_tokens | **105,419,307**（含主代理与全部 30 个子代理的 prompt+completion；洞填充后阶段6 文档与收口仍会增加） |
| 子代理个体分布 | 约 70K–14.5M；最重「攻防·协议投毒」14.46M，其次「逆向·门面隐式原语」6.05M、「攻防·沙箱逃逸」5.66M |
| 编排 | 15 个 phase 节点；洞到达时 12 个已 settle；**79/79 执行步全部完成、0 失败、0 重试循环**；phase 内 1–6 子代理并行扇出、phase 间线性推进 |
| 最慢阶段 | 阶段4 四大攻防 PoC 实测 2h36m；其次阶段5 补强施工 37m12s、阶段5 全量门禁循环 37m09s（含 3 轮门禁 + 1 次子代理升级裁决）；阶段0 基线门禁 7m56s |
| 并发 | 脚本未设 max_concurrency；观测窗口 concurrency=3/16（16 席位门）；高负载后自动恢复（health 记录 recovered since 39m19s ago）；多路 future 并行未见 429 或限流死锁 |
| runId | 材料未载 `[未知]` |

### 1.2 我方基准指纹 `[我方·实测]` + `[已验证·本轮]`

| 项 | 值 |
|---|---|
| 引擎 | `node bin/workflow.js`，worktree HEAD `30eb54f`；`fa274e5`（branch-level hole parking，"the child's idle signal replaces the drain timer"）经 `git merge-base --is-ancestor fa274e5 HEAD` 验证**在基准二进制谱系内** `[已验证·本轮]` |
| 运行时 | node v22.23.2，Windows 10.0.26200 x64 + Git Bash |
| provider | 内置离线 mock（`src/cli/index.ts:25` "mock stays the default"，未设 AI_WORKFLOW_PROVIDER）——**本报告我方全部数字均为 mock 调用，不是真实模型调用** |
| journal | `.workflow/goal-bench.db` 终值 172,032 B；sha256 `4e3cc4b7de2b0f7456b63a0a2b03b2a15470ec02ff12667013b2dc5500095c8c` `[已验证·本轮]` |
| run | `dwfrun-mvxomkgk-7e7fc1`（bench50 首跑 + 同 runId resume；status=completed；script_hash 64 位 hex；created 2026-11-01T10:23:30.069Z / updated 10:31:19.265Z）`[已验证·本轮·journal 复查]` |
| 并发基准 run | `dwfrun-mvxpq3am-9e4838`（-c 4）、`dwfrun-mvxpq46q-41dbdc`（-c 16），各用独立 db |
| 脚本与产物 | `C:/Users/86183/.zcode/workflow-drafts/goal-mission/bench/`：minimal.facade.ts 147 B、bench50.facade.ts 1,111 B、bench16.facade.ts 515 B、time-cmd.js 1,135 B、view-bench50.html 96,928 B、graph-basic.html 10,274 B —— 六件全部在位且字节数逐一对上 `[已验证·本轮·ls -la]` |

---

## 2. 七维对比矩阵（总览）

> **口径声明（2026-11-01 修订）**：本表七维判定比较的是**机制存在性**（机制有无、是否同构），不裁决纪律完备度；纪律完备度口径见 `WORKFLOW-GAP-MATRIX.md`——其逆向切片 S1..S4 全部 behind（如 §3.3 对限流列出我方两处行为缺陷并归 D8②）。两文档口径不同，并排阅读以各自口径为准。

| # | 维度 | 官方机制要点 `[官方·静态]` | 官方实测 `[官方·实测]` | 我方机制要点 | 我方实测 `[我方·实测]` | 胜负 |
|---|---|---|---|---|---|---|
| 1 | 启动/执行延迟机制 | spawn 子进程 + 入口文件承载 payload + ELECTRON_RUN_AS_NODE=1 + NDJSON 桥；hole 先停驻再记事件 | 至洞到达 4h14m（快照时点，非终值）；启动墙钟未测 | 同链路：spawn + node:vm 沙箱子进程 + NDJSON + 同一 env 防线 | 冷启动中位 689.5ms（本轮复跑 937.6ms）；编译+1 ask 自报 0.33s | **平手** |
| 2 | AST 编译与类型合成 | 全虚拟 CompilerHost Program；strict 全开 + noUncheckedIndexedAccess 刻意关；checker 真源 typed-ask | 无（"96%" 为注释历史值，liveOnly） | compile.ts 编译选项逐字同构；schema-synth.ts 注释自述 "Mirrors ZCode's schema/synthesize.ts" | 编译+首节点 0.33s；check 2 sites 干净 | **平手** |
| 3 | Token 经济性机制 | spentTokens→journal→usage-updated 同步一致；spent_tokens 仅观察面；repair=3 / nudge=1 | **105,419,307 tokens** | 同族记账面（dwf_budget_spent 事件 + output_tokens_spent 列） | 无真值（mock 不产 token，列值 NULL） | **官方胜** |
| 4 | 并发限流 | AIMD（×0.75/K=4/floor 1/300s idle）+ epoch 阻尼 + 两级席位 + D=clamp(ap−2,4,16) + 2D 增长 | 3/16 观测、自动恢复、无死锁 | AIMD 五参可对齐同值（起始 cap 8／+1每4 成功／×0.75／floor 1／300s idle；官方起始 cap 未载 `[未知]`）per-provider 桶 + withAskSeat + 默认公式逐字同构；无 epoch/lastGood | -c 4→峰值 4 波错峰；-c 16→16 齐发；共享 actor=1 | **平手**（机制存在性口径；纪律完备度官方胜——GAP-MATRIX §3.3 判 behind 并列我方两处行为缺陷，归其 D8②） |
| 5 | 持久化 | dwf_* 五表族 + append-only event + 表达式索引 + NULL 即缺席 | 库体积/事件量未披露 | 同源命名六表；dwf_runs 列族与官方 dwf_run 同构 | 50 节点→143,360 B/209 事件→resume 172,032 B/317 事件（逐类型已复核） | **平手**（机制官方全，开销我有数） |
| 6 | 断点续跑 | ScriptHashMismatch 同步拒绝 + recoverSettleOrder + 导入缓存分歧单调 + 5s quiesce | 定性含断点缓存，无命中数字 | --resume byte-identical 同纪律；script_hash 落库 | **50/50 replay 命中、0 provider calls、结果逐字节一致** | **我方胜**（证据面） |
| 7 | 交互与可视化 | phase 商图 + 浏览器投影桶 + artifact v4 + throttle UI + 4 命令通道 | 用户确认图按 15 phase 呈现 | view/graph 自包含单 HTML + serve 实时视图 | view 96,928 B（51 节点/50 徽标）+ graph 10,274 B，浏览器实开验证 | **官方胜**（丰富度） |

**记分**：官方 2 胜（维度 3、7），我方 1 胜（维度 6），平手 4（维度 1、2、4、5）。
**总判定**：两套引擎在机制层高度同源（三处源码注释显式点名镜像官方：`schema-synth.ts:4`、`child-main.ts:6` "same as the official engine"、`governor.ts:3-5`/`governor.ts:134-141` "matches ZCode's process-level governor"）`[已验证·本轮]`。官方优势在**机制完备度与真实规模**（105M tokens / 4h14m / 79 步真实运行）；我方优势在**可复现微基准证据**（延迟 / 保真 / 波形的硬数字与逐字节校验）。所有维度我方均为 mock，任何"真值类"对比（token、限流演化）在接入真实 provider 前不成立。

---

## 3. 分维详述

### 3.1 维度1：启动/执行延迟机制 —— 平手

**官方 `[官方·静态]`**
- 启动链路：构造 WorkflowEngine → 绑控制面 → 把 lowered 脚本+args 渲染成入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs` → spawn 子进程（默认 `--max-old-space-size=256`，env 强制 `ELECTRON_RUN_AS_NODE=1`）→ NDJSON 桥接子进程 `__host` 调用到引擎；run 裁决归引擎所有，harness 侧 first-wins finalize 只管子进程清理（清 timer、关 stdin、kill child），不自造结算。（harness.ts:210-318, 347-473）
- 子进程 payload 刻意不过命令行：Windows 命令行上限 32,767 字符，整份 lowered 脚本约 18KB 即 spawn ENAMETOOLONG，故写成入口文件后 argv 只剩一条路径、长度与脚本大小无关。（harness.ts:275-284）
- run-launched 宿主元数据（8 项）引擎一律不读，只在建 run 那一世紧跟首条 run-started 逐字转录一次，零 SQL；未设的键缺席而非落 undefined。（engine.ts:320-325 + engine-launch.ts:39-66）
- hole 机制：hole() 先把分支 promise 停驻进 HoleRegistry.park **再**记 hole-reached（顺序保证 emit 里同步 fillHole 的监听者能命中停驻表）；fillHole 的两条 no-op（not_waiting/settled）不写不发；已补全站点以记住的代码立刻作答。（engine-holes.ts:174-189, 93-112, 55-58）
- `[官方·静态·liveOnly]`：不带 ELECTRON_RUN_AS_NODE 时子进程按完整 Electron/Chromium 启动并卡 GPU 初始化、永远沉默不退出；Node 对 EACCES/EAGAIN 转 error 事件、其余 spawn 失败（ENAMETOOLONG/E2BIG）同步抛。（harness.ts:291-300, 302-316）

**官方 `[官方·实测]`**：至洞到达 4h14m（快照时点，非终值——洞填充后阶段6 仍会增加，见 §1.1）、最慢阶段4 2h36m；**启动墙钟未测** `[未知]`。

**我方 `[我方·实测]` + `[已验证·本轮]`**
- 同链路证据：`runner.ts:242` `spawn(process.execPath, childArgs, ...)`；`runner.ts:7,523-527` 重设 `ELECTRON_RUN_AS_NODE=1`（注释：Electron 宿主的 CLI 绝不能启动完整 Electron 应用）；`child-main.ts:1-17` node:vm 沙箱、调用约定 "Called by the parent as: `node child-main.js <scriptJsPath> <argsJson>`"、协议 "NDJSON on stdio (see protocol.ts)"、注释自述隔离目标 "same as the official engine"。`[已验证·本轮·源码核读]`
- 基1 冷启动（check 最小 facade 脚本 ×3）：**中位 689.5 ms**（678/689/759）。`[我方·实测]` 本轮同命令复跑：903/938/948 ms、中位 937.6 ms、exit=0、"✔ facade script compiled clean (2 sites)"；执行时点机器上有多并行子代理负载，量级一致均 <1s；`.workflow` 文件数 40→40 证明 check 零写入。`[已验证·本轮]`
- 基2 编译+首节点（run-script mock 最小脚本 ×3）：墙钟中位 816.4 ms（781/816/951）、引擎自报中位 0.33 s（0.34/0.31/0.33）；墙钟−自报 ≈ node 进程启动 ~0.5s（与基1 吻合）。`[我方·实测]`
- hole 对应物：branch-level hole parking（fa274e5）在谱系内 `[已验证·本轮]`；fill/answer 命令在 CLI help 可见（`fill <runId> <holeName>` 为 amend-fork 语义）`[已验证·本轮·--help]`。

**胜负：平手。**
**归因**：链路逐件同构（spawn 子进程 + NDJSON 桥 + 同一 ELECTRON_RUN_AS_NODE 防线），机制面同源无疑。差异：官方 payload 全走入口文件（argv 只剩路径）且显式设 256MB 堆上限；我方 argsJson 走 argv，且 runner.ts 中未检索到 max-old-space-size（`rg -a` 否定检索）——隔离完备度官方微胜。延迟绝对值只有我方有数（官方该项留白），不可比绝对值，故综合平手。我方 ~0.7–0.9s 冷启动与官方同链路（node spawn + NDJSON）量级可互推 `[推断]`。
**留白**：官方桌面端真实 spawn→run-started 墙钟、去 env 卡死复现（liveOnly）；我方 argsJson 过大时是否撞 32,767 上限未测 `[未知]`。

### 3.2 维度2：AST 编译与类型合成 —— 平手

**官方 `[官方·静态]`**
- 编译：typescript 库 API 在全虚拟内存 CompilerHost 建 Program；脚本包进 async `__workflowScript__()` 前奏；rootNames 仅 workflow-script.ts + facade .d.ts + 内嵌 TS_LIBS 闭包；noEmit、strict:true、ES2022、Bundler、types:[]（无 ambient @types，process/fetch/require 直接编译失败——纯度契约从编译期开始）、writeFile 直接 throw。（compile.ts:25-60, 95-115, 140-168）
- noUncheckedIndexedAccess 刻意关闭（strict 其余全开、strictNullChecks 保留）：官方注释引本地实测称开启时 TS2532/TS18048 占 undefined 族诊断 96%、是模型脚本编译失败最大单一来源。（compile.ts:47-54）——该数字为**注释历史值** `[官方·静态·liveOnly]`
- typed-ask 判定唯一真源在 checker：ask 显式带类型实参且 T 解析后非原始 string 才发射 schema（ask#1 归档）；不可序列化 T 以定位到站点的诊断拒绝；同趟同发射器检查 report(item) 可序列化（report 只出诊断不产出 schema）。（synthesize.ts:13-48, 63-84, 87-123）
- JSDoc 字段提取：description + 标签子集（@minimum…@maxItems）映射 JSON Schema 关键字，@default 先 JSON.parse 失败当裸字符串，子集外静默忽略。（jsdoc.ts:16-31, 37-45, 63-77, 80-88）
- buildAskSpecs 按站点表遍历：untyped 必须显式记 {typed:false}，"查不到就当 untyped" 的兜底会把 typed ask 静默降级 → 引擎缺席即 MissingAskSpec 硬失败。（synthesize.ts:137-157）

**官方 `[官方·实测]`**：无（96% 分布、真实模型脚本通过率均未复核）`[未知]`。

**我方 `[已验证·本轮]` + `[我方·实测]`**
- `compile.ts:71,80-81`：`strict: true` / `noEmit: true` / `noUncheckedIndexedAccess: false, // intentional, see file header`；头注释 "model-authored TS assumes it"——与官方同理由、同结论。`[已验证·本轮]`
- `schema-synth.ts:4` 注释自述 **"Mirrors ZCode's schema/synthesize.ts"**：子代理看 schema、父端校验回复、JSDoc 变字段描述；支持子集闭式枚举（primitives / 字面量 union / 数组 / 嵌套对象含可选性 / null union），子集外（函数/类/Map/Set/Date/any/index signature）**硬诊断、fail loudly never guess**；递归用路径域 seen-set 精确诊断 9015（站点+类型点名）而非深度栈爆掉。`[已验证·本轮·源码核读]`
- 实测：基2 编译+首节点 0.33 s（未单列编译时延）`[我方·实测]`；本轮复跑 check 报 "✔ facade script compiled clean (2 sites)" `[已验证·本轮]`。
- 测量口径：本轮基准全用 **untyped ask**——typed schema 为 strict + additionalProperties:false，mock 载荷带额外字段会被拒。`[我方·实测·notes]`

**胜负：平手。**
**归因**：关键分歧点（noUncheckedIndexedAccess off、strict 全开、types 封闭、schema 不可序列化即硬诊断）逐字同构，机制面同源；但证据面互补——官方的 96% 是未复核注释值，我方的 typed-ask 合成与校验路径本轮未实测（基准全用 untyped ask 绕开 strict schema）。两边各缺一半证据，谁也压不倒谁。
**留白**：真实模型脚本诊断 code 分布（官方 liveOnly）；我方 JSDoc 关键字覆盖矩阵、MissingAskSpec 等价行为、typed ask 端到端校验 `[未知]`（交叉注：GAP-MATRIX §2.2 记不变量2「schema 提取 + zod 校验 + 自愈重试」链路在分诊会话实测 pass——与本处 `[未知]` 不冲突：彼为不变量链路的实测结论，此为本基准未覆盖 typed ask 端到端的覆盖面陈述）。

### 3.3 维度3：Token 经济性机制 —— 官方胜

**官方 `[官方·静态]`**
- 记账管道：driver 回报 askStats 时 `spentTokens += stats.tokens`，先 `journal.updateRunUsage` 立刻持久化、再发 usage-updated（同一同步步骤，事件载荷与列值永远相等）；run 结算后到达的迟到 straggler 仍只记账不发事件（run-settled 必须是事件流最后一条）。（engine.ts:588-601）
- run 级 token 用量只是观察面：dwf_run 无节点上限/token 预算列，仅 spent_tokens（迁移注释"只作观察面"）；amend 经 EngineConfig.inheritedTokens 以前驱 spentTokens 起账（缺席=从零），resume 从行值恢复，跨生命周期连续。（migrations.ts:850-851, 876 + engine.ts:265-270, 310 + engine-config.ts:70）
- 引擎内"预算"只有两类**尝试预算**：typed ask 的 submit_result schema 校验失败 repair 预算 REPAIR_ATTEMPTS=3（每次拒绝发 node-repairing{attempt,violations}，耗尽 cancelAsk+ValidationFailed 结算失败）；turn 结束未提交的 nudge 预算 NUDGE_ATTEMPTS=1（耗尽 ResultNotSubmitted）。宽松归一化：原值不过且为 string 时单次 JSON.parse 再校验。（types.ts:1064-1068 + scheduler-submit.ts:23-55, 57-92, 94-116）

**官方 `[官方·实测]`**：**105,419,307 tokens**（主代理 + 30 子代理；个体 70K–14.5M，最重协议投毒 14.46M、门面逆向 6.05M、沙箱逃逸 5.66M）。

> 修订注（2026-11-01）：原稿曾在上方官方静态段内写「实盘：GLM-5.3 经 Anthropic 兼容端点常把 result 序列化成 JSON 字符串」——该运行经验在 A/B/C/D 四类来源中均无出处（无材料条目、无样本量、无时间窗），修订时移出官方静态段并标 `[未知·来源未注明]`；如需坐实，需任务下发方补充来源。

**我方 `[已验证·本轮]`**
- 同族记账面**存在**：`dwf_budget_spent` 事件 50 条（50 ask 各 1）`[已验证·本轮·journal 复查]`；`dwf_runs.output_tokens_spent` 列存在、本行为 NULL（mock 不产 token）`[已验证·本轮]`。
- 真实 token 数值：无。mock 调用不产生用量。`[未知-我方]`

**胜负：官方胜（唯一有真值的一方）。**
**归因**：我方有同构管道（事件 + 列），缺的只是真实 provider 校准——是测量边界，不是机制缺失 `[推断]`；官方 repair=3/nudge=1 的尝试预算与宽松归一化在我方源码中是否有逐条等价物未核 `[未知]`。
**留白**：我方等价 repair/nudge 预算与 JSON.parse 归一化行为；双方 per-node stats_json 载荷形状对比。

### 3.4 维度4：并发限流 —— 平手（机制存在性口径；纪律完备度见 GAP-MATRIX §3.3）

**官方 `[官方·静态]`**
- AIMD 常量：cap = max(FLOOR, floor(cap×0.75))（减半对"只多了一两个"反应过猛，从 0.5 改 0.75）；步长 1；每 +1 需连续成功 K=4（从 40 降 4）；地板 1；空闲 300s 且无在飞回起点并清 streak/cooldown/lastGood/lastBad。（concurrency.ts:22-37, 284-319）
- epoch 阻尼：一个 429 只在它属于当前 cap（epoch 相同）时才评价当前 cap；lastGood 之上探测被限流则退回 lastGood（不按系数减），否则 ×0.75 并清 lastGood；两档后 epoch+=1（同批只裁一次）；带 Retry-After 则 cooldownUntil 取 max；旧 epoch 的 429 只清 streak、不动 cap。成功侧只有当前 epoch 计 streak，streak≥K 证明当前 cap 可用（lastGood=max），有等待者且 cap<growthLimit 才 +1。（concurrency.ts:10-16, 141-162, 164-207）
- 两级席位门：①run 级 ask 席位（pumpActor：activeAsks ≥ caps.maxConcurrency 不再派发，每 actor 同时只跑一个 ask）；②进程级模型请求闸门（bootstrap 治理器：按 `${providerId}/${modelId}` 分桶、每桶一台 ConcurrencyController + 按 run 轮转准入队列、每尝试 acquire/release、退避 sleep 不持槽、canAdmit=inFlight<cap 且不在冷却）。（scheduler.ts:408-417 + workflow-concurrency-governor.ts + concurrency.ts:114-123）
- 默认 D = clamp(availableParallelism−2, 4, 16)；growthLimit=2D，治理器按 max(2D, 用过该 key 的在飞 run 最大上界) 随时挪动；用户抬上界走 seed 跳 min(target,growthLimit)（5 分钟内有过拒绝则不跳）；引擎侧 setMaxConcurrency 落列、发 run-caps-changed、抬高立刻 pumpAll。（workflow-default-concurrency.ts:16-35 + concurrency.ts:79-94, 231-282 + engine.ts:545-566）

**官方 `[官方·实测]`**：观测窗口 3/16、高负载后自动恢复（recovered since 39m19s ago）、多路 future 并行无 429 死锁。

**我方 `[已验证·本轮]` + `[我方·实测]`**
- 默认公式**逐字同构**：`engine.ts:36` `const ASK_CONCURRENCY_DEFAULT = Math.min(16, Math.max(2, availableParallelism() - 2));`（本机 32 核 → 16）。`[已验证·本轮]`
- run 级席位门：`engine.ts:418-419` `private async withAskSeat<T>`，`const max = this.options.maxConcurrency ?? ASK_CONCURRENCY_DEFAULT`（与记录引 418-431 吻合）。`[已验证·本轮]`
- 进程级 AIMD（`governor.ts`）：注释自述 "completing the three-layer concurrency model (ask seat gate → run seat gate → process governor in ZCode)"；常量同值（五参逐参核对，2026-11-01 修订轮复核行号）——起始 cap maxPerProvider=**8**（governor.ts:15-16,49）、increaseAfter=**4**（:17-18,50）、decreaseFactor=**0.75**（:19-20,51）、idleResetMinutes=**5**（:21-22,52，=300s）、失败下限 floor **1**（:97 `Math.max(1, Math.floor(...))`）；官方侧起始 cap 材料未载 `[未知]`，「同值」结论限于可对齐参数（governor.ts:14-23,48-52,97）；Retry-After 冷却 + 到期定时器唤醒等待者（60-77）；**进程级单例跨 run 共享**："Shared governor instance — one per process, across runs (matches ZCode's process-level governor)"（134-141）；引擎接线 `engine.ts:27,328,339,347,350`——每次尝试前 `acquire(routedProvider)`、结束 `release(..., 'success'|'failure', retryAfterFromError(err))`。`[已验证·本轮]`
- 与官方的机制差异 `[已验证·本轮·源码比对]`：我方**无** epoch 阻尼与 lastGood 退回（429 一律乘减）、无 2D growthLimit/seed 跳变、桶按 providerId（官方按 providerId/modelId）、冷却覆盖而非取 max。
- 波形实测（基5，16 个独立 actor + Promise.all）：`-c 4` → 峰值在飞 4，16 个 ask_start 以 4 个一波错峰（offset 0,0,0,0｜4,5,5,5｜6,7,7,7｜8,8,9,9 ms），最后 ask_done @10ms，墙钟 1233.9ms；`-c 16` → 峰值 16、全部 start 落在 0–1ms、最后 done @6ms，墙钟 1040.2ms；共享单 actor 变体峰值 = 1（actor 级 FIFO）。`[我方·实测]`
- 瑕疵记录：`run-script --help` 的 `-c` 行写 "default 4"，而源码链路（run-script.ts:47-49：ultracode→16、否则 -c 值或 undefined → runner.ts:302 → engine.ts:419 回落 ASK_CONCURRENCY_DEFAULT=16@32核）中不存在 4——help 文案与源码默认不一致。`[已验证·本轮]`

**胜负：平手。**
**归因**：可对齐五参（8/4/0.75/floor1/300s）与默认公式同值同构、三层模型同构、进程级单例语义同构——同源设计有注释级与数值级双重证据 `[已验证·本轮 + 官方锚点比对]`（官方起始 cap 未载 `[未知]`）。官方多出 epoch 阻尼与 lastGood 探测语义（真实 429 下 cap 轨迹更保守）；我方多出席位波形的精确量化（官方只有 3/16 时点读数）——波形属**证据面**，不构成机制面胜负手。另注：GAP-MATRIX §3.3（纪律完备度口径）判本子系统 behind，并另列我方两处行为缺陷——engine.ts 把 AbortError 记成 success 推高 cap、rpc 层内部重试持 AIMD 槽（归其 D8②）；本节「平手」限于机制存在性口径。
**留白**：官方真实 429/Retry-After 下的 cap 轨迹（liveOnly）；我方 AIMD 在真实限流下的 limit 演化——governor 注释自认 "Providers without signals (mock) never trip it"，mock 下该层不触发 `[未知]`。

### 3.5 维度5：持久化 —— 平手（机制完备官方胜，开销透明我方胜）

**官方 `[官方·静态]`**
- journal 是独立 dwf_* 表族（迁移 0019 一次建齐、beta 后该条不可再改按 checksum 记账）：dwf_run(id PK, parent_session_id, cwd, name, script_text, script_hash, args_json, tool_call_id, resumed_from, caps_max_concurrency not null, spent_tokens not null default 0, status CHECK, result_json, failure_json, time_created, time_updated)；dwf_actor(unique(run_id,site_id,ordinal), name, persona_json, resolved_model, session_id)；dwf_node(kind CHECK, input_hash not null, status CHECK, result_json, error_json, stats_json, message_boundary, artifact_id, unique(run_id,site_id,ordinal))；dwf_event(run_id+sequence unique, type, payload_json not null, time_created)。（migrations.ts:830-945）
- 事件 append-only 落 dwf_event，unique(run_id,sequence) 保证流序；看板取数按 sequence 分页走表达式索引 dwf_event_artifact_idx on (run_id, json_extract(payload_json,'$.artifactId'), sequence)（第三列 sequence 不是装饰）；取数源是 dwf_event 而非 dwf_node。（933-944, 858-863）
- NULL 即缺席：result_json/name/tool_call_id/args_json/resumed_from/resolved_model/message_boundary/artifact_id/input_json 都解码成缺席的键（args_json 解成 {}）；parent_session_id/session_id 刻意不加 FOREIGN KEY（子代理会话跑内存 event store 上无 session 行）；report/artifact 行有行无节点。（846-857, 852-854）
- Boundary C 事件词汇表 27 种 RunEvent 全集；node-settled 携带 cached 标记用于 replay 命中。（types.ts:502-800）

**官方 `[官方·实测]`**：真实 payload_json 逐字段形状、sequence 连续性、库体积均未披露 `[未知]`。

**我方 `[已验证·本轮]` + `[我方·实测]`**
- 表族同源命名：journal 六表 `artifacts / checkpoints / dwf_nodes / dwf_runs / events / runs`。`[已验证·本轮·sqlite_master]`
- `dwf_runs` 列族与官方 `dwf_run` 同构：`run_id / script_hash / script_path / args_json / status / parent_run_id / created_at / updated_at / runner_pid / output_tokens_spent` ↔ 官方 `id / script_hash / script_text / args_json / status / resumed_from / time_created / time_updated / spent_tokens`（差异：我方存 script_path 路径，官方存 script_text 全文；我方多 runner_pid）。`[已验证·本轮·PRAGMA table_info]`
- 开销量化（基3+基4）：50 节点首跑 → **143,360 B / 209 事件 / dwf_nodes 51 行**、墙钟 836.5ms、引擎自报 0.35s；resume 后 → **172,032 B / 317 事件**、墙钟 855.5ms。折算 ~2.9KB/节点（含事件）。`[我方·实测]` + `[推断·由记录数折算]`
- 逐类型分布（本轮复查 317 条）：`dwf_actor_created` 100 / `dwf_replay_hit` 50 / `dwf_budget_spent` 50 / `dwf_ask_start` 50 / `dwf_ask_complete` 50 / `dwf_phase` 10 / `dwf_report` 2 / `dwf_log` 2 / `dwf_completed` 2 / `dwf_size_warning` 1。**新观察**：resume 不重发 ask_start/complete/budget_spent（各保持 50），而 actor_created 翻倍（100）、phase 5→10、report/log/completed 各 +1、size_warning 不重发——replay 路径只补 actor/phase 编排事件与收尾事件。`[已验证·本轮]`
- run 行实况：dwfrun-mvxomkgk-7e7fc1、status=completed、script_hash 64-hex、parent_run_id NULL、args_json `{}`——缺席即 NULL/空对象，与官方"NULL 即缺席"纪律同构。`[已验证·本轮]`

**胜负：平手。**
**归因**：机制面官方全（actor/persona 维度、27 种事件词汇、表达式索引、artifact 版本史——我方无 per-actor 行）；事件类型对比**按词汇表级而非单次 run 观测级**（2026-11-01 修订更正：首稿把 bench50 那一次 run 的观测当成了引擎性质）——bench50 run 观测到 10 种 `dwf_*` 事件，是 engine 源码实际 emit **18 种**（`[已验证·本轮]`：`node -e` 对 engine.ts 正则 `emit\(['"]dwf_` 去重；清单：actor_created、amend_diverged、amend_hit、artifact、ask_complete、ask_start、budget_spent、child_workflow、escalation_open、failover、hole_open、log、node_failed、phase、replay_hit、report、size_warning、world_run）的子集；18 种与官方 27 种 RunEvent 词汇表的逐项映射未做、缺几多种 `[未知]`（§6 留白⑧）；开销面我方唯一有数（官方连库体积都未披露）。规模不可比（79 步、至洞到达 4h14m 真实运行 vs 50 mock 节点 0.8s），只比口径不比绝对值。
**留白**：官方真实 payload 逐字段形状（liveOnly）；我方大 journal（万级事件）取数性能与索引行为 `[未知]`。

### 3.6 维度6：断点续跑 —— 我方胜（证据面）

**官方 `[官方·静态]`**
- resume 前置硬校验：脚本哈希必须与建 run 时逐字节相同，否则**同步抛** ScriptHashMismatch 拒绝（而非先接受再 failRun——那会把 failed 盖到一份仍能用正确脚本 resume 的记录上）；改脚本要续跑须 resume_from 另起新 run；resume 从 journal 恢复结算次序闸、每 actor ask 数、报告计数（count(*)+result_json 字节和，一条不读进内存）与产物版本状态，并 updateRunStatus 回 running。（engine.ts:288-319 + engine-resume.ts:17-44）
- amend-resume 导入缓存：ImportedRunCache 由 run service 读前驱 journal 纯确定构建（全仓唯一读前驱处，三个调用点）；take 按 (seq,inputHash) 命中推进游标、未命中即分歧且**分歧单调永不回头**，级联分歧免费；缓存关门后 takeIfPure 只命中纯条目；崩溃后 reconcileRecorded 据 journal 行精确重推原次执行分歧点。（dynamic-workflow-import.ts + imported-cache.ts:26-80, 116-138, 151-239）
- 静默期探针：AMEND_TRANSCRIPT_QUIESCE_MS=5_000 有界等待，只对已静默会话谈接续；到点未落地会话不是失败，只是整段在飞转录丢弃、ask 从完整前缀重开（注释明言"这不是用超时掩盖竞态"）。（workflow-driver-quiescence.ts:61-97, 105-171, 220-236）

**官方 `[官方·实测]`**：本运行自述含断点缓存，但**无命中数字** `[未知]`。

**我方 `[我方·实测]` + `[已验证·本轮]`**
- 同纪律：`--resume` 帮助明文 "Resume a prior run: completed nodes replay from the journal at zero model calls (**script must be byte-identical**)"；`dwf_runs.script_hash` 64 位 hex 落库。`[已验证·本轮]`
- 基4 硬数字：同 runId 二次 resume（脚本字节不变）→ **缓存命中 50/50**（`asks: 0 (replayed from journal: 50)`、逐节点 "⚡ replayed from journal: ask#N#M (0 provider calls)" ×50）、**0 provider calls**、`dwf_replay_hit` 事件 50 条（本轮复查确认）、**结果 JSON 逐字节一致**（{answers:50,bytes:10060}）；耗时首跑 836.5ms/0.35s → resume 855.5ms/0.32s（replay 仅 +19ms 墙钟）；journal 143,360→172,032 B、209→317 事件。`[我方·实测]` + `[已验证·本轮]`
- hole 族：branch-level hole parking（fa274e5）在谱系内——hole 停靠/填充属断点族行为。`[已验证·本轮]`

**胜负：我方胜（证据面）。**
**归因**：本维唯一硬数字 + 逐字节保真 + 可复现命令在我方（50/50 命中、0 provider calls、byte-identical 结果）；官方机制深度（amend 导入缓存、崩溃重建、静默探针）远超我方已测面——我方只验证了理想路径（同脚本同 runId 全量命中）。"我方胜"限于**证据完备度**，不构成机制深度结论。
**留白**：5s quiesce 上界在慢磁盘/大转录下的充足性（官方 liveOnly）；我方 amend 分叉（`-m` 旗标存在未基准）、崩溃后恢复、脚本改动后另起 run 的行为 `[未知]`（交叉注：GAP-MATRIX §5 GAP-01 已实测 `--amend` fork 的**血缘正确性**——fork `dwfrun-mvxu8mqj-00bdd1` 的 `run.resumedFrom` 正确落库；本处 `[未知]` 限「未基准」——fork 的性能/重放语义未基准，崩溃恢复与改脚本续跑仍未知）。

### 3.7 维度7：交互与可视化 —— 官方胜

**官方 `[官方·静态]`**
- 阶段视图是对因果图的商图投影、因果图本体一字不动：被 k>1 个 phase 认领的 step 复制成 k 份拷贝；零标记脚本整层恒等（三字段全缺席）——这是契约，UI 视图切换条件就是"阶段词汇表在场与否"。（phase-graph.ts:6-22, 24-38, 64-68）
- 浏览器走 @zcode/dynamic-workflow/projections 纯投影桶：只导出不 import typescript——AnalysisCore 冻结成 core.json 浏览器解码后现场重算五个投影，配 7 个 *ToMermaid 发射器；几 MB 的 typescript 编译器刻意不进前端包。（projections.ts:1-111）
- artifact 协议（zcode-protocol-v4）：六种闭集 kind（file/markdown/chart/table/metrics/board，加值破坏性偏斜）；两族（内容成员有字节与版本史 ≤16 版/id，预置看板无字节、每点是一条打标签的 report journal 行）；分层纪律"字节永不进任何一个 schema（除 workflowRunArtifactRead 一次一块 base64）"；页界 maxItemsPerPage=500 / maxPageBytes=16MiB÷4。（workflow-artifacts.ts:1-58）
- UI 观察面：并发/冷却读数与四条事件行由 workflowRunThrottle 渲染；协议只带相对量 cooldownMs（引擎无时钟），冷却 deadline 由 UI 按 WeakMap"首收时刻"本地推；RunControlBinding.bind(engine) 是 run service 够到活引擎的唯一接缝（setMaxConcurrency/fillHole/openHoles/filledHoles 四命令）；run 快照 holes[].state==='waiting' 必须从活引擎停驻表投影（进程死过没有 promise 在等）。（workflowRunThrottle.ts:1-53 + workflow-runs-reducer.ts:101-120 + harness.ts:53-73 + engine-holes.ts:19）

**官方 `[官方·实测]`**：用户确认图即按 15 个 phase 节点呈现。

**我方 `[我方·实测]` + `[已验证·本轮]`**
- 基6：view → view-bench50.html **96,928 B**（run dwfrun-mvxomkgk-7e7fc1，含 51 nodes / 50 replay hits 徽标 / 分 phase 逐节点行）；graph → graph-basic.html **10,274 B**（builder 模式）。两者 doctype 完整、`</html>` 收尾、0 外链脚本（自包含），且经临时 node http 服务 + 内置浏览器实际打开验证渲染（view 页标题 "AI-Workflow run dwfrun-mvxomkgk-7e7fc1"、DAG 页 Visualizer UI：Reset Zoom / 中文切换 / Node Inspector）。`[我方·实测]`；六件产物字节数本轮核对一致 `[已验证·本轮]`
- 另有 serve 命令（help："Serve a live, self-refreshing HTML view of a run from its journal (watch nodes land in real time)"），本轮未基准 `[未知]`。
- 缺口（实测缺陷③）：graph 只吃 builder 模式脚本——facade 脚本报 "Graph Export Error: Return statement is not allowed here"（graph.ts 源码要求 default-export Workflow）。`[我方·实测]`

**胜负：官方胜。**
**归因**：官方交互面是完整产品语义（阶段迷你轨道、看板、时间线、冷却倒计时、四命令交互通道、artifact 版本史与分页）；我方 view/graph 是 CLI 静态报告（无 artifact 看板、无交互命令通道、无冷却渲染），仅剩"自包含单文件可离线打开 + 实测可打开性验证"的轻量优势。丰富度差距实质存在。
**留白**：官方 UI 最终视觉表现（liveOnly 截图核对）；我方 serve 实时视图与 hole 轨道渲染 `[未知]`。

---

## 4. 我方实测暴露的缺陷清单

| # | 缺陷 | 状态 |
|---|---|---|
| ① | run-script 末行 "journal: .workflow\dwf.sqlite" 恒显示默认路径，`--db` 实际生效（bench-smoke.db 收到了数据） | `[我方·实测]` 基准时点为真；**撰写时已由 GAP-04 修复（未提交）**——`run-script.ts:129` 现打印 `options.dbPath ?? path.join('.workflow','dwf.sqlite')`（GAP-MATRIX §5 GAP-04 / §〇 #7 实测两分支「显示=实际写入库」）；本报告未复验该行 |
| ② | inspect 命令不支持 `--db`，只读 cwd 默认库 | **已过时**：本轮复核 `src/cli/commands/inspect.ts` 当前版已含 `options.db` 分支（该文件在 worktree 中被并行任务修改，git status `M`）；缺陷在基准时点为真 `[已验证·本轮·时点对比]` |
| ③ | graph 只吃 builder 模式脚本，facade 脚本不可用 | `[我方·实测]` 记录在案；本轮未复验 |
| ④ | `run-script --help` 的 `-c` 行写 "default 4"，源码链路（run-script.ts:47-49 → runner.ts:302 → engine.ts:36,419）默认实为 ASK_CONCURRENCY_DEFAULT（32 核=16），4 在链路中不存在 | `[已验证·本轮]` 本报告新发现，help 文案级 |
| ⑤ | 50 节点小 journal（<200KB、317 事件）即出现 1 条 `dwf_size_warning`（且 resume 不重发） | `[已验证·本轮]` 本报告新观察，触发阈值未深查 `[未知]` |

---

## 5. 同源性结论（本报告的横向发现）`[已验证·本轮]`

我方引擎与官方引擎的同源关系有三处**源码注释级自述**加数值级比对：

1. `schema-synth.ts:4`："Mirrors ZCode's schema/synthesize.ts"；
2. `child-main.ts:6`：隔离目标 "same as the official engine"；
3. `governor.ts:3-5` 与 `governor.ts:134-141`："completing the three-layer concurrency model (ask seat gate → run seat gate → process governor in ZCode)"、"matches ZCode's process-level governor"。

数值级逐字同构：默认并发公式（`min(16,max(2,availableParallelism−2))`）、AIMD 五参（起始 cap 8、×0.75、连续 4 成功 +1、floor 1、300s idle；官方起始 cap 未载 `[未知]`）、编译选项（strict 全开 + noUncheckedIndexedAccess:false + noEmit）、script_hash 逐字节纪律、"NULL 即缺席"（parent_run_id NULL / args_json `{}`）。**这意味着本报告 7 维中的"机制面"对比，本质是同一设计语言的两套实现：官方是全量产品级，我方是 CLI 级镜像子集。**

---

## 6. 留白清单

**官方侧（锚点 liveOnly 6 项 + 实测缺口）**：① 桌面端真实 spawn→run-started 墙钟与去 ELECTRON_RUN_AS_NODE 卡死复现；② 96% undefined 族诊断分布实测；③ per-node stats_json 载荷形状（累计 token 已有，形状缺）；④ 真实 429/Retry-After 下 cap 演化轨迹；⑤ 真实 run 的 dwf_event/dwf_node 全行导出核对；⑥ UI 阶段轨道/看板/冷却倒计时最终视觉截图。

**我方侧**：① 真实 provider 下全部 7 维复测（本轮全 mock，token/限流演化两类对比在接入前不成立）；② typed ask 端到端（本轮全 untyped）；③ AIMD 真实限流演化；④ amend 分叉 / 崩溃恢复 / 改脚本续跑（GAP-01 已覆盖 amend 血缘正确性实测——GAP-MATRIX §5 GAP-01 探针 fork `dwfrun-mvxu8mqj-00bdd1` 的 `run.resumedFrom` 正确落库；余下 fork 基准、崩溃恢复、改脚本续跑仍 `[未知]`）；⑤ 大 journal 取数性能；⑥ serve 实时视图与 hole 轨道渲染；⑦ argsJson 走 argv 的 32,767 上界风险；⑧ 我方 engine emit 的 18 种 `dwf_*` 事件与官方 27 种 RunEvent 词汇表的逐项映射（缺失清单）。

---

## 7. 本轮实际执行的验证命令（可复现清单）

1. `git -C <worktree> branch --show-current`、`git -C <worktree> log --oneline -3`、`git -C <worktree> status --porcelain` —— 分支 `feat/issue-28-goal-e2e-pentest`、HEAD `30eb54f`、并行改动在案（未触碰）。
2. `git -C <worktree> merge-base --is-ancestor fa274e5 HEAD` → 通过（hole parking 在谱系内）。
3. `ls -la C:/Users/86183/.zcode/workflow-drafts/goal-mission/bench/` —— 六产物字节数逐一对上记录。
4. `node <worktree>/bin/workflow.js --help`、`node <worktree>/bin/workflow.js run-script --help` —— CLI 语法、--db/--resume/-c/-m 旗标确认。
5. `node <bench>/time-cmd.js 3 <worktree> node bin/workflow.js check <bench>/minimal.facade.ts` → 903/938/948 ms（中位 937.574）、exit=0、"✔ facade script compiled clean (2 sites)"；执行前后 `<worktree>/.workflow` 文件数 40→40（check 零写入）。
6. node:sqlite 只读查询 `goal-bench.db` **副本**（先 `cp` 到 `<worktree>/.scratch-b41doc/`，查毕整目录已删，原件未动）→ §3.5 逐类型分布、`dwf_runs` 列族（PRAGMA table_info）、run 行实况。
7. `node -e` crypto sha256 → `4e3cc4b7de2b0f7456b63a0a2b03b2a15470ec02ff12667013b2dc5500095c8c`（goal-bench.db 172,032 B）。
8. 源码核读（`sed -n` / `rg -a`，engine.ts 因含 null 字节被 rg 判 binary，一律加 `-a`）：`engine.ts:27,36,328,339,347,350,418-419`；`governor.ts:1-150`；`child-main.ts:1-17`；`runner.ts:7,242,523-527`；`compile.ts:1-90`（71/80/81 行）；`schema-synth.ts:1-45`；`inspect.ts:1-30`；`run-script.ts:40-55`；`src/cli/index.ts:25`。

**未执行**（如实声明）：基2/基3/基4/基5/基6 的原样重跑（本轮仅复跑基1 + journal 只读复查 + 源码核读；基2/基5 需新建临时 journal，基6 需起浏览器，超出本报告"抽查复核"的必要范围，其数字以来源 C 记录为准并如实标注）。

---

*报告结束。数据来源：A/B/C 均为 TEST-GOAL 4.1 任务下发材料；D 类为本报告 2026-11-01 执行记录。主仓全程只读；worktree 内仅新增本文件，临时 scratch（.scratch-b41doc/，含 journal 副本与查询脚本）已当场删除。*
