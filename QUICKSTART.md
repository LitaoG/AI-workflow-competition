# ⚡ AI-Workflow 1 分钟上手指南 (QUICKSTART)

> 目标：**60 秒内**从零到第一次看到自己的工作流在看板里跑完。
> 完整规范见 `README.md` 与 `docs/`；本页只管上手。

---

## 0. 前置（10 秒）

- Node.js ≥ 22
- 本仓库根目录下依赖已装好（`npm install` 一次性）
- **本包未发布到 npm**——npm 上的 `ai-workflow` 是无关的 2021 占位包（0.1.19）；安装只走源码（`git clone` 本仓库后于仓库根 `npm install`）或发布 tarball：`npm install ./ai-workflow-<ver>.tgz`（`./` 前缀不可省，裸相对路径会被当作 registry spec 解析而报 git 错误；Issue #147 已验证）

```shell
node bin/workflow.js doctor   # 环境自检：runtime/compiler/journal/sandbox 全绿即就绪
```

---

## 1. 先看 1 秒 Demo（无需写任何代码）

```shell
node bin/workflow.js demo   # 或: npm run demo
```

会发生什么：离线跑完旗舰「故障分诊」工作流（确定性 mock，**零网络调用、约 1 秒**），
然后自动在浏览器打开 **AI-Workflow Studio** 看板——左侧拓扑图、右上实时事件流、
右下节点 Inspector。点任意节点看输入/输出/产物；绿色⚡徽章 = 该节点可从 journal 零成本重放。

---

## 2. 跑第一个真实工作流（30 秒）

**统一入口**：`workflow run` 自动识别 facade 脚本（沙箱引擎）与 builder 定义，无需选错命令。

```shell
# 方式一：Key-Value 传参（PowerShell 安全，推荐）— 跑内置 capabilities-tour 示例
node bin/workflow.js run apps/capabilities-tour/lineage.facade.ts

# 方式二：JSON 文件直传（零转义烦恼）
node bin/workflow.js run my.flow.ts --args-file params.json

# 方式三：--ui 跑完自动弹 Studio 看板
node bin/workflow.js run my.flow.ts --set key=value --ui
```

> 💡 **Windows 用户**：永远优先 `--set` / `--args-file`。
> `--args '{"k":"v"}'` 这种写法会被 PowerShell 吞掉双引号——这就是我们做前两个通道的原因。

---

## 3. 写自己的工作流（30 秒）

```shell
# 交互式脚手架：选一个模板（code-review / incident-triage / repo-migration / multi-agent）
node bin/workflow.js new my-flow
```

生成的 `my-flow.facade.ts` 长这样（节选）：

```ts
phase('Draft');                                   // 阶段（编译期字面量）
const draft = await agent('strategist').ask<Plan>('...');  // 类型化子代理提问
const gate = await world.run('node', ['--version'], { timeoutMs: 30_000 }); // 确定性 shell 门禁
await artifact.markdown('plan', '# Plan\n...');   // 产物
return { ok: true };                              // 顶层 return = 运行结果
```

**铁律**（编译器强制，写错会带 💡 QuickFix 提示）：
- 禁 `Date.now()` / `Math.random()` / `new Date()` —— 时间与随机数走 `args` 传入（保证重放逐字节一致）
- 禁 `import` / `process` / `fs` / `fetch` —— facade 就是全部世界
- `phase()` 标题与 `world.run` 命令必须是字符串字面量

---

## 4. 标准循环：check → run → resume

```shell
node bin/workflow.js check my-flow.facade.ts        # 必须打印 ✔ facade script compiled clean（未编译通过的脚本绝不进 run）
node bin/workflow.js run my-flow.facade.ts          # 失败了？已完成节点全部记入 journal
node bin/workflow.js run my-flow.facade.ts --resume <runId>   # 修复后重跑：零成本重放，从断点继续
```

**人工介入**（escalation / hole 停车时）：
- 终端：`node bin/workflow.js answer <runId> <questionId> "你的回答"` 或 `workflow fill <runId> <holeName> <bodyFile>`
- 看板：`node bin/workflow.js serve <runId>` 打开 Studio，**直接在网页表单里提交**，工作流原地续跑

---

## 5. 接入你的 AI 助手（一条命令）

```shell
node bin/workflow.js setup --target all    # 生成 Claude Code + OpenCode + Codex + ZCode 配置
```

- **Claude Code**：`.mcp.json`（10 个真实 MCP 工具）+ `.claude/skills/ai-workflow/` 技能 + `.claude/settings.json`（权限预授权）→ 重启 Claude Code 即用
- **OpenCode**：`.opencode/`（workflow-runner 子代理 + `/workflow` 斜杠命令 + MCP 挂载）
- **Codex**：`.codex/instructions.md` + `tools.json`（OpenAI function-calling schema 纯 JSON，可用 `workflow export-schema --format openai` 重新导出，字节一致）
- **ZCode**：`.zcode/config.json`（引擎入口与 journal 路径声明，运行时对齐）

验证工具面：`node bin/workflow.js mcp list` —— 应列出 `workflow_run` … `workflow_get_run` 共 10 个真实引擎工具。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `workflow new <name>` | 模板脚手架 |
| `workflow check <file>` | 编译检查（✔ facade script compiled clean 才跑） |
| `workflow run <file>` | 统一执行入口（自动识别 facade/builder） |
| `workflow run <file> --ui` | 跑完自动弹 Studio 看板 |
| `workflow serve <runId>` | 实时看板（SSE）+ 网页内回答/填孔续跑；仅绑回环，跨源与非回环 Host 请求一律 403（Issue #143） |
| `workflow view <runId>` | 导出静态 Studio HTML |
| `workflow inspect <runId>` | 终端查看运行详情 |
| `workflow setup --target all` | 一键生成三助手互通配置 |
| `workflow mcp list` | 列出 10 个真实 MCP 工具 |

卡住了？`node bin/workflow.js --help`、`docs/DEVELOPER_GUIDE.md`，或在 GitHub 提 issue。
