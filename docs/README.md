# AI-workflow 权威文档目录与单一事实源（Single Source of Truth）

> 本文件是 **AI-workflow 仓库的权威文档总目录与反查索引**。
> 本仓库严格实行 **单一事实源（Single Source of Truth）与防腐规则**：
> 1. **全仓每个事实（规则、接口、流程、阈值）只在一个权威文档中唯一定义**，其他地方仅通过相对路径链接引用，严禁多处复制粘贴导致改一漏一。
> 2. **代码优先于文档**：当前现行事实以 `main` 分支真实代码、测试断言与运行接口为准，文档不得反向定义现实。
> 3. **动态数据不硬编码**：测试用例数、版本号、环境指标等动态演化数据，文档只记录查询命令与事实出处，不固化容易过期的静态数值。

---

## 一、权威文档一览表（五大主题导航矩阵）

> 全仓权威文档按 **架构设计 · 研发治理 · 逆向研究 · 安全渗透 · 扩展指南** 五大主题归组，实现专业化逻辑分类。
> `docs/WORKFLOW.md`、`docs/AI-PITFALLS.md`、`docs/AI-EVIDENCE-STANDARD.md`、`docs/README.md` 四个治理锁死文件物理路径保持 `docs/` 顶层不动，仅在下方按主题逻辑归类（物理路径由 `tests/unit/workflow-governance.test.ts` 锁死）。

### 1. 架构设计类

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **项目主入口（评委导向）** | `README.md` | 英文评委导向主页：30 秒 pitch、三种对话式失败模式的结构性修复、"一副骨架两个应用"与两个 demo 对照、三分钟评委体验（一键九幕 demo）、Kiro 集成总览、评审五维映射与合规声明——九幕证据表、质量指纹与跨引擎基准的**权威版本在 SUBMISSION.md**（本页只留链接分流，Issue #132 收敛） |
| **1分钟上手指南** | `QUICKSTART.md` | 零门槛上手：capabilities-tour 示例、统一 run 入口、--set/--args-file 传参、Studio 看板、setup 互通与命令速查 |
| **系统架构设计（权威中文规约）** | `docs/ARCHITECTURE.md` | 总体架构图（自 README 迁入）、设计哲学、模块地图、双引擎执行模型、Facade 编译器纯度契约、VM 沙箱与进程组监管、强类型 RPC、环境探测、双层持久化与零 Token 重放、可视化与 Studio、MCP、技术溯源、威胁模型与纵深防御 |
| **系统演进蓝图** | `GOAL.md` | 引擎演进蓝图与技术路线：核心使命与架构哲学、三大参考源技术谱系、已落地架构现状与里程碑（阶段 0–8）、后续演进方向、工程铁律 |

### 2. 研发治理类

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **AI 核心纪律** | `AGENTS.md` | AI 助手入口规范、核心必守纪律、P0 红线、收尾三件事 |
| **研发工作流程** | `docs/WORKFLOW.md` | 8 步改码全流程、Issue-First、Worktree 物理隔离、本机验证命令、PR 门禁与清理 |
| **文档防腐索引** | `docs/README.md` | 全仓权威文档总目录、单一事实源原则、反查速查索引（本文件） |
| **历史教训积累** | `docs/AI-PITFALLS.md` | 集中记录反复栽过的坑（G1）、单次高代价事故（G2）、强制门禁与规程（G3），只增不删 |
| **证据驱动规范** | `docs/AI-EVIDENCE-STANDARD.md` | 三档主张（已验证/推断/未知）、五态测试表达、A-E 五类交付物与失败停机升级 |
| **测试基础设施** | `TEST_INFRA.md` | 测试体系架构、分层目录结构与验证命令对照、E2E 特性映射（F1–F9）与真实场景、PBT 与治理测试方法 |
| **PR 提交模板** | `.github/PULL_REQUEST_TEMPLATE.md` | PR 提交模板、自检清单与测试输出指纹约束 |
| **Issue 立项模板** | `.github/ISSUE_TEMPLATE/` | 新特性、缺陷、治理与重构的结构化 Issue 模板 |
| **审查门禁脚本** | `scripts/pr_review_gate.mjs` | PR 审查意见回复与冷却期自动化检测工具 |
| **官方 Dynamic Workflow 对标白皮书** | `docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md` | 官方 2.1.316 逆向、实机黑盒、双向对标、红蓝对抗与 Date 纯度封印落地 |
| **官方 vs AI-workflow 双轨基准报告** | `docs/research/OFFICIAL-VS-AI-WORKFLOW-BENCHMARK.md` | 4 大场景的实测/源码级证据、C 类受阻项与解除条件 |
| **吸收能力与决策账本** | `docs/absorbed-capabilities.md` | Project Y 四级过滤（T1–T4）下每项外部能力的吸收 / 拒收决策、来源、落地模块与带日期的验证快照 |

### 3. 逆向研究类

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **ZCode 官方深度逆向** | `docs/research/workflow-reverse-engineering.md` | ZCode 官方工作流机制逆向与三代演进拆解、rea 静态分析实测、差距分析与 P0→P2 融合蓝图 |
| **Claude Code 对标白皮书** | `docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md` | 官方 2.1.316 逆向、实机黑盒、双向对标、红蓝对抗与 Date 纯度封印落地 |
| **Antigravity 原生动态工作流白皮书** | `docs/research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md` | Antigravity 架构逆向、FD 劫持隔离、未 Await 挂起 Promise 审计防御与四大谱系对标 |
| **双轨实测对比基准** | `docs/research/OFFICIAL-VS-AI-WORKFLOW-BENCHMARK.md` | 4 大场景的实测/源码级证据、C 类受阻项与解除条件 |
| **ZCode 深度逆向机制报告 v2** | `docs/research/ZCODE-DEEP-REVERSE-v2.md` | MISSION-B 阶段一交付：dynamic-workflow 全家族（runtime/adapters/bootstrap/shared）源码级 REA 证据驱动逆向，AIMD 治理等官方语义机制出处 |
| **官方 Workflow 一手遥测 Ground Truth** | `docs/research/OFFICIAL-WORKFLOW-TELEMETRY.md` | MISSION-B Phase-2 交付：官方 Workflow 真实执行的本机遥测白皮书，数值逐字取自探针 stdout 并逐条标注证据档位 |
| **ZCode×本仓七维基准对比报告** | `docs/research/ZCODE-BENCHMARK-REPORT.md` | TEST-GOAL 4.1 交付：ZCODE 官方引擎 × 本仓引擎七维基准对比与证据分级（缺口状态唯一登记处为同目录 WORKFLOW-GAP-MATRIX） |
| **双向跨界对标报告** | `docs/research/BILATERAL-CROSS-BENCHMARK-REPORT.md` | MISSION-B（Issue #67）阶段五交付：官方引擎与我方引擎同任务、同脚本、同桩模型的四维双向对标 |
| **工作流差距矩阵总账** | `docs/research/WORKFLOW-GAP-MATRIX.md` | TEST-GOAL 4.1 总交付：六大不变量实测、官方内核逆向切片、PoC 攻防与 GAP 补强修复状态的统一可复核矩阵（D#/R#/GAP-# 状态唯一登记处） |
| **Claude Code 二进制逆向证据** | `docs/research/claude-code-binary-reverse.md` | Claude Code 2.1.316 win32-x64 平台二进制（Bun 编译）npm pack + 定向标记扫描的首轮逆向证据 |
| **Claude Code 引擎完整逆向** | `docs/research/claude-code-workflow-internals.md` | Claude Code 2.1.316 workflow 模块整段 dump + 逐函数精读的深度提取逆向（配套首轮二进制证据） |

### 4. 安全渗透类

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **红蓝渗透与安全审计报告** | `docs/research/PENETRATION-AND-SECURITY-AUDIT.md` | 四大攻防用例（沙箱逃逸 PoC、NDJSON 协议投毒、DoS 资源炸弹、凭据窃取）的攻击向量、实测记录、防线状态与加固清单 |

### 5. 扩展指南类

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **开发者指南（权威中文指南）** | `docs/DEVELOPER_GUIDE.md` | 两种编写面选型、脚手架与 CLI 速查、CLI 全量命令手册 / 环境变量 / MCP 工具面与特性矩阵（自 README 迁入）、Facade 脚本规范与编译期禁忌、core 构建器、沙箱与安全测试、调试排障、测试分层与门禁 |
| **接入集成指南** | `docs/INTEGRATION.md` | CLI 接入、MCP Server 挂载（Claude Code / ZCode / opencode / Codex CLI / Cursor）、Skill 安装、Provider 路由 |
| **Kiro 集成与合规** | `docs/KIRO_INTEGRATION.md` | `.kiro/` 五子系统（specs / hooks / steering / MCP / PBT）与 Skeleton Crew 花名册、权限上限的完整指南 |
| **评委导航入口（提交权威）** | `SUBMISSION.md` | 1 分钟 pitch、演示视频占位、九幕一键复现（证据表唯一权威）、质量指纹唯一钉点、跨引擎基准实测、仓库地图与合规声明 |
| **Facade 编排模式** | `docs/authoring-patterns.md` | facade 脚本编排模式目录：workflow 脚本的写作范式与可复用结构 |
| **中文译本（历史存档）** | `docs/i18n/` | ARCHITECTURE / DEVELOPER_GUIDE / KIRO_INTEGRATION 三篇的 **2026-11-03 黑客松版本中文原文——历史存档，不再演进**；现行权威内容以各篇主文档（`docs/ARCHITECTURE.md` / `docs/DEVELOPER_GUIDE.md` / `docs/KIRO_INTEGRATION.md`）为准 |
| **多代理治理体系历史存档** | `PROJECT.md` | 私有仓时代 M1 里程碑 survey 的**历史存档**（2026-11-14 定版）：治理框架 / 证据规范 / 门禁机制的立项期全貌；现行权威以 `AGENTS.md` 与 `docs/` 各篇为准（Issue #132 登记，消除悬空状态） |
| **产品展示页** | `docs/showcase.html` | 单文件深色主题展示页：pitch、失败模式修复、架构 SVG、实拍演示输出，无构建步骤 |

---

## 二、事实反查速查表（什么事实去哪查）

| 当你不确定以下事项时 | 请直接查阅权威文档 |
|---|---|
| AI 能不能这么做、有哪些 P0 红线与不可触犯的底线 | `AGENTS.md` §二 |
| 怎么立项、分支怎么命名、Worktree 怎么建、怎么合入 PR | `docs/WORKFLOW.md` §1, §2, §6, §7 |
| 在 Windows PowerShell 下怎么跑构建、单测、PBT、E2E | `docs/WORKFLOW.md` §4 |
| 以前在当前模块或命令上栽过什么坑、有什么必记防范方法 | `docs/AI-PITFALLS.md` |
| 怎么表述测试结果、交付报告怎么分级、什么时候必须停机上报 | `docs/AI-EVIDENCE-STANDARD.md` |
| PR 模板格式是什么、发起 PR 必须贴哪些测试指纹 | `.github/PULL_REQUEST_TEMPLATE.md` |
| 怎么立项结构化 Issue、Issue 模板有哪些字段 | `.github/ISSUE_TEMPLATE/` |
| 自动化评审门禁工具怎么用、参数有哪些 | `scripts/pr_review_gate.mjs` |
| 引擎核心组件之间如何通信、RPC Schema 怎么定义 | `docs/ARCHITECTURE.md` |
| 怎么扩展新的 Slash 命令或自定义 Agent 角色 | `docs/DEVELOPER_GUIDE.md` |
| CLI 全量命令与选项、常用环境变量、MCP 工具目录、特性矩阵与验证锚点在哪 | `docs/DEVELOPER_GUIDE.md` §2.3–§2.5、§8 |
| 怎么把引擎接入 CLI、MCP Server 与各类 Host（Claude Code / ZCode / opencode / Codex CLI / Cursor） | `docs/INTEGRATION.md` |
| 怎么把引擎接入 Kiro（specs / hooks / steering / MCP / PBT） | `docs/KIRO_INTEGRATION.md` |
| 怎么编写 facade 脚本（编排模式与范式） | `docs/authoring-patterns.md` |
| 评委从哪里开始看这个仓库 | `SUBMISSION.md` |
| 测试怎么跑、特性与测试用例怎么映射、真实场景覆盖了什么、质量覆盖率指标是什么 | `TEST_INFRA.md` |
| 1 秒 demo、--set/--args-file 传参、Studio 看板怎么用 | `QUICKSTART.md` |
| ZCode 官方工作流机制怎么逆向的、三代演进与 P0→P2 融合蓝图 | `docs/research/workflow-reverse-engineering.md` |
| 官方 Dynamic Workflow 与本仓到底差在哪、有哪些实测证据与源码行号 | `docs/research/CLAUDE-CODE-DYNAMIC-WORKFLOW-WHITEPAPER.md` |
| Google Antigravity 动态工作流架构、FD 劫持隔离、未 Await 泄漏审计与四大谱系对标 | `docs/research/ANTIGRAVITY-RUN-WORKFLOW-WHITEPAPER.md` |
| 沙箱逃逸、协议投毒、DoS 资源炸弹、凭据窃取的攻防实测与防线状态 | `docs/research/PENETRATION-AND-SECURITY-AUDIT.md` |
| 4 大双轨场景哪些真正实测了、哪些是 C 类受阻 | `docs/research/OFFICIAL-VS-AI-WORKFLOW-BENCHMARK.md` |
| ZCode dynamic-workflow 全家族源码级逆向细节、AIMD 等官方语义机制的出处 | `docs/research/ZCODE-DEEP-REVERSE-v2.md` |
| 官方 Workflow 真实执行的一手遥测数据与证据档位标注 | `docs/research/OFFICIAL-WORKFLOW-TELEMETRY.md` |
| ZCODE 官方引擎与本仓引擎的七维基准对比结论与证据分级 | `docs/research/ZCODE-BENCHMARK-REPORT.md` |
| 官方与我方引擎同任务、同脚本、同桩模型的四维双向对标结果 | `docs/research/BILATERAL-CROSS-BENCHMARK-REPORT.md` |
| 六大不变量实测、PoC 攻防与 GAP/D#/R# 条目的修复状态唯一登记处 | `docs/research/WORKFLOW-GAP-MATRIX.md` |
| Claude Code 平台二进制定向标记扫描的首轮逆向证据 | `docs/research/claude-code-binary-reverse.md` |
| Claude Code workflow 引擎整段 dump 逐函数精读的完整逆向 | `docs/research/claude-code-workflow-internals.md` |
| 某项外部能力为什么被吸收或拒收、来源是什么、落在哪个模块 | `docs/absorbed-capabilities.md` |

---

## 三、文档防腐与维护纪律

1. **新增权威文档义务**：
   - 当仓库引入新的核心架构模块或规范体系时，必须在本文档第一节「权威文档一览表」与第二节「事实反查速查表」同步登记；
   - 治理门禁测试 `tests/unit/workflow-governance.test.ts` 会校验登记完整性，防止文档游离失管。
2. **文档与代码冲突时的处置规则**：
   - 遵循**代码优先于文档**原则：以 `main` 分支代码、测试用例断言及当前导出的 Schema 为准。
   - 严禁为了迁就陈旧文档而修改原本正确的代码。
   - 发现文档漂移，应作为常规文档治理任务在同一 PR 中同步修正。
3. **禁止随意新建单次游离文档**：
   - 单次排查或调试笔记严禁随意散落在仓库根目录或 `docs/` 下；
   - 长期有价值的事实归并入既有权威文档，教训归并入 `docs/AI-PITFALLS.md`，一次性草稿用完即删。
