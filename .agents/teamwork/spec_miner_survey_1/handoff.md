# 涨幅榜项目（Top Gainers List Model）多 Agent 开发工作流与治理架构调查报告

- **调研者**: teamwork_spec_miner
- **调研对象**: `${SURVEY_PROJECT_ROOT}`
- **目标适配仓库**: `${AI_WORKFLOW_REPO}`
- **生成日期**: 2026-11-01

---

## 一、Features Discovered（发现的完整规范特性清单）

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|---|---|---|---|---|---|---|
| 1 | 文档治理 | 查阅文档优先（Docs-First） | 动手前对任何阈值、命令、路径不确定时先查文档，按四级顺序：`docs/README.md` 索引 → 权威文档 → 代码/测试/接口（代码优先于文档） → 停下明说不确定并问人；禁止编造与沿用过期数值 | 待查问题/概念/路径 | 权威文档指针、代码依据 | 编造或凭记忆猜测导致返工；触发 `test_docs_first_lookup_obligation.py` 门禁失败 | `协作规范总纲.md:16-28`, `docs/WORKFLOW.md:14-133` |
| 2 | 文档治理 | 单一事实源与防腐规则 | 全仓每个事实（规则、阈值、流程）只在一个权威文档中唯一定义，其他地方仅用链接引用；当前事实以 `main` 代码为准；动态数字不硬编码 | 文档路径、事实更新请求 | `docs/README.md` 统一索引与反查表 | 文档漂移、反向定义现实；多处重复拷贝导致改一漏一 | `docs/README.md:1-175`, `协作规范总纲.md:447-474` |
| 3 | 纪律与防踩坑 | 踩坑清单集中归档（工程教训清单） | 集中记录反复栽过的坑（G1 反复 ≥2次）、单次高代价事故（G2 事故/泄密/停摆）、强制门禁与必记方法（G3），严格排除偶发小插曲；清单只增不删 | 故障排查教训、根因、门禁 | 结构化条目（`P-<簇>-<序号>`，代价、根因、正确做法、门禁、原位置） | 偶发问题混入变流水账；修好后删条目导致同类问题复发；触发 `test_ai_pitfalls_ledger.py` | `协作规范总纲.md:29-44`, `docs/工程教训清单.md:1-150`, `docs/工程教训归档流程分册.md` |
| 4 | 纪律与防踩坑 | 约定必须落成测试（P-METHOD-6） | 所有写入文档正文的纪律与约定，靠自觉已被证伪，必须在会话入口（`协作规范总纲.md`）和流程本体（`WORKFLOW.md`）双向声明，并配专属单元测试锁死措辞与关键要素 | 纪律条款、文档文本 | 单元测试断言、门禁自指 | 文档修改无声删改纪律；CI/本地测试红灯拦截 | `docs/工程教训归档流程分册.md:130-156`, `tests/test_*.py` |
| 5 | 多 Agent 协作 | 总代理与子代理分工编排（Issue #527） | 总代理负责指挥、分配、汇总与抽查复核，不得包揽重复劳动；大任务拆分成互不重叠子任务由子代理并行；关键结论必须抽查，不得原样转述当作证据 | 复合任务目标、子代理输出 | 验证后的汇总决策与交付物 | 子代理输出幻觉被总代理直接采信；简单任务滥拆降速；触发 `test_subagent_orchestration_rule.py` | `协作规范总纲.md:45-55`, `docs/WORKFLOW.md:218-221` |
| 6 | 开发纪律 | 最小改动与优先复用两档制（Issue #575） | 按改动性质分档：常规档（改行为）必须就地改、不新建平行实现、不夹带、`git diff --stat` 对照范围；重构档（零行为变更）显式豁免就地改，允许抽公共模块/搬迁，但须单内聚单元单 PR | 需求类型、代码 Diff | 精简的代码修改 | 夹带无关重构导致范围失控；重构与行为修改混杂无法回退；触发 `test_minimal_change_rule.py` | `协作规范总纲.md:56-80`, `docs/WORKFLOW.md:222-232` |
| 7 | 开发纪律 | 假定用户会出错与当场指出（Issue #843） | 默认不把用户输入当正确答案；命中事实错、决策冲突、违背纪律、前提被推翻任一，必须当场具体给证据指出；指出不等于越权，用户拍板后照办并留痕 | 用户指令、权威文档证据 | 纠错提示、拍板执行留痕 | 盲从用户错误导致线上故障；证据不足无理抗命；触发 `test_user_error_correction_843.py` | `协作规范总纲.md:104-126`, `docs/WORKFLOW.md:243-249` |
| 8 | 证据标准 | 证据驱动三档主张规范（Issue #1215） | 重要结论强制区分：〔已验证〕（可复现路径/输出）、〔推断〕（明确推断链每一步依据）、〔未知〕（写明缺什么谁有）；严禁把推断当事实，严禁把未知脑补成答案；人数与模型意见一致不是证据 | 分析结论、实验数据 | 带可核查证据的主张 | 虚构引用、编造运行事实、伪造测试通过；触发 `test_ai_evidence_standard.py` | `协作规范总纲.md:167-189`, `docs/AI-EVIDENCE-STANDARD.md:18-64` |
| 9 | 证据标准 | 评审收敛与重试上限停机 | 同一问题连续失败 3 次必须停止循环，整理已尝试方案、证据、失败原因与剩余风险升级给人；只有 4 种触发（新证据、可复现缺陷、遗漏需求、约束冲突）允许重开已验收项 | 多轮失败记录、新证据 | 升级报告、阻塞项声明 | 无限死循环消耗预算；无证据推翻有效方案 | `docs/AI-EVIDENCE-STANDARD.md:291-344` |
| 10 | 证据标准 | 反虚假完成的五类交付（A/B/C/D/E） | 交付成果强制分类：A（已完成且通过验证）、B（已实施未充分验证）、C（未完成/被阻塞）、D（仅建议未实施）、E（剩余风险与盲区）；严禁把建议写成已修 | 任务执行结果 | 结构化交付分档清单 | 将计划冒充完成，将未测冒充安全 | `docs/AI-EVIDENCE-STANDARD.md:430-448` |
| 11 | 任务立项 | Issue 驱动与真实编号防撞 | 开发必须先通过 `gh issue create` 立项；严禁凭推断或心智模型造号；必须使用 CLI 真实返回编号命名分支与测试文件，防止多会话撞号 | Issue 标题、类型、背景、DoD | 真实 GitHub Issue 编号与记录 | 撞号导致注释/测试文件名指向他人的任务与 PR | `docs/WORKFLOW.md:134-150` |
| 12 | 环境隔离 | Git Worktree 物理隔离（Issue #1249） | 主仓（`main` checkout）严禁修改任何受控文件；动手前自检分支；所有修改、测试、提交均在独立 worktree 中完成；worktree 目录路径严禁包含空格 | 主仓路径、目标分支名 | 独立的 worktree 工作目录 | 在主仓修改直接被 `test_worktree_isolation_rule.py` 判红；与 merge/pull 产生冲突 | `协作规范总纲.md:190-231`, `docs/WORKFLOW.md:151-211` |
| 13 | 环境隔离 | 仓库外目录用完即删（Issue #1458） | AI 在仓库外创建的 worktree、探针目录、临时拷贝等用完即删（连目录本身一起删）；提供明确机械判据（HEAD 已是 origin/main 严格祖先 + 工作区干净 + 上次提交 >6h） | 外部目录路径、Git 提交状态 | 干净的宿主机环境（桌面无垃圾残留） | 遗留数十个空壳目录；泄露 `.env` 等凭据副本；触发 `test_worktree_cleanup_rule.py` | `协作规范总纲.md:210-230`, `docs/WORKFLOW.md:664-715` |
| 14 | 验证门禁 | 本机测试分块执行与防 OOM | 本机内存受限或并发存在时，全量测试整跑会被系统 kill（退出码 -1）；采用 `run_tests_chunked.py` 分块进程运行，区分进程被杀与真正测试失败 | 测试用例集合、chunk-size | 分块执行日志、合计 Ran N tests | 假绿（watchdog os._exit 导致退出码为 0 但没跑完）；内存溢出进程被杀 | `协作规范总纲.md:478-490`, `docs/WORKFLOW.md:352-396` |
| 15 | 验证门禁 | 合并前必跑早筛清单（§4.1 Checklist） | 汇总全仓计数棘轮、静态一致性、纪律存在性门禁，作为合并前秒级早筛（3-5分钟）；PR 必须贴其实际输出；PR 新增测试文件未登记则拒绝合并 | 门禁模块清单、新增文件列表 | 早筛测试通过报告 | 耗费十数分钟跑完全量才发现静态门禁被破；新增门禁脱保 | `docs/WORKFLOW.md:464-494`, `scripts/pr_review_gate.py:611-650` |
| 16 | 验证门禁 | 测试副产物隔离与还原 | 测试运行时严禁污染生产数据、生产配置与知识库；测试执行完毕后强制执行 `git checkout -- data/` 恢复干净工作区 | 测试运行时文件变更 | 干净的 Git 状态 | 测试生成的运行日志或 mock 账本被带入 commit | `协作规范总纲.md:485`, `docs/WORKFLOW.md:401-409` |
| 17 | 提交与 PR | PR 模板自检与无占位符硬约束 | PR 描述必须基于模板；必须包含分块全量输出指纹（`Ran N tests`）、§4.1 早筛输出、ruff 输出、diff stat；严禁包含 `{{...}}` 等占位符或口头承诺 | 测试输出原文、代码 Diff | 合规合法的 PR 正文 | 占位符预勾放行导致未测代码合入；正文缺指纹被 review gate 拦截 | `docs/WORKFLOW.md:503-567`, `.github/PULL_REQUEST_TEMPLATE.md` |
| 18 | 提交与 PR | 命令行与脚本编码防乱码规范 | 针对 Windows PowerShell 5.1 环境，严禁使用内联转义 `\uXXXX`；PR 正文统一采用 UTF-8 文件传递（`--body-file`）；Python 脚本重置 stdout/stderr 为 utf-8 | PR 标题与正文文本 | 正常渲染的中文 Issue/PR | GBK 控制台乱码；反引号转义吃掉字符；写成功却因回显崩溃 | `docs/WORKFLOW.md:509-528`, `scripts/gh_title_safe.py` |
| 19 | 审查与合入 | PR 评论主动回看与逐条交代（Issue #1595/1618） | 监督/审查 AI 在 Issue/PR 上留下的反馈，作者在动手前、开PR前、合入前三个时机必须主动回看；四档甄别后必须回复一条回音（已处理 / 刻意不改+理由 / 需人拍板）；严禁静默跳过 | Issue/PR 评论流 | 留存的回复记录与交代状态 | 审查意见被无视直接合入；误诊被盲从照搬；触发 `test_issue1595_issue_comment_duty.py` | `协作规范总纲.md:276-308`, `docs/WORKFLOW.md:306-331`, `scripts/pr_review_gate.py` |
| 20 | 审查与合入 | 审查门禁与合并冷却期（Issue #1760 / #1264） | 机械拦截合入：PR 创建后必须冷却 ≥15 分钟（硬红线 600 秒）；必须在合入前存在评审语义评论；未回复评审或冷却期未满，`pr_review_gate.py` 退出码 1 阻断合入 | PR 元数据、评论列表、合并时间戳 | 审查门禁放行/拦截报告 | PR 闪电合并（<100s）导致审查晚于合入，带病代码进入主分支 | `docs/WORKFLOW.md:600-630`, `scripts/pr_review_gate.py:129-211` |
| 21 | 审查与合入 | 主仓执行合入与禁止命令链连写 | `gh pr checks` 与 `gh pr merge` 必须在主仓单独依次执行，严禁使用 `;` 或 `&&` 拼写；必须等待 checks 明确 pass 后再合入 | PR 检查状态 | 干净合入的 commit | 在 worktree 合入报分支冲突；checks 尚未注册被当作 pass 误合入 | `docs/WORKFLOW.md:568-630` |
| 22 | 收尾清理 | 项目收尾必做三件事（Issue #1256） | 每交付完一个 Issue/PR 当场执行：① 清理中间产物（临时脚本/md/worktree连目录删）；② 该评论则评论（留增量信息，回看评论逐条交代）；③ 该关闭则关闭（已验收无遗留才关，未完成/观察票严禁关） | 本地工作区、GitHub Issue/PR | 干净的仓库与准确反映现状的看板 | 桌面堆积残留工作区；盲目关闭未完成 Issue 丢失需求；触发 `test_project_closeout_rule.py` | `协作规范总纲.md:503-521`, `docs/WORKFLOW.md:716-740` |
| 23 | CI 架构 | CI 触发收敛与最小权限（Issue #740 / #699） | 工作流配置 `concurrency: cancel-in-progress`；权限设为只读 `contents: read`；PR 触发全套单测与覆盖率，Push main 仅跑快速 lint；Action 引用钉固定 40 位 commit SHA | Git push / PR 事件 | GitHub Actions 运行结果 | CI 额度单月耗尽被系统拦截；写权限 Token 泄露导致供应链攻击 | `.github/workflows/ci.yml:1-77` |

---

## 二、Edge Cases（边界与异常陷阱）

| # | Feature | Input / Trigger | Observed Behavior | Root Cause & Countermeasure |
|---|---|---|---|---|
| 1 | 文档治理 | 历史 PR 或已废弃文档中的旧数值 | 文档写「杠杆 ≤ 0.6」，但代码默认实际为 0.50 | 规则腐化漂移。明确：**代码优先于文档**；报数字必须现场查证真实代码配置，并给出查询命令，禁止沿用上文记忆。 |
| 2 | 环境隔离 | 在包含空格的路径下创建 worktree | 命令执行失败或脚本无法正确识别路径参数 | Windows 路径含空格时 CLI 解析截断。规范：worktree 目录名**严禁包含空格**，推荐简写如 `${WORKSPACE}/top-gainers-fix`。 |
| 3 | 环境隔离 | worktree 中未复制 `.env` 配置文件 | `src/common/config.py` 根据 `.env.example` 自动生成占位 `.env`，测试用例卡死挂起 >20 分钟 | 占位符引发特定模块等待外部连接。规范：创建 worktree 后必须先从主仓拷贝受 `.gitignore` 保护的真实 `.env`，并确认不入 Git。 |
| 4 | 环境隔离 | 删除已完成的 worktree 时 Windows 提示「正被另一进程使用」 | `git worktree remove` 或 `Remove-Item` 抛出 `EBUSY / Sharing violation` | 本地 IDE 或服务端的 File Watcher 持有目录句柄。规范：先关闭占用进程再删；门禁区分 Git 状态判定与空壳目录只报告。 |
| 5 | 本机测试 | Windows 16GB 内存下整跑全量单元测试 | 进程退出码为 `-1`，没有任何测试报错输出 | 内存溢出（OOM）被操作系统直接杀死。规范：禁止整跑，必须使用分块测试脚本 `scripts/run_tests_chunked.py`。 |
| 6 | 本机测试 | 测试中子模块触发 watchdog `os._exit(0)` | 测试套件退出码为 `0`，但实际未跑完全部用例 | 内部线程调用直接杀死解释器造成「假绿」。规范：测试统计必须基于 `Ran N tests` 输出匹配，而非仅判断退出码。 |
| 7 | 本机测试 | 多会话并发执行测试套件 | 两个全量测试同时读写本地临时目录，导致文件锁争用抛出 `PermissionError` | 并发资源争抢。规范：测试调度脚本增加跨进程文件锁（`.full_suite.lock`），后到实例等待或退出。 |
| 8 | 提交与 PR | PR 标题或正文包含非 ASCII 字符（中文）直接内联 | GitHub 上标题显示为成片十六进制乱码 `\uXXXX`，正文换行丢失 | PowerShell 5.1 不解析 Unicode 转义，反引号还会吃掉控制符。规范：严禁内联，必须通过 `--body-file` 传递 UTF-8 文本。 |
| 9 | 审查门禁 | PR 合入前没有任何人工/监督评审意见，仅作者贴了自查 | `scripts/pr_review_gate.py` 判定违规（形态②：零评审） | 缺少交叉审查盲区无法暴露。规范：强制要求合入前必须有独立审查评论，或由监督席执行快速通道自查留痕。 |
| 10 | 审查门禁 | 监督评审在合入后 109 秒才送达（创建到合入耗时 430s） | 代码合入 main 之后才收到阻塞性审查意见，形成既成事实污染 | 闪电合入（快窗合入）。规范：引入合并冷却期（创建后必须等待 ≥15 分钟，硬红线 600 秒），审查必须在合入前发生。 |
| 11 | 审查门禁 | 审查员给出错误判定（将死代码误判为 P0 缺陷） | 作者盲从审查员意见，将误诊固化为复杂代码 | 人数不是证据（P-SRC-3）。规范：审查意见必须按四档甄别，作者可驳回但必须回复驳回依据，必回的是回音不是照办。 |
| 12 | 审查门禁 | 审查员为机器 Bot（如 Copilot、Dependabot） | Copilot 的额度耗尽提示在合入前几秒贴出，被误识别为「作者自审」 | 机器人回执失真。规范：门禁中显式过滤 `[bot]`、`copilot`、`github-actions` 等 Bot 登录名。 |
| 13 | 收尾清理 | 收尾时为了「列表整洁」关掉未完全验收的 Issue | 待裁决的技术分歧与遗留缺陷被静默丢弃 | 破坏信息可见性。规范：边界条款严格禁止关闭未完成 Issue；处于观察期/待拍板事项必须保持 OPEN 状态。 |
| 14 | 外部服务 | GitHub Actions 额度耗尽（CI 停摆，133 次 run 均 steps:0） | PR 页面显示 CI 失败（红灯），但耗时仅 2 秒，无日志 | 开发者误以为是自己代码改坏。规范：CI 停摆时本机分块测试为唯一可信门禁，PR 正文必须贴 `Ran N tests`，CI 恢复前不过度依赖远端。 |

---

## 三、五组件交接报告（5-Component Handoff Report）

### 1. Observation（直接观察事实）

1. **工作流总纲与规范源文件**:
   - `${SURVEY_PROJECT_ROOT}\协作规范总纲.md` (521 行, 46,875 字节): AI 助手的核心工作规范，定义了 12 条必守纪律（§1.1-§1.12）、P0 红线（§二）、权威文档索引导航（§三）、测试摘要（§四）、收尾必做三件事（§六）。
   - `${SURVEY_PROJECT_ROOT}\docs\WORKFLOW.md` (754 行, 67,075 字节): 详细的 8 步改码正规流程：
     ```text
     §0 不确定 → 先查文档（动手之前）
     §1 Issue（立项）→ §2 分支 + worktree（隔离）→ §3 实现约束 → §4 本机验证（测试+lint）
     → §5 提交 → §6 推送 + 开 PR（等 CI）→ §7 合入 main → §8 清理（删分支/worktree）
     ```
   - `${SURVEY_PROJECT_ROOT}\docs\README.md` (175 行, 19,041 字节): 全仓权威文档一览表与反查视图，确立「代码优先于文档」、「一个事实只在一个权威文档描述」的防腐原则。
   - `${SURVEY_PROJECT_ROOT}\docs\工程教训清单.md` (203 行, 29,437 字节) 及 7 份主题分册（共 87 条教训条目，按 P-xxx 编码）：集中记录反复栽过的坑、单次高代价事故与必记方法，实行只增不删纪律。
   - `${SURVEY_PROJECT_ROOT}\docs\AI-EVIDENCE-STANDARD.md` (502 行, 29,792 字节): 证据驱动执行规范，规定主张三档（已验证/推断/未知）、测试结果五态、评审四档映射、3 次失败停机、10 项规则=判据对。
   - `${SURVEY_PROJECT_ROOT}\scripts\pr_review_gate.py` (1,015 行, 42,809 字节): 自动化审查门禁脚本，提供未回复评审拦截、合并冷却期评估（15 分钟/600 秒红线）、快窗合入审计（`--audit-merged`）、新增测试注册检查（`--new-tests`）、PR 正文 `Ran N tests` 指纹检查。

2. **机械测试锁死机制（P-METHOD-6）**:
   - `tests/test_worktree_isolation_rule.py`: 校验 `协作规范总纲.md` 和 `docs/WORKFLOW.md` 中隔离规则与关键 token；运行期直接检测当前工作区若在主仓 `main` 且源码有修改即判失败；检测本地 `main` 超前于远端的直接提交；并在临时 Git 仓库中构建负例自证。
   - `tests/test_docs_first_lookup_obligation.py`: 校验 `协作规范总纲.md`、`docs/WORKFLOW.md`、`docs/README.md` 中查阅文档优先的声明，禁止软化措辞（如「回头再核」、「凭印象就行」），动态检查所有权威文档均在 §0.3 速查表中有去处。
   - `tests/test_subagent_orchestration_rule.py`, `tests/test_minimal_change_rule.py`, `tests/test_temp_artifacts_cleanup_rule.py`, `tests/test_project_closeout_rule.py`, `tests/test_user_error_correction_843.py`: 分别以措辞锁、要素锁、反向措辞锁保护各核心工作规则。

3. **目标仓库当前状态（AI-workflow）**:
   - 工作目录: `${AI_WORKFLOW_REPO}`
   - 项目性质: TypeScript / Node.js 22+ 项目，构建为 `tsc`，测试为 `node --test`。
   - 当前 Git 状态: 当前位于 `feat/p1-amend-actors` 分支，工作区有未暂存与已暂存修改，且已存在两个 worktree (`AI-workflow` 和 `AI-workflow-ps`)。这实证了必须在独立 worktree（如 `feat/dev-workflow`）中进行规范建设，绝对不能在当前受污染的主工作区直接操作。

---

### 2. Logic Chain（推演逻辑链）

1. **观察 1** 显示 `Top Gainers List Model` 的治理体系之所以能够在大规模多会话并发、AI 频繁介入下保持主干稳定，核心在于建立了**「规则本体（协作规范总纲.md）+ 流程细节（WORKFLOW.md）+ 历史教训（工程教训清单.md）+ 证据标准（AI-EVIDENCE-STANDARD.md）+ 机械门禁（单元测试 & CI & pr_review_gate）」**的五层闭环防护网。
2. **观察 2** 表明，任何仅靠自然语言提示或自律的流程都会在多轮对话中被 AI「无声遗忘」或「软化推迟」。因此，必须将通用开发流程提升为**由测试锁死的代码级不变量**。
3. 从全流程生命周期分析，通用开发流程链路包括六大环节：
   - **环节 1：查阅文档优先**（立项前先查事实，消除先猜后做带来的高额返工代价）；
   - **环节 2：明确纪律与防踩坑**（只增不删的历史踩坑库，让团队不会在同类问题上跌倒两次）；
   - **环节 3：严格立项与范围控制**（Issue 驱动，真实编号防撞，最小改动两档制区分行为修改与重构）；
   - **环节 4：分支与 Worktree 物理隔离**（主仓 main 严禁直接改代码，所有开发在独立 worktree 执行，合入后立即删除，杜绝宿主机环境污染）；
   - **环节 5：本机验证与早筛门禁**（分块跑批、§4.1 早筛清单、指纹防假绿，测试不污染运行环境）；
   - **环节 6：审查合入与收尾清理**（冷却期防闪电合入、主动回看评论、甄别回复、合入后收尾必做三件事）。
4. **观察 3** 表明，AI-workflow 仓库是基于 TypeScript/Node.js 的 Agent 工作流引擎，绝不能照搬涨幅榜的股票/加密货币/金融交易业务逻辑（如开仓关卡、止损、资金状态机、两本账、实盘战绩），而应完整提炼上述**普适性多 Agent 开发治理机制**，结合 Node.js/TypeScript 生态工具链（如 `npm run build`、`node --test`）进行工程落地。

---

### 3. Caveats（局限性与注意事项）

1. **操作系统差异与 Shell 兼容性**: 涨幅榜项目运行于 Windows PowerShell 5.1 环境，针对 GBK 编码、PowerShell 参数转义吃引号等踩过深坑，故开发了 `gh_title_safe.py`。AI-workflow 的规范脚本落地时，需兼顾 Windows PowerShell 与跨平台环境（如 Node.js 跨平台脚本实现）。
2. **测试框架差异**: 涨幅榜测试框架基于 Python `unittest`，具备 `run_tests_chunked.py` 分块机制；AI-workflow 使用 Node.js 内置 test runner (`node --test`)。在早筛清单与测试运行设计上，需基于 Node.js 机制进行适配。
3. **CI 状态假设**: 涨幅榜由于 GitHub Actions 额度耗尽，演化出了极度强化本机测试可信度的防御机制（`Ran N tests` 正文指纹）；在 AI-workflow 中，该机制依然作为杜绝「未测先合」的优秀工程实践被完整继承。

---

### 4. Conclusion（结论与划分分析）

#### 4.1 通用多 Agent 开发流程机制（必须继承并适配至 AI-workflow）
1. **§0 查阅文档优先机制 (Docs-First Rule)**:
   - 建立全仓唯一文档导航 (`docs/README.md`)；
   - 规定查证四级顺序与代码优先原则，杜绝臆造路径、命令与参数。
2. **AI 必守纪律与教训清单体系 (工程教训清单)**:
   - 确立核心纪律：最小改动两档制（改行为就地改、重构零行为变更）、子代理分工编排（总代理分配检查、抽查复核）、假定用户会出错（指出≠越权）、及时清理中间产物；
   - 设立集中式踩坑清单 `docs/工程教训清单.md`，G1/G2/G3 准入门槛，只增不删。
3. **证据驱动与交付分级规范 (AI-Evidence-Standard)**:
   - 主张三档（已验证/推断/未知），禁止把未知脑补为答案；
   - 测试结果五态表达，交付结果 A/B/C/D/E 分类，3 次失败停机升级。
4. **Git Worktree 物理隔离与生命周期管理**:
   - 主仓 `main` 禁改任何受控代码与文档，所有任务新建独立 worktree；
   - 建立外部目录与 worktree「用完即删」生命周期管理（连目录一起删）。
5. **任务立项与真实编号规范**:
   - Issue 驱动立项，强制使用 CLI 实际返回的真实编号命名分支与测试，避免并发会话撞号。
   - PR 正文关联 `Closes #NNN`。
6. **本机测试门禁与早筛机制**:
   - 建立合并前必跑清单（Pre-merge Checklist）；
   - 测试结果必须附带真实输出指纹，杜绝占位符；
   - 测试副产物隔离与自动还原机制。
7. **审查闭环、合并冷却与收尾三件事**:
   - 审查反馈主动回看与逐条交代（四档甄别、必回一条回音）；
   - PR 合并冷却期（≥15 分钟）与审查门禁工具（`pr_review_gate`）；
   - 收尾必做三件事：清理中间产物、该评论则评论、该关闭则关闭。

#### 4.2 涨幅榜特定业务逻辑（严禁复制到 AI-workflow）
1. **交易风控与策略闸门**: 开仓 16 道关卡、卖出盈利四层、亏损卖出六机制、顺风车阶梯、跌幅保护等。
2. **金融会计与两本账机制**: Paper Broker、模拟盘 vs 官方真实盘、VWAP 成交价合并、幂等账本沉淀等。
3. **交易链路专属说明书集合**: 10 份 `TRADING-*.md` 说明书及其专属同步义务。
4. **交易专用观察票取数脚本**: `scripts/tp1_change_verdict.py`、`scripts/reentry_verdict.py` 等金融时序分析探针。
5. **量化与社群信号参数**: 绵羊社群信号、Binance 合约杠杆物理护栏、止损百分比等。

---

### 5. Verification Method（独立验证方法）

后续接手 Agent 可通过以下具体命令与文件检查本报告所述结论：

1. **查验权威源文件存在性与关键内容**:
   ```powershell
   # 验证 协作规范总纲.md 纪律本体与 P0 红线
   Get-Content "${SURVEY_PROJECT_ROOT}\协作规范总纲.md" -TotalCount 50

   # 验证 WORKFLOW.md 八步全流程
   Select-String -Path "${SURVEY_PROJECT_ROOT}\docs\WORKFLOW.md" -Pattern "## 标准链路" -Context 0,5

   # 验证踩坑清单准入门槛 G1/G2/G3
   Select-String -Path "${SURVEY_PROJECT_ROOT}\docs\工程教训清单.md" -Pattern "G1 反复"

   # 验证证据驱动三档主张
   Select-String -Path "${SURVEY_PROJECT_ROOT}\docs\AI-EVIDENCE-STANDARD.md" -Pattern "三档主张"
   ```

2. **查验审查门禁脚本的冷却期与必跑清单拦截实现**:
   ```powershell
   # 检查冷却期参数与违规判定
   Select-String -Path "${SURVEY_PROJECT_ROOT}\scripts\pr_review_gate.py" -Pattern "FAST_MERGE_FLOOR_SECONDS" -Context 0,5
   Select-String -Path "${SURVEY_PROJECT_ROOT}\scripts\pr_review_gate.py" -Pattern "unregistered_new_tests" -Context 0,10
   ```

3. **查验机械锁死单元测试的断言逻辑**:
   ```powershell
   # 检查 worktree 隔离与主仓禁改的测试实现
   Select-String -Path "${SURVEY_PROJECT_ROOT}\tests\test_worktree_isolation_rule.py" -Pattern "test_no_source_edits_in_main_checkout" -Context 0,10
   ```

4. **失效条件 (Invalidation Conditions)**:
   - 若 `Top Gainers List Model` 的 `协作规范总纲.md` 或 `docs/WORKFLOW.md` 删除了 worktree 隔离或先查文档规定，本报告相应部分失效；
   - 若 AI-workflow 的开发模式转向无需 Git 协作的单文件原型开发，多 Agent 审查与冷却期规则可做裁剪。

---

## 四、对 AI-workflow 的落地实施方案建议

为了在 `AI-workflow` 仓库建立高质量、规范化且契合自身项目特性的多 Agent 开发流程体系，建议后续实施方案分为三个阶段分步落地：

### 阶段 1：在独立 Git Worktree 中建立核心规范文档
1. 依照 R2 要求，创建并切换至工作区 `${WORKSPACE}/ai-workflow-dev-workflow`（分支名 `feat/dev-workflow`）。
2. 在根目录建立 `协作规范总纲.md`：
   - 写入 AI 开发必守纪律（先查文档、最小改动两档制、子代理编排、用户纠错、证据驱动、worktree 物理隔离、收尾三件事）；
   - 写入通用工程 P0 红线（严禁泄露密钥、依赖版本锁定、主仓 main 严禁修改等）；
   - 建立文档导航与收尾必做三件事。
3. 在 `docs/` 目录建立配套治理体系：
   - `docs/WORKFLOW.md`: 适配 Node.js/TypeScript 生态的标准 8 步改码流程（§0 先查文档 → Issue → worktree 隔离 → 实现约束 → 本机测试 `npm test` & build `npm run build` → 提交 → PR → 审查合入 → 清理）；
   - `docs/README.md`: 仓库全局唯一文档导航与防腐规则；
   - `docs/工程教训清单.md`: 踩坑清单中枢与工程/流程分册，沉淀 AI 开发常见陷阱；
   - `docs/AI-EVIDENCE-STANDARD.md`: 证据驱动规范与交付物分档验收标准。

### 阶段 2：工程化门禁脚本与 PR 模板配置
1. 建立 `.github/PULL_REQUEST_TEMPLATE.md`: 强制包含开 PR 前自检清单（无占位符、已跑测试指纹、已回看并处理所有评审评论）。
2. 移植并适配自动化审查门禁脚本 `scripts/pr_review_gate.mjs` (或 Python 脚本):
   - 实现 PR 审查回复检查（三态交代：已处理/刻意不改/需人拍板）；
   - 实现合并冷却期保护（防止闪电合并）；
   - 实现 PR 正文测试输出指纹校验。
3. 配置 GitHub Actions 工作流 `.github/workflows/ci.yml`: 采用并发控制（`cancel-in-progress`）、最小只读权限、Action 锁定 commit SHA。

### 阶段 3：编写自动化测试锁定纪律并推送到远端
1. 编写 Node.js 测试套件（如 `tests/unit/workflow-governance.test.ts`）：
   - 措辞与关键要素锁：断言 `协作规范总纲.md` 与 `docs/WORKFLOW.md` 中的关键纪律（worktree、查文档、收尾三件事）未被无声删除；
   - 运行期工作区隔离检测：断言主仓 main 未被直接修改。
2. 运行本地构建与全量测试：`npm run build` 与 `npm test`，确保全绿。
3. 提交全部规范文件，推送到远端仓库 `origin/feat/dev-workflow`，完成闭环验收。
