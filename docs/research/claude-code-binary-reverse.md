# Claude Code Dynamic Workflow 二进制逆向证据（@anthropic-ai/claude-code 2.1.316 win32-x64）

> 方法：npm pack 平台二进制（335MB PE32+，Bun 编译，JS bundle 内嵌）→ Python 定向标记扫描。
> 用途：个人研究（对齐本引擎语义）；不 redistribute 任何反编译产物。
> 清洁室修订（2026-11-20，私有仓 Issue #163 批次）：逐字专有文案、内部遥测事件名原文、
> minified 符号与 ask 内部结果契约全字段改写为行为级描述；事实性接口常量（env knob 名、
> 公开协议形状）保留。
> ZCode 侧为官方开源（apps/zcode-cli/packages/dynamic-workflow），此前报告 §2 已全覆盖，本轮为 Claude 侧补齐。

## 发现的运行时常量（env knobs）

| Env | 语义 |
| --- | --- |
| `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | 并发 agent 门（默认随机器核数推导） |
| `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` | 扇出前缀缓存 stagger（`DISABLE_PROMPT_CACHING` 时为 0） |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` / `_TOKENS` | 大工作流警告阈值（文档：>25 agents / >1.5M tokens） |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | 管理员禁用开关（managed settings env 块） |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | 结构化输出校验重试（默认 5） |

## Budget 是硬执行（推翻"只是遥测"的旧认知）

- **agent() 调用上限 1000**：超限抛 `WorkflowAgentCapError`，文案语义点名防死循环——
  `budget.total` 为 null 时 `remaining()` 返回 Infinity，无硬迭代上限的循环会永不终止；
  应给循环加硬上限或传入 token 预算（原文不录，本引擎以自有措辞实现同语义）。
- `WorkflowBudgetExceededError`：**token 预算超限即停止后续 agent() 调用**（在飞完成、结果保留），
  在 agent() 调用粒度检查 turn 花费是否越界；预算封顶会发出一条内部遥测事件（事件名不录）。
- 预算对象 API：`budget.total` / `budget.spent()` / `budget.remaining()`（total=null → remaining=Infinity）。

## 停滞与重启

- 停滞超时 90s；重启上限 5 次（文档"最多 5 次"对上）。
- stall 结果携带「已停滞」标记、停滞原因，并单独区分「reply lost」形态。
- ask 内部结果契约：结构化结果、文本、agent 消息、token 计量、工具调用记录、停滞标记、
  停滞原因、reply-lost 标记、跳过标记、时长、停止原因、输出 token、结构化输出尝试次数、
  最后一次结构化输出输入（字段全集语义在列，原文不录）。

## 执行架构（与 ZCode 惊人地同构）

- **workflow 脚本跑在 VM 里**：跨 realm await 绑定、跨界值消毒、VM 属性访问封装、
  lanes 惰性化（内部符号名不录，行为如名）。
- 阶段投影：`workflow_phase_<index>` 进度事件（meta.phases 先声明，运行时动态注册）。
- 并发门：单层并发 agent 门（ZCode 是三层：席位门+AIMD+governor——我们已实现等价物）。
- **重放键是 prompt 链哈希**：`key = hash(prevKey, prompt)`，命中缓存即短路——ZCode/我们用
  `(siteId, ordinal, inputHash)`，Claude 用链式哈希（无 site 表，靠调用序列前缀）；语义等价但
  ZCode 的显式键支持 amend 局部失效，Claude 的链式哈希在变更点后必然全量级联（与我们 amend
  的 inputHash 级联一致）。
- 模式绑定：后台 agent 标记、主循环模型重绑、用量限额拒绝→结构化失败（行为级）。

## 对本引擎的差距清单（本轮实现 1/2/5/6）

1. ✅ **budget 全局**：total/spent()/remaining()，agent() 粒度硬执行（同语义、本仓自有文案），output token 计量来自 provider usage。
2. ✅ **agent 调用上限 1000** + 同款防死循环语义。
3. ⏸ stallMs/stalled 重启：我们的 ask 是原子 provider 调用，timeout+transient 重试（attempt-classifier）已覆盖等价场景，不引入流式重启概念。
4. ⏸ 结果契约扩展：facade 作者只需要 T；内部遥测已有事件流。
5. ✅ **size warning**：asks > 25 时发出大工作流提示事件。
6. ✅ **env knob 对齐**：`AI_WORKFLOW_MAX_CONCURRENT_AGENTS`（runner 读取，--max-concurrency 覆盖）。
