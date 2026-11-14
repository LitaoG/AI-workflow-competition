# ZCODE 深度逆向机制报告 v2（ZCODE-DEEP-REVERSE-v2）

> **文档属性**：MISSION-B 阶段一交付物（Deliverable 1）——REA（Reverse Engineer Anything）证据驱动源码级逆向。
> **逆向对象**：`C:\Users\86183\Desktop\AI-workflow-research\ZCode\apps\zcode-cli\packages\`（dynamic-workflow / dynamic-workflow-runtime / adapters / bootstrap / shared）。
> **执行环境**：Windows 10 x64 ｜ Node `v26.13.0` ｜ 逆向日期 2026-11-03。
> **证据纪律**：全部行号出自本轮实际精读；标注 `[已验证]` 的结论均经主代理或探针复现；`[推断]` 给出推断链；`[未知]` 如实标注。
> **主代理抽查复核记录**：对四份子报告共抽 14 项关键主张逐条复核（AIMD 五参、REPAIR/NUDGE、`types:[]`、`__host`、HOLE_PROMPT=4000、SETTLE_EVENT_TYPES、FACADE_SITING_CODE=9001、运行期禁令、WORLD_READ_REGISTRY、appendEvent 单语句、孤儿收敛、WAL pragma、dwf_run DDL、checkpoint 零命中），**14/14 全部命中**。另对我方 `src/dwf/` 侧 4 项主张（takeFromPool 内容哈希、governor AIMD 默认参、`worldread#` 命名、sha256 哈希）复核 **4/4 命中**。
> v1 报告（`docs/research/workflow-reverse-engineering.md`、`WORKFLOW-GAP-MATRIX.md`）为静态扫描级；本 v2 为**逐文件精读 + 实跑验证**级，取代 v1 中与本文件冲突的结论。

---

## 0. 执行摘要与四项前提修正

**引擎总体特征** `[已验证]`：官方引擎核心是**纯确定性状态机**——零 I/O、不读时钟、不用随机数（`engine/engine.ts:2-5`）；时间一律参数注入（`engine/concurrency.ts:4-6`）；所有副作用经 `WorkflowDriver` 端口（`engine/types.ts:312-355`）；所有事实落 journal 事件流。文件按 oxlint 400 行上限拆分，`engine.ts` 只留薄委托。

相对任务蓝图（B.md §3.2）的原始假设，本轮逆向以 grep + 探针实证作出**四项前提修正**（这些修正直接决定阶段三的对齐方向）：

| # | B.md 原假设 | 实证结论 | 证据 |
|---|---|---|---|
| C1 | 「AST 901x 规则封禁 process/eval/Function/require/fetch/Buffer/setTimeout/globalThis」 | **901x（9001–9012 连续 12 码）是 facade 站点授权与编译期封闭集合规则，没有一条以标识符黑名单为封禁对象**。宿主 API 由 `types:[]` 在类型层挡下（process/require/Buffer→TS2591；fetch/setTimeout→TS2304 `[已验证]` 探针）；运行期禁令在 vm cell BOOTSTRAP（Date.now/Math.random/argless new Date）；`eval` 不仅不禁，反而是 hole 降级刻意生成的求值器（`lowering/lower-hole.ts:46-55`）；`globalThis`/`eval`/`Function` 是 ES intrinsic，编译干净通过 | `analysis/facade-misuse.ts:20` 起全部 12 码定义处；`compiler/compile.ts:56-59` 注释；`runtime/child-source.ts:282-302` |
| C2 | 「基于 ts.TypeChecker 动态合成运行时 Zod Schema」 | **包内无 Zod 依赖**（package.json 唯一 dependency 是 typescript）。合成目标是自有 **JSON Schema 子集**（`schema/types.ts:31-62`），运行校验由**纯手写校验器**完成（`schema/validate.ts:12-16`） | `schema/synthesize.ts`、`schema/emit.ts`、package.json |
| C3 | 「Data Events（NDJSON + SQLite）双持久化」 | **NDJSON 只是沙箱子进程 ↔ harness 的 stdio 线协议**（Boundary A，run 结束即消亡），不是持久化格式；durable 轨是**单库四表**（dwf_run/dwf_actor/dwf_node/dwf_event）事件溯源；仓内唯一 JSONL 文件是 model-io 调试日志 | `runtime/protocol.ts:1-17` 文件头；`adapters/src/storage/session-store/schema.baseline.sql:1-70`；grep 证据见 §3.5 |
| C4 | 「SQLite WAL Checkpoint 机制」 | **代码中不存在任何显式 checkpoint**（全 packages 树 grep `wal_checkpoint|checkpoint()` 零命中），`synchronous` 亦无设置；只有启动时 `pragma journal_mode=wal` + `foreign_keys=on`，checkpoint 交给 SQLite 默认 auto-checkpoint | `adapters/src/storage/session-store/migration-runner.ts:86-96`；grep 零命中 |

**机制覆盖度**：执行内核 7 组机制（§1）、编译/降级/沙箱 5 组（§2）、存储/协议 5 组（§3）全部完成逐文件精读；§4 给出与我方 `src/dwf/` 的缺口对齐矩阵（19 行）与 14 条语义漂移点；§5 列出阶段三靶向优化清单（P0×3 / P1×5 / 刻意分歧保留项）。

---

## 1. 执行内核子系统（Engine Core）

代码根：`apps/zcode-cli/packages/dynamic-workflow/src/engine/`。

### 1.1 Settle-Order 确定性事件门（replay-order.ts）

**问题** `[已验证]`：站点序号 ordinal 是**调用到达时**的计数器（`engine.ts:660-668`），扇出分支在 `await` 之后的每次 journal 调用按**完成顺序（墙钟）**编号——resume 重放时 `Promise.all` 按数组顺序跑续体，join 后第一条 `report` 会拿到「最先跑完那条分支」的序号，run 死在防御性校验 `InputHashMismatch`。文件头记录实盘事故：`replay-order.ts:8-9`「2026-09-17 实盘：五路并行调研，完成顺序 1、4、2、5、3，resume 在 report#2@2 上炸」。

**解法**：resume 重放的不仅是答案，更是**调度**——闸门持有首生（first-born）结算次序表，命中缓存的结算在释放点挂起，直到它前面每一条都已释放；表外实例直接放行（对旧 journal 退化为原行为，不会锁死一无所知的 run）（`replay-order.ts:11-14`）。

**次序表来源**：排序键 = 实例键 `siteId@ordinal`（`refToString`，`types.ts:53-55`）；**事实来源是事件本身**——结算次序逐条记在 `dwf_event` 里、与 journal 行同一次写入落库，零 schema 迁移（`replay-order.ts:159-165`）。只看三类结算事件（`replay-order.ts:30-34` `[已验证]`）：

```ts
const SETTLE_EVENT_TYPES: readonly RunEventType[] = [
  "node-settled", "artifact-published", "artifact-failed",
];
```

恢复算法 `recoverSettleOrder`（`replay-order.ts:173-199`）：① 由节点行构造 claimable 集合（`status ∈ {completed, failed}` 且 `claimsOnReplay(node)` 为真，`:179-184`）；② 按 sequence 升序遍历三类结算事件，只收**每个实例首次**结算那条（seen 去重 `:194`）且 `key ∈ claimable`；③ 得到有序 key 数组。「取首次」保证跨世稳定：重放世会按闸门释放次序再发一遍 cached 事件，第三世恢复出的仍是同一张表（`:166-168`）。

`claimsOnReplay`（`:218-224`）：report 恒 false（void 不认领）；非 artifact 全 true；artifact 失败行 true；成功行只有内容成员（非 preset op）认领。

**闸门状态机** `ReplaySettleOrder`（`:51-157`）：`position`（键→位次）、`cursor`（只前进）、`parked`（已到达等位次）、`queue`（已轮到排微任务 FIFO）、`flushing`、`opened`。

- 挂起判定 `hold`（`:83-92`）：`opened || at === undefined || at < cursor` → 立即放行；否则 `parked.set(key, release)`。
- 游标推进 `pump`（`:146-156`）：`while (cursor < order.length)` 队首已到达即出队 `cursor++`；**cursor 严格单调递增**——任何实例的释放不早于首生次序表中的全部前驱。
- **微任务一跳**（`:94-107`，最易漏掉的细节）：释放动作不直接执行，`queueMicrotask(flush)`。少了这一跳，`Promise.all` 各分支在同一同步片发起调用，队首的释放会在它自己的 `ask()` 里同步发生——那时它的 await 还没挂上，续体反而排在后面。这一跳让所有 await 先挂稳，**投递次序严格等于释放次序**。「这不是时钟：跳的是确定的一步。」
- 终态兜底 `open()`（`:124-143`）：run 结算前调用（`engine.ts:219-225` 接缝），同步放完已排队批次，再放完 cursor 之后所有 parked，兜底清 leftovers——「绝不留下没人兑现的 promise」。

**消费点**：ask 命中 `scheduler.ts:383-385`；world-read 命中 `engine-world.ts:53-70`；内容产物命中 `engine-artifacts.ts:114-127`；预置产物声明不走闸（同步 void，`engine-artifacts.ts:111-113`）。非 resume 时闸为空（`engine.ts:141-144`）。

### 1.2 Per-Actor FIFO 隔离调度（scheduler.ts）

调度器只管 ask 生命周期（`scheduler.ts:2-4`）。核心保证：同一 actor 串行（至多一个 `current`）、准入严格按 actorSeq 升序、live 并发受 run 级上界约束、跨 actor 完成次序由 §1.1 闸兜底。

**Actor 运行态**（`scheduler-types.ts:106-131`）：`recordedCount`（journal 已记录 ask 行数）、`nextAdmitSeq`、`pendingRecorded: Map<seq, release>`、`pendingLive: release[]`、`liveQueue: AskNode[]`、`current?`、`imported?`。`caps` 是 **getter**——「每次派发前现读」，因为 `setMaxConcurrency` 会整份换掉 caps（`scheduler-types.ts:46-51`）。

**准入三分支** `admitAsk`（`scheduler.ts:128-182`）：① journal 命中 `running`（崩溃于执行中）→ 按记录 actorSeq 挂 `pendingRecorded` 重新 live 派发（`:151-157`）；② 命中 completed/failed → 短路结算同样经 `pendingRecorded` 排队（`:158-165`）；③ fresh → push `pendingLive`，准入时 `seq = nextAdmitSeq++`，先问导入缓存再 live（`:170-178`）。命中时防御性校验 inputHash，不一致即 `hashMismatch`（`hash-mismatch.ts:11-20`）→ failRun **大声失败**。

**排空泵** `drainAdmission`（`scheduler.ts:357-376`）——防乱序核心 `[已验证]`：

```ts
while (progressed) {
  const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
  if (release !== undefined) { // ① 记录节点严格按 actorSeq 升序放行
    actor.pendingRecorded.delete(actor.nextAdmitSeq);
    actor.nextAdmitSeq++; release(); progressed = true; continue;
  }
  if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
    actor.pendingLive.shift()!(); // ② 记录节点全部排空后 fresh 才准入
    progressed = true;
  }
}
```

**派发** `pumpActor`（`:408-417`）四前置：未结算、`actor.current === undefined`、队列非空、`activeAsks < caps.maxConcurrency`（现读）。结算：`settleOk`/`settleFailed`（`:496-515`，失败**必须**落 journal——重放正确性硬性要求）→ `finishLiveNode` 清 current、`activeAsks--`、`pumpAll()`（`:404-406`，引擎抬高上界后唯一重扫触发点）。

**Submit/Nudge 预算**（`scheduler-submit.ts`）：`node.settled` first-wins（`:29,:96`）；typed ask 校验经 `normalizeSubmit` 宽松归一（`:70-92`，string 单次 JSON.parse 后违规回传 `after` 路径级违规）；通过→`accept`；违规且 `repairsRemaining > 0` → `node-repairing`；预算尽 → `cancelAsk`+`settleFailed(ValidationFailed)`。untyped turn 结束→直接 settle；typed 未提交且 `nudgesRemaining > 0` → `node-nudged`；否则 `settleFailed(ResultNotSubmitted)`。常量：`REPAIR_ATTEMPTS = 3`（`types.ts:1065` `[已验证]`）、`NUDGE_ATTEMPTS = 1`（`types.ts:1068` `[已验证]`）。

### 1.3 AIMD 动态流控五参矩阵（concurrency.ts）

`ConcurrencyController` 是**一个 provider key（`${providerId}/${modelId}`）上的纯 AIMD 状态机**（`concurrency.ts:80-82`）；度量单位是**模型请求**（每一次尝试），inFlight = 已准入未释放——「一个子代理同时只有一个请求在飞，『≤ N 个请求』与『≤ N 个子代理在跑』等价」（`:8-9`）。

**五参矩阵**（`[已验证]` 主代理逐行复核）：

| 常量 | 值 | 行号 | 语义 |
|---|---|---|---|
| `CONCURRENCY_DECREASE_FACTOR` | **0.75** | `concurrency.ts:25` | 乘法递减：`cap = max(FLOOR, floor(cap×0.75))`（0.5→0.75：减半对「只多了一两个」的越界反应过猛，`:21-24`） |
| `CONCURRENCY_INCREASE_STEP` | **1** | `:27` | 加法递增步长 |
| `CONCURRENCY_INCREASE_AFTER_SUCCESSES` | **4** | `:33` | 每 +1 需连续成功 K 次（40→4：探测失败只亏一个请求撞一次 429，`:28-32`） |
| `CONCURRENCY_FLOOR` | **1** | `:35` | 永远至少一个探针 |
| `CONCURRENCY_IDLE_RESET_MS` | **300 000**（5 分钟） | `:37` | 空闲（且无在飞）后遗忘学到的 cap 回起点 |

**epoch 批次阻尼**（`:11-14`）：每次准入记 epoch，每次限流裁决 `epoch += 1`；一个 429 只在它发出时的 cap 与当前 cap 同 epoch 时才评价当前 cap——旧 epoch 的 429 只清 streak、刷新 cooldown，不动 cap（`:184-190`）。

**信号行为**：
- 准入 `canAdmit`（`:119-123`）：`inFlight < cap && now >= cooldownUntil`（纯查询；空闲重置由调用方先 `observe`）。
- 成功 `succeeded`（`:148-162`）：streak≥4 → `lastGood = max(lastGood, cap)`（**只有完成的 streak 能设 lastGood**）→ 有等待者且 `cap < growthLimit` 才 `cap+1` 并发 `recovered` 事件。
- 限流 `throttled`（`:175-207`）两档：① `cap > lastGood`（在已证明水位之上探测）→ `cap = lastGood` 不按系数减；② 否则 `cap = max(FLOOR, floor(cap×0.75))` 且 `lastGood = undefined`。带 Retry-After → `cooldownUntil = max(旧, now+retryAfterMs)`。**翻 epoch 即便数值没变**（同一批请求只能触发一次裁决）。
- 瞬态失败 `failedTransient`（`:210-215`）：清 streak，**cap 不动**。
- 上限挪动 `setGrowthLimit`（`:240-251`）：抬高不立刻改（一级一级爬）；压低到 cap 之下当场夹断并发 `limit_lowered`。
- 起跳 `seed`（`:264-282`）：用户调高上界时 cap 直接 `min(target, growthLimit)`——「从 8 爬到 32 要约 96 次成功」；两种情况不跳：目标不高于 cap；`IDLE_RESET_MS` 窗口内有过任何拒绝（`lastThrottledAt`）。
- 空闲重置 `idleReset`（`:290-319`）：`now−lastRequestAt ≥ 300s && inFlight===0` → 全状态回起点，`epoch += 1`，发 `idle_reset`；幂等。

限流原因集：`"rate_limited" | "provider_overloaded" | "offpeak_queued"`（`:40-43`）；上限 `growthLimit` 由治理器按 `max(2D, 用过此 key 的在飞 run 最大上界)` 给出（`:84-86`）。

### 1.4 Hole Parking 挂起协议（engine-holes.ts）

**本质** `[已验证]`：留白 = 脚本向主代理要一段代码，run 停在该处等它。与 ask 的根本区别：**没有 journal 行**（`:5-8`）——补全产出的东西已以有效脚本身份写在 run 行上（`updateRunScript`），resume 重放有效脚本时 hole 体**内联执行**、`hole-reached` 不再出现。挂起状态纯内存、随引擎实例而生，resume 从空表起（`:90`）。

**快照内容** `ParkedHole`（`:76-82`）：`instance`（siteId@ordinal）、`name`、`since`（epoch ms）、`resolve({code})`、`reject(WorkflowError)`。外层 `HoleRegistry` 持两表：`parked: Map<siteId, ParkedHole[]>`（一站点多序号）、`filled: Map<siteId, RememberedFill>`（本世已补全直接作答不停驻）（`:92-95`）。

**park 时序** `reachHole`（`:174-194`）：**先停驻再记事件**（`:170-172` 有意排序——事件经 `driver.emit` 同步扇出，emit 里同步补全的监听者必须命中停驻表）。prompt 截断 `HOLE_PROMPT_MAX_CHARS = 4000`（`:22` `[已验证]`）。

**fill 同步五步**（`:201-226`）：① settled/not_waiting 短路（no-op 不写不发）→ ② `swapTables(askSpecs, sitePhases)` 整份换表 → ③ `journal.updateRunScript(text, hash)` **有效脚本与哈希同笔写 run 行**（两列同一 UPDATE，journal 端 `types.ts:997-1004`）→ ④ 记 `hole-filled` 事件（载荷 `types.ts:709-723`：siteId/filledAt/filledBy?/phaseNames/holes?/scriptPath?）→ ⑤ `holes.release(siteId, code, …)`：记忆 + `parked.delete` + 对该站**每一个** parked entry resolve（`:124-129`）。run 结算时 `rejectAll`（`:132-136`）。

**持久化三载体**：有效脚本写回 run 行（同笔两列）；`hole-filled` 事件；规格/阶段表整份换。resume：未补全→重跑到同一站点重新 park；已补全→内联执行根本不走到 `hole()`。

### 1.5 Amend 温缓存导入与发散判定（imported-cache.ts）

**结构**：`ImportedRunCache` 纯数据，由 run service 读前驱 journal 构建；**不是真相源——每次命中都落一行真 `dwf_node`**，丢了可从 `resumed_from` 重建（`imported-cache-types.ts:80-91`）。缓存键：actor 侧 = 有效名；world 侧 = `inputHash({op,args})`。

**哈希**：FNV-1a 32 位作用在规范化 JSON（键按 code point 排序、跳 undefined；`hash.ts:12-31, 48-50`；basis `0x811c9dc5`、prime `0x01000193`）。各路径哈希覆盖面：ask=`inputHash(instructions)`（`scheduler.ts:132`）；world=`inputHash({op,args})`（`engine-world.ts:38`）；report=`inputHash(item)`（**标签不进哈希**，`engine-report.ts:50`）；内容产物=`inputHash({args,id,op})`（`engine-artifacts.ts:102`）。

**命中/发散算法**（消费态三字段 `consumed/diverged/carriedSeq`，`:32-39`）：

```ts
take(seq, hash) {                       // :52-61
  if (this.diverged) return undefined;  // 分歧单调：永不回头（:29-30）
  const entry = this.candidate.entries[seq];
  if (entry === undefined || entry.inputHash !== hash) {
    this.diverge(seq, hash, true); return undefined;
  }
  this.consumed = seq + 1; return entry;
}
```

两种不命中同等处理（哈希不符 / seq 越界=新 ask）；**分歧级联免费且动态**——上游转 live 拿新结果，下游插值出的指令哈希必变，自动分歧无需显式传播（`:48-50`）。关门后问法 `takeIfPure`（`:71-80`）：只有纯条目（前驱 `stats.worldToolCalls === 0`）可命中——纯 ask 只依赖指令与转录前缀；缺 stats 的老条目保守按「碰过」处理。

**续跑旁路** `diverge`（`:169-181`）：恰好是前缀之后那条在飞 ask 且哈希相符（五条件：未分歧、`seq === entries.length`、`consumed === seq`、哈希相符、缓存开着）→ `carriedSeq = seq` 续跑而非分歧——导入的是**它已跑出的半场转录**（`imported-cache-types.ts:33-41`）。

**崩溃后精确重推** `reconcileRecorded`（`:116-138`）：分歧状态不落库，逐 seq 拿记录行 inputHash 与导入条目比对重建原判定——「精确，不是保守近似」。

**会话种子** `seed`（`:151-160`）：边界取最后一条被消费条目的 `messageBoundary`（**count offset 而非 id 区间——前缀复制下不变**，是链式修订根基，`types.ts:926-934`）；续跑例外取 `inFlight.messageBoundary`。

**World 队列**（`:197-212`）：每内容哈希一个游标，同 `{op,args}` 第 n 次出现对第 n 条记录。两消费点优先级：**journal replay 永远优先**（修订 run 自己崩溃后 resume，已消费命中早已是真行）；journal 未命中且门未关才查导入；命中写 completed 行、**不调 driver**——「world-run 的效应绝不静默重放」（`engine-world.ts:77-97`）。

**关门（Import Close）**：第一笔写入之前，两触发点——driver 上报在飞子代理即将执行改写工具（PreToolUse 后、handler 前，关门先于第一个字节落盘，`types.ts:438-445`）；一条 `world.run` 要 live 执行（派发前，`engine-world.ts:100-104`）。**关门永不重开**（`engine-state.ts:97-99`）；ask 转 live 本身不关门（实盘教训：拿时钟代替依赖，50 路扇出丢 6 个命中，`scheduler.ts:241-245`）。恢复 `recoverImportClosure`（`engine-world.ts:203-223`）从本 run 自己的事件按序恢复 closed/live/queuedBeforeClose 三集合，零 schema 变更。

**Actor 候选匹配**（`:226-239`）：按有效名 + `canonicalJson(personaIdentity(spec))` 一致才收；`personaIdentity` **剔除 model**（改模型是显式选择，`persona.ts:41-45`）；匿名 actor 永不附着。

### 1.6 Journal 事件模型（27 种 RunEvent）

**唯一漏斗**（`engine.ts:688-692`）：`record(event)` = `stampBirthPhase` 补出生阶段 → `journal.appendEvent`（durable 轨）→ `driver.emit`（实时轨）——两条路线**同一个对象**（bootstrap 按引用相等核对序号）。

**全 27 事件**（`types.ts:506-803`，声明序）：`run-started` / `run-launched`（仅建 run 世紧跟首条 run-started 一次；宿主元数据零 SQL 地活在事件里）/ `actor-created` / `node-queued`（`instructionsHead`=作者指令开头 240 字符）/ `node-dispatched`（重复出生事实）/ `node-repairing` / `node-nudged` / `node-waiting`（`AskWaitInfo{cause:"slot"|"backoff",…}`，纯观察不写 dwf_node）/ `node-executing`（纯观察）/ `concurrency-changed` / `run-caps-changed` / `node-settled`（`outcome:"ok"|"failed"|"cancelled"`；后五键只在 ask 缓存命中在场）/ `node-progress` / `usage-updated`（与 `dwf_run.spent_tokens` 同一同步步骤，永远相等）/ `log` / `import-cache-closed`（每 run 至多一条；resume 恢复「门已关」唯一事实来源）/ `phase-entered`（无站点无行，每次求值都发）/ `hole-reached`（无行）/ `hole-filled` / `report` / `artifact-published`（成功路径只发这一条）/ `artifact-failed`（刻意不复用 node-settled）/ `compaction`（v1 占位不发）/ `escalation-raised`/`escalation-resolved`（引擎核心从不发，driver 在 ask 边界内发；不写 dwf_node）/ `run-stalled` / `run-settled`（必须是事件流最后一条）。

出生阶段打戳只在五类事件（`engine-phase-stamp.ts:30-60`）：`actor-created`、`node-queued`、带 actor 的 `node-dispatched`（双戳）、`node-settled{cached:true}`（命中节点无 queued，settle 即出生事件）、`hole-reached`。

**记录词汇**：节点 kind `ask|world-read|world-run|report|artifact`（`types.ts:463`；world-run 单列为审计诚实「效应不该伪装成读」）；节点状态 `running|completed|failed`（report 是「两次写」规则唯一例外——一次写、落库即 completed）；run 状态 `pending|running|completed|errored|stopped`（逻辑词，物理列不迁移）；停止原因 `user|model|provider|interrupted|superseded`。`StoredEvent{sequence, event, timeCreated?}`——sequence 单调分配，是「事件日志里一切『多久以前』的唯一时钟」（`journal-memory.ts:184-198`、`types.ts:938-950`）。

### 1.7 结算与恢复

**三条终态路径 first-wins**（`engine-settlement.ts:7`，第一行都是 `isRunSettled()` 守卫）：
- `settleCompleted`（`:22-33`）：markSettled → abortInFlight(Cancelled, emit=true) → `finishRun("completed", {result})`（产物随终态**一笔落库**，分两笔有「completed 但产物丢失」崩溃窗口）→ resolve。
- `settleStopped`（`:41-63`）：superseded 的后继 id 与原因**同一笔**落库；已完结 journal 条目保留（可 resume）。
- `settleFailed`（`:66-72`）：abortInFlight(error, false) 不补发 cancelled。

`markSettled` 接缝（`engine.ts:219-225`）关键动作：**`replaySettleOrder.open()`**。结算袋语义（`types.ts:966-973` + `journal-memory.ts:64-91`）：失败三件套整体改写（缺席=清掉）；产物缺席=不触碰（`result: null` 合法）。

**Resume 前置门**：构造函数发现既有 run 行先比 `scriptHash`，不一致**同步抛** `ScriptHashMismatch`（带结构化 mismatch）——「拒绝而不是先接受再 failRun，后者会把 failed 盖到一份仍能用正确脚本 resume 的记录上」（`engine.ts:288-305`）。

**恢复算法** `restoreFromJournal`（`engine-resume.ts:17-44`）：工作行不带结果（只看 kind/status/坐标）、产物行带结果（32 id × 16 版上界）、**报告行一条不读**（只数条数与字节，`sum(octet_length(result_json))` 实测 1.5 GB 求和 0.7 ms）；`recoverSettleOrder`；`seedRecordedAsks` 一次建表（修复 O(actor×行)）；completed 产物行认领（版本号跨 resume 连续）；reportTally 连续。构造其余：`spentTokens` 从行恢复 → 修订 run 走 `recoverImportClosure` → `updateRunStatus("running")` 清残影 → 补发 `run-started`（仅建 run 世补 `run-launched`）→ `spentTokens > 0` 补发 `usage-updated`（投影把 run-started 当用量清零）。

**崩溃于执行中的三种节点**：ask running 行按记录 actorSeq 重新 live 派发；world running 行重新执行；artifact running 行重新发布（版本号从 completed 行数派生，不跳号）。

**就地改上界** `setMaxConcurrency`（`engine.ts:554-566`）：整份换 caps + `updateRunCaps` 落库 + `run-caps-changed` 三件事同一同步步骤；抬高多一次 `pumpAll()`；调低不召回在飞。

**结构化错误**（`errors.ts:47-82`）按拒绝通道分级：节点级（脚本可 catch）：`ValidationFailed/ResultNotSubmitted/DriverError/Cancelled/ContextLimit/WorldReadCapExceeded` + 产物内容族 7 码；run 级（failRun）：`InputHashMismatch/UnknownActor/MissingAskSpec/DuplicateActorName/ReportCapExceeded/ScriptHashMismatch/Artifact{SpecInvalid,Redeclared,Undeclared,PrimaryConflict}`；宿主级：`Interrupted`（进程亡故）、`ProviderStop`。

### 1.8 report 一次写与纯度护栏（engine-report.ts）

四步（`engine-report.ts:20-33`）：序列化探针先行（`JSON.stringify` 抓环与 bigint——canonicalJson 会静默折叠，不适合当护栏）→ replay 命中静默跳过（比对哈希只读行不读 item）→ 三上限先于落库（单条 1 MiB / 65,536 条 / run 级 1 GiB）→ 一次写 completed 行 + `report` 事件。

---

## 2. 编译、静态防护与降级层

代码根：`apps/zcode-cli/packages/dynamic-workflow/src/`；运行时沙箱在 `packages/dynamic-workflow-runtime/src/`；run 服务在 `packages/bootstrap/src/app/`。

### 2.1 管线总览

```text
作者脚本 (workflow-script.ts 文本)
  ├─ createWorkflowProgram()          compiler/compile.ts:95   ← 虚拟 CompilerHost（§2.2）
  ├─ collectDiagnostics()             compile.ts:118           ← TS 语法/语义诊断
  ├─ collectSites()                   analysis/sites.ts:301    ← 站点表（ask#N / actor#N / …）
  ├─ 诊断层 analyze.ts:73-142          ← 9001/9003-9010/9012（9002 由 schema 趟、9011 由宿主）
  ├─ synthesizeAskSchemas()           schema/synthesize.ts:55  ← T → JSON Schema（§2.5）
  └─ lowerWorkflow()                  lowering/lower.ts:139    ← __host.* 改写（§2.3）
       · 第一趟 ts.transform（打桩，按节点身份）   lower.ts:306
       · 打印 __workflowScript__ 函数体语句        lower.ts:311-315
       · 第二趟 ts.transpileModule（类型擦除）     lower.ts:319-322
     ↓ LoweredWorkflow { code, siteIds, holeBodies }
  └─ bootstrap compileOnce/compileProgram（一次编译全喂，dynamic-workflow-run-compile.ts:36,60）
     ↓ runtime harness：payload 内嵌入口文件 → spawn 子进程 → vm 独立 realm（§2.7）
```

### 2.2 虚拟 CompilerHost 纯度沙箱

**编译选项**（`compiler/compile.ts:40-60`）`[已验证]`：

```ts
const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  lib: ["lib.es2022.d.ts"],                    // :42 全局类型环境只剩 ES2022 闭包
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,                                 // noUncheckedIndexedAccess 刻意 OFF（:47-53，
  target: ts.ScriptTarget.ES2022,               //  模型语料几乎都按 off 写，开它是未定义族诊断 96% 来源）
  types: [],                                    // :59 封锁全部 ambient @types——纯度契约从编译期开始
};
```

`[已验证]` 探针（typescript@5.9.3 同配置 + es2022 闭包 55 个 lib 文件）：`process/require/Buffer` → **TS2591**；`fetch/setTimeout` → **TS2304**；`eval/Function/Date/globalThis` → **编译干净通过**（ES intrinsics / checker 内建）。

**脚本包装**（`:18-38`）：`async function __workflowScript__() { ... }` + `export {}`——镜像运行时执行形态（AsyncFunction body），顶层 await 与末尾 return 合法；`SCRIPT_PRELUDE_LENGTH` 是作者坐标系换算常数（诊断行号回写、hole 拼接都走它）。

**虚拟 Host 本体**（`:140-169`）：程序可见的每个文件都来自内存 Map（`workflow-script.ts` + `workflow-facade.d.ts` + 内嵌 TS_LIBS 闭包）——**零磁盘访问**；`fileExists` 只认 Map，任何磁盘文件（含 `@types/*`）在解析层不可见，与 `types:[]` 双重封闭。TS_LIBS 由 `scripts/generate-libs.mjs` 构建期从 `lib.es2022.d.ts` 沿 `/// <reference lib>` 传递闭包生成 `libs.generated.ts`（57 个文件，`[已验证]` generate-libs 输出）。`writeFile: () => { throw }`。TS1184（顶层 declare/export）按精确修饰符 span 改写成点名的可执行修复文案（`:177-217`）。

**两份 facade**（`facade/dts.ts:320-353`）：完整 `FACADE_DTS` 与 snippet 子集 `SNIPPET_FACADE_DTS`（减 actor/report/artifact/phase/hole 族——`agent(...)` 在 snippet 下是普通 TS2304，拒绝发生在编译期）。facade 身份=文件名 `workflow-facade.d.ts`（registry/sites/facade-misuse/lowering 多处按声明文件名判定）。

### 2.3 901x 诊断码全量清单（9001–9012，连续 12 条）

（前提修正 C1 的展开；产出管线 `analysis/analyze.ts:73-142`，`lowerWorkflowScript` 独立复验 9001+9012 于 `lowering/lower.ts:121-128`。唯一不扣图的例外是 9006——它描述运行期失败而形状可分析。）

| 码 | 常量 | 定义处 | 封禁对象（触发条件） |
|---|---|---|---|
| 9001 | `FACADE_SITING_CODE` | `facade-misuse.ts:20` `[已验证]` | facade 可调用物出现在直接调用以外：别名/方法抽取/解构抽取/作实参（pass1 引用扫描 `:110-131`）；产生站点却未 sited 的直接调用（pass2 纵深防御 `:149-163`，按 resolved signature 的 (container,member) 判定）；携带站点成员的类型被改型为不携带的类型（pass3 改型边界 `:183-224`：as/satisfies/实参→形参/return/注解绑定/赋值；evolving-any 豁免） |
| 9002 | `SCHEMA_DIAGNOSTIC_CODE` | `schema/types.ts:78` | 不可 JSON 序列化的 ask 结果 T / report item：any、never、非可选位 undefined/void、bigint、symbol、函数类型、REJECTED_BUILTINS（Date/RegExp/Map/Set/Promise/Error 族/ArrayBuffer/DataView/9 种 TypedArray 等 28 项，`emit.ts:34-65`）、class 实例、thenable、union>100（`MAX_UNION_MEMBERS=100`，`types.ts:90`） |
| 9003 | `WORLD_RUN_LITERAL_CODE` | `world-run.ts:18` | `world.run` 第一实参非无洞字符串字面量（args/opts 允许运行期值——「被钉住的是跑哪个命令，不是拿什么跑」） |
| 9004 | `PHASE_MARKER_CODE` | `phases.ts:19` | phase 名非字面量/空；调用非独立语句（标记的意义是「从这里到块尾」，表达式位置无可指范围） |
| 9005 | `DUPLICATE_ACTOR_NAME_CODE` | `actor-names.ts:43` | 两个 agent 站点静态有效名同一字面量（只漏报不误报；正门在引擎运行期 DuplicateActorName） |
| 9006 | `FANOUT_ACTOR_NAME_CODE` | `actor-names.ts:54` | 固定字面量名 + 词法落在 fan-out 体内（数组方法回调；for...of 不算）；刻意接受误报 |
| 9007 | `ARTIFACT_DECLARATION_CODE` | `artifacts.ts:37` | artifact id：非字面量/空/>64 字符/非法字符（`[A-Za-z0-9_.-]` 外）；同 id 跨成员种类；report 标签非字面量/指向内容 id/未声明预置 |
| 9008 | `ARTIFACT_HOISTING_CODE` | `artifacts.ts:48` | **预置族**（chart/table/metrics/board）声明长在 loop/callback/conditional（hole 体看穿；内容族豁免——常常就该循环里每轮发一版） |
| 9009 | `ARTIFACT_PRIMARY_CONFLICT_CODE` | `artifacts.ts:55` | 两个不同 id 的 spec 都写字面量 `primary: true`（算出来的旗子留给引擎） |
| 9010 | `MODEL_REFERENCE_CODE` | `actor-models.ts:42` | `model()` 实参非非空字面量；persona.model **类型**非 ModelRef/字符串字面量/其联合（判类型不判语法——一条规则同时覆盖 const/三目/查表；按初值表达式自型防拓宽误报）；ModelRef 出现在值位置 |
| 9011 | `MODEL_UNRESOLVED_CODE` | `actor-models.ts:49` | 模型名对宿主目录解析失败（**非本包产出**；launch 工具在确认窗前报） |
| 9012 | `HOLE_CODE` | `hole-sites.ts:24` | hole 八类：类型实参缺席；名字非字面量/空/>128；与 hole/phase 重名；FNV 撞 id；未被 await（tail 除外）；落在数组方法回调（for...of 允许）；函数体非内联字面量；体读后置非提升绑定 |

**互补防线**（非 901x）：类型层 `types:[]`（§2.2）；vm cell 运行期禁令（§2.7）。

### 2.4 lower.ts 的 `__host` 重写

输出契约（`lowering/lower.ts:51-67,71` `[已验证]`）：`HOST_BINDING = "__host"`；`LoweredWorkflow.code` 是 async 函数体，**code 里唯一自由标识符是 `__host`**——沙箱 vm 的 globals 只需 ES intrinsics + `__host`；`siteIds` 是全部打桩 site id 按源码序；schema 从不跨沙箱边界。

改写总表（`:27-48` 文件头）：`agent→__host.createActor("actor#2",…)`；`p.ask<T>(x)→__host.ask("ask#3", p, x)`（**丢弃类型实参**；可选链保留为 nullish 守卫三目，receiver 求值恰一次）；`files.glob/read→__host.worldRead("world-read#1","glob",[p])`；`report→__host.report(siteId,x,tag?)`；`artifact.file/markdown→__host.publishArtifact`、`chart/table/metrics/board→__host.declareArtifact`（实参原样按位置打包数组字面量，lowering 零校验）；`log→__host.log`；`phase("gate")→__host.enterPhase("gate")`（无站点）；`model("X")→"X"`（不过 host）；`hole→__host.hole(siteId,name,prompt,(__src)=>eval(__src),body?)`；`args/run` 值→`__host.args/__host.run`（刻意不注入 `const args`——用户再声明 args 会变运行期重复声明，编译期看不出）。

精确算法：入口 `lowerWorkflowScript`（`:116-131`）——typecheck 干净 → collectSites → 9001+9012 零诊断才降级（「脏脚本不降级」）。匹配**按节点身份**（站点表持有的 raw `ts.CallExpression` 直接作 Map 键；`log` 按 checker 签名解析识别，计算成员 `files["read"]` 也能命中）。第一趟 transform（`:147-304`）→ 只取 `__workflowScript__` 函数体语句打印（`removeComments: false`）→ `ts.transpileModule` 第二趟擦类型。

**hole 求值器**（`lower-hole.ts:34-63`）：`(__src) => eval(__src)`——**直接调用 eval** 以闭包住站点处词法绑定，补全文能读到站点之前的每个绑定（含 `__host`）；循环里的留白每次到达新造求值器。已补全的留白：改写后的函数体作第五实参传入，cell 直接调用不过线。`printHoleBodies`（`:73-88`）用同一套 TRANSPILE_OPTIONS——「主体与留白函数体必须由同一套参数产出」，活补全与日后 replay 执行**逐字节相同**的文本。

### 2.5 spliceHoleBody 洞体拼接（文本级）

`analysis/hole-splice.ts:34-58` 对**作者原文文本**操作（不是 AST 拼接），位置用站点表 AST 跨度换算回作者坐标（减 `SCRIPT_PRELUDE_LENGTH`）：

- **插入点 = 最后一个实参的末尾**（`lastArg.getEnd()`），不是右括号之前——实盘教训（2026-09-28）：prettier 习惯 `hole<T>(\n "名", \`提示\`,\n);` 的尾随逗号会让右括号前插入产生 `, , async` 四条语法错误；接实参末尾则原尾随逗号与注释都合法保留。
- 拒接条件：hole 不在站点表 / 已有函数体 / 实参列表空 → `undefined`。
- 缩进：体行 = 调用行缩进 + 2 空格；右花括号 = 调用缩进；空行保持空。
- 返回 `insertedAtLine`（首条体行 1-based 行号）与 `insertedLines`——诊断按此分「补全文件内 / 草稿内」。
- **拼接后稳定性复核** `checkSiteStability`（`:90-134`）：覆盖全部八类站点；before 的每个 id 都在 after；插入点后行号整体后移；**新增站点白名单**——after 有而 before 没有的 id 必须带被补全 hole 的前缀或 owner fill 链可达。
- **id 稳定性根基**（`hole-id.ts:1-15`）：hole id 是**名字键** `hole#<FNV-1a 32 位 hex>`（名字先 trim；offset 0x811c9dc5 / prime 0x01000193 与 §1.5 同族）——不用位置计数器（补全会让插入点之后编号改号）、不用外层前缀（每层 7 字符接龙到 64 上界）。体内站点只带一层 `<holeId>/` 前缀（全新一套计数器）。

### 2.6 动态 Schema 合成（JSON Schema 子集，非 Zod）

（前提修正 C2 展开。）

**typed-ask 判定**（`synthesize.ts:43-48`）：显式类型实参**且**解析后非原始 string——`ask()` 与 `ask<string>()` 都是无类型 ask（结果即末轮文本，不发射 schema）。`buildAskSpecs`（`:150-157`）**按 `table.asks` 遍历**——untyped 站点必须显式记 `{typed:false}`；按键构造会让 untyped 站点缺席，而引擎把 askSpecs 缺席当 `MissingAskSpec` 硬失败，「那条兜底会把 typed ask 静默降级」。report item 与 ask 用**同一个发射器、同一条诊断通道**（9002）——「另建平行检查器 = 开始维护第二份真相」。

**发射器**（`emit.ts:96-132` 核心循环）：`any` 拒绝（用 unknown 或具体类型）；`unknown → {}`（许可式）；never/非可选位 undefined/void、bigint、symbol、函数 → 拒绝；布尔/字符串/数字字面量 → `{const}`；union：成员 >100 拒绝、含 undefined 拒绝、全字面量成员 → `{enum}` 否则 `{anyOf}`；intersection：品牌类型按原始类型发射、有 call signature 拒绝；Array/Tuple（`prefixItems` + minItems/maxItems）；**REJECTED_BUILTINS 按名拒绝**（Date/RegExp/Map/WeakMap/Set/Promise/Error 族/ArrayBuffer/DataView/TypedArray 9 种）；用户 class 由 `SymbolFlags.Class` 兜底；thenable 拒绝；**递归类型 → `$defs`/`$ref`**（复合类型压栈帧，再次进入同一 `ts.Type` 返回 `$ref`，帧结束被 requested 过才登记 def——非递归具名类型仍就地内联保快照可读）；可选属性**剥掉 undefined 后再发射**（可选性由 required 表达）；`additionalProperties`：无索引签名 → `false`（校验 UX 与严格结构化输出惯例，非「忠于 TS」）。

**JSDoc 约束标签**（`schema/jsdoc.ts`）：`@minimum @maximum @exclusive* @minLength @maxLength @minItems @maxItems`（数值）、`@format @pattern`（字符串）、`@default`（先 JSON.parse 失败当裸字符串）；子集外标签静默忽略。**正则支持路径**：T 里写 `RegExp` 类型被拒，但字符串 pattern 经 `@pattern` 进 schema，校验器 `new RegExp(schema.pattern).test(value)`。

**Submit profile**（`actor-submit-profiles.ts:22-41`）三档：`untyped`（不注册 submit_result）/ `mono`（全部 typed ask 的 schema 相同 → 工具声明冻结，缓存中性）/ `generic`（通用工具 + 每 ask 尾注）。判定在编译期——「工具块渲染在 prompt 最前面，按 ask 换 schema 会打掉整个缓存前缀」。保守规则：任一 ask 的 actor 集解析为空 → **所有** actor 记 generic（宁少省缓存不凭不完整的图拿掉工具）。

**校验器**（`validate.ts:12-16`）：纯手写，覆盖范围恰是合成侧会发射的子集。

### 2.7 运行时沙箱与执行衔接

**编译一次**（`bootstrap/dynamic-workflow-run-compile.ts`）：一个 ts.Program 同时喂站点表/schema/lowering；`scriptHash = sha256(scriptText)` 算在**作者原文**上，所有权在 bootstrap（harness 刻意不校验 lowered 自洽——「校验等于把编译再跑一遍，正是编译一次要省掉的那次」）。

**payload 不过命令行**（`runtime/child-entry-file.ts:4` + `harness.ts:275-285`）：Windows 命令行上限 32,767 字符，`--eval` 路线脚本一过约 18KB 就 `spawn ENAMETOOLONG`——改写 `renderChildEntry(payload)` 到 `<cwd>/.zcode/workflow-runs/<runId>.mjs`，argv 只剩一条路径。

**vm 独立 realm**（`child-source.ts:315-334`）：

```ts
const sandbox = { __argsJson, __runJson };  // context 内 JSON.parse 后 Object.freeze
sandbox.__send = (line) => deps.stdout.write(line + "\n");
deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
deps.vm.runInContext(BOOTSTRAP, sandbox, ...);
```

裸 vm context 天然没有 process/require/Buffer/fetch 与定时器；`import()` 无回调 → `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`。BOOTSTRAP 注入 `__host = { args, run, createActor, ask, worldRead, publishArtifact, declareArtifact, report, log, enterPhase, hole }`（channel/future 由第二段引导补挂）。每类 shim 按同步/异步分派 request/response vs 即发即忘事件。

**运行期禁令**（`child-source.ts:282-302` `[已验证]`）：`Date.now()` / 无参 `new Date()` / `Math.random()` 改写为抛错——「belt；编译诊断是 suspenders」（确定性要求：世界读取与 world.run 都 journal 化，非确定性时钟/随机会破坏 resume 重放）。

**停滞检测**（`child-cell-streams.ts:116-141`）：cell 没有定时器与 I/O，能唤醒挂起脚本的只有 host response；每条 response 投递后与 `__execute` 起步后各在 `setImmediate` 问一次 `__checkStalled`——「无在飞请求且未完成」在这一刻成立就永远成立；有接收者停在 channel 上报 `ChannelDeadlock` 点名通道，否则 `ScriptStalled`。

**线协议**（`protocol.ts:1-17` `[已验证]`）：child→parent `create-actor`（即发即忘，FIFO 定映射）/ `request{ask|world-read|publish-artifact|hole}`（需应答）/ `event{log|report|declare-artifact|phase-entered}`（**FIFO 顺序对 report/declare 承重**——打标签的 report 只有在其预置声明已到达父进程后才合法，否则 `ArtifactUndeclared` failRun）/ `complete`；parent→child `response`。桥接失败归一 → `stopped(interrupted)` 可 resume（`harness.ts:443-457`）。

**facade API 面**（`facade/dts.ts` 全量）：`agent(name?, persona?): Agent`；`Agent.ask<T=string>(instructions): Node<T>`；`log(message): void`；`report(item, artifactId?): void`；`artifact.{file,markdown,chart,table,metrics,board}`（content 族返回 `Promise<ArtifactRef>` 是效应，preset 族 void 是声明）；`phase(name): void`（**无 id、无 journal 行、不占计数器**）；`files.{glob,read,grep}`；`git.{changedFiles,diff,status,log}`；`world.run(cmd, args?, opts?)`；`args`/`run{id, resumedFrom?}`；`hole<T>` 三重载；`channel<T>(name?): Channel<T>`（send/close/AsyncIterable）；`future<T>(body)`；`model(id): ModelRef`。上限契约：`WORLD_READ_CAPS`（glob 2000 文件/grep 2000 条 256KB/diff 512KB/log 100 条/run 输出 16MiB/默认超时 300s）、`REPORT_CAPS`（65536 条/1MiB 条/1GiB run，溢出 failRun——report 返回 void 无处 catch）、`ARTIFACT_CAPS`（32 id/16 版/20MiB 文件/256KB markdown/64 id 长度；内容族超限节点级拒绝可 catch，预置族 failRun）。

---

## 3. 持久化、存储与协议面

### 3.1 单库四表事件溯源（前提修正 C3/C4 展开）

durable 轨：`dwf_run / dwf_actor / dwf_node / dwf_event` 四表同住一个 session 库（`~/.zcode/cli/db/db.sqlite`，`paths.ts:4-6`），由单一 migration `0019_dwf_journal` 一次建齐、历史迁移按 SHA-256 checksum 锁死（改动即 `checksum_mismatch` 拒启）。NDJSON 是 Boundary A 线协议（§2.7），非持久化。端口同步、仓储式，「正好贴合 node:sqlite 的 DatabaseSync——引擎不必为持久化引入异步缝隙，replay 确定性不受存储实现影响」（`dwf-journal.ts:2-5`）。

**DDL 要点**（`schema.baseline.sql` `[已验证]`）：
- `dwf_run`：`id text primary key`；`script_text/script_hash/args_json/resumed_from` 等元数据**只写一次**；`caps_max_concurrency`、`spent_tokens`；`status CHECK IN ('pending','running','completed','failed','cancelled')`（物理 5 值）；`result_json/failure_json`。
- `dwf_actor`：`unique(run_id, site_id, ordinal)`；`persona_json/resolved_model/session_id`。
- `dwf_node`：`unique(run_id, site_id, ordinal)`；`kind CHECK 5 值`；`actor_site_id/actor_ordinal/actor_seq`；`input_hash not null`（重放匹配键）；`input_json`（world 专用有界 4096 字节）；`status CHECK 3 值`；`message_boundary`（ask 专用 count offset）。
- `dwf_event`：`unique(run_id, sequence)`；`payload_json` 原样 JSON 不迁移；表达式索引 `dwf_event_artifact_idx(run_id, json_extract(payload_json,'$.artifactId'), sequence)`。
- **无 `dwf_artifact` 表**（仅 migration 元数据出现一次；产物归属 `dwf_node(kind='artifact')` 行 + `artifact_id` 列）。
- `parent_session_id` 纯 text **不加 FK**——子代理会话跑在内存 event store 上没有 session 行，而 runner 开着 `foreign_keys=on`，真加 FK 会把合法 journal 记录挡在门外；可空列一律「NULL 即缺席」。

**写入协议**：
- `appendEvent`（`dwf-journal.ts:429-454` `[已验证]`）：**序号分配与写入必须是同一条语句**——`insert … values(?, coalesce((select max(sequence)+1 from dwf_event where run_id=?),0), …) returning sequence`；单独读再插会在多进程（WAL 下允许多 Agent 共享同库）竞争出重复序号。`time_created` 在 append 时取 Date.now() 原样回给调用方（避免「刚写的事件没有时刻」两面不一致）。
- `updateRunStatus`（`:147-194`）：非终态 → 清 `failure_json/result_json`（resume 必须清上一世残留）；终态 → **一笔写**（failure 整列改写防双实例互踩、result coalesce 保留产物）——「分两条 UPDATE 会开出『completed 但 result_json 为空』的崩溃窗口」。
- `updateRunScript`（`:224-229`）：`script_text` 与 `script_hash` **必须同一条 UPDATE**（否则「文本是新的、哈希是旧的」崩溃窗口，resume 撞上就是 ScriptHashMismatch）。
- `putNode`（`:324-377`）：准入→结算→统计回填同一条 upsert。
- `assertRunTouched`（`:461-463`）：UPDATE 0 行显式抛 `unknown run`。

**读面全部下推**（`journal-read-types.ts:3-11` 设计动机：item 存两份最坏每 run 约 2 GiB——「没有读者可以整表读进内存再过滤」，读选项**必填**，一次整表读必须在调用点写出 `"all"`）：事件读 + report 剥离用分界 sequence + `json_remove`（不用 `row_number()`——会把 2 GiB 载荷抄进 temp store）；分页两道界（条数 + `octet_length` 字节窗口，收尾行连 1 MiB item 一个字节都不读）；列裁剪 `null as <列>`（「没读」与「读到 NULL」在行上同形）。

**逻辑↔物理状态映射**（零迁移的终态重构，`dwf-journal-codecs.ts:15-170`）：`stopped{…}` → 物理 `cancelled` + failure 信封 `{stopReason, supersededBy?, error?}`；`errored` → `failed`；`Interrupted` code 兼容老孤儿行；**事件载荷不映射原样存读**——没有任何读者从事件派生状态。

### 3.2 冷重放两层

**引擎层 resume**（§1.7）+ **宿主层 UI 冷回放**（`bootstrap/dynamic-workflow-run-replay.ts`）：把 `dwf_event` 按序重铸成与 live 完全同种进度载荷喂**同一个 reducer**；读的形状 `COLD_REPLAY_EVENT_READ = { types:"all", reportItems:{limit:64} }`——reducer 按实例 upsert、满 64 拒新、`run-started` 不清表、每 report 实例只发一次事件，故归约结果与读全量**逐字节相同**（修复前：一个报了 65,536 条的 run 在会话打开时要解码约 2 GiB 进内存）。**结算以行为准**（`:27-40`）：终态行存在时回放的最后一条 `run-settled` 永远按行铸造，「事件的词表再怎么变，冷回放都不会再对着旧事件说谎」；铸出载荷只存在于返回值，**绝不写回 dwf_event**。`defaultConcurrency` 必填（漏掉则冷回放首条载荷比 live 少一个键）；`hole-reached.reachedAt` 取 journal `timeCreated` 与 live 同源。

**确定性总结** `[推断]`（推断链）：① 站点 id/ordinal 由编译期站点表 + 到达序铸造；② 同一 runId resume 强制逐字节同脚本（哈希门）；③ 命中行按 `input_hash` 匹配短路；④ 完成顺序这一唯一墙钟量由事件日志首次结算次序持久化并在重放强制复现；⑤ 实参/lineage/模型 pin 等脚本可见输入在 run 生命周期内冻结或从行恢复 ⇒ 同一 journal + 同一脚本必然收敛到同一状态轨迹。

### 3.3 孤儿进程与中断对账

**锚点**：宿主元数据零 SQL 地活在首条 `run-launched` 事件里（`engine/types.ts:531-536`「零 SQL：锚点活在 journal 事件里，不在 dwf_run 列上（刻意不做迁移）」）；读取端一条窄查（类型过滤 + limit 下推，`run-launch-anchor.ts:66-76`）。解析优先级：修订续跑沿用前驱锚点 → 显式 UUID v7 → 父轮 inputId → 兜底铸 UUID v7；`scriptPath` 例外：最后一条在场的胜过建 run 世记录。

**孤儿收敛**（`run-reconcile.ts:60-108` `[已验证]`）：run service **构造时**（此刻本实例名下零在飞 run，任何非终态行都只可能是死进程遗物；二次构造天然幂等）把本 `parentSessionId` 名下所有非终态 run 收敛为 `stopped(interrupted)`（专属 code `Interrupted`——不能是 DriverError，状态不能是 cancelled，「语义必须保持可分辨」）。三条边界：判定权威在 service 侧（SQL 物理终态集只是索引友好预筛）；**不合成 dwf_event**（「事件日志的契约是『引擎发过什么』，`run-settled` 是引擎的收口不是清扫者的」）；收敛失败只 warn 不拖垮构造。`parent_session_id` 必须入条件——不带它会把同进程兄弟会话正在飞的 run 标死；SQL `= ?` 天然不匹配 NULL（父会话缺席的行不属于任何会话）。

**其他中断统一归一**：harness 的沙箱崩溃/墙钟超时/NDJSON 损坏/spawn 失败一律 `engine.stop("interrupted")` 可 resume（「让异常直接冒出去会绕过引擎结算……journal 行却永远 running」）；App 关闭 close() 以 interrupted abort 每个在飞条目并**无超时等待结算**——「service 绝不自己写终态行：绕过引擎写就会造出 dwf_run 的第二个写入者，且 journal 里不会有对应的 run-settled」（`run-service.ts:33-39` 不变式 7）。

### 3.4 SQLite 配置

`pragma journal_mode = wal`（拒绝即 `sql_failed` 启动错误；`:memory:` 豁免）+ `foreign_keys = on` 每次启动；迁移期 `busy_timeout` 25ms + 指数退避 acquire（10ms×2 到 200ms 封顶，默认可等 60 分钟），结束恢复 5000ms。**无显式 checkpoint / synchronous 设置** `[已验证]`（前提修正 C4）。

### 3.5 子域存在性核查（搜索证据）

| 子域 | 结论 | 搜索证据 |
|---|---|---|
| NDJSON/JSONL 事件持久化文件 | **不存在** | `grep -rniE "ndjson|jsonl"` 全命中为线协议（protocol/harness/child-source）、model-io 调试日志、文档 |
| `projections.ts` 作为事件冷重放 | **不是**（它是浏览器端分析投影桶：站点图/因果图/CFG/交接图） | `projections.ts:1-12` 文件头 |
| 显式 WAL checkpoint | **未找到** | `grep -rniE "wal_checkpoint|checkpoint()"` 全 packages 零命中 |
| `dwf_artifact` 表 | **不存在** | `grep -rn "dwf_artifact"` 仅 1 命中（migration 元数据） |

### 3.6 bootstrap 生命周期概要

`run-service.ts:9-39` 七条不变式核心：引擎独占 createRun（服务绝不预插行）；编译恰好一次（scriptHash 由服务算）；**没有 journal 就不构造本服务**（能力探测失败 → CreateWorkflow 回占位诊断——「可见的降级，而不是坏掉的功能」）。submit：编译 → AbortController → `trackSettlement` 常驻阻塞登记（防常驻池把带在飞引擎的 App 按 idle 关掉）→ fire-and-forget launch。resume 七连门：`not_found/already_running/superseded/not_resumable/script_missing/compile_failed/script_mismatch`；**先替换注册表条目再启动**（条目晚一步，重臂的 watcher 会对着旧终态行结算）；caps 沿用 journal 行（「重算等于悄悄挪门柱」）。cancel = `controller.abort(initiator)`——「abort 是 harness 里唯一的『真停止』」。终态注册表条目保留 32 个。

---

## 4. 代码级落位：我方 `src/dwf/` 缺口对齐矩阵

> 我方行号实测于本 worktree `src/dwf/`（主代理抽查 4 项命中）。对齐状态：✅ 同构 / 🟡 部分对齐 / ❌ 缺失。

| # | 官方机制 | 官方锚点 | 我方对应（文件:行号） | 状态 | 建议动作 |
|---|---|---|---|---|---|
| 1 | Settle-Order 重放闸 | `replay-order.ts:30,51,173`；`engine.ts:219-226` | 无次序闸；等价物=内容哈希结算池 1:1 消费（engine.ts:1019-1029 takeFromPool、:1057-1104 journalled 重放沿用池内原 ordinal） | 🟡 | 我方用「内容匹配」解同一问题；缺官方「hash 不匹配大声失败」防御（漂移 1） |
| 2 | Per-Actor FIFO + actorSeq 准入 | `scheduler.ts:357-376` | engine.ts:114（actors Map 带 chain）、:312-321（actor.chain.then 链式排队）、:506-519（全局席位 FIFO） | 🟡 | ask FIFO 同构；缺跨 resume 的记录节点优先准入 |
| 3 | AIMD 五参 + epoch 阻尼 + lastGood/lastBad | `concurrency.ts:25,27,33,35,37`；`:11-14`；`:75-76` | governor.ts:48-53（max=8/increaseAfter=4/decreaseFactor=0.75/idleReset=5min 全对齐）、:91-100、:124-130；缺 epoch 阻尼与双水位 | 🟡 | 阶段三补两点（见 §5 P1-1） |
| 4 | Hole Parking | `engine-holes.ts:93-95,107-115,198-216` | engine.ts:874-897（parked 落盘 + dwf_hole_open）；runner.ts:661-669（maybePark）；fill=spliceHoleBody（lower.ts:213-235）+ 两笔独立写 + amend fork | 🟡 | fill 两笔写无事务保证（漂移 4） |
| 5 | Amend 温缓存 + 分歧单调 + 纯度门 + messageBoundary | `imported-cache.ts:29-34,53-55,64-74,148-159` | runner.ts:270-299（amend 门）；engine.ts:1004-1016、:1086-1103；纯度门=importClosed kind 级闸；哈希=sha256 | 🟡 | 缺分歧单调 flag 与 messageBoundary 会话种子（漂移 2/3） |
| 6 | 27 种事件 + 单语句序号 + 出生阶段戳 | `types.ts:506-803`；`dwf-journal.ts:429-454`；`engine-phase-stamp.ts:30` | 我方 25 种 dwf_* 事件；序号=内存 ++seq + resume 续接种子；无出生阶段戳（view.ts:48-75 事后按时间归组） | 🟡 | 出生阶段戳缺失（漂移 6 相关） |
| 7 | CompilerHost 纯度 | `compile.ts:42,47,56-59,140` | compile.ts:70-83（同参）、:85-112（虚拟 host；lib 磁盘回退） | ✅ | 行为等价；lib 内嵌与否不影响纯度契约 |
| 8 | 901x 十二码 | §2.3 全表 | compile.ts:171-311（9002/9003/9004/9006/9010-9014/9016 各有对应但**码位语义冲突**）；schema-synth.ts:63,133（9005/9015） | 🟡 | **最大缺口：官方 9001 facade 站点授权我方完全没有**（§5 P0-1）；码位对照表待发布（漂移 9） |
| 9 | lowering `__host` + eval 求值器 + spliceHoleBody + 稳定性复核 | `lower.ts:71`；`lower-hole.ts:34-63`；`hole-splice.ts:34-134` | lower.ts:85-183（重写面同构且我方超集：多 escalate/workflow/sessions/fanout）；spliceHoleBody lower.ts:213-235（IIFE 拼接）；site 稳定检查内联 runner.ts:1070-1081（仅 hole 前缀） | 🟡 | IIFE 与 eval 词法求值器 bind 语义不同；前缀校验已覆盖我方 fork-amend 语义 |
| 10 | Schema 合成 JSON Schema 子集 | `emit.ts` 全套；`jsdoc.ts` | schema-synth.ts:23-25（MAX_DEPTH 8/MAX_PROPS 64/MAX_UNION 24 vs 官方 100）；递归 9015 硬拒不发射 $ref；无 @pattern 标签；**无 REJECTED_BUILTINS 黑名单**（schema-synth.ts:128-161 Object 路径 Date 疑漏 [推断]） | 🟡 | §5 P1-3/P1-4 |
| 11 | 存储四表 + 同语句序号 + 孤儿收敛 | `schema.baseline.sql`；`dwf-journal.ts:429-454`；`run-reconcile.ts:60-108` | sqlite-store.ts:19（WAL）、:83-127（dwf_runs/nodes/evidence 五表含我方独有 evidence；事件共享 events 表；无 dwf_actor 表）；孤儿收敛=pid 探针（runner.ts:162-176, 239-258） | 🟡 | 判据不同（pid 存活 vs parentSessionId 构造收敛）；我方发 dwf_resume_takeover 事件、官方不合成事件 |
| 12 | 结算 first-wins + 闸 open | `engine-settlement.ts:7-91` | runner.ts:615-636 finish() 单一收口（settled 旗唯一写者）；:810-827/:851-867 各终态路径 | 🟡 | first-wins 同构；我方终态通道更多 |
| 13 | vm realm + 运行期禁令 + 入口落盘 + 停滞检测 | `child-source.ts:99,282-302,315-334,364-385`；`child-entry-file.ts:4` | child-main.ts:505-518（null 原型 + codeGeneration 禁 eval）、:80-495 BOOTSTRAP、:375-447（Math/Date/**Intl.DateTimeFormat 封印**——官方无）；runner.ts:322-325（入口落盘）、:934-936（env 白名单+脱敏）、:969-981（父侧 90s stall） | ✅/🟡 | 沙箱面我方更严；停滞检测层级不同（官方抓脚本卡死，我方抓 provider 不吐字）——互补非缺陷 |

### 4.1 我方独有机制（19 项，节选）

多 Provider 故障转移链+熔断重试编排（engine.ts:396-477、retry-orchestrator.ts:61-125、attempt-classifier.ts:25-66）；Token 预算硬顶体系（官方明确移除预算）；不可逆脱敏纪律（redact.ts，journal 即掩码权威）；证据凭证台账 dwf_evidence 第 5 表；进程树监督 killTree（Windows taskkill /T /F）+ env 双层脱敏；**Intl.DateTimeFormat 无参封印**（墙钟侧信道，官方无）；编译期原型链封禁（constructor/__proto__）；帧预算泵；工作区逃逸守卫；Schema 预发射 lint（零 token 拒绝）；run 级墙钟超时；escalate 持久化人闸（官方内存 registry 刻意不落盘）；workflow() 嵌套组合（官方硬禁）；events.jsonl 镜像双通道持久化+显式降级事件；僵尸行 pid 接管。

### 4.2 语义漂移风险点（14 条，节选关键 6 条）

1. **重放键模型（最大漂移）**：官方=位置优先 `(siteId,ordinal)` 命中即短路 + inputHash 防御校验、不匹配**大声失败**；我方=内容哈希池 1:1 消费、不匹配**静默实跑**分配新 ordinal。同一 journal 在两套引擎下 resume 结果不同构。
2. **Amend 分歧语义**：官方 diverged 单调、下游级联实跑；我方逐节点事件无 flag，可产生「半缓存半实跑」混合前缀。
3. **messageBoundary 会话种子**：官方 amend 后新 ask 看得见前驱上下文；我方 amend 重放只回填结果、新 ask 上下文为空（行为级差异）。
4. **Hole 续跑**：官方同进程释放 + hole-filled 与有效脚本同笔写；我方两笔独立写（崩溃窗口留中间态）。
5. **9xxx 码位冲突**：同码不同义（官方 9001 facade siting ↔ 我方无；9002 schema ↔ 我方 purity-ban；9004 phase ↔ 我方 shadowing；9010/9011 模型 ↔ 我方 hole 类型实参……）跨工具消费诊断必炸。
6. **AIMD 结构**：官方 epoch 阻尼 + lastGood/lastBad 双水位；我方单 limit+streak。默认并发公式 floor 不同（我方 `min(16,max(2,cores-2))` vs 官方 `max(4,min(16,cores-2))`）。

其余：siteId 命名（`worldread#` vs `world-read#`）、预算立场相反（官方移除/我方硬顶——基准跑需可关）、schema 合成子集窄化、CompilerHost lib 来源、escalate 持久化立场相反、孤儿收敛判据、停滞检测层级、事件表形状。

---

## 5. 阶段三靶向优化清单（依据 §4 漂移点导出）

**P0（行为正确性）**：
1. **Facade aliasing 防御**（对齐官方 9001 pass1/pass2）：禁 `const f = agent`、方法抽取、facade 函数作实参——否则 siteId 静态表与执行序脱钩，威胁 site 表完整性（我方 site 体系同样以静态站点表为键）。落点：`compile.ts` 诊断层新增检查。
2. **重放大声失败防御**（对齐官方 InputHashMismatch 语义的最小子集）：journalled 重放路径中「池内命中但 inputHash 不同」当前静默实跑；至少对 `ask` 节点补防御分支或显式策略开关，消除「同一 journal 两引擎不同构」的最大漂移源。
3. **Amend 分歧单调**：importedPool 命中失败一次即对该 actor/site 链置 diverged 旗标，禁止混合前缀。

**P1（结构补强）**：
1. **AIMD epoch 批次阻尼 + lastGood/lastBad 双水位**（governor.ts）。
2. **Schema REJECTED_BUILTINS 黑名单**（schema-synth.ts：Date/RegExp/Map/Set/Promise 等按名拒绝）+ union 上限对齐 100。
3. **fill 同笔写**：hole 节点行 + run 行 completed 收敛为单事务（SQLite 同一事务内两写）。
4. **出生阶段戳**：dwf 事件补 phaseName（node-queued/settled 族），view.ts 按戳归组替代墙钟重建。
5. **messageBoundary 会话种子**（评估项：我方 provider 链与官方会话模型不同构，需先验证可移植性再动）。

**刻意分歧保留项**（不跟齐并留痕）：Token 预算硬顶（我方卖点）；Intl 封印与原型链封禁（我方更严）；pid 探针孤儿收敛（物理事实优于会话归属推断）；escalate 持久化（设计立场相反，文档互注）；多 Provider 故障转移（官方无）。

---

## 附录 A：关键常量速查表（官方）

| 常量 | 值 | 位置 |
|---|---|---|
| CONCURRENCY_DECREASE_FACTOR | 0.75 | concurrency.ts:25 |
| CONCURRENCY_INCREASE_STEP | 1 | concurrency.ts:27 |
| CONCURRENCY_INCREASE_AFTER_SUCCESSES | 4 | concurrency.ts:33 |
| CONCURRENCY_FLOOR | 1 | concurrency.ts:35 |
| CONCURRENCY_IDLE_RESET_MS | 300 000 | concurrency.ts:37 |
| REPAIR_ATTEMPTS / NUDGE_ATTEMPTS | 3 / 1 | types.ts:1065/1068 |
| INSTRUCTIONS_HEAD_MAX_CHARS | 240 | ask-observation-types.ts:27 |
| HOLE_PROMPT_MAX_CHARS | 4000 | engine-holes.ts:22 |
| WORLD_READ_INPUT_MAX_BYTES | 4096 | types.ts:478 |
| REPORT_CAPS（条/单条/run） | 65 536 / 1 MiB / 1 GiB | facade/report-caps.ts |
| ARTIFACT_CAPS（id/版本/文件/markdown） | 32 / 16 / 20 MiB / 256 KB | facade/artifact-caps.ts |
| MAX_UNION_MEMBERS | 100 | schema/types.ts:90 |
| FNV-1a basis / prime | 0x811c9dc5 / 0x01000193 | hash.ts:36-41、hole-id.ts:27-34 |
| 事件页协议限界 | 500 条 / 单帧上限÷4 | shared/zcode-protocol-v4/transport.ts:636-637 |
| 投影限界 | maxRuns 8 / maxNodes 1024 / maxReports 64 | shared/…/workflow-runs.ts:14-44 |

## 附录 B：逆向方法与可复核性

- 逆向人日：4 个并行子代理（内核 / 编译 / 存储 / 我方缺口），主代理逐项抽查 14+4 项主张全数命中。
- 探针实验 2 项：① CompilerHost 纯度（typescript@5.9.3 同配置：TS2591/TS2304/干净通过清单）；② generate-libs es2022 闭包 57 文件。
- 探针实验 3 项（阶段二执行，见 `OFFICIAL-WORKFLOW-TELEMETRY.md`）。
- 研究仓探针性改动披露：`packages/dynamic-workflow/vitest.config.ts`（npm 装依赖后父级配置不可解析，加最小本地配置；未跟踪文件）。
