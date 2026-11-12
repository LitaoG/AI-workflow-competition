# AI-workflow 权威文档目录与单一事实源（Single Source of Truth）

> 本文件是 **AI-workflow 仓库的权威文档总目录与反查索引**。
> 本仓库严格实行 **单一事实源（Single Source of Truth）与防腐规则**：
> 1. **全仓每个事实（规则、接口、流程、阈值）只在一个权威文档中唯一定义**，其他地方仅通过相对路径链接引用，严禁多处复制粘贴导致改一漏一。
> 2. **代码优先于文档**：当前现行事实以 `main` 分支真实代码、测试断言与运行接口为准，文档不得反向定义现实。
> 3. **动态数据不硬编码**：测试用例数、版本号、环境指标等动态演化数据，文档只记录查询命令与事实出处，不固化容易过期的静态数值。

---

## 一、权威文档一览表

| 领域 / 主题 | 权威文档路径 | 核心职责与涵盖范围 |
|---|---|---|
| **研发工作流程** | `docs/WORKFLOW.md` | 8 步改码全流程、Issue-First、Worktree 物理隔离、本机验证命令、PR 门禁与清理 |
| **文档防腐索引** | `docs/README.md` | 全仓权威文档总目录、单一事实源原则、反查速查索引 |
| **证据驱动规范** | `docs/AI-EVIDENCE-STANDARD.md` | 三档主张（已验证/推断/未知）、五态测试表达、A-E 五类交付物与失败停机升级 |
| **项目概述入口** | `README.md` | 项目愿景、动态工作流 /workflow 架构概览、快速上手指南 |
| **系统架构设计** | `docs/ARCHITECTURE.md` | 核心分层架构、RPC 契约、DAG 调度、SQLite WAL 存储机制 |
| **开发者指南** | `docs/DEVELOPER_GUIDE.md` | 模块开发说明、自定义 Step 与 Agent 编写、调试与排障手段 |
| **Kiro 集成与合规** | `docs/KIRO_INTEGRATION.md` | `.kiro/` 五子系统（specs / hooks / steering / MCP / PBT）与 Skeleton Crew 花名册、权限上限的完整指南 |
| **宿主集成指南** | `docs/INTEGRATION.md` | MCP 工具（`workflow_script_check/run`）、Agent Skill（`skills/ai-workflow/`）与 CLI Provider 接入 |
| **评委导航入口** | `SUBMISSION.md` | 1 分钟 pitch、演示视频占位、九幕一键复现、仓库地图与合规声明 |
| **Facade 编排模式** | `docs/authoring-patterns.md` | facade 脚本编排模式目录：workflow 脚本的写作范式与可复用结构 |
| **中文译本** | `docs/i18n/` | ARCHITECTURE / DEVELOPER_GUIDE / KIRO_INTEGRATION 三篇权威文档的中文对照版 |
| **产品展示页** | `docs/showcase.html` | 单文件深色主题展示页：pitch、失败模式修复、架构 SVG、实拍演示输出，无构建步骤 |
| **PR 提交模板** | `.github/PULL_REQUEST_TEMPLATE.md` | PR 提交模板、自检清单与测试输出指纹约束 |
| **Issue 立项模板** | `.github/ISSUE_TEMPLATE/` | 新特性、缺陷、治理与重构的结构化 Issue 模板 |
| **审查门禁脚本** | `scripts/pr_review_gate.mjs` | PR 审查意见回复与冷却期自动化检测工具 |

---

## 二、事实反查速查表（什么事实去哪查）

| 当你不确定以下事项时 | 请直接查阅权威文档 |
|---|---|
| 怎么立项、分支怎么命名、Worktree 怎么建、怎么合入 PR | `docs/WORKFLOW.md` §1, §2, §6, §7 |
| 在 Windows PowerShell 下怎么跑构建、单测、PBT、E2E | `docs/WORKFLOW.md` §4 |
| 怎么表述测试结果、交付报告怎么分级、什么时候必须停机上报 | `docs/AI-EVIDENCE-STANDARD.md` |
| PR 模板格式是什么、发起 PR 必须贴哪些测试指纹 | `.github/PULL_REQUEST_TEMPLATE.md` |
| 怎么立项结构化 Issue、Issue 模板有哪些字段 | `.github/ISSUE_TEMPLATE/` |
| 自动化评审门禁工具怎么用、参数有哪些 | `scripts/pr_review_gate.mjs` |
| 引擎核心组件之间如何通信、RPC Schema 怎么定义 | `docs/ARCHITECTURE.md` |
| 怎么扩展新的 Slash 命令或自定义 Agent 角色 | `docs/DEVELOPER_GUIDE.md` |
| 怎么把引擎接入 Kiro（specs / hooks / steering / MCP / PBT） | `docs/KIRO_INTEGRATION.md` |
| 怎么把引擎接入其他 agent 宿主（MCP / Skill / Provider） | `docs/INTEGRATION.md` |
| 怎么编写 facade 脚本（编排模式与范式） | `docs/authoring-patterns.md` |
| 评委从哪里开始看这个仓库 | `SUBMISSION.md` |

---

## 三、文档防腐与维护纪律

1. **新增权威文档义务**：
   - 当仓库引入新的核心架构模块或规范体系时，必须在本文档第一节「权威文档一览表」与第二节「事实反查速查表」同步登记；
   - 登记完整性由本索引自身维护：任何新增文档必须可从本索引反查到达，发现游离文档应并入既有权威文档或删除，严禁在索引之外新立文档入口。
2. **文档与代码冲突时的处置规则**：
   - 遵循**代码优先于文档**原则：以 `main` 分支代码、测试用例断言及当前导出的 Schema 为准。
   - 严禁为了迁就陈旧文档而修改原本正确的代码。
   - 发现文档漂移，应作为常规文档治理任务在同一 PR 中同步修正。
3. **禁止随意新建单次游离文档**：
   - 单次排查或调试笔记严禁随意散落在仓库根目录或 `docs/` 下；
   - 长期有价值的事实与教训归并入既有权威文档，一次性草稿用完即删。
