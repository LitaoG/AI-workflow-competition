# 标准改码与开发全流程规范（WORKFLOW）

> 本文件是 **AI-workflow 项目的大厂级标准研发流程**。任何针对文档、配置或代码的修改，一律严格执行本流程。
> 严禁直接在 `main` 分支修改，严禁跳步。
> 流程原则与纪律本体见 `AGENTS.md`；全仓事实与文档索引见 `docs/README.md`。

---

## 标准开发链路（8 步）

```text
§0 不确定 → 先查文档（动手之前）
   ↓
§1 Issue 驱动立项（无 Issue 不开工，真实编号防撞）
   ↓
§2 分支 + Worktree 物理隔离（强制绑定 Issue 编号，主仓禁改）
   ↓
§3 实现约束（两档制、子代理编排、用户纠错）
   ↓
§4 本机验证门禁（tsc 构建、单测、PBT、E2E、副产物还原）
   ↓
§5 规范化提交（Conventional Commits、无垃圾副产物、绑定 Issue）
   ↓
§6 推送 + 发起 PR（模板自检、测试指纹、无占位符、声明 Closes #NN）
   ↓
§7 审查合入与合并冷却期（15分钟冷却、评论逐条三态交代、pr_review_gate 校验）
   ↓
§8 收尾清理闭环（用完即删 Worktree、该评论则评论、该关闭则关闭）
```

---

## 0. 不确定 → 先查文档（查阅文档优先，动手前第一步）

> 核心准则：*对任何不确定的事项，必须查阅文档优先，先看有没有，绝不先猜。*
> 查文档先于写代码、先于建 Issue，因为查证结果决定了是否立项以及如何实现。

### 0.1 什么时候算「不确定」

只要答案需要依赖记忆、上下文猜测或惯性直觉，均属于「不确定」范畴：
1. **接口参数与返回结构**：RPC 消息体结构、Zod Schema 校验字段、CLI 命令标志位；
2. **构建与运行命令**：在 Windows PowerShell 环境下的正确调用方式（`npm.cmd` 而非 `npm.ps1`）；
3. **架构职责与分层归属**：模块划分（`compiler/`, `runtime/`, `prober/`, `dwf/` 等）与依赖方向；
4. **测试与质量门禁标准**：单元测试、PBT 属性测试、E2E 覆盖率与断言要求。

### 0.2 查证四级顺序（严格按序执行）

```text
① docs/README.md（全仓统一索引：定位哪一份文档是该事项的权威定义）
   ↓
② 命中的权威文档（查阅官方设计标准、API 规范与架构约定）
   ↓
③ 代码 / 测试 / 运行接口（【代码优先于文档】：以 main 分支真实代码实现与测试断言为准）
   ↓
④ 仍不确定 → 停下来，明说不确定并问人（向人类/总代理提问）
   禁止凭空编造接口、命令或测试数据；禁止使用上文过期的数值或假设。
```

- **代码优先于文档**：若发现文档描述与 `main` 代码不一致，以代码为准。在修复或改造时，应在同一次 PR 提交中同步更新对应文档，消除文档漂移。

### 0.3 事实速查表（反查视图）

| 待查事项 / 疑问 | 权威文档出处 |
|---|---|
| AI 必守纪律、P0 红线、收尾三件事 | `AGENTS.md` |
| 全流程开发规范、本机验证命令、PR 门禁 | 本文件 `docs/WORKFLOW.md` |
| 全仓文档一览表、单一事实源与防腐规则 | `docs/README.md` |
| 历史反复踩坑清单、高代价事故与强制规则 | `docs/AI-PITFALLS.md` |
| 证据驱动三档主张、五态测试报告、A-E 交付分级 | `docs/AI-EVIDENCE-STANDARD.md` |
| PR 模板规范与测试指纹自检清单 | `.github/PULL_REQUEST_TEMPLATE.md` |
| Issue 结构化模板配置 | `.github/ISSUE_TEMPLATE/` |
| 自动化评审回复与冷却期检查脚本 | `scripts/pr_review_gate.mjs` |
| 引擎架构设计、ZCode 启发式理念与状态持久化 | `docs/ARCHITECTURE.md` |
| 扩展开发指南与自定义 Agent 接入方法 | `docs/DEVELOPER_GUIDE.md` |
| 测试基础设施、分层覆盖率与验证方法 | `TEST_INFRA.md` |

### 0.4 为什么是硬纪律（本仓库实证反例）

| 先猜了什么 | 产生代价 | 对应教训 |
|---|---|---|
| 猜在 PowerShell 下可直接运行 `npm` | 触发 Windows `npm.ps1` 执行策略报错（`UnauthorizedAccess`），流程中断 | `P-ENV-1` |
| 猜可以在主仓直接修改代码 | 导致工作区污染，与后续 pull/merge 产生分支冲突 | `P-GIT-1` |
| 猜测试跑完工作区自然干净 | 忽略测试向 `fixtures/` 写入的运行时数据，导致测试脏数据误入 commit | `P-TEST-2` |
| 猜不同分支的事件类型名称一致 | 跨分支合并时触发 TypeScript 强类型编译失败 | `P-BUILD-1` |

答案早就在代码与文档中，返工几乎全部来源于「先猜后查」。

### 0.5 动代码前查踩坑清单

查清「这是什么」之后，在动代码前必须查阅 `docs/AI-PITFALLS.md`。
- 查看拟修改的模块或环节是否存在历史陷阱；
- 新增分支判断、异步流程、状态持久化或测试时必查。
- 清单严格实行 **G1/G2/G3** 准入门槛，**只增不删**。

---

## 1. Issue 驱动立项（无 Issue 不开工）

**任何功能演进、Bug 修复、架构重构或治理优化，动手前必须先在 GitHub 上建立 Issue。**

```powershell
# 1. 查阅现有 Issue 避免撞号
gh issue list --state all --limit 50

# 2. 创建真实 Issue（优先使用 .github/ISSUE_TEMPLATE/ 结构）
gh issue create --title "[类型] 简要标题" --body "## 背景与目标`n...`n## 涉及范围`n...`n## 验收标准(DoD)`n..."

# 3. 在 Issue 上留言宣告开工
gh issue comment <issue-number> --body "🚀 **工作流开始执行**：建立独立分支与 Worktree，启动开发。"
```

- **严禁凭空编造 Issue 编号**：多 Agent 并发开发时，严禁使用「推断」的 Issue 编号命名分支或测试，必须使用 `gh issue create` 真实返回的编号。
- **分支命名强制绑定真实 Issue 编号**：格式必须为 `<type>/issue-<num>-<slug>`（例如 `feat/issue-18-enterprise-workflow`）。
- **PR 正文必须声明关联**：正文必须包含 `Closes #NNN`（或 `Fixes #NNN`）。

---

## 2. 分支 + Worktree 物理隔离

> 规则本体见 `AGENTS.md` §1.8；门禁 `tests/unit/workflow-governance.test.ts`。

**主仓（main checkout）严禁修改任何受控文件**。动手前第一步执行环境自检：

```powershell
git branch --show-current
git worktree list
```

### 2.1 创建独立 Worktree 规范

```powershell
# 统一在主仓同级目录创建独立 worktree（分支与目录强制绑定 issue-<id>）
git worktree add -b feat/issue-<id>-<short-desc> ../AI-workflow-worktrees/issue-<id>-<short-desc> origin/main
```

- **路径约束**：worktree 目录路径**严禁包含空格**。
- **目录隔离**：严禁在主仓内部嵌套创建 worktree，必须位于同级目录。
- **依赖隔离（P-ENV-3 强制，2026-11-15 修订）**：每个 worktree **独立安装依赖**——进入 worktree 后执行 `npm.cmd ci`，postinstall 钩子自动落位 `ai-workflow` 自链（`scripts/link-self.mjs`）与离线 SDK 桩（`scripts/bootstrap-fixtures.mjs`）。
  **严禁**以 Windows 目录联接/符号链接跨 worktree 共享 `node_modules`：共享区的 `node_modules/ai-workflow` 自链会把 worktree 内全部包名导入解析到**别的 checkout 的 dist**——主仓 dist 一旦落后即产生假绿指纹与 0 步假成功（P-ENV-3 第 3 次实例实证）。门禁首跑前自查：
  ```powershell
  node --input-type=module -e "console.log(import.meta.resolve('ai-workflow'))"
  ```
  输出必须落在**本 worktree** 路径内，否则删除 `node_modules/ai-workflow` 后重跑 `npm.cmd ci`。

### 2.2 Worktree「用完即删」机械判据

当任务合并完成后，外部 worktree 必须彻底删除（连目录本身一起删除），避免宿主机磁盘堆积。

**判据（满足以下条件判定为用完未删）**：
1. HEAD 已经进入 `origin/main` 成为其严格祖先；
2. 工作区干净（`git status --porcelain` 为空）；
3. 最后一次提交时间已超过 6 小时。

---

## 3. 实现约束

1. **最小改动两档制开发规范**（规则本体见 `AGENTS.md` §1.4）：
   - **常规档（改动运行时行为）**：就地改那一处，不新建平行逻辑或冗余实现，不夹带格式化与无关重构；
   - **重构档（零行为变更）**：显式豁免「就地改」与「不新建」，但要求接口与可观察行为逐字一致，一次只重构一个内聚单元，单独成 PR；
   - 提交前对照 Issue 范围执行自检：`git diff --stat`。
2. **多 Agent 分工编排原则**（规则本体见 `AGENTS.md` §1.3）：
   - 复杂大任务拆解为互不重叠的子任务；
   - 总代理对子代理汇报的路径、测试结果、构建状态进行抽查复核，严禁盲信转述。
3. **假定用户会出错，当场指出**（规则本体见 `AGENTS.md` §1.6）：
   - 遇到事实错误、决策冲突或违背红线时，当场提供具体依据并指出后果；用户确认坚持原方案则按用户方案执行并留痕。
4. **文档同步纪律**（规则本体见 `AGENTS.md` §1.11）：
   - 改动代码导致任何文档语义受影响时，必须在同一次 PR 内更新全部受影响文档，严禁留下过时文档；
   - 以 `docs/README.md` 索引为起点全局检索受影响语义，列出「受影响文档清单」逐一更新；
   - PR 正文列明「已同步的受影响文档清单」，或明确声明「无文档影响」并附理由。

---

## 4. 本机验证门禁

在提交与发起 PR 前，必须在当前 Worktree 目录依次通过以下 5 级门禁：

```powershell
# 1. 静态编译与强类型检查
npm.cmd run build

# 2. 单元测试套件
npm.cmd run test:unit

# 3. 集成测试套件（预算/failover/replay/MCP 等花钱与恢复路径；触及 src/dwf、src/mcp、src/cli/commands、src/state 时必跑）
npm.cmd run test:integration

# 4. 不变式与性质测试（PBT）
npm.cmd run test:pbt

# 5. E2E 全场景流程测试
node --experimental-strip-types tests/e2e/runner.ts

# 6. 工作流治理不变量测试
node --experimental-strip-types tests/unit/workflow-governance.test.ts

# 7. 还原测试副产物（强制恢复干净）
git restore tests/unit/fixtures/
git status --porcelain
```

### 4.1 提取真实测试指纹

PR 正文中必须包含真实的测试输出指纹（严禁占位符）：
- `Ran N tests` 或 `pass N, fail 0`；
- TypeScript 编译器退出码为 0。

---

## 5. 规范化提交

遵循 Conventional Commits 规范，并在提交信息中关联 Issue 编号：

```powershell
git add .
git commit -m "feat(workflow): establish standardized multi-agent workflow (#<issue-id>)"
```

- 提交前再次执行 `git status --short`，确保无未跟踪临时文件、构建副产物或敏感配置混入。

---

## 6. 推送与发起 PR

### 6.1 推送分支

```powershell
git push -u origin feat/issue-<issue-id>-<desc>
```

### 6.2 发起 PR 与正文规范

- PR 正文必须使用 [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) 模板。
- **严禁占位符**：正文中严禁包含 `{{...}}`, `PLACEHOLDER_*`, 「待填」或口头承诺。
- **必须关联 Issue**：正文必须包含 `Closes #<issue-id>`。
- **必附测试指纹**：必须包含 §4 本机运行的真实输出指纹。
- **Windows PowerShell 编码防乱码规范**：
  ```powershell
  gh pr create --title "feat(workflow): establish standardized multi-agent workflow (#<issue-id>)" --body-file pr_body.md --base main
  ```

---

## 7. 审查合入与合并冷却期

### 7.1 合并冷却期（15 分钟）与评审机制

- **冷却期硬约束**：PR 创建后必须等待 **满 15 分钟**（硬红线 600 秒：`mergedAt - createdAt < 600s` 且无评审即违规），杜绝闪电合入；
- **主动回看评论并逐条甄别**：作者在合入前必须主动调用：
  ```powershell
  gh pr view <pr_number> --comments
  gh issue view <issue_number> --comments
  ```
  对审查意见进行逐条甄别（区分真实缺陷、必要修复、可选优化、主观偏好）。
- **逐条三态交代**：对所有实质性审查意见，必须在 PR 留下明确回复：
  1. **已处理**（写明对应的修改位置或 commit 哈希）；
  2. **刻意不改 + 明确理由**（给出事实与架构考量）；
  3. **需人拍板**（列出分歧请求裁决）。
  **必回一条回音（必回的是回音，不是照办）**：审查意见不一定对（P-SRC-3 人数不是证据），判定为误报也必须回复驳回依据，严禁静默跳过。
- **回音判定规则（Issue #109，机械锁死于门禁）**：
  1. 编号闭环：带编号的发现项（F1、F2…）逐条记账；回音必须**同时引用对应编号并携带三态关键词**（已处理/刻意不改/需人拍板…），一条回音只消它引用的编号；
  2. 角色判别：带审查标题（`## 监督席`、`## 审查意见` 等）的评论是意见不是回音——回音写在 PR 正文（模板 §5）或普通评论里均可；
  3. 时间线：comments 与 reviews（`submittedAt`）按时间合并排序，回音必须晚于意见；
  4. 关联 Issue 并入（F5）：门禁从 PR 正文 `Closes/Fixes/Resolves #N` 拉取该 Issue 的评论并入同一时间轴——**写在 Issue 上的审查意见必须在 PR 内闭环**，不得只在 Issue 下回音。

### 7.2 审查门禁工具校验

运行自动化审查门禁脚本：
```powershell
node --experimental-strip-types scripts/pr_review_gate.mjs <pr_number>
```
脚本机械检查：
- PR 正文是否明确关联有效 Issue（`Closes #NN`）；
- PR 正文是否包含真实测试指纹与无未消除占位符；
- PR 创建时间是否已过 15 分钟冷却期（支持 `--ack` / `--bypass-cooling` 授权豁免）；
- 评论与 Review 流（含关联 Issue 评论，F5）中所有审查意见是否均已完成三态回复交代：带编号发现项须引用编号 + 三态关键词，带审查标题的评论不算回音，时间轴合并排序；
- PR 正文是否包含真实测试指纹与无未消除占位符（指纹只认 `Ran N tests` / `pass N, fail 0` / node:test 分行摘要，N > 0；裸 "passed" 一词不算，Issue #109）。

### 7.3 合入操作（必须在主仓 main 执行）

```powershell
# 1. 远端 CI 已于 2026-11-14 经用户重新拍板恢复（比赛仓为 public 仓库，Actions
#    免费，Issue #7；历史拍板 Issue #203）：合入放行判据 = PR 正文本机门禁指纹
#    + scripts/pr_review_gate.mjs <pr_number> 校验通过 + CI 绿（gh pr checks）。

# 2. 确认放行后，执行 merge（禁止使用 && 或 ; 连写）
gh pr merge <pr_number> --merge --delete-branch
```

---

## 8. 收尾清理闭环

PR 合入主分支后，当场执行收尾动作，绝不拖延：

### 8.1 仓库与环境清理

```powershell
# 1. 彻底删除已完成的 Worktree（连目录本身一起删除）
git worktree remove --force ..\AI-workflow-worktrees\issue-<id>-<short-desc>
Remove-Item -Recurse -Force ..\AI-workflow-worktrees\issue-<id>-<short-desc> -ErrorAction SilentlyContinue

# 2. 清理本地与远程临时分支
git branch -d feat/issue-<id>-<short-desc>
git fetch --prune origin

# 3. 三查验证：确认工作区干净、仅剩正常 worktree
git worktree list
git status --short
```

### 8.2 收尾必做三件事

1. **清理中间产物**：删除临时脚本、调试数据，worktree 连目录彻底删除（`git worktree list` 无残留）；
2. **该评论则评论**：在 Issue 与 PR 上留存最终交付说明、Commit 哈希与验收指纹；
3. **该关闭则关闭**：确认所有验收条件达成、且所有评论均已交代后，当场显式关闭对应 Issue：
   ```powershell
   gh issue close <issue-number> --comment "✅ 任务交付闭环：代码已合入 main，全套门禁校验通过，临时 Worktree 已清理。"
   ```
