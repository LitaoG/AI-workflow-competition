# ZCode `/workflow`（Dynamic Workflows）逆向研究报告与优化蓝图

> 生成日期：2026-11-01
> 研究方法：官方开源源码精读（无需逆向）+ rea 静态分析实测 + Claude Code 官方文档 + 两个开源复刻项目对照
> 所有研究材料已克隆到 `C:\Users\86183\Desktop\AI-workflow-research\`
> 修订记录（2026-11-02）：依据 `docs/research/WORKFLOW-GAP-MATRIX.md` §3.1 / §七 R1 的切片 1 实测，修正三处已被证伪的结论——2.3-⑤ settle-order 门为**首生结算次序**（非「按启动顺序重放」）；2.3-⑦ 血缘指针落在 **dwf_run 列 + stopped 结算同笔**（非 run-launched 事件）；2.4-2 journal 重放为**位置优先+哈希防御，池化仅在 world 导入队列**（非三元组无条件共用）。各处内注官方源码 path:line 证据，其余内容未动。

---

## 0. TL;DR

1. **ZCode 已经官方开源**（[zai-org/ZCode](https://github.com/zai-org/ZCode)，Apache-2.0），动态工作流引擎完整源码在 `apps/zcode-cli/packages/dynamic-workflow`（纯域逻辑）+ `packages/dynamic-workflow-runtime`（沙箱）+ `packages/bootstrap/src/app/dynamic-workflow-*.ts`（宿主胶水）+ `packages/core/src/tool/handlers/`（工具层）。**本报告第 2 章是它的完整架构逆向**。
2. **Claude Code 的 dynamic workflows 是闭源的**，但官方文档（[code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows)）公开了完整 DSL 语义；[six-ddc/codex-dynamic-workflows](https://github.com/six-ddc/codex-dynamic-workflows)（约 8000 行 TS）和 [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) 是两个高质量开源复刻，覆盖了运行时行为（第 4 章）。
3. **rea**（[morluto/rea](https://github.com/morluto/rea)）是"逆向任何东西"的 MCP 工具集，本次已按其用法对本机 ZCode 桌面端的 `app.asar`（374 MB）做了静态分析实测（第 3 章）。对已开源的 ZCode 它只是交叉验证；它的真正用武之地是分析**闭源目标**（如 Claude Code 的 `cli.js`）。
4. **你的 AI-Workflow 与官方实现是两条架构路线**（声明式 step 构建器 vs 脚本即代码+编译器）。第 5 章做差距分析，第 6 章给出 P0/P1/P2 分阶段融合蓝图——保留你的优势（DAG 可视化、prober、mock 模式、MCP），吸收 ZCode 的确定性内核与 Claude Code 的 authoring 语义。

---

## 1. 资料来源清单（均已就位）

| 仓库/资源 | 位置 | 许可 | 用途 |
| --- | --- | --- | --- |
| ZCode 官方源码 | `AI-workflow-research/ZCode/` | Apache-2.0 | 第 2 章逆向对象（**无需逆向，直接读码**） |
| ZCode 桌面端安装 | `C:\Users\86183\AppData\Local\Programs\ZCode\resources\app.asar` (374 MB) + `resources\glm\packages\bundled-skills\skills\dynamic-workflows\SKILL.md`（1623 行 authoring 契约） | — | rea 实测对象；SKILL.md 是面向模型侧的完整 API 契约 |
| morluto/rea | `AI-workflow-research/rea/`（6980 文件） | MIT | 第 3 章逆向方法论 |
| six-ddc/codex-dynamic-workflows | `AI-workflow-research/codex-dynamic-workflows/` | 开源 | Claude DSL 的完整独立 TS 引擎实现 |
| scasella/claude-dynamic-workflows-codex | `AI-workflow-research/claude-dynamic-workflows-codex/` | MIT | sessionful workers / race / fleet / 实时执行图 |
| Claude Code 官方文档 | https://code.claude.com/docs/en/workflows | — | 官方 DSL 语义与限制 |

---

## 2. ZCode 官方实现逆向（重点）

### 2.1 三代演进（读官方设计文档 `apps/zcode-cli/docs/design/v2/` 得到）

```
v1 ScriptWorkflowRuntime（legacy，仍在维护）
   设计文档: docs/design/v2/workflow-script.md, tool/15-workflow.md
   - export const meta 用"平衡括号扫描"在子进程中求值（不做完整 AST）
   - DSL: agent(prompt, opts) / parallel / pipeline / phase / log / workflow / args / budget
   - 子进程 RPC 隔离（"process isolation, not a security sandbox"）
   - 恢复: 每个 dispatchable call 有 callIndex/callPath/inputHash，对 workflow_activity 表查缓存
   - 存储: workflow_definition / workflow_run / workflow_activity / workflow_event 四张表
   - 上限: MAX_WORKFLOW_AGENT_CALLS = 1000

v2 /expert Expert Workflow（GSAP 风格图调度器）
   设计文档: docs/design/v2/expert-workflow.md, workflow-expert-runtime-split.md
   - WorkflowGraphScheduler（ready/active/blocked/frontier）
   - planner→actor→critic 循环，节点可 reopen
   - 运行目录 ~/.zcode/cli/workflows/runs/<runId>/（run.json + events.jsonl + graph.jsonl）
   失败恢复设计: workflow-failure-recovery.md —— 失败暂停（paused + 结构化 WorkflowFailure）而非直接 failed

v3 Dynamic Workflow（现役，本报告的主角）
   代码: packages/dynamic-workflow（引擎+编译器，纯域）
        packages/dynamic-workflow-runtime（沙箱 harness）
        packages/bootstrap/src/app/dynamic-workflow-*.ts（宿主装配，每个文件 ≤400 行）
        packages/core/src/tool/handlers/create-workflow.ts 等（工具入口）
   官方文档: packages/dynamic-workflow/docs/{authoring,launch,execution-engine,analysis,presentation,concurrency}.md
```

> 注意名称冲突：现役系统是 `CreateWorkflow` 工具；legacy `Workflow` 工具和 `/expert` 是另两代，共用 "workflow" 一词。

### 2.2 端到端管线（一次 CreateWorkflow 调用的完整生命周期）

```
CreateWorkflow（core 工具处理器，15 秒预算）
 │  analyzeWorkflowScript() ← @zcode/dynamic-workflow
 │    （完整 TS 类型检查 + 901x 授权规则 + 因果图分析）
 │  编译不过/模型绑定不解析 → 跳过审批窗直接返回诊断（绝不请用户批准编不过的代码）
 ▼
确认窗口（phaseNames、subagent 模型、world.run 命令清单、holes 清单 ← 均为编译期字面量）
 │  Allow
 ▼
DynamicWorkflowRunPort.submit（bootstrap/dynamic-workflow-run-service.ts）
 │  7 条文件头不变量：engine 独占建 run 行；编译恰好一次；无 journal 无服务；
 │  构造时孤儿对账；registry 先于 launch 注册；常驻跟踪；close() 只经 engine 停止
 │  mintRunId → 内存 registry {AbortController, WorkflowRunControl}（同步，先于 fire-and-forget）
 │  compileOnce: 一个 ts.Program 同时喂 → site 表、ask schema 合成、world.run 命令收集、
 │              因果解释（interpret）、lowering 产物、phase 投影、作者原文的 sha256 scriptHash
 ▼
launchDynamicWorkflowRun
 │  席位门 + 进程级 governor 注册 + journal 顺序捕获
 │  createAgentRuntimeWorkflowDriver（实现引擎的 WorkflowDriver 端口）
 ▼
harness.runWorkflowScript（dynamic-workflow-runtime）
 │  写 <cwd>/.zcode/workflow-runs/<runId>.mjs（lowered body + args 以 JSON 内嵌，避开 Windows 32767 argv 上限）
 │  spawn node --max-old-space-size=256（SEA 单文件: 隐藏子命令 re-exec；永远 ELECTRON_RUN_AS_NODE=1）
 ▼                        NDJSON over stdio
子进程 childMain：node:vm createContext（独立 realm）
 │  只注入 __host.{createActor, ask, worldRead, publishArtifact, declareArtifact, report, log, enterPhase, hole, run}
 │  禁 Date.now / 无参 new Date / Math.random（编译期诊断是双保险）；import()/eval 只到达 vm 上下文
 │  channel/future 是 cell 内纯 promise 机制；setImmediate 做停滞检测
 ▼                        __host 请求
引擎 WorkflowEngine（纯确定性状态机，无 I/O 无时钟无随机）
 │  实例身份 = siteId × per-site ordinal
 │  journal 查 (siteId, ordinal) 命中 → 短路返回缓存结果，不调 driver（这就是零 token 重放）
 │  inputHash 不匹配 → 大声失败（fail loudly），绝不静默错配
 │  未命中 → AskScheduler（per-actor FIFO + 并发门）→ driver.startAsk
 ▼
driver：每个 actor 一个持久 AgentRuntime 子会话
 │  模型策略: persona model() 绑定 > run 级 subagentModel > 恢复 pin (dwf_actor.resolvedModel) > 父会话模型
 │  工具 = 全量工作集 − 禁用清单（AskUserQuestion/EnterPlanMode/CreateWorkflow/AmendWorkflow/…）
 │  一次 ask = 一次 executeTurn；typed 结果经 submit_result 提交 → 引擎验证 accept/reject/nudge
 │  escalate 工具 → dwfq-xxx 问题停靠 → 主代理 ResolveWorkflowQuestion 回答
 ▼
journal（SQLite node:sqlite 同步端口）: dwf_run / dwf_actor / dwf_node / dwf_event
 │  每个 engine 事件: appendEvent → 同步 emit → toProgressPayload → 父会话/UI（活跑与冷回放字节级一致）
 ▼
settlement: completed | errored | stopped{user|model|superseded|interrupted}
resume  = 同 runId 重编译 + scriptHash 校验 + restoreFromJournal → 重放短路（已完成 ask 零模型调用）
amend   = 停靠前代 → ImportedRunCache（per-actor ask 序列 + messageBoundary）→ 新 run（resumed_from 血缘）
```

### 2.3 十二个关键机制（逆向结论）

**① 编译器：进程内 TS Compiler API + 全虚拟 CompilerHost**
`packages/dynamic-workflow/src/compiler/compile.ts`。脚本被包进 `async function __workflowScript__() { ... }`（使顶层 await/return 合法），与 facade `.d.ts`、内嵌 ES2022 stdlib 一起在**内存 Map** 中编译：`noEmit`、`strict`、`types: []`（无 ambient @types——纯度契约从编译期开始，`process`/`fetch` 直接编译错误）。关键取舍：**`noUncheckedIndexedAccess` 特意关闭**——模型的 TS 语料默认它关闭，开启曾导致 96% 的 undefined 族误报。诊断坐标映射回作者原文（减去一行 prelude）。

**② Facade：一个 .d.ts 常量，分段拼装**
`src/facade/dts.ts` 导出 `FACADE_DTS`（由 dts-model / dts-stream(channel/future) / dts-hole 等 segment 拼成）与 `SNIPPET_FACADE_DTS`（评测片段用子集，`agent()` 在片段里直接 TS2304）。五个模块以 `workflow-facade.d.ts` 这个文件名为 key。**"加一个原语 = 加一行注册表"**（`facade/registry.ts` 的 WORLD_READ_REGISTRY / ARTIFACT_REGISTRY）。

**③ Site 表与 lowering：编译期重写**
`src/lowering/lower.ts`。类型擦除 + site-id 戳记重写：`agent()`→`__host.createActor("actor#2",…)`、`p.ask<T>(t)`→`__host.ask("ask#3",p,t)`、`files.*`/`git.*`/`world.run`→`__host.worldRead`、`report`/`artifact.*`/`log`/`phase`/`hole` 各有对应 `__host.*`。`Promise.all` 扇出保持为 cell 内普通 promise——**编排控制流就是原生 TS，引擎只拦截边界调用**。siteId 跨 amend 稳定性由 `checkSiteStability` 强制。

**④ 沙箱：子进程 + node:vm 独立 realm + NDJSON IPC**
`dynamic-workflow-runtime/src/{harness,child-source,protocol}.ts`。隔离目标是**故障隔离与确定性**，不是安全边界（官方明说）。工程细节密集且都是踩坑结晶：entry 文件落盘（Windows argv 上限）、`--max-old-space-size=256`、`ELECTRON_RUN_AS_NODE=1` 防止 Electron Helper 启动 Chromium 挂死、SEA 单文件用隐藏子命令 re-exec（Node 不解析单文件二进制的 flags）、`childMain` 以 `Function.toString()` 内嵌进 entry（因此内部函数绝不许命名——esbuild `keepNames` 会注入 `__name` 帮助函数，仅在压缩产物里炸，有测试守着）。

**⑤ 确定性引擎与零 token 重放（本项目最值得抄的机制）**
`src/engine/engine.ts`。引擎是**纯确定性状态机**：实例身份 = `siteId × ordinal`；每个 `__host` 调用先查 journal 的 `(siteId, ordinal)`，**命中即短路**（不发生任何模型调用），`inputHash` 不匹配则 fail loudly。重放不是特殊模式，就是正常路径的缓存命中。配套：`replay-order.ts` 的 settle-order 门（扇出场景下按**首生结算次序**释放缓存结算——次序表从 `node-settled`/`artifact-published`/`artifact-failed` 结算事件序列恢复、只收每个实例首次结算那一条，解决的正是 join 后序号错位炸 `InputHashMismatch`，见官方仓 `engine/replay-order.ts:11/:30/:167`；2026-11-02 修订：早期版本误记为「按启动顺序重放，与 Claude Code 启动序对齐」，已被实测证伪）、`scheduler.ts` 的 per-actor FIFO。

**⑥ Journal：SQLite 四表，同步端口**
`adapters/.../dwf-journal.ts`（`node:sqlite` `DatabaseSync`，**同步**是有意为之——引擎里不能有异步缝，否则重放不确定）。`dwf_run`（script_text+script_hash+args+caps+血缘+状态）、`dwf_actor`（冻结 persona、session_id、resolved_model pin）、`dwf_node`（(run_id,site_id,ordinal) 唯一、input_hash、result_json、**message_boundary**）、`dwf_event`（全事件流）。快照就是行本身，不另做快照表；报表上限跨 resume 用 `countNodes/sumResultBytes` 恢复（不物化 item）。

**⑦ Resume / Amend：血缘与温缓存导入**
Resume：同 runId 重编译 → 结构化拒绝（`compile_failed`/`script_mismatch`/`not_resumable`/`superseded`/`already_running`）→ `restoreFromJournal` 恢复 settle 顺序、per-actor 已记账 ask 数、artifact 版本、report 计数 → 引擎构造函数发现已存在 run 行进入 resume 分支。Amend：preflight（前代存在 ∧ 每个完成 ask 有 message 边界）→ 停靠前代 `{superseded: newRunId}` → **静止探针**（问 driver 哪些会话已停止写入，不信任还在动的消息数）→ `buildImportedCache`（per-actor ask 序列 + 输入哈希 + 消息边界）→ 新 run 运行时按 seq+hash 消费缓存，miss 即翻转 `diverged` 单调标志，下游自动级联实跑。**血缘指针走 dwf_run 列，不走 run-launched 事件**：`resumed_from` 是建 run 那一刻写入的 `dwf_run` 列（官方仓 `dwf-journal.ts:99/:117-119`「lineage 同属这条只写一次的元数据路」），`supersededBy` 随 stopped 结算**同一笔** UPDATE 落库（`engine/types.ts:969-970` `RunSettlementRecord`——stopped 信封整体重写，「分两笔会丢」）；`run-launched` 事件只载 launch 锚点（inputId/modelBindings/scriptPath/权限模式等，`engine/types.ts:532-556`，且 resume 命中既有行时不再记）。「零迁移」只在结算次序/关门判定**从事件恢复**这一意义上成立（`engine/replay-order.ts:160-166` 事实来源是事件而非新列）。2026-11-02 修订：早期版本误记为「血缘指针放 run-launched 事件里，零 SQL 迁移」，已被实测证伪（与 2.3-⑥「dwf_run 含血缘」的正确记载矛盾，实测站在 2.3-⑥ 一边）。

**⑧ Holes：运行中生长工作流**
编译期 facts（CompiledHole）+ 引擎 `HoleRegistry`（`reachHole`/`fillHole`）。Fill 流程：串行 fill 队列（修过真并发竞态）→ 找开放 hole → `spliceHoleBody` → 对有效脚本全量 `analyzeWorkflowScript` → `checkSiteStability` → compile → 引擎写入 run 行的有效脚本、journal `hole-filled`、释放停放的 promise。cell 内用 `__fills` map 记住 body，循环再次到达 hole 时按当轮闭包求值。上限 32 holes/snapshot；fill 只能引用已在绑定表里的模型（诊断 9011）。

**⑨ Escalation：子代理向主代理升级提问**
driver 内的 `escalate` 工具（不在引擎里）→ 造 `dwfq-…` id → 内存 registry 停靠（**有意不持久化**——持久 pending 表在进程死亡后会说谎；恢复手段是 resume 后重新 ask 拿新 qid）→ 主代理经通知/GetWorkflowRun.pendingQuestions 看到 → ResolveWorkflowQuestion 回答 → deferred 以答案文本 resolve。预算：每 ask 3 次，cancelAsk 会拒绝停靠中的升级（"没人回答就永远卡死"的逃生门）。

**⑩ 并发：三层，纯算术耦合**
(a) 引擎调度门 `activeAsks >= caps.maxConcurrency`；(b) **run 席位门**（FIFO 停靠模型请求，使调低的限额在超限子代理的*下一个 turn 步*生效；工具自身的请求永不停靠，`activeAsks = working + parked` 保证无死锁）；(c) **进程级 governor**：每 `providerId/modelId` 一个 AIMD 桶（×0.75 乘性降、4 连成后 +1 加性升、Retry-After 冷却、5 分钟空闲重置），跨 run 轮询准入。默认并发 D = `max(4, min(16, availableParallelism − 2))`，AmendWorkflow 可以对活跑 run 原子 retune 三层。

**⑪ Caps：按错误通道定策略**
`report()` 返回 void → 超限**失败整个 run**（ReportCapExceeded）：65,536 项/run、1 MiB/项、1 GiB/run。world-read 返回 promise → 超限**拒绝该节点（可 catch）**：glob 2000 文件、grep 2000 匹配/256 KiB、git.diff 512 KiB、git.log 100、`world.run` stdout/stderr 各 16 MiB、默认命令超时 300 s。artifact：32 id/run、16 版本/id、文件 20 MiB、markdown 256 KiB。**有意移除**：token 预算、节点数上限、run 级墙钟超时——取消是唯一停止手段（"budget 只是遥测"）。世界读拒绝可 catch → 兜底重试；report 超限不可 catch → 结构性失败。

**⑫ Actor 策略：冻结与降级诚实**
模型优先级链（见 2.2）；persona 在创建时冻结；权限模式在 launch 时冻结进 `run-launched` 事件（会话模式后续变化绝不升级活跑；未记录 → YOLO）；工具 = 全量 − 固定禁用清单；会话被修剪 → 诚实降级为新会话并 log 警告，绝不假装连续。

### 2.4 直接可抄进你项目的设计决策清单

1. **Compile once**：一个 `ts.Program` 喂 site 表/schema 合成/lowering/因果图/scriptHash——你的 DAG 就能从脚本自动推导，不再手写 `dependsOn`。
2. **确定性内核 + journal 短路**：官方 journal 重放是**位置优先 + 哈希防御**——先按 `(siteId, ordinal)` 查行命中（`engine/scheduler.ts:136` `journal.getNode`），再防御性校验 `inputHash`，不符才 `InputHashMismatch`（哈希校验是四条 replay 路径共用的防御，见 `engine/hash-mismatch.ts:1`，不是共用键）；按内容 1:1 消费的**池化**（内容哈希游标，第 n 次出现对第 n 条记录）只存在于 world 导入队列（`engine/imported-cache.ts:194-205` `ImportedWorldQueue`）。2026-11-02 修订：早期版本「`(siteId, ordinal, inputHash)` 三元组是重放、amend 导入、去重共用的同一机制」表述过宽，已被实测证伪。
3. **数据事件替代 SQL 列**：launch 锚点全放 `run-launched` 事件，零迁移。
4. **错误通道决定 cap 策略**（void→fail run；promise→reject node 可 catch）。
5. **同一 analyzer 服务所有工具**（Create/Amend/Save/Fill），单槽 memo 按脚本文本键控；"可保存但不可运行"不可能发生。
6. **诊断永远不进审批窗**：编不过就别问用户。
7. **活跑与冷回放同一投影函数**，字节级一致（UI 不会说两套故事）。
8. **升级 registry 不持久化**，恢复=重问。
9. **数字错误码只是日志位**，消息前缀才是真判别器；拒绝文案由服务端逐字给出。
10. **每个文件 ≤400 行**（oxlint 上限），文件头注释块写不变量——大系统的可维护性习惯。

---

## 3. rea：逆向方法论与本次实测

### 3.1 rea 是什么 / 怎么用

rea（Reverse Engineer Anything，MIT，v6.8.0）是统一 MCP + CLI 的逆向工具集，覆盖原生二进制（Hopper/Ghidra/IDA）、Electron/JS 应用、.NET、固件等。对 JavaScript/Electron 目标的核心命令：

```bash
# 静态分析整个 Electron 应用（ASAR 或目录），不执行任何代码
rea analyze /absolute/path/to/app.asar --json
rea analyze-javascript-application /absolute/path/to/app --integrity-policy record-and-continue --json

# 只选关键源文件省内存（长清单用 --source-paths-json）
rea analyze /path/to/app.asar --source-path package.json --source-path main.js --json

# 结果视图（摘要/切片），stdout 始终是完整结果文档，stderr 是 rea_progress 进度行
rea inspect-analysis-view view.json
```

返回 Evidence 记录：JavaScript Application Graph（模块图 + Electron 主/渲染进程观察）、统计、**明确的 limitations**。也可以 `rea setup` 注册成 MCP 让 agent 直接调用。

### 3.2 本次实测（真实结果）

```bash
npx -y rea-agents@latest analyze "C:\Users\86183\AppData\Local\Programs\ZCode\resources\app.asar" --json
```

**第一次运行即抓到一个真实发现**——rea 的完整性校验拒绝了分析并返回结构化错误（`rea-zcode-asar-evidence.json` 首次内容）：

```json
{
  "error": "JavaScript application analysis failed",
  "code": "artifact_integrity_mismatch",
  "category": "integrity_mismatch",
  "message": "Declared ASAR integrity for unpacked entry
    node_modules/@img/sharp-win32-x64/lib/libvips-42.dll contradicts its companion file;
    packaging tools commonly sign or strip unpacked native binaries after writing the archive...",
  "details": {
    "logical_path": "node_modules/@img/sharp-win32-x64/lib/libvips-42.dll",
    "declared_sha256":  "f8d356de…e1529",
    "calculated_sha256": "d741664e…c7a9",
    "unpacked": true
  }
}
```

即：ZCode 桌面端 asar 中 sharp 的原生 `libvips-42.dll` 实际字节与 asar 头部声明的哈希**不一致**（Electron 打包工具对 unpacked 原生库做后处理签名的常见现象，也是供应链审计工具存在的意义）。rea 给出的 remediation 是按文档用 `--integrity-policy record-and-continue` 把观察到的字节标记为不可信并继续。

**第二次运行**（`record-and-continue`）产出完整 Evidence：应用模块图 + Electron 静态观察 + 统计 + limitations（文件：`AI-workflow-research/rea-zcode-asar-evidence.json`；asar 内含 27,645 个 JS 文件，全量解析耗时较长）。

**交叉验证（决定性证据）**：桌面端 asar 只是 Electron 壳，agent CLI 本体是 `resources\glm\zcode.cjs`（15.4 MB，打包于 2026-10-29）。对该 bundle 的字符串验证证明**发布二进制里就是我们在开源仓库读到的那份实现**：

| 标记（来自 §2 逆向结论） | 在 zcode.cjs 中出现次数 |
| --- | --- |
| `dwf_run`（journal 表） | 19 |
| `workflow-facade`（facade d.ts 文件名常量） | 1 |
| `createActor`（lowering 目标 `__host.createActor`） | 19 |
| `FillWorkflowHole`（工具名） | 16 |
| `scriptHash` | 34 |
| `dwfrun-`（run id 前缀） | 2 |
| `noUncheckedIndexedAccess`（编译选项） | 10 |

（验证命令：`grep -c -a -o <标记> zcode.cjs`；文件清单来自 `npx @electron/asar list`，已存 `AI-workflow-research/asar-filelist.txt`。）

**rea 实测完整弧线（方法论结论）**：

1. 全量 `analyze`（默认策略）→ 类型化拒绝：`artifact_integrity_mismatch`（抓到真实打包问题）。
2. 全量 `analyze --integrity-policy record-and-continue` → 成功，但 Evidence 达 **618 MB**（asar 内 27,645 个 JS 文件全量清点）——超过 Node 单字符串上限，连 rea 自己的 `inspect-analysis-view` 都以 `resource_constraint` 拒绝（错误里附完整 heap 预算明细：`projected_value_bytes`/`available_heap_bytes`…）。
3. **选择性分析**（`--source-path` 指定 renderer 的两个 workflow chunk）→ 秒级完成（`rea-zcode-selective-evidence.json`）。注意：即使选择性分析，rea 仍会**清点并校验整个 artifact**（这是它的设计：complete verification），所以 evidence 仍含全量清单。
4. 对 asar（Electron 壳）的标记验证为 0 是**正确结果**：dynamic-workflow 引擎不在壳里，在 `resources\glm\zcode.cjs`——架构分层印证。

给你的引擎的错误契约启示：rea 全程没有"裸异常"——每次失败都是 `{code, category, message, retryable, remediation, details}`，且 remediation 是可执行的动作。这正是你 P0 阶段值得照抄的错误形状。

方法论收获：rea 的错误也是类型化的（code/category/remediation 三件套），失败不丢信息——这本身就是值得抄进你引擎的错误契约设计（对照 ZCode 的"消息前缀判别器 + 数字码只是日志位"）。

### 3.3 rea 的正确使用场景：闭源目标

对 **Claude Code**（npm 包 `@anthropic-ai/claude-code`，发货的是压缩混淆后的 `cli.js`）：

```bash
mkdir claude-code-pkg && cd claude-code-pkg
npm pack @anthropic-ai/claude-code        # 或 npm i 到独立目录
npx -y rea-agents@latest analyze /absolute/path/to/package --json > evidence.json
```

注意：单个大 JS 文件走的是 rea 的另一条分析路线；对压缩 bundle，更实用的顺序是——先找 sourcemap（有则直接还原），没有就用 rea 的 inventory 拿到字符串常量表（工具名、诊断码、cap 数字都在字符串里），再定向反混淆。**但对你当前的需求，逆向 Claude Code 二进制不是必要的**：官方文档 + 两个复刻已经把语义、限制、恢复规则全覆盖（第 4 章），而且你完全可以像 six-ddc 那样用 ScriptedAgentRunner 做黑盒行为验证。若仍要逆向，请只做个人研究、勿再分发反编译产物（npm 包为专有许可）。

---

## 4. Claude Code Dynamic Workflows（要融合的另一侧）

### 4.1 官方语义（docs/en/workflows）

**DSL**（脚本=JS，作者为 Claude；body 顶层 await，顶层 return 即结果）：

| 原语 | 语义 |
| --- | --- |
| `export const meta` | 必须是第一条语句、纯字面量：`name`、`description` 必填，`phases`、`whenToUse` 可选；非字面量会从 `/` 自动补全里消失 |
| `agent(prompt, {schema, label, stallMs})` | 产一个子代理；schema 为 JSON Schema（自相矛盾 schema 启动前拒绝；连续 5 次校验失败报错，`MAX_STRUCTURED_OUTPUT_RETRIES` 可调）；中途停止/不可恢复 API 错误 → `null` |
| `pipeline(items, fn…)` | 每项独立流过各阶段（**无栅栏**）；失败项占位 `null` → `.filter(Boolean)` 惯用法 |
| `parallel(tasks)` | 并发全跑并等齐（栅栏） |
| `phase(title)` / `log(msg)` | 进度分组 / 叙事行 |
| `args` | 调用入参（数组/对象皆可，缺省 undefined） |

**确定性**：`Date.now()`、`Math.random()`、无参 `new Date()` 被**改为抛错**，使 relaunch 重放逐字节一致——时间戳须经 `args` 传入。（与 ZCode facade 禁令同源同因。）

**恢复/重放**：按子代理**启动顺序**重放；已完成者返回缓存；第一个 prompt 变化处起重跑；**失败者连同其后启动的全部重跑**；手动停止某 agent 视同失败。relaunch 前须等停止 run 的 agent 全部退出。停滞 agent 自动换新 transcript 重启（最多 5 次）。

**限制与缓存**：并发默认 16（CPU 相关，`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 1–256）；单次 `parallel/pipeline` 4096 项；每 run 1000 agents。**扇出前缀缓存**：后续 agent 与第一个共享缓存前缀，迟到者最多被 hold 5 秒（`…_PREFIX_STAGGER_MS`）等首响应建立缓存；子代理 prompt 缓存 TTL 默认 5 分钟（可至 1h）。

**成本与控制**：>25 agents 或预计 >1.5M token 弹 Large workflow 提示；size guidelines（small<5 / medium<10 默认 / large<50 / unrestricted）；脚本存 `~/.claude/projects/`，`/workflows` 面板可暂停恢复、`s` 保存到 `.claude/workflows/`（项目）或 `~/.claude/workflows/`（个人）；`disableWorkflows` 配置或 `CLAUDE_CODE_DISABLE_WORKFLOWS=1` 关闭。

### 4.2 ZCode dwf vs Claude Code（语义对照）

| 维度 | Claude Code | ZCode dwf |
| --- | --- | --- |
| 语言 | JS（无类型检查，schema 靠运行时） | TS（严格编译 + facade .d.ts + 静态授权规则） |
| 恢复键 | prompt 变化处重跑（隐式 call 序） | `(siteId, ordinal)` + `inputHash` 显式键控，编译器保证 site 稳定 |
| 失败重放 | 失败者连同其后全部重跑 | 失败节点按重试策略；未完成才实跑 |
| 修改运行 | 编辑脚本文件 relaunch | `AmendWorkflow` 温缓存导入 + 血缘（省掉未变的全部下游 token） |
| 运行中生长 | 无 | `hole<T>()`（停停靠 + FillWorkflowHole 填代码） |
| 人机交互 | 审批窗（launch 时） | 审批窗 + 子代理 escalate 提问（`dwfq-…`） |
| 并发治理 | 单层并发上限 + 缓存 stagger | 调度门 + 席位门 + AIMD governor 三层，可活跑 retune |
| 预算 | 1000 agents/run、4096 项/调用 | **无 token/节点预算**（只有结构 cap）；墙钟超时也移除 |

### 4.3 两个复刻项目各自的可借鉴点

**six-ddc/codex-dynamic-workflows**（约 8k 行 TS，独立引擎，依赖 Bun）：
- `WorkflowController` → `parseWorkflowScript`（meta 解析）→ Bun 子进程跑开放 TS/JS body → **JSONL IPC** 把 `agent()/workflow()/phase()/log()` 路由回父进程 → 可插拔 Runner（CodexSdk / GeminiCli / PiCli / **ScriptedAgentRunner 确定性测试**）。
- `FileWorkflowJournal`：以 `prompt+options+runId` 为键缓存完成调用，`resume` 尽力重放。
- **provider config**：单 run 内可按调用路由不同后端/模型；Claude 硬编码的模型名被忽略以保证脚本可移植。
- `budget` 全局（`total/spent()/remaining()`，共享于嵌套 workflow）——官方 Claude 没有而它有。
- 兼容性分歧声明（README）：脚本开放执行（可 import/用 Bun API），因此 resume 是尽力而为——**这就是你项目的现状**；想要 ZCode/Claude 的强重放，就必须走"受限 facade + 确定性禁令"路线。

**scasella/claude-dynamic-workflows-codex**（Claude Code skill，零依赖 runner + 实时执行图 viewer）：
- **Sessionful workers**（超越一次性 DSL 的关键扩展）：`agent.start(prompt, opts) → AgentSession`（不等首 turn 返回）；`waitAny(sessions, {timeoutMs})`（任一 worker 可行动即返回）；`session.steer(msg)`（**同一热线程上的后续 turn**——worker 保留全部上下文）；`session.cancel()/close()`；`AgentSessionSnapshot{status, result, tokens, ms…}`。由此可写 **race 三路 root-cause、取消败者、胜者继续 steer** 的模式。
- `human()` gate：运行中停在页面等人在 viewer 里回答。
- `--multi` 舰队模式：Claude 主代理同时监督多个并发 workflow（答 gate、steer、杀死死路、fork 胜者）。
- effort 政策：`--auto-effort` 按并行宽度自动分层（1→xhigh，扇出→high floor）。
- journal 记录 `phase` 覆盖，解决并发 pipeline 中全局 `phase()` 竞态——viewer 分组正确。
- 离线 viewer：`node runner/bin/view-run.js <runDir> --open`，DAG + worker 时间线 + gate 答题。

---

## 5. 你的 AI-Workflow 现状与差距分析

### 5.1 现状（`src/`）

- **Authoring**：`defineWorkflow({name, phases, steps[{id, phaseId, execute(ctx), dependsOn}]})` 声明式构建器（`core/workflow.ts`，Kahn 环检测）；脚本是普通 TS 模块直接被 node 加载（如 `demos/*/workflow.ts`）。
- **Agent RPC**：`agent(name).ask<T>(prompt, zodSchema, opts)` + 修复重试环（`agent/rpc.ts`）、mock provider（离线演示）、bedrock provider。
- **确定性探测**：`prober/`（系统/git/工具链/脱敏 env）。
- **持久化**：`state/event-log.ts`（events.jsonl）+ SQLite WAL；`--resume-from-failed`。
- **可视化**：`dag/`（SVG Bézier 时间线、kanban、mermaid、ASCII）——**这块比官方 CLI 还全**。
- **MCP**：client+server+registry；**CLI**：`/workflow run/replay/graph/probe/list/inspect/init/mcp` + i18n（en/zh）。
- 质量：121 测试 + fast-check PBT + .kiro 合规套件。

### 5.2 差距表（对照 ZCode dwf 与 Claude Code）

| # | 能力 | 你的现状 | ZCode dwf / Claude Code | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 脚本模型 | 手写 `dependsOn` 的 step 图 | 脚本即代码，DAG/阶段由编译器从代码推导 | 每 demo 手工维护依赖图；无法静态保证 |
| 2 | 编译期契约 | 无（运行时 Zod） | facade .d.ts 严格类型检查 + 字面量规则（phase/model/world.run 命令在审批前已知） | 错误发现晚；审批窗信息少 |
| 3 | 隔离 | 脚本直接 `import node:fs` | 子进程 + vm realm + NDJSON `__host` | 脚本崩溃=宿主崩溃；无法禁 Date.now |
| 4 | 零 token 重放 | 事件日志 + resume-from-failed（重放=重新执行） | `(siteId, ordinal, inputHash)` journal 短路 | 你的 resume 仍烧 token；这是官方最大卖点 |
| 5 | Amend/血缘 | 无 | 温缓存导入 + resumedFrom/supersededBy | 改一行脚本 = 全部重跑 |
| 6 | Holes | 无 | `hole<T>()` + FillWorkflowHole | "探索后才知道形状"的任务写不了 |
| 7 | 子代理会话 | 每次 ask 独立（无记忆） | 每 actor 持久 AgentRuntime（跨轮上下文）+ Claude 复刻的 steer/waitAny | planner-reviewer 循环每轮从零学起 |
| 8 | 并发治理 | Promise.all 即并发 | 三层门 + AIMD + 活跑 retune | 无法对 provider 限速自适应 |
| 9 | 升级问答 | 无 | escalate/dwfq + ResolveWorkflowQuestion | 死锁场景只能失败 |
| 10 | typed 结果 | ✅ Zod + 修复环（**你已达标**） | TS 类型 ask + submit_result 验证 | 保持优势 |

**结论**：你不缺可视化、探测、mock、MCP、i18n——缺的是**确定性内核（编译器+site+journal 短路）**与**authoring 契约（facade）**。这正是第 6 章蓝图的主体。

---

## 6. 优化版 `/workflow` 融合蓝图（P0 → P2）

> 原则：**不推翻现有 builder**——它作为 Level-0 API 保留（你的 121 个测试和 demo 都押在它上面）；新增 Level-1 "facade script" 模式，两条路线共用同一个 journal/引擎内核。

### P0（1–2 周，可对外演示的核心跃迁）

**P0-1 Facade 编译器（最强差异化）**
- 新模块 `src/compiler/`：用项目已有的 `typescript` devDependency 建**虚拟 CompilerHost**（内存 Map：脚本 + `workflow-facade.d.ts` 常量 + 内嵌 lib），`strict`、`types: []`、`noUncheckedIndexedAccess:false`（照抄官方理由）。
- facade d.ts 起步版：`agent(name)` → `Node<T>`、`ask<T>`、`phase`、`log`、`files.glob/read/grep`、`git.changedFiles/diff/log`、`world.run`、`args`、`report`、`artifact.file/markdown`。
- site 收集器：遍历 AST 得 `[{siteId, kind, phase, actorName}]` → **自动生成 DAG** 喂给你现有的 `dag/visualizer.ts`（手写 dependsOn 时代结束）。
- 交付物：`/workflow check <script.ts>` 子命令输出诊断 + 阶段图。

**P0-2 确定性重放 v2（把"零 token resume"做实）**
- 现状底子比预期好：`state/replay.ts` 的 `ReplayEngine.analyzeRun` 已实现 step 级 checkpoint 重放（skip completed / execute failed+downstream）。**精确差距是缓存键**：现在只按 `stepId` 命中，步骤的 prompt/输入变了仍返回旧缓存——官方的 `inputHash`（对 (site 语义 + 插值后的 prompt + args) 求哈希，不匹配 fail loudly）就是补这个洞的。
- 升级为 journal 短路模型：lowering 阶段给每个 facade 调用戳 `(siteId, ordinal)`；执行前查 SQLite `(run_id, site_id, ordinal)` 且 `input_hash` 相符 → 直接返回 `result_json`；不符则 fail loudly（绝不静默错配）。
- 脚本纯度门：vm 里把 `Date.now/Math.random` 换成抛错版（Claude/ZCode 同款）；`args` 传时间戳。
- 验收：demo2（repo migration）`--resume` 时已完成的 fan-out 步骤 **0 次 provider 调用**（用 mock provider 计数器证明——正好是你现成的测试基建）。

**P0-3 沙箱子进程（安全+纯度）**
- `src/runtime/child.ts`：`node:vm.runInContext('(async (__host) => {…})')` + NDJSON stdio 桥（six-ddc 的 JSONL IPC 是更简单的参考实现）；宿主禁 `fs` 直达，`world.run` 白名单命令。
- Windows 细节照抄官方：entry 落盘而非 argv 传参；heap 上限。

**P0-4 Demo 升级**：incident demo 用 facade script 重写一版放 `demos/`，对外叙事变成"我们实现了 ZCode 同款确定性内核 + Claude Code 同款 DSL，外加他们都没有的 XX"。

### P1（3–6 周，长期维护的地基）

- **P1-1 Amend + 血缘**：`/workflow amend <runId> --script <file>`：停靠前代 → 逐 actor 导入 ask 缓存（含 messageBoundary 概念的简化版）→ 新 run。先做"未变 ask 全缓存命中"，quiescence 探针可后置。
- **P1-2 Holes**：`hole<T>(name, prompt)` 停靠 + `/workflow fill <runId> <holeId>` 填 body → 拼接 + 重编译 + site 稳定性检查。
- **P1-3 Escalation**：子代理 `escalate` 工具 → 内存 registry → CLI/`mcp` 通道回答（每 ask 3 次预算，照抄）。
- **P1-4 并发席位门**：先做单层（`activeAsks < maxConcurrency` 的 FIFO 停靠），AIMD governor 留接口。
- **P1-5 持久 actor 会话**：`agent("评审员")` 复用同一上下文跨轮 ask（对应 ZCode 每 actor 一个持久 runtime）——planner-reviewer 循环的成本直接砍半。

### P2（长期）

- **P2-1 Sessionful workers**（抄 scasella API 形状）：`agent.start/waitAny/steer/cancel/close` → 支持 race-and-cancel、热线程 steer。
- **P2-2 Provider/model 策略**：persona 绑定 > run 级 > 会话级；`model()` 编译期闭包检查（诊断 9010/9011 同款）。
- **P2-3 实时执行图**：把 `dag/html-renderer.ts` 接到 journal 事件流上（活跑与冷回放同一投影函数——官方第 7 条经验），加 worker 时间线与 gate 答题（对齐 scasella viewer）。
- **P2-4 Saved workflows 注册表**：`.zcode/workflows/*.workflow.ts` + frontmatter（name/description/whenToUse/args），`/workflow list` 已有目录扫描可复用。
- **P2-5 MCP server 扩展**：把 `get-run/list-runs/fill-hole/resolve-question` 暴露为 MCP 工具——让你引擎能被其他 agent 宿主（包括 ZCode 本身）调用。

### 明确不抄的东西

- token 预算 / 节点数硬上限（官方已移除，理由充分：预算只是遥测）；
- 把 vm 当安全边界（官方明说不是）；审计用 OS 级沙箱/容器;
- 一次性把 P1/P2 全做了——官方自己也是三代演进过来的。

---

## 7. 关键文件速查表（ZCode 仓库内）

| 想看什么 | 路径（相对 `AI-workflow-research/ZCode/`） |
| --- | --- |
| 编译器 + 虚拟 host | `apps/zcode-cli/packages/dynamic-workflow/src/compiler/compile.ts` |
| facade d.ts 常量 | `…/packages/dynamic-workflow/src/facade/dts.ts`（+ `dts-model.ts`/`dts-stream.ts`/`dts-hole.ts`/`registry.ts`） |
| site 收集 / 因果解释 | `…/src/analysis/{sites,interpret,site-phases,analyze}.ts` |
| lowering | `…/src/lowering/{lower,lower-hole}.ts` |
| 确定性引擎 | `…/src/engine/{engine,scheduler,replay-order,engine-resume,engine-holes,concurrency,journal-memory}.ts` |
| 沙箱 harness / 子进程 | `apps/zcode-cli/packages/dynamic-workflow-runtime/src/{harness,child-source,protocol,child-entry-file}.ts` |
| 工具处理器 | `apps/zcode-cli/packages/core/src/tool/handlers/{create-workflow,amend-workflow,fill-workflow-hole,eval-workflow-snippet,resume-workflow-run,save-workflow}.ts` |
| 宿主装配（run service） | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-{service,submit,compile,launch,fill,holes,lineage,replay}.ts` |
| 驱动（actor 运行时） | `…/bootstrap/src/app/workflow-driver.ts` + `workflow-actor-{model,tools,permission,transcript}.ts` |
| 并发三层 | `…/bootstrap/src/app/{workflow-seat-gate,workflow-concurrency-governor,workflow-default-concurrency}.ts` |
| SQLite journal | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal*.ts` |
| 官方引擎文档 | `apps/zcode-cli/packages/dynamic-workflow/docs/*.md`（authoring/launch/execution-engine/analysis/presentation/concurrency） |
| 面向模型的 authoring 契约 | 本机 `C:\Users\86183\AppData\Local\Programs\ZCode\resources\glm\packages\bundled-skills\skills\dynamic-workflows\SKILL.md`（1623 行，含完整 facade 类型段 §16） |
| Claude 官方文档 | https://code.claude.com/docs/en/workflows |
| 独立开源引擎 | `AI-workflow-research/codex-dynamic-workflows/src/{runtime,controller,journal,task-manager,workflow-tool}.ts` |
| Sessionful 扩展 | `AI-workflow-research/claude-dynamic-workflows-codex/{SKILL.md,references/authoring.md,references/fleet-protocol.md}` |

---

*报告完。所有结论均有源码文件或官方文档背书；两个子代理的完整架构报告（约 8k 字）可作为本文件的深度附录，按需展开。*
