# 官方 Dynamic Workflow vs AI-workflow · 4 大双轨场景基准报告

> **版本**：1.0（2026-11-02）
> **对照对象**：Claude Code `@anthropic-ai/claude-code@2.1.316` vs 本仓 `main`（含 PR #56/#58/#60/#62）
> **证据等级**：`[已验证]` / `[推断]` / `[未知]`；未实测的数据不填数字。
> **结论先行**：4 个场景中，**只有场景 4（3 级嵌套）完成了真正的同台实测**；场景 2/3 是源码 + 单测级证据；场景 1（真实模型大规模重构）因缺受控 API Key 与 Claude CLI provider，明确列为 C 类受阻。

---

## 0. 总览

| # | 场景 | 官方 | 本仓 | 判定 |
|---|---|---|---|---|
| 1 | 15 文件 TypeScript 重构（机械 + 架构 + monorepo + 多仓） | 机械 469,040/38/27.8s；架构 486,152/41/28.3s；monorepo 486,554/57/44.0s；多仓 585,832/111/196.4s | 机械 3,579/0/8.1s；架构 5,233/0/12.5s；monorepo 5,188/0/10.7s；多仓 4,987/0/11.75s | **四组均真实模型同台，双方全部正确** |
| 2 | 429 限流 + 60s 超时 | 源码级（45s throttle / 90s stall / 5 retries）；live 注入未做 | **live 注入：1 次 429 → 2,013ms 后重试成功**；单测/集成覆盖 | **本仓 live，官方源级** |
| 3 | 5 步 Amend Replay | 源码级结构哈希；真实模型 2 轮各 5 agents（跨调用 0 复用） | 真实模型 5→2 live，3 个 amend 复用 | **真实模型部分同台**（§4.3） |
| 4 | 3 级父子 Agent 嵌套 | **实测硬拒绝** | **实测 3 级成功** | **本仓胜出** |

---

## 1. 方法与边界

- 官方侧：`workflow-module-pretty.js` 逐函数精读 + 本会话 Workflow 工具黑盒探针。
- 本仓侧：worktree 内真实 `npm test` / E2E / 对抗测试 + MCP facade 实跑。
- **已做**：真实模型 5 步 amend 双轨（§4.3，2026-11-02，经本机企业网关）。
- **未做**：15 文件大规模重构的真实模型基准、官方 429 注入；本仓 CLI provider 只支持 codex/gemini/opencode，不支持本机 `claude` CLI。
- 所有“官方更强/本仓更强”的判断都附源码行号或测试指纹；没有数据的格子写 `[未知]`。

### 1.1 公开源检索（仅记录，不克隆）

2026-11-02 用 `gh search repos` 检索到的公开镜像/研究仓（按关键字分组，仅记录 URL 与描述，不克隆、不复制）：

| 仓库 | 描述 |
|---|---|
| `alanisme/claude-code-decompiled` | Claude Code 源码分析报告（架构/agent loop/工具/提示词等） |
| `liangkang/claude-code` | “claude code Decompiled Restored” |
| `veryos/claude-code-unpacked` | 源码分析与文档镜像 |
| `h26liu/claude-code-unpacked` | clean-room reconstruction（架构/提示词/agents/skills） |
| `gallifreyCar/claude-code-unpacked-i18n` | 多语言解包 |
| `TasosY2K/claude-code-source-leak` | 声称从 npm source map 泄露的源码 |
| `rayzhux/claude-code-source-leak`、`serein-213/claude-code-source-leak`、`zhb7670/claude-code-source-leak`、`naufalelghani/claude-code-source-leak`、`Julian-glitch-alt/Claude-Code-Source-leaked` | 同类泄露镜像 |
| `harvenstar/claude-verify-agent` | 基于泄露源提取 internal agents 的对抗验证 |

**清洁室决定**：不克隆上述泄露仓库，也不把其代码复制进本仓；本文所有官方行号均来自 `@anthropic-ai/claude-code@2.1.316` 的自购 npm 包解包件（`workflow-module-pretty.js`）。`h26liu/claude-code-unpacked` 标注为 clean-room reconstruction，仅作为概念交叉参考，未复制。

---

## 2. 场景 1：15 文件大规模重构

### 2.1 计划中的指标

- 步数收敛率（完成同一重构所需 agent 调用数）
- 上下文总 token / 输出 token
- 代码可读性与“无夹带”保证（diff 范围）

### 2.2 真实模型实测（2026-11-02） `[已验证]`

fixture：15 个 `src/modules/mNN.ts`，每个含本地重复的 `validateAmount` 与 `processNN`；目标是把本地函数替换为 `import { validateAmount } from '../shared/validate'`，行为不变。校验：`tsc --strict` + 30 条行为断言。

| 轨道 | 并发单元 | tokens | tool uses | 用时 | 正确性 |
|---|---|---|---|---|---|
| 官方 Workflow（`claude-haiku-5-5`，5 agents × 3 文件，工具改文件） | 5 agents | 469,040 | 38 | 27.77s（agents） | **15/15**，tsc 0，check OK |
| 本仓 facade（网关 `bailian/deepseek-v4.1-flash-1017`，5 asks × 3 文件，harness 写盘） | 5 asks | 3,579 | 0 | 8.10s（engine）/ 9.43s（含 tsc/check） | **15/15**，tsc 0，check OK |

- 本仓 runId：`dwfrun-mvzghahc-973867`；官方 Workflow run `wf_8169662e-17c`（agent_count 5、tokens 469,040、tool_uses 38、duration 27,766ms）。
- 官方 15 个文件全部 `import` 共享 helper、无本地 `function validateAmount`；本仓 15 个文件同样全部正确。
- 复现 harness：原 `bench/refactor-15/`（`generate.mjs`、`ours-refactor.facade.ts`、`run-ours.mjs`）——已于 2026-11-09 仓库精简时移除（Issue #205），实测数字保留在本文。

### 2.3 边界

- 官方 agent 自带工具/大系统提示，38 tool uses 与 469k tokens 含 harness 开销；本仓是文本-only，文件写入由 `run-ours.mjs` 完成。**不是纯模型效率对比**，而是“官方工具改文件 vs 本仓返回内容 + harness 写盘”的真实形态。
- §2.2 是机械式 15 文件去重；架构级变体见 §2.4。
- 本仓 `stats.asks` 与 token 来自 journal evidence；官方无本地 token 细分，只有 Workflow 工具的 agent/token/tool 汇总。

### 2.4 架构重构变体（2026-11-03） `[已验证]`

fixture：15 文件（`core/money.ts`、`pricing.ts`、`discount.ts`、11 个 `domain/orderNN.ts`、`main.ts`）。`pricing ↔ discount` 是 **type-only 循环依赖**；11 个 order 各自重复 `Money`/`formatMoney`。

任务：新建 `core/contracts.ts` 抽出 `PriceBreakdown`/`DiscountRule`，拆掉 pricing/discount 互相 import；11 个 order 改用 `core/money`；行为输出不变。验收：tsc + check + contracts 存在 + 环拆除 + 11 orders 统一。

| 轨道 | 并发单元 | tokens | tool uses | 用时 | 正确性 |
|---|---|---|---|---|---|
| 官方 Workflow（`claude-haiku-5-5`，5 agents） | 5 agents | 486,152 | 41 | 28.29s | **全部通过** |
| 本仓 facade（网关 `bailian/deepseek-v4.1-flash-1017`，5 asks） | 5 asks | 5,233 | 0 | 12.5s（含 tsc/check） | **全部通过** |

- 本仓 runId `dwfrun-mvzz2mj4-a334ef`；官方 run `wf_eec064c7-500`（agent_count 5、tokens 486,152、tool_uses 41、duration 28,289ms）。
- 边界同 §2.3：官方带工具/大系统提示，本仓文本-only + harness 写盘；不是纯模型效率对比。
- 官方 group 5 的 agent 指出 `src/domain/main.ts` 不存在（实际是 `src/main.ts`），但 main.ts 无需改动；提交版脚本已修正路径。

### 2.5 跨包 monorepo 契约重构（2026-11-03） `[已验证]`

fixture：3 包布局（`packages/contracts`、`packages/pricing`、`packages/orders` + `apps/api`），15 文件。初始 `pricing.getPrice(n, currency): number`，11 个 order 各自重复 `Money`/`formatMoney`。

任务（跨包 API 契约变更）：contracts 增加 `Money`/`formatMoney`；pricing 改为返回 `Money`；11 个 order 改用新契约；`apps/api` 行为输出不变。验收：tsc、check、contracts 契约、pricing 返回 Money、11 orders 无本地重复。

| 轨道 | 并发单元 | tokens | tool uses | 用时 | 正确性 |
|---|---|---|---|---|---|
| 官方 Workflow（`claude-haiku-5-5`，5 agents） | 5 agents | 486,554 | 57 | 44.0s | **全部通过** |
| 本仓 facade（网关 `bailian/deepseek-v4.1-flash-1017`，5 asks） | 5 asks | 5,188 | 0 | 10.7s | **全部通过** |

- 本仓 runId `dwfrun-mw002ygw-922a4f`；官方 run `wf_e3f7d931-f4d`（agent_count 5、tokens 486,554、tool_uses 57、duration 43,997ms）。
- 边界同 §2.3/§2.4：官方带工具/大系统提示，本仓文本-only + harness 写盘；不是纯模型效率对比。

### 2.6 跨组织多仓契约重构（2026-11-03） `[已验证]`

fixture：4 个独立本地 repo（`contracts-repo`、`pricing-repo`、`orders-repo`、`apps/api-repo`），通过 `node_modules/@bench/*` 联结模拟 npm link；按 contracts → pricing → orders → api 顺序构建。

任务：跨仓契约变更——contracts 增加 `Money`/`formatMoney`；pricing 的 `getPrice` 从 `number` 改为 `Money`；11 个 order 改用 `@bench/contracts`；api 行为不变。验收：4 仓 tsc、check、contracts 契约、pricing 返回 Money、11 orders 无本地重复。

| 轨道 | 并发单元 | tokens | tool uses | 用时 | 正确性 |
|---|---|---|---|---|---|
| 官方 Workflow（`claude-haiku-5-5`，6 agents） | 6 agents | 585,832 | 111 | 196.4s | **全部通过** |
| 本仓 facade（网关 `bailian/deepseek-v4.1-flash-1017`，6 asks） | 6 asks | 4,987 | 0 | 11.75s | **全部通过** |

- 本仓 runId `dwfrun-mw04xkem-800e04`；官方 run `wf_83adf734-a2d`（agent_count 6、tokens 585,832、tool_uses 111、duration 196,393ms）。
- 边界同 §2.3-§2.5：官方带工具/大系统提示，本仓文本-only + harness 写盘；不是纯模型效率对比。
- 官方侧在首次编译时 group 5 尚未写完（order10/11 仍报 TS2322），等待 agent 完成并重新编译后 4 仓全部通过；这是跨仓并行写入的时序现象，不是最终失败。

---

## 3. 场景 2：429 限流 + 60s 超时

### 3.1 官方机制（源码级）`[已验证]`

- 429/throttle：先等待约 45s，重发 `${label} (throttle-retry)`；再退化则放弃 throttle 退避。
- stalled：`Mi=90000ms` 无进展判定，最多 `Xr=5` 次重试，重发 `${label} (retry N)`。
- reply lost：响应流静默结束、Claude Code 放弃等待，与 stalled 分开文案。
- usage-limit：基于结构化 `quotaLimits.resetsAt` 最多等待 2 次。
- 源码：官方解包件（语义锚：重试上限与停滞超时常量、throttle/retry/abandon 文案段）。

### 3.2 本仓机制（测试级）`[已验证]`

- `attempt-classifier.ts`：429 退避（Retry-After 感知）、transient 快重试、quota/auth policy-stop。
- `retry-orchestrator.ts`：每 provider/总 attempt 预算、circuit breaker、failover 链。
- `stallMs`（#59）：默认 90000ms，`AI_WORKFLOW_STALL_MS` 覆盖，`0` 关闭；`StallError` 重试带 `(Retry N after no progress ...)`。
- 测试：
  - `tests/unit/dwf/dwf-stall.test.ts` → 2/2（重试标记 + `stallMs=0`）
  - `tests/integration/dwf-stall.test.ts` → 2/2（facade run 失败/关闭）
  - `tests/unit/dwf/retry-policy.test.ts`、`attempt-classifier.test.ts` 覆盖 429/transient/quota 分类。

### 3.3 本仓 live 429 注入（2026-11-03） `[已验证]`

本机代理 `127.0.0.1:3426` 对首个 `POST /v1/messages` 返回 `429` + `Retry-After: 2`，随后转发到真实网关；facade 只发一个 ask。

```text
injected-429  074429
forward       076442   # 2,013ms later
run completed in 3.09s; asks: 1; result {"value":"ok"}
runId dwfrun-mvzxvgxy-cc9bda
```

- 引擎在 429 后 **2,013ms** 重试（与 Retry-After: 2 一致），随后成功；整个 run 3.87s（含代理/CLI 启动）。
- `asks: 1`——重试发生在 rpc 内部，不新增 journal ask。
- 复现：原 `bench/rate-limit-429/`（429 注入代理 + ask facade 脚本，env-only）——已于 2026-11-09 仓库精简时移除（Issue #205）。

### 3.4 未同台的部分 `[未知]`

- **官方 live 429 注入未做**：官方 Workflow 使用宿主模型的 `ANTHROPIC_BASE_URL`；把它指向注入代理需要修改宿主设置并重启会话，风险高，本轮刻意不改用户配置。官方侧仍为源码级（45s throttle / 90s stall / 5 retries）。
- 官方无本地重试计数器/逐次时间戳；只能看最终 wall 与日志。
- 结论：**本仓 live 验证了 Retry-After 遵守；官方仍为源级，二者不同台**。

---

## 4. 场景 3：5 步 Amend Replay

### 4.1 官方 `[已验证]`（源码）

- 重放键结构哈希（slot/fork/join/replaced 语义），把 prompt + 7 字段 opts 哈希成 `v2:` 键（语义锚：官方解包件重放键实现段）。
- 前序步骤微调 → 后续链式键全量失效；无本仓式局部 amend `[推断，基于结构哈希的链式 prev]`。

### 4.2 本仓 `[已验证]`（测试）

- `(siteId, ordinal, inputHash)` 显式键 + journal 池；amend 时 `inputHash` 命中零成本重放，不匹配标 diverged 并实跑。
- 测试：`tests/integration/dwf-run.test.ts`、`dwf-failed-node.test.ts`、e2e Tier 3 replay；`--resume`/`--amend` 都有零 provider 调用断言。
- 事件：`dwf_replay_hit`、`dwf_amend_hit`、`dwf_amend_diverged`。

### 4.3 真实模型实测（2026-11-02） `[已验证]`

任务：5 个顺序步骤，每步返回一个固定 JSON；第二次仅把 step 3 的 prompt 改为 `"s3-EDITED"`。

**官方 Workflow 工具**（`agent(..., {model:'claude-haiku-5-5'})`，5 个顺序 agent）：

| 轮次 | agent 数 | subagent tokens | wall |
|---|---|---|---|
| run 1（原 step 3） | 5 | 469,249 | 16.2s |
| run 2（改 step 3） | 5 | 469,260 | 17.9s |
| 合计 | **10** | **938,509** | **34.1s** |

run 2 仍是 5 个 agent——**跨两次顶层 Workflow 调用 0 复用**。

**本仓 facade**（`agent(...,{provider:"anthropic"})`，网关模型 `bailian/deepseek-v4.1-flash-1017`）：

| 轮次 | live asks | prompt tokens | completion tokens | total | wall |
|---|---|---|---|---|---|
| run 1 | 5 | 541 | 35 | 576 | 3.32s |
| amend（改 step 3） | 2 | 228 | 17 | 245 | 1.63s |
| 合计 | **7** | **769** | **52** | **821** | **4.95s** |

amend 事件：step 1/2/5 `♻ amended run reused`（0 provider calls），step 3/4 `⑂ diverged` 实跑。step 5 虽在 step 4 之后，但因 step 4 输出未变、`inputHash` 命中而复用——这是 `(siteId, ordinal, inputHash)` 的局部失效优势。

runId：`dwfrun-mvzfd4sp-a1848c`（run 1）、`dwfrun-mvzfd83e-7e359a`（amend）。

### 4.4 边界与不可比项

- 官方 agent 自带工具与大系统提示，469k tokens 含大量 harness 开销；本仓 agent 是文本-only，二者**不是纯模型效率对比**，但“同任务、同 5 步、同宿主模型映射”下的真实用量/墙钟有效。
- 官方无本地 amend/replay 计数器，只能看 agent_count 与墙钟；本仓有事件与 journal 证据。
- 本次只做了 5 步 JSON 任务；15 文件重构与 429 注入仍未做（§7）。
- 真实模型跑一次约消耗 0.5k（本仓）到 469k（官方）token；报告中的 `[已验证]` 仅指本次样本。

---

## 5. 场景 4：3 级父子 Agent 嵌套

### 5.1 官方实机 `[已验证]`

official-nesting-probe：子工作流尝试再组合 grandchild，返回：

```text
workflow() cannot be called from within a child workflow — nesting is limited to one level.
Inline the inner script or call its agents directly.
```

官方解包件把子上下文的 `workflow` 替换为拒绝 stub。

### 5.2 本仓实机 `[已验证]`

PR #58（Issue #57）：`workflowAncestry` 环检测 + 5 层上限 + 子 run 继承父 workspace。

`tests/integration/dwf-composition.test.ts`：

```text
ok 1 - workflow() composes a saved workflow as a child run
ok 2 - workflow() composes three levels and threads the value back up
ok 3 - workflow() rejects a composition cycle and names the full chain
ok 4 - workflow() enforces the bounded nesting depth and names the full chain
ok 5 - workflow() refuses unknown names with the registry listed
# tests 5 / # pass 5 / # fail 0
```

3 级返回值实测：

```json
{"level":"root","child":{"level":"middle","child":{"level":"grandchild","value":3}}}
```

### 5.3 判定

**本仓胜出**：官方硬限单层；本仓支持 3 级并有环/深度错误。剩余风险：子 run 结果未入父 journal（resume 会重跑），见白皮书 §8。

---

## 6. 指标汇总（只填有证据的）

| 指标 | 官方 | 本仓 | 证据 |
|---|---|---|---|
| 3 级嵌套 | ❌ 硬拒绝 | ✅ 通过 | 官方探针；composition 5/5 |
| 环检测 | N/A（不允许多级） | ✅ 完整链路错误 | composition test 3 |
| 深度上限 | 1（硬编码） | 5（常量） | `engine.ts` `MAX_WORKFLOW_NESTING_DEPTH` |
| 429 退避 | 源码：45s throttle / 90s stall；live 注入未做 | live：1 次 429 → 2,013ms 后重试成功；单测覆盖 Retry-After | §3.3 / runId `dwfrun-mvzxvgxy-cc9bda` |
| 停滞重试 | 5 次 + `(retry N)` | `stallMs` + `(Retry N ...)` | #59 测试 4/4 |
| Amend 局部失效 | 跨顶层调用 0 复用（5→5 agents，实测） | 5→2 live，3 复用（amend 事件） | §4.3 / runIds |
| 真实模型 5 步 token/延迟 | 5 agents/轮，469k tokens，16.2/17.9s | 5 live 576 tokens 3.32s；amend 2 live 245 tokens 1.63s | §4.3 |
| 15 文件机械重构 | 5 agents / 469,040 tokens / 38 tools / 27.8s / 15/15 正确 | 5 asks / 3,579 tokens / 0 tools / 8.1s / 15/15 正确 | §2.2 / runId `dwfrun-mvzghahc-973867` |
| 15 文件架构重构 | 5 agents / 486,152 tokens / 41 tools / 28.3s / 全部通过 | 5 asks / 5,233 tokens / 0 tools / 12.5s / 全部通过 | §2.4 / runId `dwfrun-mvzz2mj4-a334ef` |
| 跨包 monorepo 重构 | 5 agents / 486,554 tokens / 57 tools / 44.0s / 全部通过 | 5 asks / 5,188 tokens / 0 tools / 10.7s / 全部通过 | §2.5 / runId `dwfrun-mw002ygw-922a4f` |
| 跨组织多仓重构 | 6 agents / 585,832 tokens / 111 tools / 196.4s / 全部通过 | 6 asks / 4,987 tokens / 0 tools / 11.75s / 全部通过 | §2.6 / runId `dwfrun-mw04xkem-800e04` |
| 官方 429 注入 | `[未知]` | 可 mock | 未做网络控制 |

---

## 7. C 类受阻与解除条件

| # | 受阻项 | 缺什么 | 解除条件 |
|---|---|---|---|
| 1 | 跨云/跨租户多仓协作 | 真实远端仓库、CI 发布与凭据边界 | 需受控远端仓库与 CI；本轮本地 4 仓已覆盖跨仓契约 |
| 2 | 官方 Workflow live 429 注入 | 需把宿主 `ANTHROPIC_BASE_URL` 指向代理并重启会话 | 在受控副本/独立宿主上设置代理 base URL；本轮刻意不改用户配置 |
| 3 | 官方缓存命中计数器 | 官方无本地 amend/replay 遥测 | 只能墙钟 + agent_count 近似，或接受 `[未知]` |
| 4 | Ultracode / `/ultrareview` 云端协同 | claude.ai 账号与云端权限 | 组织级云端权限 |
| 5 | claude.exe 335MB Ghidra 深度分析 | 1h 预算内 `provider_timeout`；notepad 小 PE 已通 | 增大 `REA_GHIDRA_STARTUP_TIMEOUT_MS` 或用 `REA_GHIDRA_DISABLED_ANALYZERS` 降覆盖 |

> 真实模型 5 步 amend（§4.3）、15 文件机械重构（§2.2）、15 文件架构重构（§2.4）、跨包 monorepo（§2.5）、跨组织多仓（§2.6）与本仓 live 429（§3.3）已解除；剩余 C 类为跨云/跨租户多仓、**官方 Workflow** live 429、Ultrareview 与 claude.exe 335MB Ghidra 超时。

---

## 8. 复现命令

```bash
# 本仓组合（3 级/环/深度）
node --test dist/tests/integration/dwf-composition.test.js

# 本仓 stall（单元 + 集成）
node --test dist/tests/unit/dwf/dwf-stall.test.js
node --test dist/tests/integration/dwf-stall.test.js

# 本仓全量
npm.cmd test
npm.cmd run test:pbt
node --experimental-strip-types tests/e2e/runner.ts
node --experimental-strip-types tests/unit/workflow-governance.test.ts

# 真实模型 5 步 amend：harness 已于 2026-11-09 仓库精简时移除（Issue #205），实测记录见 §4.3

# 官方嵌套探针：本会话 Workflow 工具，child.js 调用 workflow({scriptPath: grandchild.js})
```

---

## 9. 后续建议

1. **跨云/跨租户多仓**：本地 4 仓已完成（§2.6）；下一步接入真实远端仓库、CI 发布与凭据边界。
2. **回归基准**：原 bench 回归 harness（amend 复用、15 文件吞吐）已于 2026-11-09 仓库精简时移除（Issue #205）；engine 改动后的回归验证一律以 `npm run gate` 全量门禁为准，历史实测数字沉淀于本文。
3. **429 代理注入**：本机代理返回 429 + Retry-After，分别驱动官方与本仓。
4. **官方 amend 计时**：同一 5 步脚本，第 3 步改提示词前后各跑 3 次，记录墙钟；本仓同时采集 replayHits/amendHits/diverged。
5. **Ultracode 云端**：保持 C 类，不伪造数据。

---

## 10. 证据索引

- 白皮书：`docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md`
- 官方锚点：解包件语义锚（重试/停滞/文案段、重放键实现段、子脚本拒绝 stub 段）——行号自清洁室修订（2026-11-20）起不录
- 本仓：`src/dwf/engine.ts`、`src/agent/rpc.ts`、`src/dwf/attempt-classifier.ts`
- Issue：#55（Date/Intl）、#57（多级组合）、#59（stallMs）、#61（Claude Code 挂载）