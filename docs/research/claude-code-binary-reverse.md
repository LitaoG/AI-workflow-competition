# Claude Code Dynamic Workflow 二进制逆向证据（@anthropic-ai/claude-code 2.1.316 win32-x64）

> 方法：npm pack 平台二进制（335MB PE32+，Bun 编译，JS bundle 内嵌）→ Python 定向标记扫描。
> 用途：个人研究（对齐本引擎语义）；不 redistribut任何反编译产物。
> ZCode 侧为官方开源（apps/zcode-cli/packages/dynamic-workflow），此前报告 §2 已全覆盖，本轮为 Claude 侧补齐。

## 发现的运行时常量（env knobs）

| Env | 语义 |
| --- | --- |
| `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | 并发 agent 门（默认 `bi`，机器相关） |
| `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` | 扇出前缀缓存 stagger（`DISABLE_PROMPT_CACHING` 时为 0） |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` / `_TOKENS` | 大工作流警告阈值（文档：>25 agents / >1.5M tokens） |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | 管理员禁用开关（managed settings env 块） |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | 结构化输出校验重试（默认 5：`Xr=5`） |

## Budget 是硬执行（推翻"只是遥测"的旧认知）

- `os = 1000`：**agent() 调用上限 1000**，超限抛 `WorkflowAgentCapError`，文案点名防死循环：
  "This usually means a loop using budget.remaining() never terminates because no token
  budget was set — remaining() returns Infinity when budget.total is null. Add a hard
  iteration cap to the loop, or pass a token budget."
- `WorkflowBudgetExceededError`：**token 预算超限即停止后续 agent() 调用**（在飞完成、结果保留），
  按 `budget.getTurnSpent() >= budget.total` 在 agent() 调用粒度检查；遥测事件 `tengu_workflow_budget_cap_exceeded`。
- 预算对象 API：`budget.total` / `budget.spent()` / `budget.remaining()`（total=null → remaining=Infinity）。

## 停滞与重启

- 停滞超时 `Mi = 90000`（90s）；重启上限 `Xr = 5`（文档"最多 5 次"对上）。
- stall 结果：`{stalled: true, stalledReason, replyLost: reason==='stalled' && …}`；"reply lost" 单独成态。
- ask 完整结果契约（内部）：`{structured, text, agentMessages, tokens, toolCalls, stalled, stalledReason, replyLost, skipped, durationMs, stopReason, outputTokens, structuredOutputAttempts, lastStructuredOutputInput}`。

## 执行架构（与 ZCode 惊人地同构）

- **workflow 脚本跑在 VM 里**：`bindVMAwait` / `sanitizeVMValue` / `getVMProp` / `withLanesInert`。
- 阶段投影：`workflow_phase_${index}` 进度事件 `{type:"workflow_phase", index, title, kind}`（meta.phases 先声明，运行时 `resolvePhase` 动态注册）。
- 并发门：`workflow: concurrent agent gate = ${n}` 单层门（ZCode 是三层：席位门+AIMD+governor——我们已实现等价物）。
- **重放键是 prompt 链哈希**：`key = hash(prevKey, prompt)`，`results.get(key)` 短路——ZCode/我们用 `(siteId, ordinal, inputHash)`，Claude 用链式哈希（无 site 表，靠调用序列前缀）；语义等价但 ZCode 的显式键支持 amend 局部失效，Claude 的链式哈希在变更点后必然全量级联（与我们 amend 的 inputHash 级联一致）。
- 模式绑定：`isBackgroundAgent: true`、`mainLoopModel` 重绑、`takeUsageLimitDenial`（用量限额拒绝→结构化失败）。

## 对本引擎的差距清单（本轮实现 1/2/5/6）

1. ✅ **budget 全局**：total/spent()/remaining()，agent() 粒度硬执行（WorkflowBudgetExceededError 同文案），output token 计量来自 provider usage。
2. ✅ **agent 调用上限 1000** + 同款防死循环文案。
3. ⏸ stallMs/stalled 重启：我们的 ask 是原子 provider 调用，timeout+transient 重试（attempt-classifier）已覆盖等价场景，不引入流式重启概念。
4. ⏸ 结果契约扩展：facade 作者只需要 T；内部遥测已有事件流。
5. ✅ **size warning**：asks > 25 时发出大工作流提示事件。
6. ✅ **env knob 对齐**：`AI_WORKFLOW_MAX_CONCURRENT_AGENTS`（runner 读取，--max-concurrency 覆盖）。
