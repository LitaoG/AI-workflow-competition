# 双向跨界对标报告（BILATERAL-CROSS-BENCHMARK-REPORT）

> **文档属性**：MISSION-B（Issue #67）阶段五交付物——官方引擎（ZCode `@zcode/dynamic-workflow` 0.1.0）与我方引擎（AI-workflow `src/dwf`）的**同任务、同脚本、同桩模型**四维对标。
> **工作区**：`C:/Users/86183/Desktop/AI-workflow-worktrees/issue-67-zcode-benchmark`（下称 WT，分支 `feat/issue-67-zcode-benchmark`）。
> **输入材料**（本文全部数据的来源，未引入任何外部数字）：
> ① `WT/docs/research/OFFICIAL-WORKFLOW-TELEMETRY.md`（阶段二 Ground Truth，下称「遥测」）；
> ② `WT/tests/cross-engine/results/official-cross-benchmark.json` 与 `ours-cross-benchmark.json`（阶段四实测，下称「官方 JSON」「我方 JSON」）；
> ③ `WT/docs/research/ZCODE-DEEP-REVERSE-v2.md` §4 缺口矩阵 / §4.1 我方独有机制 / §4.2 漂移点 / §5 优化清单（下称「逆向 v2」）。
> **证据纪律**：逐条标注 `[已验证]` / `[推断]` / `[未知]`；§3 门禁指纹为本撰写会话在 WT 内**实际运行**所得，命令与输出摘要在 §5 可复核；§2 数值逐字取自上述输入文件；未运行、未测得的指标一律如实标注，禁止编造。
> - 撰写会话：2026-11-03/04；撰写者：对标报告撰写员（workflow 子代理）

---

## ① 执行摘要

**任务级对等已达成，架构级分歧如实存在，本轮 5 项优化落地后全部门禁绿。**

1. **行为对等 `[已验证]`**：同一 facade 任务脚本（`cross-benchmark-mission.facade.ts`：planner → 4 路扇出 → verifier 自愈 → report/complete，共用一套 ScriptedDriver/ScriptedProvider 桩模型 `scripted-fake-model-v1`、零网络零密钥）下，双引擎 run1/run2 wall 时间几乎持平——官方 167.271 / 155.256 ms，我方 168.833 / 154.248 ms（差 +1.562 ms / −1.008 ms，即 +0.93% / −0.65% `[已验证·算术]`）；确定性自比对：官方 `determinism` 块 **5 键全 `true`**、我方 **4 键全 `true`**（我方 JSON 未导出 `journalEventSequence` 字段，故无 `journalEventSequenceIdentical` 一键——缺的是键不是真值，见维度二「跨引擎对账」），且**跨引擎归一化结算序结构相等**（12 = 12，`crossCompare.settleSequenceStructurallyEqual: true`）。
2. **资源效率我方占优 `[已验证·JSON]`**：任务运行期峰值 heapUsed 我方 **40.54 MB vs 官方 100.18 MB**（−59.5%）、RSS **147.7 vs 235.88 MB**（−37.4%，同为每 5ms 采样）。
3. **编译面互有胜负 `[已验证·JSON]`**：冷编译官方 66.444 ms vs 我方 211.506 ms（我方慢 3.2×）；温编译官方 51.072 ms vs 我方 **7.206 ms**（我方快 7.1×，官方温≈冷、无跨调用编译缓存——遥测 §5 `[推断]`）。
4. **本轮 P0-1/P0-2/P0-3/P1-1/P1-2 已全部落地并验证 `[已验证·本轮运行]`**：9001 facade 站点授权（补齐逆向 v2 §4 第 8 行「最大缺口」）、重放哈希失配大声失败、amend 分歧单调、AIMD epoch 阻尼 + lastGood/lastBad 双水位、Schema REJECTED_BUILTINS 黑名单 + MAX_UNION 对齐 100。改动面：4 个源文件 + 2 个既有测试 + 5 个新测试文件（`git diff --stat` 373 insertions / 35 deletions + 未跟踪新文件）。
5. **门禁全绿（本会话实跑）`[已验证]`**：build 0 错；`test:unit` **288 pass / 0 fail**；`test:pbt` **5 pass / 0 fail**；governance **24 pass / 0 fail**；e2e **121 / 121**（Tier1 50 + Tier2 50 + Tier3 15 + Tier4 6）。
6. **如实记录的差距**：我方 **无 nudge 边界**（官方 `NUDGE_ATTEMPTS=1`，我方 JSON 自述 `mechanism: none on this side`）；hole 补全机制不同构（官方进程内 payload 换装 0.635 ms vs 我方 fork-amend + journal 零成本重放 411.455 ms，定位不同：内存瞬时 vs 持久谱系）；`queueWaitMs` 我方为派生值（`queueWaitDerived: true`）非原生事件戳；官方 AIMD「有等待者 cap+1」增长分支在双方探针中均未触发 `[未知]`。

---

## ② 四维对标矩阵

> 每行四栏：官方表现 / 我方表现 / 差距诊断 / 我方超越点。时间量级均为单机单跑样本（Windows × Node v26.13.0），量级与结构可复现，绝对值随负载浮动 `[推断]`（遥测 §7.1 结论 6 同款口径）。

### 维度一：AST 静态准入（编译期封闭集合与纯度契约）

| 栏目 | 内容 |
|---|---|
| **官方表现** | ① 诊断码 9001–9012 连续 12 码，其中 **9001 facade siting** 是站点授权正门（别名/方法抽取/解构/作实参全部拒绝，逆向 v2 §2.3 `[已验证·源码]`）；② 纯度由 `types:[]` 类型层封锁（process/require/Buffer→TS2591，fetch/setTimeout→TS2304；eval/Function/Date/globalThis 编译干净——ES intrinsic），遥测 §2.2 探针 `[已验证]`；③ 12 个官方 fixtures 冷编译 **34.091–167.747 ms**、温均值 **33.172–69.841 ms**，5 个带诊断脚本 **5/5 全部拒绝降级**（遥测 §5 `[已验证·JSON]`）；④ 基准任务脚本：冷编译 66.444 ms + 冷降级 217.611 ms、温均值 51.072 ms、0 诊断、20 个降级站点、`holeBodies: []`（官方 JSON `compile` `[已验证·JSON]`；20 vs 我方 30 的对账见维度二·差距诊断首项）。 |
| **我方表现** | ① 落地 P0-1 后 9001 facade 站点授权补齐：`src/dwf/compile.ts:42`（官方 pass1 最小子集、文案逐字）与 `:210-268`（别名 / 方法抽取 / 解构抽取 / bind-call-apply 四类拒斥）`[已验证·本轮 grep 源码]`；② 落地 P1-2 后 Schema 准入补 REJECTED_BUILTINS 黑名单（Date/RegExp 等，`schema-synth.ts:35-47`）+ `MAX_UNION` 对齐官方 100（`schema-synth.ts:27`）`[已验证·本轮 grep 源码]`；③ CompilerHost 同参虚拟 host（lib 允许磁盘回退，逆向 v2 §4 第 7 行 ✅）；④ 基准任务脚本：冷编译 211.506 ms、温均值 **7.206 ms**、0 诊断、30 个降级站点（我方 JSON `compile` `[已验证·JSON]`；站点数与官方 20 的差异属编号方案——我方对每个 facade 调用发号，详见维度二·差距诊断首项对账）。 |
| **差距诊断** | 冷编译我方 **211.506 vs 66.444 ms，慢 3.2×** `[已验证·算术]`——成因未在本轮归因（虚拟 host 的 lib 装载路径与 program 构建策略均可能是来源）`[未知·根因]`；我方 JSON **未导出独立降级（lowering）耗时字段**，无法与官方 `coldLowerMs: 217.611` 同口径对比 `[未知]`；其余 9xxx 码位仍有跨工具语义冲突（官方 9002 schema ↔ 我方 purity-ban 等，逆向 v2 §4.2 漂移 5，P0-1 仅补齐 9001）`[已验证·源码对照]`。 |
| **我方超越点** | ① **温编译 7.206 vs 51.072 ms，快 7.1×**（且为我方自身冷编译的 1/29.4）`[已验证·算术]`；官方温≈冷、每次编译全新 TS program（遥测 §5 `[推断]`），我方存在跨调用编译缓存；② Schema 预发射 lint：不可序列化内建类型在**编译期**给出可执行修复文案（如 Date→ISO string 建议，`schema-synth.ts:152-157`）而非运行期炸 `[已验证·源码]`；③ 纯度面更严：编译期原型链封禁（constructor/__proto__）+ 运行期 `Intl.DateTimeFormat` 无参封印（墙钟侧信道，官方无此防线，逆向 v2 §4.1 / §4 第 13 行）`[已验证·源码]`。 |

### 维度二：调度时序与确定性（准入顺序与重放一致性）

| 栏目 | 内容 |
|---|---|
| **官方表现** | ① 任务级：run1 wall **167.271 ms** / run2 **155.256 ms**；70 事件 / 10 类型；两 run 的 settleSequence、eventTypeSequence、artifact 全部逐条一致，`determinism` 五项全 `true`（官方 JSON `[已验证·JSON]`）；② 引擎级（遥测 Probe A）：first-ask 派发 **1.093 ms**、6 ask 排队等待 **≤ 0.266 ms**、occupancy 对模拟时延开销 +5.1~+12.4 ms、全程 87.988 ms `[已验证·JSON]`；③ AIMD：五参 0.75/1/4/1/300000 运行时导出吻合；三连 429 缩容曲线 `[6,6,6]`（一次裁决、后续旧 epoch 吸收）；Retry-After 冷却内 `canAdmit=false`；终态快照 cap 6 / epoch 1 / streak 20（遥测 §4 `[已验证·JSON]`）。 |
| **我方表现** | ① 任务级：run1 wall **168.833 ms** / run2 **154.248 ms**；56 事件 / 7 类型；`determinism` **4 键全 `true`**（`settleSequenceIdentical / eventTypeSequenceIdentical / artifactIdentical / artifactMatchesExpectedTable`；官方第 5 键 `journalEventSequenceIdentical` 在我方 JSON 中**整键缺席**——我方未导出逐条 journal 事件序列，只导出 `journalNodes 16 / journalAskNodes 12` 计数，属采集面差异非真值差异）`[已验证·JSON 对照]`；跨引擎结算序归一化后**结构相等**（12=12，A1..A10@1+A10@2+A10@3 两序完全同构，我方 JSON `crossCompare` `[已验证·JSON]`）；② occupancy 区间与官方同形（run1 我方 14.558–46.577 ms vs 官方 15.002–45.804 ms，同一套桩时延表）`[已验证·算术]`；③ 落地 P1-1 后 governor 具备 epoch 批次阻尼 + admittedEpochs FIFO 配对 + lastGood 水位 + Retry-After 冷却（`src/dwf/governor.ts:5-9,39-49,62-67,75-87`）`[已验证·本轮 grep 源码]`。 |
| **差距诊断** | **跨引擎对账（同脚本下三处计数差异的完整解释，先行回答「可比性」之问）**`[已验证·算术，全部可由两个 JSON 与任务脚本源码复核]`：**(a) 降级站点 20 vs 30**——任务脚本静态调用构成为 4 phase + 6 agent + 10 ask + 4 report + 6 log（`tests/cross-engine/cross-benchmark-mission.facade.ts:34-85`，ask#10 自愈重试 3 实例计入 ask 站点不计站点数）；官方 `loweredSiteIds` 恰为 actor×6 + ask×10 + report×4 = **20**（官方 phase 无站点、log 无站点号——phase「无 id、无 journal 行、不占计数器」逆向 v2 §2.7，log 按 checker 签名识别 §2.4）；我方「每个 facade 调用都发站点号」（我方 JSON `crossCompare.note` 自述），4+6+10+4+6 = **30** 恰好闭合（且我方 ask 序号最大 #26 与逐调用编号完全吻合：phase#1、agent#2、ask#3 … verifier heal 循环 ask#26、log#27/#28、report#29、log#30）。**降级函数面双侧同构：10 个 ask 站点一一对应、结构相等，30 vs 20 是站点编号方案差异，非降级面差异**。**(b) 事件 70 vs 56**——共享骨架：phase 4 + actor-created 6 + log 6 + report 4 = 20 条双侧相同；每 ask 官方 4 条（node-queued / node-dispatched / usage-updated / node-settled）×12 = 48，我方 3 条（dwf_ask_start / dwf_budget_spent / dwf_ask_complete）×12 = 36；官方另有 run 边界事件 2 条（run-started / run-settled）。48+20+2 = **70**，36+20 = **56**，差 14 = 12×(每 ask 少一条生命周期事件——官方 queued 与 dispatched 分立) + 2（run 边界）。**事件差是双方事件模型的结构差，逐条可对账，不含行为分叉**。**(c) 确定性键 5 vs 4**——见我方表现①：我方缺的是 `journalEventSequenceIdentical` 这个**键**（字段未导出），不是任何一项为 `false`。其余诊断：① wall 差 ±1% 内持平（run1 我方 +1.562 ms，run2 我方 −1.008 ms）`[已验证·算术]`；② 我方 `queueWaitMs` 为**派生值**（`queueWaitDerived: true`，如 run1 ask#3#1 = totalMs 29.822 − occupancyMs 26.187 = 3.635 ms）非原生事件时间戳，与官方原生 ≤0.266 ms 不同口径，且首轮最大值 3.635 ms 疑似预热毛刺 `[已验证·算术 + 推断·成因]`；③ **基准场景内**事件词汇 7 类 vs 官方 10 类（引擎全量词汇为另一口径：官方 27 种 RunEvent、我方 25 种 dwf_*，逆向 v2 §1.6/§4 第 6 行——场景内出现数 ≠ 全量词汇数）：我方无原生 `run-settled`/`usage-updated` 对应物（以 `dwf_budget_spent` 计账）、无出生阶段戳（P1-4 未落地）`[已验证·JSON 对照]`；④ 缺官方 Settle-Order 重放闸（`replay-order.ts` 首生次序表），我方以内容哈希池 1:1 消费解同一问题（逆向 v2 §4 第 1 行 🟡）——P0-2 补上「哈希失配大声失败」、P0-3 补上「分歧单调」后行为差距收窄，但架构仍不同构 `[已验证·源码]`；⑤ 官方 journal 读回为空数组是探针查询参数缺陷（`limit:"all"`→NaN 空页，遥测 §3.3 复现实验），非引擎差异，官方 `journalEventSequenceIdentical: true` 为**空对空的真空成立** `[已验证·遥测]`。 |
| **我方超越点** | ① **内存**：峰值 heapUsed 40.54 vs 100.18 MB（−59.5%）、RSS 147.7 vs 235.88 MB（−37.4%）`[已验证·JSON 算术]`；② **逐 ask 预算记账**：`dwf_budget_spent` 12 条与 ask 一一对应（官方已明确移除预算体系——刻意分歧保留项，逆向 v2 §5）`[已验证·JSON]`；③ **持久节点图**：journalNodes 16 / journalAskNodes 12 逐节点落库，fork-amend 重放零成本可审计（我方 JSON `hole.fill`）`[已验证·JSON]`；④ 跨引擎结算序结构相等是**双向互证**：两套独立调度器在同一脚本上收敛到同一首生序 `[已验证·JSON]`。 |

### 维度三：执行与降级开销（运行面与流控）

| 栏目 | 内容 |
|---|---|
| **官方表现** | ① AIMD 全曲线实测（遥测 §4）：增长判定需「有等待者」（探针零需求构造下 24+20 次成功零增长——该增长分支行为双方均未触发 `[未知]`）；② 降级：7 个干净 fixtures lowering 59.584–99.119 ms，5 个脏脚本 5/5 拒绝降级（遥测 §5）；任务级冷降级 217.611 ms（官方 JSON）；③ 引擎自开销：首 ask 派发 1.093 ms，结算即 dispose（`disposedOnSettle: true`）；任务级 `disposedCalls: 1`。 |
| **我方表现** | ① 任务级 12 次 ask = 12 次 providerCalls，1:1 无隐藏重试（我方 JSON `[已验证·JSON]`）；② hole 机制实测：park 经真实 runner 管线挂起（wall 10109.068 ms，含驻留等待），fill 走 `workflow fill` 文本拼接 + fork amend 新 runId + 未变节点从 journal 零成本重放（fill wall 411.455 ms、`amendHitEvents: 1`、`hole value: verdict-42`）`[已验证·JSON]`；③ 降级：30 个站点降级成功、0 诊断脚本无拒降级案例；我方 JSON 无独立 lowering 计时 `[未知]`。 |
| **差距诊断** | ① **hole 补全不同构且量级悬殊**：官方进程内同步 `fillHole` payload 换装 **0.635 ms**、无 journal 行（遥测/逆向 v2 §1.4）；我方为持久化 fork-amend（411.455 ms）——这是**定位不同的两族机制**（内存瞬时补全 vs 崩溃可恢复的谱系化修订），不能以快慢论优劣，但「续跑时延」上官方占优 650× `[已验证·JSON + 推断·定位]`；② 我方 fill 为两笔独立写（hole 节点行 + run 行），存在崩溃中间态窗口（逆向 v2 §4.2 漂移 4，P1-3 未落地）`[已验证·源码对照]`；③ 官方 AIMD「有等待者 cap+1」与空闲重置行为在我方探针中同样未覆盖 `[未知]`。 |
| **我方超越点** | ① **多 Provider 故障转移链 + 熔断重试编排**（`retry-orchestrator.ts` / `attempt-classifier.ts`，官方单 driver 端口无此层，逆向 v2 §4.1）`[已验证·源码]`；② **进程树监督 killTree（Windows taskkill /T /F）+ env 双层脱敏 + 工作区逃逸守卫**（逆向 v2 §4.1）`[已验证·源码]`；③ **Intl.DateTimeFormat 封印**：官方沙箱仅封 Date.now/Math.random，我方连格式化侧信道一并封死（逆向 v2 §4 第 13 行「沙箱面我方更严」）`[已验证·源码]`；④ 不可逆脱敏纪律：journal 即掩码权威（redact.ts，逆向 v2 §4.1）`[已验证·源码]`。 |

### 维度四：自愈与反思能效（修复 / 提醒 / 反思轨迹）

| 栏目 | 内容 |
|---|---|
| **官方表现** | ① 预算常量：`REPAIR_ATTEMPTS=3` / `NUDGE_ATTEMPTS=1`（逆向 v2 §1.2 `[已验证·源码]`）；② 修复实测：3 个脚本化提交 `[reject, reject, accept]`、`nodeRepairingEvents [1,1]`、2 轮修复、终值 `{pass:true,risk:"low"}`、wall **92.899 ms**（官方 JSON `repairNudge.repair` `[已验证·JSON]`）；③ nudge 实测：turn 结束未提交 → `nodeNudgedEvents 1`、`[nudge, accept]`、终值同上（`repairNudge.nudge` `[已验证·JSON]`）；④ 任务级自愈：脚本层 healRounds=3（「two malformed rounds healed on round 3」），artifact 与期望一致。 |
| **我方表现** | ① 修复在**同一 ask 节点内**完成（`src/agent/rpc.ts` extractJson/repairJsonString + zod safeParse，maxRetries=3）：3 次 providerCalls、2 轮修复、修复提示语在历史中出现 **3 次**（显式反思面包屑）、终值与官方逐字相同、wall **1.683 ms**（我方 JSON `repairNudge.repair` `[已验证·JSON]`）；② 任务级自愈：healRounds=3，artifact 与期望一致，双引擎产出逐字节同构（`artifactMatchesExpected: true` 两侧）`[已验证·JSON]`；③ nudge：**无对应机制**（JSON 自述 `mechanism: none on this side`，untyped ask 以 provider 终文结算）`[已验证·JSON]`。 |
| **差距诊断** | ① **nudge 边界缺失**是本轮基准新坐实的真实缺口：官方对「turn 结束未提交」有一次提醒预算，我方 typed ask 只在 schema 校验失败路径自愈、untyped 路径无任何提醒 `[已验证·JSON 对照]`；② 修复 wall 92.899 vs 1.683 ms（55×）**不可直接比较**：官方走引擎边界 driver 提交路径（每次尝试独立结算），我方在单节点内 provider 循环，测量基数不同 `[推断·口径]`；③ 反思 token 记账差异：我方修复提示语进历史 = 下轮上下文变长（token 代价 `[未知]`，桩模型不计量），官方经 submit_result schema 校验回传违规信息（载荷结构 `[未知]`）。 |
| **我方超越点** | ① **同等自愈效果更省轮次内开销**：同脚本同桩下 2 轮修复收敛到同一终值，且修复轨迹收敛在**一个 journalled 节点**内（1 行节点 + N 次 provider 调用，journal 行数少于官方按次发 `node-repairing` 事件的模型）`[已验证·JSON + 推断·行数]`；② **修复可见性**：修复提示语逐条留在会话历史（3 条完整可审计）`[已验证·JSON]`；③ token 预算硬顶体系（官方明确移除——刻意分歧保留项）与 escalate 持久化人闸（官方内存 registry 刻意不落盘，立场相反留痕）构成我方「自愈失控兜底」双保险（逆向 v2 §4.1/§5）`[已验证·源码]`。 |

---

## ③ 本轮落地优化与门禁指纹

### 3.1 五项优化落地证据（代码级，本会话逐项 grep 核实 `[已验证·本轮]`）

| 项 | 内容 | 落点 | 配套测试（已编译进 dist 并纳入 test:unit 288） |
|---|---|---|---|
| P0-1 | 9001 facade 站点授权（官方 pass1 最小子集：别名 / 方法抽取 / 解构抽取 / bind-call-apply 拒绝，文案逐字） | `src/dwf/compile.ts:42,210-268` | `tests/unit/dwf-facade-aliasing.test.ts` |
| P0-2 | 重放哈希失配大声失败（同脚本重放 strict；amend 温缓存路径保持 fork 语义） | `src/dwf/engine.ts:91-92,150,1053-1055,1113` | `tests/unit/dwf/dwf-replay-strict.test.ts` |
| P0-3 | amend 分歧单调（首 miss 即对 actor 置 diverged 旗，`dwf_amend_diverged` 每 actor 恰发一次，禁混合前缀） | `src/dwf/engine.ts:142-148,1132-1136` | `tests/unit/dwf/dwf-amend-divergence.test.ts` |
| P1-1 | AIMD epoch 批次阻尼 + admittedEpochs FIFO 配对 + lastGood/lastBad 双水位 + Retry-After 冷却 | `src/dwf/governor.ts:5-9,39-49,62-67,75-87` | `tests/unit/dwf-governor-aimd.test.ts` + 既有 `tests/integration/dwf-registry-aimd.test.ts` 增补 |
| P1-2 | Schema REJECTED_BUILTINS 黑名单（Date/RegExp 等按名拒绝）+ MAX_UNION 对齐官方 100 | `src/dwf/schema-synth.ts:27,35-47,152-157` | `tests/unit/dwf-schema-builtins.test.ts` |

- 改动面 `[已验证·git diff --numstat，本会话]`：6 文件修改，合计 **373 insertions / 35 deletions**，分文件精确增删为：`compile.ts +150/−0`、`engine.ts +86/−13`、`governor.ts +71/−9`、`schema-synth.ts +36/−2`、`tests/integration/dwf-registry-aimd.test.ts +14/−3`、`tests/unit/dwf/dwf-replay.test.ts +16/−8`（自检：150+86+71+36+14+16 = 373，0+13+9+2+3+8 = 35，与合计逐数相符）。注意口径：`git diff --stat` 数字列是「增+删合计变更行」（如 compile.ts 150），**不等于插入数**——精确增删以 `--numstat` 两列为准。另 5 个新测试文件未跟踪。
- 附注：5 个新测试以 TS 源直跑（裸 `node --test` 无 `--experimental-strip-types`）会因加载器缺失报错——`test:unit` 门禁走 `dist/tests/unit/**/*.test.js` 编译产物，5 个文件全部在内且通过（本会话另以 `node --test dist/tests/unit/dwf/dwf-amend-divergence.test.js dwf-replay-strict.test.js` 定向复跑 **pass 6 / fail 0** 验证）`[已验证·本轮]`。

### 3.2 门禁指纹（本撰写会话在 WT 内实跑，命令逐条见 §5）`[已验证]`

| 门禁 | 命令 | 结果指纹 |
|---|---|---|
| 静态构建 | `npm.cmd run build`（tsc） | **exit 0，0 错误**（无输出即无诊断） |
| 单元 + 集成 | `npm.cmd run test:unit` | **tests 288，pass 288，fail 0**，cancelled 0 / skipped 0，duration_ms 9766.36 |
| 性质测试（PBT） | `npm.cmd run test:pbt` | **tests 5，pass 5，fail 0**，duration_ms 2268.08（5 条核心不变式含 Schema 契约 100% 类型健全、事件日志单调序、凭证脱敏） |
| 治理锁死 | `node --experimental-strip-types tests/unit/workflow-governance.test.ts` | **tests 24，pass 24，fail 0** |
| E2E 场景 | `node --experimental-strip-types tests/e2e/runner.ts` | **121 / 121 passed，0 failed**（Tier1 50 + Tier2 50 + Tier3 15 + Tier4 6），wall 42720 ms，`[TEST_RUNNER_SUCCESS]` |

- 测试副产物处置 `[已验证·本轮]`：运行后 `tests/unit/fixtures/` 出现 7 处运行时改写，已按《AGENTS.md》§四.7 执行 `git restore tests/unit/fixtures/` 还原，`git status --porcelain` 恢复为仅含本 Issue 在册改动（4 源文件 + 2 既有测试 + 本报告与两份研究文档 + tests/cross-engine/ + 5 个新测试）。

---

## ④ 剩余差距与后续演进路线

**已收窄（本轮 P0-1/P0-2/P0-3/P1-1/P1-2 之后）**：9001 站点授权缺口（逆向 v2 §4 第 8 行「最大缺口」）闭合；重放键模型的大声失败防御（漂移 1）在**同脚本重放**路径闭合；AIMD 结构差距（漂移 6 的 epoch 阻尼与双水位）闭合；Schema 内建类型黑名单与 union 上限（§4 第 10 行两项）闭合。

**仍开放的差距（按优先级）**：

1. **nudge 边界缺失**（本轮基准新坐实）：官方 `NUDGE_ATTEMPTS=1` 对「turn 结束未提交」有一次提醒；我方 typed/untyped 均无对应物。建议：在 typed-ask 校验路径补「turn 结束未提交」探测与单次提醒预算，或在文档明示立场分歧并留痕。
2. **fill 两笔写崩溃窗口**（漂移 4 / P1-3 未落地）：hole 节点行 + run 行 completed 应收敛为单事务（SQLite 同事务两写）。
3. **出生阶段戳**（P1-4 未落地）：dwf 事件族补 phaseName，view 按戳归组替代墙钟重建——收窄与官方的事件模型口径差（全量词汇官方 27 种 RunEvent vs 我方 25 种 dwf_*，逆向 v2 §1.6/§4 第 6 行；本基准场景内出现数为官方 10 类 vs 我方 7 类，两口径区分见维度二·差距诊断③）。
4. **messageBoundary 会话种子**（P1-5 评估项）：官方 amend 后新 ask 可见前驱上下文，我方 amend 重放只回填结果——逆向 v2 已注明需先验证我方 provider 链可移植性再动。
5. **9xxx 码位冲突表未发布**（漂移 5 余项）：P0-1 已使 9001 双侧同义，但 9002/9004/9010 等仍同码不同义，跨工具消费诊断必炸——需在 docs 发布逐码对照表。
6. **冷编译 3.2× 劣势**（211.506 vs 66.444 ms）：根因未归因 `[未知]`，候选方向为虚拟 host lib 装载与 program 构建策略；顺带补齐我方 JSON 缺失的独立 lowering 计时字段。
7. **AIMD 增长分支双侧未验证**（`[未知]` 双侧同病）：「有等待者 cap+1」与空闲重置行为需补一等价探针；同时我方默认并发公式 floor（`min(16,max(2,cores-2))` vs 官方 `max(4,min(16,cores-2))`，漂移 6 余项）待裁决。
8. **queueWait 派生口径**：我方 `queueWaitMs` 为算术派生（`queueWaitDerived: true`），建议在事件流补原生 queued→dispatched 时间戳对，消除与官方口径差与首轮毛刺疑云。

**刻意分歧保留项（不跟齐、留痕）**：Token 预算硬顶（官方移除）；Intl 封印与原型链封禁（我方更严）；pid 探针孤儿收敛（物理事实优于会话归属推断）；escalate 持久化（立场相反，文档互注）；多 Provider 故障转移（官方无）；hole fork-amend 持久谱系（官方内存瞬时）。

---

## ⑤ 证据索引

### 5.1 本会话实际运行的命令与输出指纹（WT 目录下执行）

| # | 命令 | 输出摘录 |
|---|---|---|
| E1 | `npm.cmd run build` | tsc 静默通过，exit 0 |
| E2 | `npm.cmd run test:unit` | `ℹ tests 288 / ℹ pass 288 / ℹ fail 0 / ℹ duration_ms 9766.3616` |
| E3 | `npm.cmd run test:pbt` | `ℹ tests 5 / ℹ pass 5 / ℹ fail 0 / ℹ duration_ms 2268.083` |
| E4 | `node --experimental-strip-types tests/unit/workflow-governance.test.ts` | `ℹ tests 24 / ℹ pass 24 / ℹ fail 0` |
| E5 | `node --experimental-strip-types tests/e2e/runner.ts` | `Total Test Cases Executed: 121 / Passed: 121 / Failed: 0`，`[TEST_RUNNER_SUCCESS]` |
| E6 | `git restore tests/unit/fixtures/` 后 `git status --porcelain` | 恢复为仅含 Issue #67 在册改动 |
| E7 | `git diff --stat` / `git diff --numstat` | `6 files changed, 373 insertions(+), 35 deletions(-)`；numstat 分文件：`150 0 compile.ts`、`86 13 engine.ts`、`71 9 governor.ts`、`36 2 schema-synth.ts`、`14 3 tests/integration/dwf-registry-aimd.test.ts`、`16 8 tests/unit/dwf/dwf-replay.test.ts`（精确增删以此为准，--stat 数字列为增删合计） |
| E8 | `grep -n` 五项优化标记（compile.ts / engine.ts / governor.ts / schema-synth.ts，行号见 §3.1） | 5/5 命中 |
| E9 | `node --test dist/tests/unit/dwf/dwf-amend-divergence.test.js dist/tests/unit/dwf/dwf-replay-strict.test.js` | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`（P0-2/P0-3 定向复证） |

### 5.2 输入材料文件（全部数字的出处）

| 文件 | 用途 |
|---|---|
| `WT/docs/research/OFFICIAL-WORKFLOW-TELEMETRY.md` | 阶段二 Ground Truth：官方套件指纹（2034 测试 2030 首跑通过、4 项环境性失败、定向重跑 131/131）`[转述·未复验：来源=任务指令，遥测 §2 自述其撰写会话亦未重跑全量套件，本撰写会话同样未重跑——按本文 §纪律不标「已验证」]`、Probe A/B/C 全部官方侧引擎/AIMD/编译数值 `[已验证·遥测 JSON]` |
| `WT/tests/cross-engine/results/official-cross-benchmark.json` | 阶段四官方轨实测：任务 wall/事件/确定性/修复/nudge/hole/内存 |
| `WT/tests/cross-engine/results/ours-cross-benchmark.json` | 阶段四我方轨实测：同上 + crossCompare 跨引擎归一化对比 |
| `WT/docs/research/ZCODE-DEEP-REVERSE-v2.md` | §4 缺口矩阵 13 行 / §4.1 我方独有机制 / §4.2 漂移 14 条 / §5 P0×3+P1×5 优化清单与刻意分歧保留项 |

### 5.3 本会话代码级核实（grep 行号，WT 内）

- P0-1：`src/dwf/compile.ts:42`（机制注释）、`:210,212`（标识符引用扫描）、`:231-236`（方法抽取）、`:240-244`（bind/call/apply）、`:265-268`（解构抽取）。
- P0-2：`src/dwf/engine.ts:91-92`（池命中/失配语义）、`:150`（P0-2 strict 开关注释）、`:1113`（失配大声失败分支）。
- P0-3：`src/dwf/engine.ts:142-148`（divergedActors 定义与每 actor 一次 `dwf_amend_diverged`）、`:1132-1136`（take 失配或越前缀即分歧）。
- P1-1：`src/dwf/governor.ts:5-9`（epoch 阻尼与 lastGood 语义头注）、`:39-49`（epoch/admittedEpochs/lastGood/lastThrottledAt/cooldownUntil 字段）、`:62-67`（构造默认参 max=8/increaseAfter=4/decreaseFactor=0.75/idleResetMs）、`:75-87`（`acquire` 准入盖 epoch 戳 `:78` + 冷却唤醒定时器）。
- P1-2：`src/dwf/schema-synth.ts:25-27`（`MAX_UNION = 100` 对齐官方 `schema/types.ts:90`）、`:35-47`（REJECTED_BUILTINS 集合与判定函数）、`:152-157`（按名拒绝 + 可执行修复文案）。

### 5.4 本会话未能完成 / 未测得的事项（如实）

- 我方 JSON 无独立 lowering（降级）耗时字段 → 该项对比 `[未知]`。
- 官方 AIMD「有等待者 cap+1」增长分支与空闲重置行为：双侧探针均未构造等待者 → `[未知]`。
- 官方 `run-settled` 事件逐条顺序（「必须是最后一条」主张）：官方 JSON 导出了 `eventTypeSequence`（基准场景内可见 `run-settled` 居末 `[已验证·JSON]`），但遥测 Probe A 场景未导出逐条顺序 → 该探针口径 `[未知]`。
- 官方全量套件指纹（2034/2030 等）：来源为任务指令给出的前序实跑记录（遥测 §2 明示），本撰写会话**未重跑**官方套件。
- 修复路径 token 消耗：桩模型不计量 → `[未知]`。

---

## 修订说明（独立审读意见逐条处理留痕）

> 本节记录第一轮独立审读的 6 条意见与处理结果。**6 条全部采纳、0 条驳回**；每条注明核实证据与修订落点。

| # | 审读意见 | 处理 | 核实证据与修订落点 |
|---|---|---|---|
| 1 | 确定性项数前后矛盾（摘要「五项全 true」vs 维度二我方「四项全 true」） | **采纳修正** | 实况：官方 JSON `determinism` 5 键、我方 4 键——我方缺 `journalEventSequenceIdentical` 一键（我方 JSON 未导出 `journalEventSequence` 字段，只导出 `journalNodes/journalAskNodes` 计数），是**键缺席而非真值差异**。已改摘要第 1 条并在我方表现①补键名级说明。 |
| 2 | 改动面 408 ≠ 373 自相矛盾 | **采纳修正** | 根因：`git diff --stat` 数字列是「增+删合计变更行」（compile.ts 150 = 150+0），此前误当插入数加总。已改用 `git diff --numstat` 精确两列（`compile.ts +150/−0、engine.ts +86/−13、governor.ts +71/−9、schema-synth.ts +36/−2、aimd 测试 +14/−3、replay 测试 +16/−8`），并自检 150+86+71+36+14+16=373、0+13+9+2+3+8=35 逐数相符；§3.1 与 §5.2 E7 同步改写并注明口径。 |
| 3 | 官方事件词汇数两处口径冲突（10 vs 27） | **采纳修正** | 两数本是两个口径：10 = 基准场景内出现的官方事件类型数（官方 JSON `eventCounts` 键数）；27 = 官方引擎全量 RunEvent 词汇（逆向 v2 §1.6）；我方对应为场景内 7 类、全量 25 种 dwf_*（逆向 v2 §4 第 6 行）。已在维度二·差距诊断③显式区分两口径，§4 第 3 条改为双口径表述。 |
| 4 | 「同任务同脚本同桩」下降级站点 20 vs 30、事件 70 vs 56 未对账 | **采纳补齐** | 已在维度二·差距诊断首项新增「跨引擎对账」块：**(a)** 任务脚本静态调用构成 4 phase + 6 agent + 10 ask + 4 report + 6 log（`tests/cross-engine/cross-benchmark-mission.facade.ts:34-85` 源码核对）；官方站点 = actor×6+ask×10+report×4 = 20（官方 phase/log 无站点号，逆向 v2 §2.4/§2.7），我方逐 facade 调用发号 4+6+10+4+6 = 30（我方 JSON `crossCompare.note` 自述；ask 序号最大 #26 与逐调用编号闭合）——**降级函数面同构（10 ask 一一对应），差异是编号方案**。**(b)** 事件 70 vs 56 逐条分解：共享骨架 20 条 + 每 ask 官方 4 条×12=48 vs 我方 3 条×12=36 + 官方 run 边界 2 条 = 70/56，差 14 = 12×1 + 2，**纯事件模型结构差、零行为分叉**。**(c)** 确定性键 5 vs 4 同块收口。维度一两处 20/30 并加对账交叉引用。 |
| 5 | P1-1 证据指针不一致（§3.1 写 65-87，他处写 75-87） | **采纳统一** | 以 `sed -n '60,90p' src/dwf/governor.ts` 核对原文：`:62-67` = 构造默认参（max=8/increaseAfter=4/decreaseFactor=0.75/idleResetMs），`:75-87` = `acquire` 准入盖戳（`:78` admittedEpochs.push）与冷却唤醒。三处（§3.1 表、维度二、§5.3）统一为 `governor.ts:5-9,39-49,62-67,75-87`，§5.3 补行段语义。 |
| 6 | 官方套件指纹标「已验证·来源=任务指令」与本文纪律冲突 | **采纳修正** | 该标签沿用了遥测文档自身口径，但按本报告头部自订三档纪律，未经本会话复跑的转述不应标「已验证」。§5.2 已改为 `[转述·未复验：来源=任务指令，遥测 §2 自述其撰写会话亦未重跑全量套件，本撰写会话同样未重跑]`；遥测 Probe A/B/C 数值仍标 `[已验证·遥测 JSON]`（有可复现命令支撑，性质不同）。 |
