# AI 踩坑与必记方法清单（AI-PITFALLS）

> 面向 AI 助手与人类开发者：本文件 `docs/AI-PITFALLS.md` 把在 `AI-workflow` 研发与维护过程中**反复踩过的坑**、**高代价事故**与**必记防范方法**集中归档，
> 避免同一教训在多个文件中重复抄写，也避免修好一处后因遗忘导致同类问题死灰复燃。
>
> **本文件是「教训」的权威源，不是「事实」的权威源。** 架构设计、接口约定与执行命令本体仍在各自权威文档。
> 本清单只回答一个核心问题：**「这里以前栽过什么坑、根因是什么、以后怎么不踩第二次。」**
>
> 纪律来源见 `AGENTS.md` §1.2 与 `docs/WORKFLOW.md` §0.5，由 `tests/unit/workflow-governance.test.ts` 门禁锁定。

---

## 0. 准入门槛与记录规范

### 0.1 严格准入门槛（三选一，否则不予录入）

| 门槛代号 | 准入标准 | 说明与判定依据 |
|---|---|---|
| **G1 反复** | 同一根因**反复发生**（≥2 次） | 偶发一次的小插曲不占版面；反复栽倒的才需要集中警示 |
| **G2 单次高代价** | 只发生过 1 次，但造成**主干污染 / 凭据泄露 / 阻塞合并 / 假绿放行**等严重后果 | 后果严重且不可逆，必须写入规则 |
| **G3 已成强制** | 已提炼为**自动化测试门禁**或写入**核心工程规程** | 已是团队工程制度的一部分，本文件作为索引 |

**明确排除内容**：
- 偶发的临时环境抖动、单次输入笔误；
- 尚未复现的主观猜测；
- 接口与阈值参数的数值本体（属于事实文档，防腐原则禁止跨文件抄写）。

### 0.2 每条记录的结构化标记

```text
#### P-<簇>-<序号> 一句话标题
- 复发性：G1 反复 (≥N 次) / G2 单次高代价 / G3 已成强制
- 代价：<真实产生的代价或后果>
- 根因：<深入分析产生问题的根本技术原因>
- 正确做法：<可复现、可执行的正确命令或编码规范>
- 门禁：`tests/...` 或对应自动化脚本 / 无门禁 —— 待补
- 原位置：<权威出处与相关文档指针>
```

### 0.3 维护纪律（只增不删）

- 本清单**只增不删**。任何踩过的坑被修复后，必须在条目中更新标注为「已修 + 对应门禁」，严禁直接删除条目（删除会导致后续会话丢失记忆并重蹈覆辙）。

---

## 1. AI-workflow 专属已知踩坑与防范规程

#### P-ENV-1 Windows PowerShell 下执行 bare `npm` 导致脚本策略拦截
- 复发性：G1 反复 (已实测发生多次)
- 代价：自动化脚本或测试执行中途挂死或抛出 `File npm.ps1 cannot be loaded because running scripts is disabled`，命令直接失败。
- 根因：Windows 默认 PowerShell 执行策略（Restricted / RemoteSigned）禁止执行未经签名的 `.ps1` 脚本。调用 bare `npm` 时 PowerShell 优先解析环境变量 PATH 下的 `npm.ps1` 而非可执行批处理。
- 正确做法：在 Windows PowerShell 下执行任何 npm 相关命令时，**必须显式调用 `npm.cmd`**（例如 `npm.cmd run build`、`npm.cmd run test:unit`）或使用 Node.js 直接驱动 `node --experimental-strip-types ...`。
- 门禁：`tests/unit/workflow-governance.test.ts`（静态扫描文档与命令，断言包含 `npm.cmd` 指引）。
- 原位置：`docs/WORKFLOW.md` §4。

#### P-ENV-2 Windows 文件句柄占用导致 Worktree 清理失败
- 复发性：G1 反复 (≥2次)
- 代价：在收尾执行 `git worktree remove` 或删除临时目录时，操作系统抛出 `EBUSY: resource busy or locked` 或 `Access is denied`，导致残留垃圾目录滞留宿主机桌面。
- 根因：本地 IDE、终端会话、Node.js 运行实例或文件监视器（File Watcher）仍保持对该 worktree 目录内部文件的活动打开句柄，Windows 内核禁止删除处于打开句柄状态的文件或父目录。
- 正确做法：执行清理前，先关闭对应的工作区进程或会话；若在终端操作，确保当前终端的工作目录（Current Working Directory）不在待删 worktree 之内（先 `cd` 回主仓或上一级），再执行清理。
- 门禁：`docs/WORKFLOW.md` §8 清理顺序规范。
- 原位置：`docs/WORKFLOW.md` §8.0。

#### P-GIT-1 嵌套 Worktree 导致主仓 Git 状态被静默污染
- 复发性：G2 单次高代价
- 代价：如果在主仓内部目录（如 `.worktrees/`）直接创建 git worktree，由于 `.gitignore` 默认未忽略该路径，会导致主仓出现不可忽略的大量 untracked 文件，污染主分支状态并阻碍分支切换。
- 根因：Git 工作区边界认知不清，将隔离工作区置于受控仓库根树之内。
- 正确做法：所有 Git Worktree 必须统一建立在主仓同级的外部独立目录（Sibling Directory），如 `../AI-workflow-worktrees/<name>`。
- 门禁：`tests/unit/workflow-governance.test.ts`（断言主仓 worktree 隔离规则）。
- 原位置：`AGENTS.md` §1.8、`docs/WORKFLOW.md` §2。

#### P-TEST-1 Node.js ExperimentalWarning SQLite 告警与假绿拦截
- 复发性：G1 反复
- 代价：运行含有 SQLite 持久化测试时，stderr 打印 `(node:XXXXX) ExperimentalWarning: SQLite is an experimental feature`。若仅基于 stderr 是否为空判定测试成败，会产生误报；反之若仅看进程返回码，当测试中存在未捕获异常但被静默捕获时会出现「假绿」。
- 根因：Node.js 22 内置 `node:sqlite` 在执行时会向标准错误输出警告信息；同时部分测试框架可能存在退出码为 0 但实际用例未跑完的风险。
- 正确做法：测试判定必须基于 TAP 输出与测试断言指纹（`pass N, fail 0` 与 `tests N`），PR 正文必须完整提取并贴出包含用例统计的真实测试指纹，严禁使用占位符。
- 门禁：`scripts/pr_review_gate.mjs`（`--check-fingerprint` 校验真实测试指纹）。
- 原位置：`docs/WORKFLOW.md` §4、`.github/PULL_REQUEST_TEMPLATE.md`。

#### P-TEST-2 测试副产物修改 Fixtures 污染 Git 跟踪状态
- 复发性：G2 单次高代价
- 代价：运行 `npm.cmd run test:unit` 后，测试脚本向 `tests/unit/fixtures/` 输出了 `exported-dag.html`、`test-scaffold-basic` 等测试生成文件，若不注意直接 `git add .`，会将运行副产物带入 Git 提交。
- 根因：单元测试包含 CLI 生成逻辑，直接写入了受版本控制的测试夹具目录。
- 正确做法：测试运行完毕后，必须强制执行 `git restore tests/unit/fixtures/` 还原夹具目录，确保 `git status --porcelain` 完全干净后再进行 Git 提交。
- 门禁：`AGENTS.md` §四、`docs/WORKFLOW.md` §4.1。
- 原位置：`docs/WORKFLOW.md` §4。

#### P-TEST-3 门禁指纹汇总只存计数导致失败失名；无超时保护的 spawn 集成测试负载下挂起
- 复发性：G1 反复 (Issue #32 实测：基线采样 5 轮中 2 轮在同一用例挂起，round3/round4 均卡 `stdio e2e: real spawn lists all seven tools` 超过 10 分钟零输出)
- 代价：TEST-GOAL 阶段0 基线核验出现 237/238 一例红灯，但指纹汇总层只保留了 tests/pass/fail 计数，未保存 not ok 行名，失败用例失名，追因只能整轮重跑盲猜。
- 根因：两层叠加——① 基线/门禁指纹汇总层采集 TAP 时只提取计数摘要，丢弃 `not ok` 行名；② `tests/integration/mcp-stdio-e2e.test.ts` 的真实 spawn 集成测试未设 timeout（node:test 默认无限等待），宿主机负载下 `StdioClientTransport` connect 可无限挂起，整轮卡死既不出 ok 也不出 not ok。
- 正确做法：① 汇总层采集失败指纹时必须同时提取并输出全部 `not ok` 行名（失败即失名禁止），挂起轮次以护栏超时截断并标记 INCOMPLETE、附最后一个 `# Subtest` 行指认挂点，不得伪装成绿；② 真实 spawn 子进程的集成测试在 connect 等无内置超时的 await 上必须做**竞速超时**（`Promise.race` + 失败时关闭 transport 杀子进程）——实测 node:test 的 `timeout` 选项只能标记失败、**无法打断已挂死的 await**，竞速超时才能把"整轮挂死"转化为带行名的快速失败（`tests/integration/mcp-stdio-e2e.test.ts` 的 `CONNECT_TIMEOUT_MS`）。
- 门禁：`scripts/baseline_sample.mjs`（逐轮指纹必附 not ok 行名 + 单轮挂起护栏 + INCOMPLETE 判定）、`scripts/pr_review_gate.mjs`（`checkFailureNaming`：失败汇总无 not ok 行名即拦截）、`tests/unit/workflow-governance.test.ts`（两函数行为锁死）。
- 原位置：`scripts/pr_review_gate.mjs`、`scripts/baseline_sample.mjs`、Issue #32。

#### P-TEST-4 适配器只在 mock 模式下被测试：真实路径全坏仍然全绿
- 复发性：G2 单次高代价（Issue #106：假绿放行）
- 代价：`ctx.mcp.callTool` 在真实模式下每次都报 `MCP Server "x" is not connected`，所有外部 MCP 调用必然失败；唯一调用它的测试以 `--mock` 运行，CI 一直是绿的。
- 根因：`MCPClientManager` 的 mock 分支在连接检查之前就返回伪结果，真实分支（读配置 → 连接 → 关闭）没有任何测试走到；「测试通过」只证明了 mock 分支。另一半根因是 `ExecutionContext.mcp` 每次调用都新建一个从未连接的客户端，没有任何代码调用 `connectServer`。
- 正确做法：每个对外适配器（MCP、模型 Provider、子进程）至少保留一条走真实传输的测试——例如经 stdio 启动真实子进程、断言调用成功，并断言 run 结束后该进程已退出；mock 只用来隔离 LLM 等不可控依赖，不能替代适配器自身的真实路径。
- 门禁：`tests/unit/mcp-lazy-connect.test.ts`（真实 stdio 子进程调用 + 退出校验 + `.mcp.json` 解析）、`tests/pbt/mcp-lazy-connect.test.ts`（单次握手性质）。已修 + 门禁（随 Issue #106 分支合入生效）。
- 原位置：Issue #106、`docs/absorbed-capabilities.md` CAP-001、`src/mcp/client.ts`。

#### P-BUILD-1 跨分支事件类型定义冲突导致 TypeScript 构建报错
- 复发性：G1 反复 (feat/p1-amend-actors 分支实测发生)
- 代价：合并分支后运行 `npm.cmd run build` 报 `error TS2345: Argument of type '...' is not assignable to parameter of type 'WorkflowEventType'`，构建直接失败。
- 根因：不同 Agent 在并行开发中各自扩展了私有事件类型或未将新增类型登记到全局事件枚举中，导致类型契约破裂。
- 正确做法：遵循强类型契约原则。任何事件或消息类型的新增必须在核心类型定义中集中登记，在合入前必须完整运行 `npm.cmd run build` 进行全量类型检查。
- 门禁：`npm.cmd run build` (tsc 编译检查)。
- 原位置：`AGENTS.md` §四、`docs/WORKFLOW.md` §4。

#### P-SEC-1 Worktree 与临时工作区遗留敏感配置
- 复发性：G2 单次高代价
- 代价：临时 worktree 中若放置了真实环境配置（如包含模型 API 密钥的 `.env`），当 worktree 滞留未删或被误传时，会形成不可控的凭据泄露面。
- 根因：开发与测试时随意复制包含敏感凭证的文件，缺乏生命周期收尾机制。
- 正确做法：测试一律使用 MockProvider 或环境变量占位符；若必须引入测试配置，确保文件受 `.gitignore` 保护，且在任务完成后立即执行 `git worktree remove` 连目录彻底清除。
- 门禁：`AGENTS.md` §二 P0 红线、`docs/WORKFLOW.md` §8 清理规程。
- 原位置：`AGENTS.md` §2.1。

#### P-SEC-2 沙箱边界反模式「宿主域对象图注入 VM realm」——跨 realm Function 逃逸
- 复发性：G2 单次高代价
- 代价：TEST-GOAL 攻防实测（run dwfrun-01748f21，2026-11-01）在真实引擎复现任意命令执行：facade 脚本经 `args.constructor.constructor("return process")()` 拿到宿主域 Function → 宿主 `process` → `process.binding('spawn_sync')` 执行任意命令并写出工作区外文件（PoC2b/2c，run 正常完成 exit 0 无感）；同根因辅助向量 PoC1 构造器链 / PoC3 原型链污染 / PoC3c 协议畸变 / PoC4 microtask 伪造 done 帧。
- 根因：child-main 曾在宿主域 `JSON.parse(args)` 后把整个外层对象图（`__host`、`args`、`Math/Date` 替身、`__fanout`、`__sessions`）注入 VM context——「脚本触及的一切」不是 context-native。宿主对象的 `.constructor.constructor` 即宿主 Function，而 `codeGeneration:{strings:false}` 只约束 realm 自身的 Function：V8 按被调用 Function 的创建域检查代码生成许可，宿主 Function 在宿主域内编译不受限。另注意：contextified sandbox 的**原型链属性会泄成 realm 全局**（实测 `Object.create({x:1})` 作 sandbox 时脚本可读到 `x`），故 sandbox 本身也必须 null 原型。
- 正确做法：预Seed 纪律（对齐官方 `child-source.ts:202-206`，Issue #31 落地）——跨界入站只有字符串（`__argsJson`，realm 内 `Object.freeze(JSON.parse(...))` 重建 args）与两个「即捕即删」能力（`__send`/`__timer`：BOOTSTRAP 捕获进闭包后在 realm **内部** `delete globalThis.*`，宿主函数从此不可达；注意 delete 必须由 realm 内发起——**宿主侧对 sandbox 对象 `delete` 实测删不掉已 contextified 的 realm 全局**，Issue #31 第一版收紧方案因此被探针否决）；入站投递函数 `__deliver` 走更彻底的形态：**从不挂上 globalThis**，作为 BOOTSTRAP 引导源最后一个表达式语句的完成值（`vm.runInContext` 返回值）交宿主逐行持有——否则脚本可伪造 ok/err reply / budgetSync / runInfo 改写 realm 内镜像（独立评审第 1 轮边界面收紧，第 2 轮修正措辞）；`__host`/`__fanout`/`__sessions`/Math/Date 影子全部在 BOOTSTRAP 内以 context-native 代码重建；静态层保持 GAP-02 的 9002 构造器链禁令（`compile.ts` PROTOTYPE_CHAIN_PROPS）。**任何新增 realm 注入物必须是 context-native 值**——在宿主域 new 一个对象/闭包再塞进 sandbox 都会重开此洞。
- 门禁：`tests/adversarial/goal-poc2-crossrealm-function.test.ts`（②c raw realm 探针断言 EvalError "Code generation from strings disallowed"，含动态拼接绕静态层向量）、`tests/adversarial/goal-poc4-microtask-escape.test.ts`（microtask 伪造向量）、`src/dwf/compile.ts` 9002。
- 原位置：`src/dwf/child-main.ts`（预Seed BOOTSTRAP）、`docs/research/WORKFLOW-GAP-MATRIX.md` §S2/D1、`docs/research/PENETRATION-AND-SECURITY-AUDIT.md`、Issue #31。

#### P-SEC-3 脱敏层只查键名的「敏感命名」不查「凭据形状」——密钥以键名形式原样过闸
- 复发性：G2 单次高代价（MISSION-X #104 对标探针实测，S3 立项 G-B）
- 代价：形如 `ghp_…` / `AKIA…` / JWT 的 token 一旦作为对象**键名**出现（agent 输出被 parse 成对象时真实可发生），`redactValue` 原样放行进 journal / 事件流——journal 是权威持久层，泄露不可逆。
- 根因：`redactValue` 对象分支只对「键名命中 SENSITIVE_KEY_REGEX」的条目整体遮蔽其**值**，键名文本本身从不经过 `redactText`；`CREDENTIAL_TOKEN_SHAPES` 只扫字符串值路径。
- 正确做法：序列化边界处**键名也过一遍 `redactText`**（子串遮蔽，同时覆盖 `Bearer ghp_…`、URI 内嵌凭据等部分凭据键）；两个不同凭据键会掩成同一占位符，必须按插入序加 `#N` 后缀去重，否则后一条目静默覆盖前一条目丢数据。
- 门禁：`tests/unit/dwf/redact.test.ts`（键名形状遮蔽 / 双凭据键不丢条目 / 部分凭据键遮蔽三用例）。已修 + 门禁（随 Issue #104 分支合入生效）。
- 原位置：Issue #104、`src/dwf/redact.ts`（redactValue 对象分支）。

#### P-SEC-4 Windows `.cmd` 路由的 cmd/CRT 双解析器引号失配——args 含 `&` 即执行第二条命令
- 复发性：G2 单次高代价（Issue #259 实测注入：`spawnSupervised('npm', ['--version','&','echo','INJECTED_MARKER'])` 的 stdout 出现 INJECTED_MARKER）
- 代价：`world.run('npm', args)` 等所有经 `.cmd`/`.bat` shim 的 spawn（npm/npx/tsc/pnpm/yarn），参数若来自数据（分支名、文件名、PR 标题、用户填的洞、agent 产出的字符串），`&` `|` `^` `>` `<` 会被 cmd 重新解释成命令分隔/重定向——数据即第二条命令；审批面只展示 cmd + args，注入段肉眼易漏。
- 根因：cmd.exe 判定元字符只看引号开关（不认 MSVCRT `\"` 转义），而 Node/libuv 默认按 CRT 规则加引号——单独出现的 `&` 不被引号包裹直达 cmd；job helper 的 QuoteArg（CRT 规则）还会对每个 argv 元素再次重排引号，两套解析器语义失配，任何一层单独转义都护不住。
- 正确做法：`.cmd`/`.bat` 路由一律走 `buildCmdRouteInvocation`：每个参数在 cmd 解析层加引号（`quoteForCmd`：内嵌 `"` 加倍成 `""`、尾随反斜杠加倍），整体尾部再包一层外引号（cmd `/s` 规则会剥掉第一对）；job-helper 走 `--raw` 模式把 `GetCommandLineW` 尾部按字节透传给 CreateProcessW（Node 侧 `windowsVerbatimArguments`），无 helper 的 fallback 分支同样 verbatim。已知残差：`%VAR%` 在引号内仍被 cmd 早期展开（仅净化后 env 内变量可展开）、奇数个反斜杠紧邻内嵌引号时引号文本丢失——均为数据级损坏、非注入面。
- 门禁：`tests/integration/process-supervision-cmd-route.test.ts`（`&` 不执行第二条命令、npm/npx 仍跑通、quoteForCmd/buildCmdRouteInvocation 形状锁死）。已修 + 门禁（随 Issue #259 分支合入生效）。
- 原位置：Issue #259、`src/process-supervision.ts`（quoteForCmd / buildCmdRouteInvocation / spawnSupervised）、`scripts/win32-jobhelper.cs`（--raw 模式）。

#### P-TEST-4 两个 worktree 的全量门禁链并行跑——负载窗口互撞出假红
- 复发性：G1 反复（第三次；MISSION-X 期间两 worktree 同跑已复现过一例，#137/#148 收录同家族单例）
- 代价：2026-11-07（Issue #153/#157 收口）两条全量门禁链在两个 worktree 并行执行，#153 的 unit 全集出现 3 例失败；**单独重跑 452/452 全绿**——失败与代码无关，纯属并行负载下的时间窗/资源竞争。
- 根因：unit 全集含墙钟敏感用例（ stall/SLA/adversarial 家族），并行链把宿主压入负载窗口，时间窗断言失准。
- 正确做法：**门禁链串行跑**；必须并行开发时，各 worktree 只跑与改动相关的子集，最终合入前在空闲宿主上串行复跑一次全量。PR 指纹必须来自串行轮。
- 门禁：无机械门禁（宿主级纪律）；本条目即防线，PR 自检清单「指纹必须串行轮」。
- 原位置：PR #161 正文留痕、Issue #148（同家族单例）、Issue #137。

#### P-TEST-5 node --test 每文件子进程隔离 × 测试遗留 sandbox/jobhelper 子进程树——全量 unit 套件挂死
- 复发性：G2 单次高代价（PR#197 实施期三轮报挂死、第四轮 bisect 确证；该 PR 已撤回未合入，但隐患仓库级常驻——未来任何在 unit 套件 spawn 真实子进程树的测试都会复发）
- 代价：`npm.cmd run test:unit` 全量运行时 runner 级测试文件之后进程树排空挂死（并行挂/串行卡/隔离绿），全量 unit 门禁不可依赖；配合并行负载还会产生时间窗假红（见 P-TEST-4 并行条目）。
- 根因：node --test 默认每文件一个子进程；文件进程退出时 node 等待其整棵子进程树排空。unit 测试若遗留 sandbox（child-main）或 jobhelper 子进程树存活，文件进程永不退出，runner 无限等待。`--test-isolation=none` 可绕过但引入跨文件模块级 memo 串扰假红（jobGuardMemo 实证），不可作为门禁默认。
- 正确做法：**unit 套件保持纯隔离语义**——runner 级（带真实子进程树）用例一律落 `tests/integration/`（串行，#113 先例）；unit 内只允许有界同步形式（`spawnSync`/`execSync`，调用即返回不可能存活过调用点）。机械门禁：`tests/unit` 禁用 `spawn(`/`execFile(`/`fork(`/`spawnSupervised`/`spawnJobGuarded`/`adoptPidIntoJobGuard` 及 `src/process-supervision.js` 导入。
- 门禁：`tests/unit/workflow-governance.test.ts`（Tier 3「unit suite keeps pure isolation semantics」锁死）。已修 + 门禁（随 Issue #198 分支合入生效）。
- 原位置：Issue #198、PR #197（已撤回，bisect 取证评论）、`docs/WORKFLOW.md` §4。

#### P-INT-1 MCP SDK 的 tools/list 会剥离描述符上的未知字段——结构化标志必须在目录源头断言
- 复发性：G2 单次高代价（2026-11-07，Issue #153 一轮返工）
- 代价：`McpToolDescriptor.deprecated: true` 加进目录后，走真实 InMemoryTransport 的 tools/list 断言拿到 `undefined`——测试假红，差点误判"标注没生效"。
- 根因：`@modelcontextprotocol/sdk` 的 ListToolsResult 对 Tool 形状做 schema 校验，**未知字段被静默剥离**（zod strip 语义）；结构化扩展字段活不过协议边界。
- 正确做法：需要过协议面的信息放进 `description` 文本（协议保证存活）；结构化标志只在**目录源头**（TOOL_CATALOG 导入）断言。新增描述符字段前先问"这个字段要不要过 wire"。
- 门禁：`tests/unit/mcp-catalog-consistency.test.ts`（wire 断言 description 指针 + catalog 源头断言结构标志的双层写法）。
- 原位置：Issue #153、`src/mcp/server.ts`（TOOL_CATALOG）、PR #161。

#### P-PERF-1 脱敏层正则在长连续串上的平方级回溯——同一根因两次栽倒（#121、#122）
- 复发性：G1 反复（同文件两次：#121 `SENSITIVE_KV_PAIR` 键名规则、#122 `CREDENTIAL_TOKEN_SHAPES` JWT 分支）
- 代价：序列化边界的 `redactText` 被构造输入拖死事件循环——#121 修复前 20 KB 约 0.94 s；#122 修复前实测 40 KB 420 ms / 160 KB 18.4 s / 640 KB 405 s（1 MB 约 6.8 分钟），dwf runner 在此期间整体停摆。
- 根因：同一段连续字符类 run 上存在多个正则起点，每个起点贪婪扫描到同一 run 末尾后逐位回溯失败——k 个起点 × O(run) = O(n²)。#122 特有放大器：JWT 分支的续扫类 `[A-Za-z0-9_-]` 含 `-`（非单词字符），`-eyJ` 处处构成 `\b`，一段 run 内可容纳 n/4 个起点；而其续配所需的 `.` 永不出现在 run 内，失败无法提前退出。
- 正确做法：① 优先用正则结构消灭起点（#121：lookbehind 锚定 run 起点 + 前瞻一次性消费 + 后引用防回溯）；② 结构消不掉的（#122）改手写扫描器 + **run 失败记忆**：同一段 run 内一个 `eyJ` 起点失败 ⇒ 其后同 run 全部起点必败（其扫描是严格子切片），据此跳过后续 JWT 尝试；**只跳过 JWT 尝试，绝不跳过其它分支**（run 内 `-` 之后仍可起 `sk-`/`xox` 等匹配——朴素「跳过整段 run」会漏脱敏）；③ 每消耗一个匹配后不得重扫剩余全文（短路标记），否则「大量 JWT 令牌 + 零其它形状」输入仍是平方级；④ 等价性必须用新旧正则差分对照证明（60 万例种子差分 0 分歧）+ 子进程限时回归。
- 门禁：`tests/unit/dwf/redact.test.ts`（#121/#122 限时用例、30,000 例种子差分、run 记忆边界语义用例）。已修 + 门禁（#121 随 9dcd1d0 合入，#122 随本条目对应 PR 合入生效）。
- 原位置：Issue #121、Issue #122、`src/dwf/redact.ts`（SENSITIVE_KV_PAIR、replaceCredentialShapes）。

#### P-SHELL-1 门禁/构建调用的管道掩码退出码——`\| tail` 后接 `&&`，失败静默放行
- 复发性：G1 反复（≥5 次：mission-b 留痕一次；2026-11-08 夜批再犯两次——#108 构建链 `npm.cmd run build 2>&1 | tail -1 && echo BUILD_OK` 使 tsc exit 2 被掩、带错继续跑出 dist 测试，#177 合入链 `gate 2>&1 | tail -3 && gh pr merge` 使审查门禁拦截被掩、merge 照跑；同日 11-08 夜批审计（#196 看板 S3）再补记第 4/5 次——#184/#185 合入实施过程自曝管道掩码复发，整改当批已兑现 [已验证：#186=928s / #187=2311s / #188=927s，均 >600s 硬红线]）
- 代价：带类型错误的构建产出残缺 dist 继续测试；审查门禁的硬拦截（指纹/冷却/not-ok 行名）形同虚设——假绿放行通道。
- 根因：bash 管道的退出码是**最后一个命令**（tail/echo）的退出码，与管道左侧门禁的真实退出码无关；`&&` 链只看管道返回值。
- 正确做法：门禁调用**禁止管道后接 `&&`**。要么裸跑命令看 `$?`，要么 `set -o pipefail`，要么把输出落盘后单独 grep 摘要（`cmd > log 2>&1; echo "EXIT=$?"; grep … log`）——退出码必须来自门禁本身。
- 门禁：无机械门禁（宿主级纪律）；本条目即防线，PR 自检链路必须逐段可退出。
- 原位置：mission-b PR 正文留痕、Issue #108/#177 实施过程、Issue #196 S3（第 4/5 次补记）。

#### P-ENV-3 跨 worktree 共享 node_modules 里的 `ai-workflow` 自链被任一 worktree 全局重指向
- 复发性：G1 反复（2026-11-08 夜批两次：污染两轮 git bisect 探针——假 good/假 bad 交错、结论一度作废；另一次干净房验证 3/8 假红）
- 代价：demo 内 `import 'ai-workflow'` 经共享 `node_modules/ai-workflow` 解析到**别的 checkout 的引擎版本**——被测代码与被导入代码版本错位，测试结果不可信；bisect 每步都在错位状态下跑，结论全部报废重做。
- 根因：worktree 用目录联接共享主仓 `node_modules`（省 install 时间），而 `scripts/link-self.mjs` 产出的自链是**物理目录项**——任一 worktree 执行 link-self 都会改写共享区的指向，且其幂等逻辑「链接已存在即跳过」使复位必须先 rmdir 再跑。
- 正确做法：① 多 worktree 并行验证期，每个 worktree 跑门禁前先 `cmd /c rmdir node_modules\ai-workflow && node scripts/link-self.mjs` 对齐自己；② bisect 脚本**每步**重置自链；③ 验证结束后复位主仓指向；④ 终极解是各 worktree 真实 `npm install`（MISSION-Y 教训）或 link-self 支持 per-worktree 隔离。
- 门禁：无机械门禁（待补）；本条目即防线。
- 原位置：Issue #169/#174 实施过程、`scripts/link-self.mjs`。

#### P-GIT-2 stash 编号是全仓命名空间——跨 worktree `git stash drop stash@{0}` 误删他人 WIP
- 复发性：G2 单次高代价
- 代价：2026-11-08 夜批，A worktree 收尾时 `git stash drop stash@{0}`，删掉的实为 B worktree 刚 stash 的全部改动（5 文件测试修复），整组重做。
- 根因：stash 引用（stash@{N}）挂在**仓库级** refs/stash 上，所有 worktree 共享同一编号序列；worktree A 的 stash@{0} 与 worktree B 的 stash@{0} 是同一引用。
- 正确做法：跨 worktree 并行时，stash 必须**命名**（`git stash push -m "issue-174-wip"`）并以名字/引用哈希操作（`git stash pop stash@{u}` 或 `git checkout <stash-commit> -- <paths>`）；drop 前先 `git stash list` 核对描述；能用临时分支（`git stash branch <name>`）就不用裸 stash。
- 门禁：无机械门禁（宿主级纪律）。
- 原位置：Issue #174 实施过程（改动丢失重做）。

#### P-CI-1 远端 CI（GitHub Actions）已整体移除——引用「CI 绿/红」或执行 `gh pr checks` 属虚假证据
- 复发性：G3 已成强制（2026-11-09 用户拍板移除 CI，治理测试反向锁死）
- 代价：GitHub Actions 个人额度频繁耗尽（账单红灯常态化，衍生 #195 全量补跑负担）；CI 的门禁命令与本机门禁链完全重复（本机为超集），远端额度成本高于其增量价值。若在 CI 移除后仍等待/引用 CI 状态，会产生虚假证据与假阻塞。
- 根因：远端 CI 与本机门禁链职责重叠，而额度约束使远端执行不可持续。
- 正确做法：验证一律走本机全量门禁链（AGENTS.md §四：build → unit → integration → PBT → E2E → governance → pr_review_gate --check-clean）；严禁声称「CI 绿/红」、严禁执行 `gh pr checks` 等待远端状态；`.github/workflows/ci.yml` 已删除，任何交付物中「等待 CI」表述视为占位符级违规。
- 门禁：`tests/unit/workflow-governance.test.ts`（Tier 1 反向锁死：ci.yml 必须不存在 + AGENTS.md/README.md 不得引用已移除的 CI）。
- 原位置：Issue #203、`AGENTS.md` §1.8、`docs/WORKFLOW.md` §7.3、`README.md`「自动化门禁（本机为唯一验证链）」。
- **状态更新（2026-11-14，Issue #7，只增不删）**：用户重新拍板恢复远端 CI——比赛仓库为 **public 仓库**，GitHub Actions 对 public 仓库免费（runner 分钟数只对私有仓计费），本条目的额度前提不复存在。现行为：本机门禁链仍是合入放行第一判据（本条「CI 重复本机门禁」的告诫仍然有效——CI 是公开信号与 Linux 跨平台验证面，**不替代本机门禁**）；治理锁死已由「ci.yml 不得存在」改写为「ci.yml 必须存在且镜像本机门禁链」；「引用 CI 绿/红属虚假证据」的告诫自本更新起仅在私有仓语境下成立。

#### P-ENV-4 worktree 共享 node_modules 跳过 postinstall——demo fixture 离线 SDK 桩缺失，集成 baseline gate 假红
- 复发性：G1 反复（家族第 2 次；首例=「新 worktree 缺 dist 首轮 unit 0 tests 假绿须先 build」，同为 worktree 缺生成产物家族）
- 代价：2026-11-11（Issue #233 取证轮）：worktree 里 demo-migration 基线门禁报 `Cannot find package 'aws-sdk'`（ERR_MODULE_NOT_FOUND）→ demo-facade-migration 与 Demo 2 TEST 4 连锁两红。与 #233 主根因（transient spawn 失败被当真实 gate 失败）**无关的第二个红源**——不看穿会误诊修复方向。
- 根因：worktree 用符号链接共享主仓 `node_modules`（省 install 时间），但 `apps/repo-migration-engine/fixtures/legacy-aws-sdk-app/node_modules` 的离线 SDK 桩由 **postinstall 钩子**（`scripts/bootstrap-fixtures.mjs`）创建——postinstall 只在真实 npm install 时执行，共享链接路径下从不触发；stub 目录受 `.gitignore` 的 `node_modules/` 规则保护不入库，fresh worktree 天然缺失。
- 正确做法：① `test:integration` 前置 `node scripts/bootstrap-fixtures.mjs`（随 #233 落地，与 `test`/`test:e2e`/`test:adversarial` 既有惯例对齐；幂等、已存在即跳过绝不覆盖）；② 新 worktree 首跑门禁链前自查：先 build（dist 生成）再跑测试、确认 fixture 桩就位（bootstrap 幂等跑一次无害）。
- 门禁：`tests/unit/workflow-governance.test.ts`（Tier 2：`test:integration` 必须前置 bootstrap-fixtures + P-ENV-4 在册）。已修 + 门禁（随 Issue #233 分支合入生效）。
- 原位置：Issue #233、`scripts/bootstrap-fixtures.mjs`、`package.json` scripts 区。

