# Facade 脚本编排模式目录（Authoring Patterns）

> 面向 `src/dwf` facade DSL（`agent().ask<T>` / `phase` / `files` / `git` / `world.run` / `hole<T>` / `escalate` / `--amend` / `--resume`）。
> 体例借鉴 zircote《Dynamic Workflow Design Patterns》（2026-07，GoF 式四族分类 + 反模式命名）与
> [zircote/workflows-plugin](https://github.com/zircote/workflows-plugin) 的"机制与词汇分层"实践；
> 所有模式均已改写为本引擎的原语与语义，示例可直接作为 facade 脚本骨架。

## 四族总览

| 族 | 解决什么 | 模式 |
| --- | --- | --- |
| I 结构 | 工作怎么分块、怎么流动 | Fan-out/Join · Pipeline · Map-Reduce · Planner-Reviewer |
| II 行为 | 控制权怎么转移 | Race-and-Cancel · Retry-Gate-Loop · Hot-Path Short-Circuit |
| III 验证 | 结论怎么变可信 | Confirm-Per-Finding · Judge Panel · Deterministic Gate |
| IV 契约 | 运行怎么与人和未来交互 | Human Escalation · Hole Growth · Amend Lineage |

---

## Family I：结构模式

### 1. Fan-out / Join（扇出合流）
独立项各发一个子代理，`Promise.all` 合流。项间无一致性问题 → 每项独立 actor（并发、缓存友好）。
```ts
const reviews = await Promise.all(
  paths.map((p) => agent(`reviewer-${p}`).ask<Review>(`Review ${p}`)),
);
```
**反模式**：把 `agent()` 提到循环外"复用" —— 扇出退化成 FIFO 队列（我们的 per-actor FIFO 会让它串行）。

### 2. Pipeline（流水线）
下一阶段逐项消费，不等全体。`ask` 返回 `Node<T>`（PromiseLike），把阶段的 promise 串起来即可；确需栅栏（去重/排序/汇总）才 `Promise.all`。

### 3. Map-Reduce
扇出产中间值 → 单一 reducer 汇总。reducer 用**同一个** actor 保持口径一致（per-actor FIFO 天然序列化）。

### 4. Planner-Reviewer（规划-评审环）
```ts
const planner = agent("planner");
let feedback = "none";
for (let round = 1; round <= 3; round++) {
  const plan = await planner.ask<Plan>(`Round ${round}. Previous critique: ${feedback}`);
  const review = await agent("reviewer").ask<Review>(`What breaks this plan? ${JSON.stringify(plan)}`);
  if (review.approved) break;
  feedback = review.comments;
}
```
持久 actor（ask#2 能看到 ask#1）让 round 3 便宜；评审员问"什么会坏"而不是"好不好"。

## Family II：行为模式

### 5. Race-and-Cancel
同一问题发多路，先到先得。JS 原生 `Promise.any`；败者 ask 照常落 journal，不浪费重放。

### 6. Retry-Gate-Loop（确定性门驱动的重试环）
```ts
for (let round = 1; round <= 5; round++) {
  const fix = await agent("fixer").ask<Fix>(`Tests failed:\n${gate.stderr}\nFix them.`);
  gate = await world.run("npm", ["test"]);
  if (gate.exitCode === 0) break;
}
```
`world.run` 命令名是编译期字面量（进审批集）；退出码是值不是异常。

### 7. Hot-Path Short-Circuit（热路径短路）
typed 结果 + 确定性分支：confidence 低/审批拒绝 → 提前 `return`，省掉全部下游（参考任意 triage 型 facade 的 `triage.confidence < 0.5` 分支写法）。

## Family III：验证模式

### 8. Confirm-Per-Finding（逐发现复核，对抗收敛）
发现者不复核自己的发现：每条要动手改的 finding 由独立子代理仅凭证据复现；复现失败标 `unconfirmed` 保留而非丢弃。这是官方"agents attempt to refute each other's findings"的本引擎写法。

### 9. Judge Panel（评审团）
N 个独立 lens 的评审各给结构化裁决（不同视角：正确性/安全/性能），单数 judge 汇总 —— 视角分离，避免相关评审员盲区叠加。

### 10. Deterministic Gate（确定性门）
凡命令能裁决的就不问子代理：`world.run` 退出码即证据，journal 可重放。子代理的断言永远次于门。

## Family IV：契约模式

### 11. Human Escalation（人机闸门）
`await escalate(question)` —— 停靠 + `workflow answer` 回填。用于：只有运行主人知道的事实、无法满足的门、需要业务拍板的分叉。答案权在 journal 里，重放不再问。

### 12. Hole Growth（探索后生长）
`hole<T>(name, prompt)` —— 形状未知时写到知道为止，停下填代码。**hole 是代码（可含 facade 调用）**，escalation 是文本；两者共用停靠/journal/amend 基建。

### 13. Amend Lineage（修订血缘）
改一行脚本 → `--amend <runId>` fork：未变节点 ♻ 零调用重放，变更子树 ⑂ 自然级联（下游 prompt 插值变了就重跑）。`--resume`（同脚本）hash 不符会大声失败 —— 那是它在对你说"该用 --amend"。

---

## 反模式速查（8 条，命名即提醒）

| 反模式 | 症状 | 解法 |
| --- | --- | --- |
| Barrier Abuse | 到处 `Promise.all`，slot 空转 | 逐项串联，仅真正需要全体时合流 |
| Impatient Monitor | 轮询进度/睡眠等待 | 事件驱动：run 事件 + journal |
| Hidden Clock | `Date.now`/`Math.random`（编译期 9002 拒绝） | 时间与随机经 `args` 传入 |
| Context Flood | 把整个文件塞进 prompt | 传路径，子代理自己 `files.read` |
| Mid-Run Conversation | 在 ask 的 systemPrompt 里塞历史 | 持久 actor 已经做了：共享同一 `agent()` 值 |
| Unbounded Loop | `while(true)` 等收敛 | 一切循环带上限（run 会杀超时） |
| Free-Text Parsing | ask 返回裸 string 再正则拆 | ask<T> 结构化 + JSDoc 字段描述 |
| Monolithic Agent | 一个 agent 干五件事 | 按角色拆 actor，持久会话按角色复用 |

## 选择指南（速查）

- **项独立且结果可信**？→ Fan-out（1）
- **下一步取决于发现**？→ 先写到知道为止 + Hole（12）
- **结论要被人拿去动手**？→ Confirm-Per-Finding（8）或确定性门（10）
- **要人拍板**？→ Escalation（11）；要人写策略？→ Hole（12）
- **改了脚本不想全跑**？→ Amend（13）
