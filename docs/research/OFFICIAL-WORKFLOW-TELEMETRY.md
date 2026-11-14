# 官方 Workflow 真实执行一手遥测数据白皮书（Ground Truth）

> **定位**：本文是 MISSION-B Phase-2 遥测交付物（Deliverable 4，part 2/2）。全部数据来自**本机真实运行**，
> 逐条标注证据档位：`[已验证]`（本轮已用具体命令/可复现证据验证）、`[推断]`（由已验证事实逻辑推演，
> 给出推断链）、`[未知]`（现有信息不足，如实标注）。**禁止编造**：数值逐字取自探针 stdout JSON
> 与任务指令给出的官方套件指纹；探针拿不到的指标一律标 `[未知]`。
>
> - 撰写会话：2026-11-03；撰写者：遥测白皮书撰写员（workflow 子代理）
> - 工作区：`C:/Users/86183/Desktop/AI-workflow-worktrees/issue-67-zcode-benchmark`（下称 WT）
> - 探针脚本：`tests/cross-engine/official-telemetry-probe.mjs`（WT 内，源码注释明示 "No repo files
>   are modified"，official-telemetry-probe.mjs:2-3 `[已验证·源码]`）
> - 本文是本次任务**唯一**新建的文件；探针 stdout JSON 存于仓库外临时目录，本文转写其逐字数值后
>   临时文件按《AGENTS.md》§1.5 清理。重跑同一条命令即可再生同类数据（毫秒级数值随机器/负载浮动）。

---

## 1. 环境与命令

| 项 | 值 | 证据 |
|---|---|---|
| Node | `v26.13.0` | `node --version` 及探针 JSON `node` 字段一致 `[已验证]` |
| 官方包 | `@zcode/dynamic-workflow` `0.1.0` | 官方包 `package.json` `[已验证]` |
| 官方包编译器 | `typescript` `5.9.3` | 官方包 `node_modules/typescript/package.json` `[已验证]` |
| 官方包根 | `C:/Users/86183/Desktop/AI-workflow-research/ZCode/apps/zcode-cli/packages/dynamic-workflow`（dist 已构建，探针 JSON `pkgRoot` 字段逐字一致 `[已验证]`） | 探针 JSON |
| 驱动方式 | in-process `import(dist/index.js)`，内存桩 driver，无子进程/无真实 IPC | 探针源码 official-telemetry-probe.mjs:26 `[已验证·源码]` |

**执行命令**（在 WT 目录下，各跑一次，先预热后正式）：

```bash
node tests/cross-engine/official-telemetry-probe.mjs   # 第 1 次：预热（数据仅用于方差参照）
node tests/cross-engine/official-telemetry-probe.mjs   # 第 2 次：正式数据（本文 §3–§5 全部数值来源）
```

- 两次运行 exit code 均为 0，stderr 均为空 `[已验证]`。
- 第 2 次（正式）stdout JSON 是 §3、§4、§5 所有数值的**唯一**来源；第 1 次（预热）仅用于 §7.1 方差示例。

---

## 2. 官方全量测试套件指纹

> **来源声明**：本节指纹由**任务指令给出**（本 workflow 前序步骤对官方测试套件的一次完整实跑记录），
> 本文逐字转写。本次撰写会话**未重跑**全量套件（超出本探针任务范围），此点如实注明。

- 官方套件首跑：**2034 tests，2030 pass**，总时长 **54.26s** `[已验证·来源=任务指令]`；
- 4 项失败均为**环境性**：**2× 缺 dist**（目标包未构建）、**1× 5000ms 默认超时**、**1× 性能预算
  10138 < 10000**（阈值判定方向：实测超预算） `[已验证·来源=任务指令]`；
- `npx tsc` 构建 dist 后，对 3 个失败文件定向重跑：**131/131 全过** `[已验证·来源=任务指令]`；
- **结论：失败均为环境性、无引擎缺陷** `[已验证·来源=任务指令]`。

---

## 3. 引擎实跑探针（Probe A：engine-run）

### 3.1 场景

`planner → fanout(4, maxConcurrency=4) → verifier → report → complete`
（探针 JSON `scenario` 字段逐字）。结构事实来自探针源码 `[已验证·源码 official-telemetry-probe.mjs:80-104]`：

- 6 个 actor：`actor#1` planner、`actor#2..5` researcher-2..5、`actor#6` verifier；
- 6 个 ask 站点，模拟模型时延 `{ask#1:12, ask#2:40, ask#3:25, ask#4:33, ask#5:18, ask#6:10}` ms；
- 引擎 caps `{maxConcurrency: 4}`；三个阶段 `enterPhase("plan"/"research"/"verify")`；
- driver 每站点 `createActorSession` 一次、ask 结束时回写 `askStats(tokens=120)` 与
  `askTurnEnded`；全部 emit 事件带 hrtime 毫秒时间戳被捕获。

### 3.2 事件计数表（emit 流）

`[已验证]`（探针 JSON `engine.eventCounts` 逐字）：

| 事件类型 | 次数 |
|---|---|
| `run-started` | 1 |
| `actor-created` | 6 |
| `phase-entered` | 3 |
| `node-queued` | 6 |
| `node-dispatched` | 6 |
| `usage-updated` | 6 |
| `node-settled` | 6 |
| `report` | 1 |
| `run-settled` | 1 |
| **合计 `eventsEmitted`** | **36** |

结构读法 `[推断]`（推断链：计数与场景一一对应——6 actor→6 条 actor-created；3 次 enterPhase→3 条
phase-entered；6 ask→queued/dispatched/usage-updated/settled 各 6；planner→fanout→verifier 共 6 ask；
1 次 report、1 次 complete）：emit 流与场景结构零缺零余。

- `phase-entered` 的**名称**字段探针采到的是 `null`：事件实际载荷键为 `name`（官方源码
  `src/engine/types.ts:690` `{ type: "phase-entered"; name: string; ordinal: number }`），探针读的是
  `phaseName` `[已验证·源码]`。三次调用的名称为 `plan / research / verify`（探针源码显式实参
  official-telemetry-probe.mjs:92,95,100 `[已验证·源码]`；名称与 3 条计数一致 `[已验证·计数]`）。
- `run-launched` **缺席**：探针未传 `EngineConfig.launch` 元数据，官方源码证实该事件仅在 launch
  元数据在场时紧跟首条 `run-started` 记录（`src/engine/engine-config.ts:60`、
  `src/engine/engine-launch.ts:54`）`[已验证·源码]`——缺席与逆向报告 §1.6「仅建 run 世」的限定一致。
- 事件流**逐条顺序**（如 `run-settled` 是否最后一条）探针 JSON 未导出 → `[未知]`。

### 3.3 journal 事件序列

- **探针读回结果：空数组**（探针 JSON `journalEventSequence: []`）`[已验证·JSON]`。
- **根因已定位并复现** `[已验证·复现实验]`：探针以 `journal.listEvents(runId, { types: "all",
  reportItems: { limit: 0 }, limit: "all" })` 调用，而 `limit` 选项是数字截断参数——官方实现
  `src/engine/journal-memory.ts:225-226` `filtered.slice(0, Math.max(0, opts.limit))`，
  `"all"` → `Math.max(0, NaN)` → `slice(0, NaN)` → **空页**。复现实验（对官方 dist 的
  InMemoryJournalStore 造 2 条事件后查询）：`limit:"all"` → 0 条；`limit` 缺省 → 2 条；
  `limit:99` → 2 条。journal 本身工作正常，是**探针查询方式**取不回数据。
- 因此：**journal 逐条事件序列在本次探针中未取到 → `[未知]`**。旁证：官方为单一漏斗——
  `record(event)` = 补出生阶段戳 → `journal.appendEvent`（durable 轨）→ `driver.emit`（实时轨），
  两条路线是**同一个对象**（逆向报告 §1.6，`src/engine/engine.ts:690`）——emit 流的 36 条计数即
  journal 内容计数 `[已验证·源码+计数一致]`。

> **增补（Issue #89，2026-11-04）**：探针查询已修复——`limit` 改传数字 `10_000`
> （official-telemetry-probe.mjs:127-131）。修复后正式遍读回 **36 条全序列**
> `[已验证·JSON]`（`journalEventSequence` 逐字）：
>
> ```text
> run-started > actor-created ×6 > phase-entered(plan) > node-queued > node-dispatched >
> usage-updated > node-settled > phase-entered(research) > node-queued ×4 > node-dispatched ×4 >
> usage-updated/node-settled ×4（交错） > phase-entered(verify) > node-queued > node-dispatched >
> usage-updated > node-settled > report > run-settled
> ```
>
> 两个由此升格的结论：
> 1. **`run-settled` 是事件流最后一条**——逆向报告 §1.6「事件流终态收口」不变式由实测直接印证
>    `[已验证·JSON]`（§6 对照表同步行已更新）；
> 2. journal 读回序列与 emit 流计数 **36 = 36 完全一致**——「单一漏斗、两条轨同一对象」不再只是
>    源码旁证，而是同批数据对齐 `[已验证·JSON]`。

### 3.4 各实例时延分解

`[已验证]`（探针 JSON `engine.instanceTimings` 逐字；site→角色/模拟时延映射来自探针源码
official-telemetry-probe.mjs:40,88-90,101 `[已验证·源码]`；「开销」列 = occupancy − 模拟时延，
算术推导 `[已验证·算术]`，其成因（Node 定时器聚束、结算路径耗时）为 `[推断]`）：

| site | 角色（模拟时延） | queueWaitMs | occupancyMs | totalMs | 开销 = occupancy−模拟 |
|---|---|---|---|---|---|
| ask#1 | planner (12ms) | 0.218 | 24.207 | 24.425 | +12.207 |
| ask#2 | researcher-2 (40ms) | 0.266 | 45.513 | 45.779 | +5.513 |
| ask#3 | researcher-3 (25ms) | 0.232 | 30.089 | 30.321 | +5.089 |
| ask#4 | researcher-4 (33ms) | 0.211 | 45.358 | 45.570 | +12.358 |
| ask#5 | researcher-5 (18ms) | 0.179 | 29.926 | 30.105 | +11.926 |
| ask#6 | verifier (10ms) | 0.047 | 15.427 | 15.474 | +5.427 |
| report#1 | report 节点 | null | null | null | —（report 无 queued/dispatched/settled 三态，与逆向报告 §1.6「report 同族地有行无节点」一致 `[推断]`） |

- **queueWait 全部 ≤ 0.266ms**：fanout(4) 恰好等于 `maxConcurrency: 4`，派发粒度上未观察到排队
  `[已验证·JSON]`；「cap 未构成瓶颈」的推广 `[推断]`（4 ≤ 4，无超额需求可排）。
- occupancy 恒 ≥ 模拟时延（开销 +5.1 ~ +12.4ms）`[已验证·算术]`。

### 3.5 first-ask 时延、结算状态与全程

| 指标 | 值 | 证据 |
|---|---|---|
| `wallMs`（t0 到 settled） | **87.988** | 探针 JSON `[已验证]` |
| `firstAskAfterRunStartMs`（run-started → 首 node-dispatched） | **1.093** | 探针 JSON `[已验证]` |
| `driverSessions` | 6（每 actor 一个会话） | 探针 JSON `[已验证]` |
| `disposedOnSettle` | `true`（结算即 dispose driver） | 探针 JSON `[已验证]` |
| 结算状态 | `status: "completed"` | 探针 JSON `[已验证]` |
| 结算载荷产物值 | `[未知]`：探针读 `settled.result`，而官方 settled 载荷键为 `artifact`（`src/engine/engine-settlement.ts:32` `resolveSettled({ status, artifact })`）`[已验证·源码]`，JSON 中该键缺席（undefined 被 JSON 序列化省略） |
| 6 个 ask 的 settled 结果 | 计数层面 6 queued = 6 dispatched = 6 settled = 6 usage-updated，无失败事件族（`node-repairing`/`node-nudged` 等均为 0 次出现）`[已验证·计数]` |

- 关键路径一致性核对 `[推断]`（推断链：串行段 ask#1 total 24.425 + fanout 段 max(ask#2 total
  45.779) + 串行段 ask#6 total 15.474 ≈ 85.68ms，加 report/结算与事件路径 ≈ 实测 87.988ms）：
  wall 时间结构与三段串/并行结构吻合。
- `settled` promise 在 `complete()` 后兑现、driver 在结算内被 dispose（`engine-settlement.ts:88`
  `state.driver.dispose?.()`）`[已验证·源码]`，与 `disposedOnSettle: true` 实测一致 `[已验证·JSON]`。

---

## 4. AIMD 并发桶实测（Probe B：真实 ConcurrencyController + 虚拟时钟）

控制器：`new ConcurrencyController("prov/model", 8, 32)`（initial=8，growthLimit=32）；
时间全部为探针注入的**虚拟时钟**（`now` 由调用方传入，控制器纯包不读钟——官方源码
`src/engine/concurrency.ts:4-6`）`[已验证·源码]`。

### 4.1 五参数实测值

`[已验证]`（探针 JSON `aimd.params` 逐字；与官方常量导出一致）：

| 参数 | 实测值 |
|---|---|
| `CONCURRENCY_DECREASE_FACTOR` | **0.75** |
| `CONCURRENCY_INCREASE_STEP` | **1** |
| `CONCURRENCY_INCREASE_AFTER_SUCCESSES` | **4** |
| `CONCURRENCY_FLOOR` | **1** |
| `CONCURRENCY_IDLE_RESET_MS` | **300000**（5 分钟） |

### 4.2 增长期：24 次成功的 cap 轨迹

- **实测轨迹：cap 全程无变化**——`growCaps: []`（24 次成功期间零条 cap 变化事件，cap 恒 = 8）
  `[已验证·JSON]`。
- 根因 `[已验证·源码]`：探针只调 `canAdmit/observe/succeeded`，从未调用 `admitted()` 与
  `waiters()`；而官方增长分支要求**有等待者**才兑现——`succeeded` 中
  `if (this.waiters_ <= 0 || this.cap >= this.growthLimit_) return changes;`
  （`src/engine/concurrency.ts:156`，源码注释「无等待者时 streak 照累积但不兑现」:147-148）。
- 连带语义（同源码，非最终快照可见项）`[已验证·源码语义]`：streak 仍逐次累积且 ≥4 后把
  `lastGood` 设为当前 cap（concurrency.ts:152-155）——该中间值随后被 429 清掉，不在最终快照中。
- **「有等待者时 cap +1」的增长分支未被本探针触发 → 该行为在本探针中 `[未知]`**（探针构造所限，
  非引擎缺陷）。

### 4.3 三连 429（Retry-After=1200ms）缩容曲线

- **实测缩容曲线：`[6, 6, 6]`**（每次 `throttled()` 后的 cap 快照，逐字）
  `[已验证·JSON]`。
- 展开 `[已验证·源码语义 + JSON 一致]`：
  - 第 1 次 429（now=0，epoch=0 匹配）：走「按系数减」档——`cap = max(FLOOR, floor(8×0.75)) = 6`，
    记 `lastBad = 8`、清 `lastGood`、`epoch += 1`、`cooldownUntil = max(0, 0+1200) = 1200`
    （concurrency.ts:196-199,201,187-189）；
  - 第 2、3 次 429（探针传入的 epoch 实参仍为旧值 0，控制器已是 1）：**旧 epoch 的 429 不评价
    cap**——`if (epoch !== this.epoch) return changes;`（concurrency.ts:190）只清 streak、刷新
    `lastThrottledAt` 并顺延 cooldown（1201、1202）——cap 维持 6，故曲线 `[6,6,6]`；
  - 该「一次裁决、后续吸收」行为与逆向报告 §1.3「epoch 批次阻尼」逐字吻合。
- 注：探针源码自称 "three throttled completions of current-epoch requests"
  （official-telemetry-probe.mjs:170-171），但实参传法使第 2、3 次落在翻页后的旧 epoch——以上展开
  以官方源码语义与实测快照（`lastThrottledAt: 2`、`cooldownUntil: 1202`）为准 `[已验证·源码+JSON]`。

### 4.4 冷却期准入阻断

- **实测：`cooldownBlockedAdmissionDuringWindow: true`**——Retry-After 窗口内（now=2 <
  cooldownUntil=1202）`canAdmit()` 返回 `false` `[已验证·JSON]`；闸门定义
  `inFlight < cap && now >= cooldownUntil`（concurrency.ts:119-123）`[已验证·源码]`。

### 4.5 恢复轨迹与最终 snapshot

- 恢复段：虚拟时钟 +1300ms（越过冷却）、epoch 翻到 1 后连续 **20 次成功**——
  **cap 恒 6，`recoveryCaps: [6]`（去重后）** `[已验证·JSON]`；不增长的原因同 §4.2（零等待者，
  concurrency.ts:156）`[已验证·源码]`。
- **最终 snapshot**（探针 JSON `aimd.finalSnapshot` 逐字）`[已验证·JSON]`：

```json
{ "key": "prov/model", "initial": 8, "growthLimit": 32, "cap": 6, "epoch": 1,
  "inFlight": 0, "waiters": 0, "successStreak": 20, "cooldownUntil": 1202,
  "lastGood": 6, "lastBad": 8, "lastThrottledAt": 2 }
```

- 语义读法 `[已验证·源码+JSON 互相印证]`：`successStreak: 20` = 恢复期 20 次当前 epoch 成功
  全部计入（429 清零后重累计）；`lastGood: 6` = 恢复期 streak≥4 时由**完成的 streak** 设定
  （concurrency.ts:155）；`lastBad: 8` = 缩容前 cap；`lastThrottledAt: 2` / `cooldownUntil: 1202`
  = 最后一次 429 时刻及其 Retry-After 窗口；`epoch: 1` = 一次限流裁决翻页。

---

## 5. 编译 / 降级开销（Probe C：12 个官方 fixtures）

对官方包 `tests/workflows/` 全部 12 个 `.ts` fixtures（排序后），每脚本 1 次 cold
（完整 TS program + 虚拟 CompilerHost）+ 10 次 warm + 1 次 lowering（仅对干净脚本）。
`[已验证]` 全表数值逐字取自探针 JSON `compile.fixtures`：

| fixture | diagnostics | coldMs | warmMeanMs | warmP95Ms | lowerMs |
|---|---|---|---|---|---|
| actor-names.ts | 0 | 167.747 | 48.410 | 57.594 | 70.185 |
| artifact-typo.ts | 1 | 44.689 | 39.365 | 42.471 | null |
| es-lib-globals.ts | 0 | 64.198 | 48.792 | 51.479 | 59.584 |
| facade-misuse.ts | 2 | 42.812 | 35.415 | 40.385 | null |
| files-no-write.ts | 1 | 34.091 | 33.172 | 36.050 | null |
| git-log-vs-log.ts | 0 | 72.665 | 61.333 | 64.907 | 78.386 |
| glob-fanout.ts | 0 | 71.580 | 62.102 | 66.003 | 66.207 |
| lean-prover-loop.ts | 0 | 71.608 | 66.665 | 75.957 | 85.225 |
| phase-markers.ts | 0 | 61.756 | 62.148 | 68.028 | 71.771 |
| planner-reviewer.ts | 0 | 73.485 | 69.841 | 74.706 | 99.119 |
| purity-ambient-apis.ts | 4 | 67.795 | 62.948 | 67.465 | null |
| two-errors-one-line.ts | 2 | 60.107 | 66.786 | 76.712 | null |

- 范围汇总 `[已验证·算术]`：cold **34.091 ~ 167.747ms**；warm 均值 **33.172 ~ 69.841ms**；
  warm p95 **36.050 ~ 76.712ms**；7 个零诊断脚本全部完成 lowering（**59.584 ~ 99.119ms**），
  5 个带诊断脚本**全部拒绝 lowering**（`lowerMs: null`，与「脏脚本不得降级」的纯度契约一致）。
- **指标口径注记** `[已验证·源码]`：`warmP95Ms` 的探针实现（official-telemetry-probe.mjs:217）取的是
  10 个 warm 样本排序后第 5 个，统计上更接近下中位数而非严格 P95——本文照实引用字段名与数值，
  口径以探针实现为准。
- warm ≈ cold（同一量级）`[已验证·数值]` → 每次编译都是全新 TS program、无跨调用编译缓存
  `[推断]`（推断链：若存在显著温缓存，warm 应显著低于 cold，实测未观察到）。
- 与逆向报告 §2.1 管线的对应 `[推断·结构印证]`：cold 主开销来自完整 TS program 装载与诊断收集
  （createWorkflowProgram → collectDiagnostics → collectSites → analyze → synthesizeAskSchemas），
  lowering 是其后独立一段（两趟 transform/transpile），故干净脚本 lowerMs 与 compile 量级相近
  且独立计费。

---

## 5A. Schema 合成与运行时校验开销（Probe D，Issue #89 增补）

> 蓝图 B.md §4.3 点名指标「从 TS 泛型提取到运行时 JSON 校验的平均耗时与内存峰值」——原探针未覆盖，
> 本节为补测。数据源：升级后探针的 `schema` 块（预热一遍 + 正式一遍，正式遍逐字转写）
> `[已验证·JSON]`；命令同 §1。

### 5A.1 测量构造

`[已验证·源码 official-telemetry-probe.mjs:264-281]`：双 typed-ask 脚本（planner.ask
`{steps: string[]; risk: "low"|"medium"|"high"; meta?: {owner: string}}`；reviewer.ask
`{pass: boolean; findings: Array<{path: string; line: number; severity: string}>; note?: string}`），
含嵌套对象 / 数组 / 字面量联合 / 可选属性四类形状。两阶段：

1. **提取**：`synthesizeWorkflowSchemas(script)`（官方 dist 导出）——冷 1 次 + 温 20 次；
2. **运行时校验**：取第二个 ask 的合成 schema（358 字节），`validate(schema, value)` 各 500 次，
   合规与违规两路负载（违规 = 首属性类型错 + 数组成员双错，实测产出 **4 条 violation**）。

### 5A.2 实测数据

| 指标 | 值 | 档位 |
|---|---|---|
| 提取冷（含 TS program 构建） | **50.643 ms** | `[已验证·JSON]` |
| 提取温均值 / p95（20 次） | **48.675 / 51.066 ms** | `[已验证·JSON]` |
| 提取期间 heapUsed 增量 | **+27.117 MB** | `[已验证·JSON]` |
| `validate()` 合规负载：mean / p95 | **18.55 µs / 13.9 µs** | `[已验证·JSON]` |
| `validate()` 违规负载：mean / p95 | **8.04 µs / 6.6 µs** | `[已验证·JSON]` |
| 违规负载 violation 数 | **4**（fail-fast，schema 遍历更浅） | `[已验证·JSON]` |
| 500 次校验期间 heapUsed 增量 | **−137.727 MB（负值）** | `[已验证·JSON·口径不可靠]` |

### 5A.3 读法与限制

- **提取 ≈ 一次全量编译的量级**：`synthesizeWorkflowSchemas` 内部自建 TS program，48.7ms 温均值与
  §5 fixtures 温编译区间（30–70ms）同量级——「一次编译喂全链」（compileOnce）架构下提取成本已含在
  编译里，不额外叠加 `[推断]`（推断链：温均值区间重合 + 导出面为纯函数无缓存）。
- **运行时校验可忽略不计**：单次 6–19µs，相对最短 ask 占用（15.4ms，§3.4）约 **1/1000 量级**
  `[已验证·算术]`。合规均值 > 违规均值：违规在首层属性即短路、遍历深度更浅，且合规负载本体更大
  （2 findings + note）`[推断]`。
- **校验不产生可测的堆驻留**：500 次迭代 heap 增量为**负**（GC 在基准期内回收了先前分配）——该
  口径受 GC 干扰不可靠，如实标注；可确认的上界是「校验器无随调用次数增长的累积驻留」`[推断]`
  （负增量 + violation 数组短生命周期）。
- **max 异常值**：合规路 max 5788µs 为首调用 JIT 编译尖峰（单次，不影响 p95=13.9µs）
  `[推断·成因]`（实测仅 1 个样本超 100µs `[已验证·JSON]`）。

## 6. 与逆向报告 v2 的交叉印证（ZCODE-DEEP-REVERSE-v2.md §1.3 / §1.6 / §2）


逆向报告路径：`WT/docs/research/ZCODE-DEEP-REVERSE-v2.md`。下表逐条对照实测：

| 逆向报告主张 | 实测印证 | 档位 |
|---|---|---|
| §1.3 五参矩阵：0.75 / 1 / 4 / 1 / 300000ms（concurrency.ts:25/27/33/35/37） | 探针从官方 dist 运行时导出读出**同五个值**（§4.1 表） | `[已验证]` 双方独立一致 |
| §1.3 限流两档：`cap>lastGood` 退回 lastGood；否则 `max(FLOOR, floor(cap×0.75))` 并清 lastGood、记 lastBad | 实测 8→6 走系数减档，最终快照 `lastBad:8`、`lastGood` 被清后由恢复期重设为 6（§4.3/§4.5） | `[已验证]` |
| §1.3 epoch 阻尼：旧 epoch 的 429 只清 streak、刷新 cooldown，不动 cap | 实测缩容曲线 `[6,6,6]`：仅第 1 次裁决动 cap，第 2、3 次吸收（§4.3） | `[已验证]` |
| §1.3 `cooldownUntil = max(旧, now+retryAfterMs)`；冷却内 canAdmit=false | 实测 `cooldownUntil:1202` = 最后一次 429(now=2)+1200；窗口内准入被阻断 `true`（§4.4） | `[已验证]` |
| §1.3 增长需「有等待者且 cap<growthLimit」；无等待者 streak 照累积但不兑现 | 实测 24+20 次成功零增长、`successStreak:20` 照累积（§4.2/§4.5） | `[已验证]` |
| §1.3 空闲重置 `IDLE_RESET_MS=300000`、lastRequestAt 保留 | 五参实测读到 300000；重置路径本身未被触发（探针时间跨度 1302ms ≪ 300s）→ 行为 `[未知]`（本探针未覆盖） | `[已验证·参数]` / `[未知·行为]` |
| §1.6 单一漏斗：record = appendEvent + driver.emit 同一对象（engine.ts:688-692） | emit 流 36 条与场景结构一致；journal 读回失败根因是探针查询参数而非漏斗断裂（§3.3 复现实验） | `[已验证]` |
| §1.6 27 种 RunEvent 全集 | 实测 emit 流出现其中 9 类 36 条，全部在清单内；`run-launched` 缺席与 launch 元数据缺席的源码语义一致（§3.2） | `[已验证]` |
| §1.6 `usage-updated` 与 `dwf_run.spent_tokens` 同一同步步骤 | 6 次 askStats → 6 条 usage-updated，计数严格相等（§3.2） | `[已验证·计数]` |
| §1.6 report「有行无节点」、一次写 | 实测 `report` 事件 1 条、`instanceTimings` 中 report#1 无 queued/dispatched/settled 三态（§3.4） | `[已验证·计数]` |
| §1.6 `run-settled` 必须是事件流最后一条 | 修复后 journal 全序列 36 条读回，`run-settled` 恰为最后一条（§3.3 增补） | `[已验证·JSON]`（Issue #89 起升格） |
| §2.1 编译管线五段 + lowering 独立一段 | §5 开销结构与量级吻合（冷/温/降级三段计费、脏脚本拒降级） | `[推断·结构印证]` |
| §2.2 探针记录 typescript@5.9.3 同配置 | 本机官方包 node_modules 实测 typescript 5.9.3（§1） | `[已验证]` |

---

## 7. Ground Truth 结论与限制

### 7.1 结论

1. **官方引擎本机实跑功能正常**：planner→fanout(4)→verifier→report→complete 全程 87.988ms、
   36 事件、6 ask 全部结算、run `completed`、driver 结算即 dispose `[已验证]`。
2. **引擎自身开销极小**：first-ask 派发 1.093ms；6 个 ask 的排队等待 ≤ 0.266ms；occupancy 对
   模拟时延的开销 +5.1 ~ +12.4ms（含 Node 定时器粒度）`[已验证]`。
3. **AIMD 控制器行为与源码/逆向报告逐条一致**：五参实测吻合；一次 429 裁决 8→6、后续旧 epoch
   429 被吸收（缩容曲线 `[6,6,6]`）；Retry-After 冷却阻断准入；恢复期 streak 累积、lastGood=6、
   lastBad=8 `[已验证]`。
4. **编译/降级成本有界**：12 个官方 fixtures cold ≤ 167.747ms、warm 均值 ≤ 69.841ms、lowering
   ≤ 99.119ms；5 个带诊断脚本全部拒绝 lowering `[已验证]`。
5. **官方套件质量**：2034 测试首跑 2030 通过，4 项失败全部环境性，定向重跑 131/131，
   无引擎缺陷 `[已验证·来源=任务指令]`。
6. **数据可复现**：重跑 §1 的探针命令即可再生同结构数据；本文所有数值为单机单跑样本，绝对值
   随机器/负载浮动，量级与结构稳定 `[推断]`。

### 7.2 限制（逐条如实）

1. **单机单跑**：Windows / Node v26.13.0 单机样本。两次探针间的实测方差示例 `[已验证·两次对照]`：
   `wallMs` 86.726 → 87.988；`firstAskAfterRunStartMs` 2.265 → 1.093；actor-names coldMs
   169.722 → 167.747。定性结果（事件计数、AIMD 曲线、lowering 拒绝模式）两次完全一致。
2. **AIMD 用虚拟时钟**：`canAdmit`/cooldown 均对探针注入的合成 `now` 求值，无真实 1200ms 等待；
   真实定时器/真实 429 响应头语义未覆盖 `[已验证·探针构造]`。
3. **AIMD 零需求构造**：探针未调用 `admitted()`/`waiters()`，「有等待者时 cap+1」增长分支与
   空闲重置行为在本探针中未触发 → **`[未知]`**（§4.2/§4.5）。
4. **in-process、无真实 IPC**：driver 为内存桩（setTimeout 模拟模型时延），无子进程、无真实
   模型调用、无 SQLite journal 侧——真实端到端时延不适用本文数字 `[已验证·探针构造]`。
5. **探针采集缺口（根因均已定位，`[已验证·复现/源码]`）**：
   - ~~journal 逐条事件序列：`limit:"all"` → NaN 空页（§3.3）~~ **已修复（Issue #89）**：`limit`
     改传数字后 36 条全序列读回（§3.3 增补），`run-settled` 收口不变式随之印证；
   - Schema 校验开销（蓝图 §4.3 点名）：**已补测（Issue #89，§5A）**——提取 48.7ms 温均值 /
     +27.1MB 堆增量，运行时校验 6–19µs/次；
   - settled 载荷产物值：键名 `result` ≠ 官方 `artifact`（§3.5）——探针载荷键名缺陷，仍 `[未知]`；
   - phase-entered 名称：键名 `phaseName` ≠ 官方 `name`（§3.2，名称另有探针源码旁证）；
   - `node-settled` 的 outcome 逐条分布：探针 JSON 未导出 → `[未知]`。
6. **套件指纹未在本撰写会话重跑**：§2 数值来源为任务指令给出的前序实跑记录，本文照实标注出处
   而非冒称本轮复跑 `[已验证·来源=任务指令]`。
