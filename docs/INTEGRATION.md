# AI-Workflow 与智能体宿主集成指南

引擎同时是三种形态：**独立 CLI**、**MCP Server** 与**可嵌入库**。任何能派生子进程或讲 MCP 协议的宿主（Host）都可以驱动它。

## 1. 独立 CLI

```bash
npm install && npm run build
node bin/workflow.js --help
# 或全局链接后直接使用 workflow 命令：
npm link && workflow --help
```

Facade 脚本驱动回路（智能体实际操作的三个步骤）：

```bash
workflow check <script.ts>                                  # 编译期检查，必须零错误通过
workflow run-script <script.ts> --cwd <ws> --args '{}'      # 沙箱执行，journal 逐节点记录
workflow run-script <script.ts> --cwd <ws> --resume <runId> # 断点续跑：已完成节点零成本重放
```

> `workflow run <script.ts>` 会通过静态扫描自动识别 facade 脚本特征，两种入口等价。

## 2. MCP Server（Claude Code / ZCode / opencode / Codex CLI / Cursor…）

`workflow mcp serve` 通过 stdio 提供 MCP 协议，并把同一份工具目录以两种形态暴露
（工具目录与线上形态严格同步——`workflow mcp list` 渲染出的内容与
`tools/list` 返回值完全一致，由 `tests/unit/mcp-catalog-consistency.test.ts` 锁定）：

- **Facade 形态（现役，推荐）**——dwf 沙箱安全标准：
  `workflow_script_check`、`workflow_script_run`、`workflow_run_script`、
  `workflow_inspect_run`、`workflow_get_run`；
- **Legacy 形态（已废弃，过渡期内仍可用）**——builder 引擎工具
  `workflow_run`、`workflow_probe`、`workflow_inspect`、`workflow_replay`、
  `workflow_graph`。每个工具均携带 `deprecated: true`，并在描述中指回 facade 形态的对应工具。

各宿主接入配置示例：

```bash
# Claude Code
claude mcp add ai-workflow -- node <repo>/bin/workflow.js mcp serve
```

```text
# ZCode（settings → MCP servers → stdio）
command: node
args: [<repo>/bin/workflow.js, mcp, serve]
```

```json
// opencode（opencode.json）
{
  "mcp": {
    "ai-workflow": {
      "type": "local",
      "command": ["node", "<repo>/bin/workflow.js", "mcp", "serve"]
    }
  }
}
```

```toml
# Codex CLI（~/.codex/config.toml）
[mcp_servers.ai-workflow]
command = "node"
args = ["<repo>/bin/workflow.js", "mcp", "serve"]
```

接入完成后，宿主智能体按 `skills/ai-workflow/SKILL.md` 编写 facade 脚本，
以 `workflow_script_check` → `workflow_script_run`（→ resume）驱动执行。引擎保证：
任何脚本运行之前先过严格编译期检查、沙箱隔离、确定性 journal 重放（零 Provider 调用）、
进程树安全的监督与清理。

## 3. Skill 安装

任何支持 Skill 机制的宿主都可以直接指向 `skills/ai-workflow/`（SKILL.md +
`examples/review.facade.ts`）：

- **Claude Code**：复制到 `~/.claude/skills/`（或某个插件的 `skills/` 目录）。
- **Codex CLI**：在 `AGENTS.md` / 提示词包中引用。
- 其他宿主：SKILL.md 是纯 Markdown，智能体可直接阅读。

## 4. 将 worker ask 路由到外部智能体 CLI（Provider 路由）

默认情况下，`agent().ask()` 调用走 Provider 注册表（默认 mock Provider，另可选 Bedrock）。
若要把 ask 请求路由给外部智能体 CLI 充当 worker，请在启动前设置环境变量：

```bash
AI_WORKFLOW_PROVIDER=codex    workflow run-script script.ts ...   # codex exec
AI_WORKFLOW_PROVIDER=gemini   workflow run-script script.ts ...   # gemini -p
AI_WORKFLOW_PROVIDER=opencode workflow run-script script.ts ...   # opencode run
AI_WORKFLOW_CLI_COMMAND='C:\bin\codex.exe'  # 显式覆盖可执行文件路径
AI_WORKFLOW_CLI_TIMEOUT_MS=120000
```

各 Provider 通过进程监督器派生 CLI 子进程（POSIX 上独立进程组、Windows 上整树终止、
环境变量脱敏），因此 worker 调用与 `world.run` 门禁享有同一套生命周期保证。

## 注意事项与边界

- 沙箱提供的是面向确定性与生命周期的进程/VM 隔离，**不是安全边界**；
  `world.run` 命令是编译期字面量，会原样展示以供审批。
- 全仓采用 Apache-2.0 授权——欢迎嵌入（`exports` 映射暴露 `./core`、`./agent`、
  `./dag`、`./mcp` 子路径导出）。
