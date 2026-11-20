# 工作流差距矩阵（TEST-GOAL 4.1）· WORKFLOW-GAP-MATRIX

> **文档定位**：TEST-GOAL 阶段 4.1 总交付——把「六大不变量实测、官方内核逆向四切片、PoC 攻防、GAP 补强施工、deferred 遗留」统一为一张可复核的差距矩阵（短板 / 根因 / 对应修复状态 / 证据），未修复项全部落入 §六 后续计划。
>
> - **生成时间**：2026-11-01（本会话）
> - **生成者**：文档·差距矩阵 子代理（dynamic workflow，TEST-GOAL 4.1 汇总节点）
> - **所在 worktree**：`<workspace-worktrees>/issue-28-goal-e2e-pentest`（分支 `feat/issue-28-goal-e2e-pentest`，HEAD `30eb54f`）
> - **上游输入**：TEST-GOAL 4.1 各执行节点（不变量分诊、逆向对照、PoC 攻防、GAP-01..06 施工子代理）的实测汇报；本矩阵做结构化与状态映射，§五 保留施工汇报要点全文。凡标注「上游实测」者为执行子代理本会话实测、本汇总节点未复跑；本节点亲手执行的复核见 §〇。
> - **证据纪律**：按 `docs/AI-EVIDENCE-STANDARD.md` 三档标注 `[已验证]` / `[推断]` / `[未知]`；严禁把 mock/探针输出说成真实模型调用（本文涉及的全部引擎运行均为 mock / 离线探针路径）。
> - **状态总注记**：GAP-01..06 的全部代码修复当前停留在本 worktree 工作树，**均未 git commit**（按任务约束留给收口层统一提交）。因此本矩阵中「已修复 / 已闭合」一律指「**已修复·待提交**」；主仓 `main` 现状不变。
> - **文档分工（2026-11-01 修订确立）**：本文是 TEST-GOAL 4.1 三份文档（`ZCODE-BENCHMARK-REPORT.md` / `PENETRATION-AND-SECURITY-AUDIT.md` / 本文）的**唯一状态登记处**（D#/R#/GAP-# 条目号）——PENETRATION 只做安全判定并引用本文条目号，BENCHMARK 只管基准；状态冲突时以本文为准。
> - **行号基准**：本文行号基于 HEAD `30eb54f`；上游汇报行号为其编辑时点，已按 §〇 复核并以「现 ：NNN」标注漂移；引用以符号名为准。
> - **修订记录（2026-11-01，修订员）**：§1.1/§1.2 逆向切片载体对齐 §3.0（D1/D3/D4/D8＋R4）；PoC4 登记条目收敛为 R4④；不变量6 定义补「短示例串契约豁免」限定、§四「泄漏 0」加场景限定、子项①状态改「done（契约内豁除外）」；§2.3 计数口径补注（driver.mjs/verify.mjs 具名检查）；compile.ts isReference 行号漂移标注（汇报时点 :334，现 :341）；§七 #4 清理清单对齐实际 git status（scratch-audit-41 与 .scratch-b41doc 已删）；附录补 xrealm2 探针下落与 inv1 变体不可复跑警示；§2.6 子项④补桥接说明；测试计数统一 `tests N / pass N / fail 0 / skipped K` 格式；新增 §七 #7（inv1 变体入库建议）。未改动任何实测数字。

---

## 〇 本会话复核记录（汇总节点实际执行的检查）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | worktree 状态 | `git -C <wt> branch --show-current`；`git -C <wt> log --oneline -1`；`git -C <wt> status --porcelain` | 分支 `feat/issue-28-goal-e2e-pentest`，HEAD `30eb54f`；已跟踪修改 18 文件（含 GAP-01..06 全部 changedFiles：`src/dwf/{child-main,compile,engine,redact,runner}.ts`、`src/cli/commands/{inspect,run-script}.ts`、`src/cli/index.ts`、`tests/unit/dwf/{dwf-compiler,redact}.test.ts`、`package-lock.json`、artifacts/demos 元数据）；另有大量未跟踪文件（`tests/adversarial/fixtures/*`、`tests/adversarial/*.test.ts`、`scratch-*` / `.scratch-*`、`examples/` 等，多为 TEST-GOAL 各子任务产物） |
| 2 | 目标目录 | `ls <wt>/docs/research` | 目录已存在（`claude-code-binary-reverse.md`、`claude-code-workflow-internals.md`、`workflow-reverse-engineering.md`），无同名文件——本文为新建，未覆盖任何既有文档 |
| 3 | GAP-02 锚点 | `grep -na PROTOTYPE_CHAIN_PROPS <wt>/src/dwf/compile.ts` | `:39` 常量定义；`:170` 属性访问规则；`:176` ElementAccess 括号形式规则 [已验证] |
| 4 | GAP-01 锚点 | `grep -na callHost <wt>/src/dwf/child-main.ts`；`grep -na "runInfo\|pushToChild" <wt>/src/dwf/runner.ts` | child-main `:97 log: (siteId…) => callHost('log', siteId, message)`、`:98 report: (siteId…) => callHost('report', siteId, item)`；runner `:453 pushToChild = …`、`:461 pushToChild({ t: 'notify', op: 'runInfo', runId, resumedFrom: amendedFrom ?? priorRunParent })` [已验证] |
| 5 | GAP-05 锚点 | `grep -na "only a parked run" <wt>/src/dwf/runner.ts` | `:584` 守卫消息在位 [已验证] |
| 6 | GAP-03 锚点 | `grep -na redactText <wt>/src/dwf/engine.ts` 等 | `:20` 导入 redactValue；`:783 emit('dwf_world_run', { cmd, args: args.map((a) => redactText(String(a))) })`；`:972 value = redactValue(value)`；`:822` stdout/stderr、`:943` 错误消息亦有脱敏；`redact.ts:38 CREDENTIAL_TOKEN_SHAPES`、`:76` 替换调用 [已验证] |
| 7 | GAP-04 锚点 | `grep -na options.dbPath <wt>/src/cli/commands/run-script.ts` | `:129 console.log(\`  journal: ${options.dbPath ?? path.join('.workflow', 'dwf.sqlite')}\`)` [已验证] |
| 8 | GAP-06 锚点 | `grep -na renderFacadeInspect <wt>/src/cli/commands/inspect.ts` | `:37` facade 分支入口、`:125` 函数定义 [已验证] |
| 9 | engine.ts U+0000 | `node -e`（readFileSync + 逐行 indexOf('\0')） | 文件 1016 行；U+0000 真实字节现位于 **`:889`**（上游汇报 :886，GAP-03 顺延 +3 行）[已验证] |
| 10 | 对抗测试转正复跑 | `node --experimental-strip-types --test tests/adversarial/goal-poc1-constructor-escape.test.ts`（worktree 内执行） | **tests 3 / pass 3 / fail 0 / skipped 0**（# duration_ms 2941）——该文件 describe.skip 已转为正式断言且全绿 [已验证] |
| 11 | 残余 skip 扫描 | `grep -na "describe.skip\|\.skip(" tests/adversarial/*.test.ts` | 仍 skip 5 处：`goal-poc1-ndjson-protocol.test.ts:136`（洪泛饿死）、`goal-poc2-control-char-injection.test.ts:160`（log/report round-trip 载荷）、`goal-poc2-crossrealm-function.test.ts:56`（BREACHED 跨 realm）、`goal-poc3-oversize-frames.test.ts:149`（无帧长上限）、`goal-poc4-microtask-escape.test.ts:23`（BREACHED 伪造 done 帧）[已验证] |

以上为本汇总节点唯一亲手执行项；其余结论均引自上游实测汇报（见各节，§五 为其要点保留）。行号漂移说明：各 GAP 汇报的行号为**其编辑时点**行号；因共享工作树上并行代理互有增删，当前工作树个别行号有小幅漂移（如 engine.ts :886→:889），锚点内容本身逐一核实无误。

---

## 一 总览与状态迁移

### 1.1 统计

- 六大不变量：修复前实测 **2 pass / 3 partial / 1 fail**；修复后（工作树）：fail 项已闭合，partial 中 2 项大部闭合，1 项（不变量4）未修。
- 逆向四切片：**behind ×4**（对齐工程未开工，落入 D1 / D3 / D4 / D8，部分残余在 R4——与 §3.0 速览表 S2/S3 载体行一致）。
- PoC 防线：**held ×1 / partial ×3**；partial 中「constructor 链逃逸静态门」「凭据窥探主向量」已被 GAP-02 / GAP-03 闭合。
- 补强施工：**GAP-01..06 全部 done（6/6），A 类交付**（改动已实施且各自验证通过），全部未提交。
- Deferred 遗留：**D1..D10 共 10 项**（§6.1）＋ 矩阵梳理中发现的未入册残余 **R1..R4**（§6.3）。

### 1.2 状态迁移总表

| 对象 | 修复前 | 修复后（本 worktree 工作树） | 修复载体 | 主要残余 |
|---|---|---|---|---|
| 不变量1·AST 防火墙 | **fail** | 已闭合*（check 5 变体全报诊断；对抗测试转正 3/3 pass 实测） | GAP-02 | inv1 run 级 compile_failed 复跑未单独执行 |
| 不变量2·Schema 自愈 | pass | pass | — | — |
| 不变量3·NDJSON 帧稳定 | partial | 大部闭合*（log/report 正文已入 journal） | GAP-01 | 内容级 journal 断言测试待补；D4（畸形帧/字节预算/EPIPE/洪泛） |
| 不变量4·零孤儿进程 | partial | partial（**未修**） | D7 | 引擎自身无父死保证；宿主 Job 耦合来源 [未知] |
| 不变量5·断点零Token重放 | pass | pass | — | — |
| 不变量6·敏感信息脱敏 | partial | 大部闭合*（①⑤闭合、④部分闭合、⑥本就通过） | GAP-03＋GAP-01＋GAP-04＋GAP-06 | ②值形已知边界（R3）、③入参脱敏未修（R2）、list/view/MCP→D2、probe→D6 |
| 逆向切片 S1..S4 | behind ×4 | behind（未开工） | D1 / D3 / D4 / D8（＋R4） | 多天工程 |
| PoC2b/2c·跨 realm 逃逸 | partial | 静态门已闭合*；动态预Seed 未修 | GAP-02（静态）＋D1（动态） | goal-poc2-crossrealm skip 未转正（D1 DoD） |
| PoC·协议投毒 | partial | 未修（GAP-01 保持未收 runInfo 直接 spawn 行为不变：9 pass/0 fail） | D4 | ndjson 洪泛、oversize 两 skip 未转正 |
| PoC·资源炸弹三连 | **held** | held（防线实测有效） | — | — |
| PoC·凭据窥探三向量＋错误路径 | partial | 主向量已闭合* | GAP-03 | 短裸 sk- 值形（刻意）、args_json（R2） |
| PoC4·microtask 伪造 done 帧 | breached（skip 记录） | 未修（主获取路径暂被静态门遮断——GAP-02；纵深防御 done 帧鉴权未修） | **R4④**（唯一登记条目；PENETRATION §7 #10 指向此处） | `goal-poc4-microtask-escape.test.ts:23` |

\* 「已闭合 / 大部闭合」均指 worktree 工作树已修、未提交（见状态总注记）。

---

## 二 六大不变量差距对比表

### 2.0 速览表

| # | 不变量 | 前 | 后 | 短板（一句话） | 根因（一句话） | 修复状态 | 明细 |
|---|---|---|---|---|---|---|---|
| 1 | AST 防火墙 | fail | 已闭合* | `({}).constructor.constructor` 静态放行 | compile.ts 属性访问分支无 constructor/__proto__/prototype 链规则 | **GAP-02 done** | §2.1 |
| 2 | Schema 自愈 | pass | pass | — | — | — | §2.2 |
| 3 | NDJSON 帧稳定 | partial | 大部闭合* | log/report 正文在子进程边界被丢 | lower.ts 与 child-main.ts 边界函数签名漂移（siteId 被当载荷） | **GAP-01 done**；D4 余项 | §2.3 |
| 4 | 零孤儿进程 | partial | partial | 引擎自身无父死退出 / Job 保证 | 引擎源码无 Job Object、child-main 无 stdin-EOF 退出 | **未修 → D7** | §2.4 |
| 5 | 断点零Token重放 | pass | pass | — | — | — | §2.5 |
| 6 | 敏感信息脱敏 | partial | 大部闭合* | argv / 结果正文多处明文落库 | recordEvent 无脱敏；journalled 边界不掩码 | **GAP-03/01/04/06 done**；R2/D2/D6 余项 | §2.6 |

### 2.1 不变量1·AST 防火墙（fail → 已闭合*）

- **不变量定义**：`process.exit()` / `eval()` / `Date.now()` / `Math.random()` / `({}).constructor.constructor` 5 变体必须 100% 被 `node bin/workflow.js check` 静态报诊断。
- **测得状态**：fail（修复前 v1-v4 报诊断、v5 完全放行）→ **已闭合***（修复后 5 变体 CLI check 全部 exit 1；对抗测试转正实测 3/3 pass）。
- **短板**：`({}).constructor.constructor`（Function 构造器逃逸）完全绕过静态检查——check 报 `ok:true` 并放行至沙箱执行；唯一防线是运行期 VM codeGeneration 加固（`src/dwf/child-main.ts:291`），不满足「check 必须 100% 静态报诊断」。
- **根因**：`src/dwf/compile.ts` 的 `visit()` 属性访问分支（汇报时点 :155-166 一带）没有 constructor/__proto__/prototype 链规则；`Function` 构造器可从裸对象字面量经 constructor 链重建。
- **对应修复状态**：**GAP-02 done（未提交）**，实施与上游修复建议一致并超出：
  - `src/dwf/compile.ts:38-39`（现 :39）新增 `PROTOTYPE_CHAIN_PROPS = new Set(['constructor','__proto__','prototype'])`；
  - `src/dwf/compile.ts:169-180`（现 :170/:176）在既有属性访问分支内：属性访问名为上述三者之一 → push 9002 purity-ban（消息含 "constructor-chain access can rebuild Function from nothing; facade primitives only"）；兄弟块覆盖 `ts.isElementAccessExpression` + StringLiteral 计算形式（`obj["constructor"]`）；`isReference` 未触碰（`const e = eval` 初始化位漏网属 D3，不在本次范围）；
  - 上游建议①（治理锁死测试）已满足于两层：`tests/unit/dwf/dwf-compiler.test.ts` 追加 5 条（v1-v4 各 ok:false 且 9002、v1 另断言 TS2591、v5 ok:false 且消息含 constructor-chain、括号形式 ok:false、正向对照最小 agent+ask 脚本 ok:true）＋ `tests/adversarial/goal-poc1-constructor-escape.test.ts` skip 块转为正式断言（含 any-cast 变体 poc1b 与 `check -j` 静态断言）；
  - 上游建议②（按 `.workflow/inv1-v5.db` 中 run `dwfrun-mvxo7utl-051ba3` 的 script_path 复跑 run 验证 compile_failed）**未单独执行**——以 5 变体 CLI check exit 1 作等效静态验证；run 级验证留给收口层（[未知] 是否必要，因 check 拒绝后 run 根本无法启动）。
- **证据**：
  - 修复前基线（GAP-02 会话内进程探针，对 analyzeFacadeScript）：v1=[TS2591,9002]，v2/v3/v4=[9002]，v5=ok:true 无诊断，clean=ok:true——与根因精确吻合；
  - 修复后：`node node_modules/typescript/bin/tsc --noEmit -p <wt>/tsconfig.json` exit 0；build exit 0；`node --test dist/tests/unit/dwf/dwf-compiler.test.js` **tests 14 / pass 14 / fail 0**（9 既有 + 5 新增）；dwf 单测全目录 10 文件 **tests 70 / pass 70 / fail 0**；
  - 修复后 v5 诊断实例：`v5-constructor-chain.ts:7:17 purity-ban(9002): "constructor" property access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`；
  - CLI check × 5 inv1 变体（v1-process-exit / v2-eval / v3-date-now / v4-math-random / v5-constructor-chain）全部 exit 1；4 个 demos facade（gate/budget/growth/lineage.facade.ts）全部 exit 0 无回归；全仓 grep 确认仅 `tests/adversarial/` 下应拒样本受影响，无正当脚本受累；
  - **本节点实测**：`node --experimental-strip-types --test tests/adversarial/goal-poc1-constructor-escape.test.ts` → **tests 3 / pass 3 / fail 0 / skipped 0**（§〇 #10）；
  - 变体脚本存于 `<local-machine>/.zcode/workflow-drafts/goal-mission/inv1/`（按任务指令在仓库外；2026-11-01 修订轮核实目录在位，五文件 v1-process-exit.ts / v2-eval.ts / v3-date-now.ts / v4-math-random.ts / v5-constructor-chain.ts 逐一存在——**仓库外路径意味着第三方不可直接复跑本条主证据链**，入库建议见 §七 #7）；journal `inv1.db`、`inv1-v5.db` 保留于 worktree `.workflow/`（存在性本节点已核实）；
  - 披露：上游 ask 原文指定的 `node --experimental-strip-types <测试文件>` 直跑方式在本仓对单元测试因 pre-existing 结构性原因不可用（测试 import `../../../src/dwf/compile.js` 仅能经编译 dist 解析，直跑 ERR_MODULE_NOT_FOUND，GAP-02 改前已验证）；GAP-02 改用 `node --test dist/...`（`npm run test:unit` 同款机制）。对抗测试目录不受此限（本节点 #10 即 strip-types 直跑成功）。

### 2.2 不变量2·Schema 自愈（pass）

- **不变量定义**：`ask<T>` 编译期 JSON Schema 提取 + 运行时 zod 校验 + 自愈反思重试循环。
- **测得状态**：**pass**，无缺口。
- **证据**：TEST-GOAL 4.1 不变量分诊阶段实测判 pass（上游实测，本节点未复跑；分诊 journal `inv2-schemaheal.db` 在 `.workflow/` 下）。

### 2.3 不变量3·NDJSON 帧稳定（partial → 大部闭合*）

- **不变量定义**：host↔子进程双工 NDJSON：prompt/log 含 `\r\n`、`\u0000-\u001f`、多字节 emoji、100KB 级文本，run-script 全程跑通，journal 完整无撕裂无粘包。
- **测得状态**：partial → **大部闭合***。
- **短板与根因**：NDJSON 帧稳定性本身在两层实测全部通过（原始协议 14/14、journal 10/10×2 次运行——计数口径：`scratch-pentest/ndjson/` 探针会话的两份脚本，`driver.mjs`（原始协议层）静态含 13 处 `check(...)` 调用点、10 个具名检查（duplex 三项带 if/else 双分支），`verify.mjs`（journal 层）恰 10 个具名检查（run-status / dwf_completed-event / stats-asks / no-failure-events / ask-inputHash-full-prompt / ask-reply-shape / ask-start-400 / worldread-result-full-file / log-frame-count / log-content-boundary-bug）；「journal 10/10」与 verify.mjs 具名检查数吻合，「14」为上游会话运行时输出、其逐项构成本节点未复核 `[未知]`）；定级 partial 仅因「log 含 \r\n/控制字符/emoji/100KB」一腿的内容无法经 run-script journal 逐字节验证——log()/report() 的真实内容在子进程边界即被丢弃（`lower.ts:140` 与 `child-main.ts:95-96` 签名漂移，main 上已存在：realm 边界把 siteId 当载荷转发、正文丢失）。
- **对应修复状态**：
  - 上游建议①（边界函数改两参）＝ **GAP-01 done（未提交）**：child-main.ts `:97 log: (siteId, message) => callHost('log', siteId, message)`、`:98 report: (siteId, item) => callHost('report', siteId, item)`（engine.ts 按 frame.siteId+payload[0] 消费，改后 journal `dwf_log` 携带全文；探针 ASSERT1 `message="hello dwfrun-mvxu6hyu-1a1070"` 实证）。**内容级 journal 断言的正式测试文件尚未补**（探针三断言为手工 node:sqlite 执行）——待办，见 §七 #3（R4 各项为 cell 停滞/host 错误线/退避抖动/PoC4，与本待办无关）；
  - 上游建议②（runner.ts:384-386 对解析失败帧静默 continue → 累计计数并在 run 结束 emit 诊断事件）→ **未修，D4**；
  - 上游建议③（engine.ts 含真实 U+0000 字节，grep/Read 会误判或误渲染，排障用 `node -e` 读）——注意事项仍然有效；**本节点实测该字节现位于 `engine.ts:889`**（§〇 #9）。复现材料保留：worktree `scratch-pentest/ndjson/{ndjson-probe.facade.ts,verify.mjs,driver.mjs,gen-payload.mjs,payload-100kb.txt}`，journal `.workflow/ndjson-inv.db`。
- **证据**：原始协议 14/14、journal 10/10×2（`.workflow/ndjson-inv.db`，上游实测；计数口径见上「短板与根因」，复现材料 `scratch-pentest/ndjson/{driver.mjs,verify.mjs,ndjson-probe.facade.ts,gen-payload.mjs,payload-100kb.txt,run-stdout.txt,run-stderr.txt}` 在位）；GAP-01 探针三断言（§5 GAP-01）；`dwf_report.item` 修复前 `{"item":"report#N"}` → 修复后 `{"k":1}`。

### 2.4 不变量4·零孤儿进程（partial，未修）

- **不变量定义**：宿主/父进程退出后不留孤儿子进程。
- **测得状态**：**partial，未修**。
- **短板与根因**：实测零孤儿是宿主机级机制（进程树 Job 耦合，可能是本机安全软件/沙箱或 Windows 26200 行为），**不是引擎保证**——引擎源码无 Job Object（grep 零命中），`child-main.ts` 无 stdin-EOF/父死退出；父进程被强杀时唯一树杀（`taskkill /T /F`）不会被调用。若在无该耦合的宿主（或 POSIX）上，源码层面孤儿将存活。
- **对应修复状态**：**未修 → D7**（child-main.ts 给 stdin readline 加 `'close'` 处理器 → `process.exit`，一行级；stdin 是父→子 NDJSON 通道，父死即 EOF，天然父死信号；与 GAP-01 同文件故顺延，GAP-01 已在工作树就绪后可立即接力）。次选：spawnSupervised/runner.ts:242 spawn 时显式创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job 并 AssignProcessToJobObject（方案②，未排期）。
- **证据与未知**：`[未知]` 本机 per-tree Job 的创建者未能确认——`NtQueryInformationProcess(37)` 查句柄返回 0xC0000004，未能读到 Job 名/flags；需用正确 info class 或 Process Explorer 确认，并回答「干净宿主上是否仍零孤儿」（方案③：无 Job 耦合的干净宿主复跑本不变量，观测裸行为）。

### 2.5 不变量5·断点零Token重放（pass）

- **不变量定义**：3 节点脚本 node1 ask → node2 world.run gate → node3 ask；`--resume` 后 node1 命中 journal 缓存 0 次模型调用。
- **测得状态**：**pass**，无缺口。
- **证据**：TEST-GOAL 4.1 不变量分诊阶段实测判 pass（上游实测，本节点未复跑；分诊 journal `inv5-baseline.db`、`inv5-replay.db`、`inv5-view-resume.html` 在 `.workflow/` 下）。

### 2.6 不变量6·敏感信息脱敏（partial → 大部闭合*）

- **不变量定义**：诱饵 env `GOAL_POC_TOKEN=sk-decoy-123`、`GH_TOKEN=gh-decoy-456` 全通道不泄露（口径限定：上游 ask 契约对**短示例串**有「勿吞」豁免——redactText `sk-[A-Za-z0-9]{20,}` 下限刻意放行 <20 位裸值如 sk-decoy-123，见子项①证据列；「全通道不泄露」在该契约豁免范围内成立）。
- **测得状态**：partial → **大部闭合***（子项①⑤闭合、④部分闭合、⑥本就通过；②③残留）。
- **六子项逐条状态**：

| 子项 | 缺口（上游实测） | 根因 | 修复状态 | 证据 |
|---|---|---|---|---|
| ① dwf_world_run argv 明文落库 | world.run 参数携带凭证（如 `world.run('curl',['-H','Authorization: Bearer '+tok,…])` 或 `'--api-key='+k`）时 token 原样入库（inv6.db events 第 6 行含 sk-decoy-123/gh-decoy-456） | engine.ts:780 → runner.ts:283 recordEvent 无脱敏，与 `src/dwf/redact.ts:5-8` 自述契约「任何即将写入 SQLite 的字符串都必须先经过脱敏」相悖 | **GAP-03① done（契约内豁除外）**：engine.ts `:783 emit('dwf_world_run',{cmd, args: args.map((a)=>redactText(String(a)))})`；`:784` spawn 仍用原始 args（observability-only）；redact.ts `:39` 增补 `sk-[A-Za-z0-9]{20,}` 形状 | 独立探针 journal triage-fix-3-probe.db：dwf_world_run args 实测 `['GOAL_POC_TOKEN=***REDACTED***','***REDACTED***','sk-decoy-123']`——KV 形状与长裸 sk- 被掩码；**短裸 sk-decoy-123 因 {20,} 下限刻意原样保留**（redactText 契约内、上游 ask 明文「勿吞短示例串」，如实披露非隐藏） |
| ② 非敏感键名下值不掩码 | `'bare=sk-decoy-123'` 存入 result_json | redact.ts:20-25 明文记录的「按键名/值形、宁过勿漏」权衡 | **已知边界非缺陷**；如需收紧：对 sk-/ghp_ 等前缀形值加 shape 规则（**R3**，可选，未排期） | 上游 inv6 实测 |
| ③ run 入参原样持久化 | dwf_runs.args_json 与 `.workflow/runs/<runId>/args.json` 无任何脱敏 | resume 需要完整入参，实现时未做掩码 | **未修 → R2**（建议至少对命中 SENSITIVE_KEY_REGEX 的入参键掩码） | 上游 inv6 实测 |
| ④ inspect/list/view 与独立 `--db` 互不兼容 | 按并发纪律用独立 --db 的 facade run 对事后审查三件套完全不可见；run-script.ts:129 汇总行硬编码显示 `.workflow/dwf.sqlite` 与实际不符 | inspect.ts:15-17 只找 runs/&lt;id&gt;/checkpoints.db 或 runs.db、:22-25 要求 checkpoints 行；list.ts:14 只读 runs.db；view 同败 | **GAP-04 done**（:129 改打印真实 journal 路径，两分支 CLI + node:sqlite 交叉实读验证）；**GAP-06 done**（inspect 增 `--db` + facade 分支 renderFacadeInspect；builder 老库 5 变体输出字节级回归一致）；**list/view/MCP → D2 未修** | GAP-04/06 自测（§5）；改前盲区实拍 `inspect … --db` → `error: unknown option --db` exit 1 |
| ⑤ log()/report() 正文从未入 journal | 隐私上无泄露面，但日志内容整体丢失，疑似绑定错位 | child-main.ts:95-96 单参绑定错位（siteId 被当载荷） | **GAP-01 done**（同不变量3①），顺带闭合 | GAP-01 探针 ASSERT1/2/3 |
| ⑥ env 通道（本不变量规定场景） | — | — | **实测通过（上游）**：probe 双模式 0 泄露、world.run 子进程 env 按名过滤（敏感键一个都不传）、输出 KV 对源头不可逆掩码、env-only journal 字节级 0 原始值 | 上游 inv6 实测 |

- **证据保留**：测试副产物 `.scratch-inv6/`、`.workflow/inv6.db`、`.workflow/inv6b.db` 在 worktree 供复核（存在性已核实），建议本 issue 收尾时随 worktree 一并删除；GAP-03 门禁与测试结果见 §5（redact.test tests 12 / pass 12 / fail 0、goal-poc3-files-grep 转正 tests 2 / pass 2 / fail 0 / skipped 0、dwf 全目录 tests 71 / pass 71 / fail 0）。

> 子项④桥接说明（2026-11-01 修订）：本子项列的是 CLI 可见性工程（GAP-04/06），与「脱敏」看似无直接因果——桥接在于：按并发纪律用独立 `--db` 的 run 对事后审查三件套完全不可见时，journal 里是否落了敏感信息**无从审计**；先让 journal 可见（GAP-04 显示真实 journal 路径、GAP-06 inspect 支持 `--db`），本不变量其余子项才可第三方复核。

---

## 三 逆向四切片差距对比表

### 3.0 速览表

| # | 切片 | 我方状态 | 核心结构性差距 | 对齐载体 |
|---|---|---|---|---|
| S1 | 引擎内核与缓存（ImportedRunCache 静止探针 + settle 池/重放键 + resume 血缘） | behind | per-actor 具名缓存缺席（amend 命中率天花板）；静止探针/消息边界/转录种子整层在无状态单发 ask 模型下不适用 | **D8①**；底稿修正 R1 |
| S2 | 沙箱子进程（VM Realm/NDJSON 帧协议/进程监管） | behind | VM Realm 预Seed 泄宿主对象图（**已在我方真实引擎实测逃逸**）；无 cell 停滞检测；畸形帧静默；EPIPE 竞态 | **D1（最高优先·安全）**；D4；R4 |
| S3 | 三层限流（引擎并发门 + run 席位门 + AIMD Governor）与退避 | behind | 核心公式一致但官方四层纪律全缺 | **D8②**；R4（退避抖动两点） |
| S4 | facade 未宣传原语与 caps 全量清单 | behind | channel/future、model() 路由、artifact preset 三族缺席；caps 四处小修；isReference 初始化位漏网 | **D3（15 分钟）**；**D8③④** |

### 3.1 S1·引擎内核与缓存 — behind

- **底稿需修正三处（实测推翻）**：① 底稿 2.3-⑤「settle-order 门按启动顺序重放」错——是首生**结算**次序（node-settled 事件序），且它解决的是 join 后序号错位炸 InputHashMismatch，不是「与 Claude Code 启动序对齐」；② 底稿 2.3-⑦「血缘指针放 run-launched 事件里」错——resumedFrom 是 dwf_run 列、supersededBy 随 stopped 结算同一笔落库，run-launched 只载 launch 锚点（「零迁移」对结算序/关门判定的事件恢复才成立）；③ 底稿 2.4-2「(siteId, ordinal, inputHash) 三元组共用」要限定——官方 journal 重放是位置优先+哈希防御，池化（按内容 1:1 消费）只存在于 world 导入队列。
- **底稿需深化两处**：④ 完全漏了 in-flight ask 接续（ImportedInFlightAsk）——静止探针的存在意义正是裁决「半场转录能否接续」，quietSessions 缺席=全部静默的不对称、5 秒有界等待的「不是超时掩盖竞态」论证、快照语义都值得记入；⑤ 漏了 import-closure 关门（askMutating/world-run 两个触发点、takeIfPure 纯条目豁免、从事件恢复关门判定）。→ 文档级待办，归入 **R1**（随 D8① 执行时一并落）。
- **我方差距排序**：已有内容池重放 + amend 温缓存 + parent_run_id 血缘（实测零调用重放与 3/5 amend 命中都工作）；在底稿 P1-1「quiescence 探针可后置」之上，真正结构性缺口是：
  - (a) **per-actor 具名缓存**（名字+persona 匹配，对 site 重编号免疫）替代我方按 siteId 键控的池——这是 amend 命中率的天花板（**D8①**）；**已落地（Issue #39）**：ask 行增 `(actorName, actorSeq, contentHash, personaJson)` 身份列，amend 按名+persona 附着、1:1 消费、分歧单调；旧账本站点键控回放保持兼容；
  - (b) 静止探针/消息边界/转录种子整层在无状态单发 ask 模型下暂时不适用，只有引入持久 actor 会话才值得建——建议在底稿 P1-1 标注此前置依赖；
  - (c) 若保留内容池方案，应修正 engine.ts 头注释里已滞后的「mismatch fails loudly」表述，或补一个 run 级 scriptHash 之外的显式纯度契约。
- **验证方式（上游）**：官方结论全部逐行读码（探针 workflow-driver-quiescence.ts 逐函数、导入构建 dynamic-workflow-import.ts 逐函数）；我方行为在 worktree 用 mock provider 实测（run/resume/amend 三世 + node:sqlite 查 journal），scratch 已清理。

### 3.2 S2·官方内核深度逆向：dynamic-workflow-runtime 沙箱子进程 — behind

（对照物：child-source.ts / child-cell-streams.ts / harness.ts / protocol.ts + child-entry-file.ts ↔ 我方 src/dwf 沙箱与 src/process-supervision.ts）

- **核心差距：VM Realm 预Seed（已在我方真实引擎复现逃逸，非纸面对比）**：official 把「脚本触及的一切」都约束在 context 内构造，跨界只剩一个 `__send` 函数与入站行字符串（child-source.ts:21-24）；我方 child-main.ts 把 `__host`、args（child-main.ts:107 在外层 JSON.parse）、Math/Date 替身、`__fanout`、`__sessions` 整个外层 realm 对象图注入 context。
  - 逃逸实测：`node bin/workflow.js run-script xrealm2.facade.ts --args '{"a":1}'`（脚本 `return args.constructor.constructor("return typeof process + \":\" + process.cwd()")();`）返回 `"object:C:\...\issue-28-goal-e2e-pentest"`，且 `check` 编译门禁放行（compiled clean）；同型 side-by-side 测试中 official 模式（JSON 字符串 seed、context 内 parse）返回 undefined。
  - 修复方向：① 仿 official 改为 JSON 字符串 seed + 在 context 内 `Object.freeze(JSON.parse(...))` 重建 args/run；② `__host` 在 BOOTSTRAP 内重建，外层只递一个 `send(string)` 函数；③ 编译期对 `.constructor.constructor` 形态加诊断（**已由 GAP-02 完成**）。→ 动态层 **D1（最高优先·安全）**。
- **次级差距**：④ 我方无 cell 停滞检测（official 每条 response 后 setImmediate 查 pending，无在飞即 ScriptStalled/ChannelDeadlock error-complete；我方零宿主调用的死等脚本要挂满 600s 整跑超时）；⑤ 畸形 NDJSON 行我方静默 continue（runner.ts:384-387）而 official 停 run 并点名该行（harness.ts:446-455），host 错误线形态只带 name 丢 code/violations/finalText；⑥ 我方 runner 未给 child.stdin 挂 error 监听（official harness.ts:440 有），杀子进程竞态窗口内 reply 可致 EPIPE uncaughtException。→ ④⑤ **未入册 → R4**；⑤ 的畸形帧计数部分与 ⑥ 已入 **D4**。
- **我方领先处（保持）**：env 白名单+值遮蔽（official 沙箱全量继承 `{...process.env}`）、POSIX 进程组 + taskkill /T 树杀、孤儿 run 收敛、CLI stop/doctor、compile 期 codeGeneration 禁 eval/wasm。

### 3.3 S3·三层限流与退避 — behind

- **公式一致**：×0.75 递减、+1/4 次成功、Retry-After 冷却、空闲重置、FIFO 排队都在；但官方围绕公式的四层纪律我方全缺：
  - ① governor 桶键升到 providerId/modelId，并补 epoch 纪律（旧信号不评价当前 cap）与 lastGood/lastBad 两档递减（已证明水位之上退回 lastGood，之下才 ×0.75）；
  - ② 增长兑现加 waiters>0 门槛，并区分 initial（起点/空闲落点）与 growthLimit（2D 起、随 run 登记上界抬升）；
  - ③ engine.ts:346-348 把 AbortError 记成 success 会推高 cap，应走只减 inFlight 的 ended 语义；
  - ④ rpc 层内部重试（默认 3 次）期间持有 AIMD 槽，应改为每次尝试前 acquire/退避即 release，或把重试上提到引擎层统一治理；
  - ⑤ 若将来做 retune（中途改 max_concurrency），必须同时补第二执行点 run 席位门（官方 workflow-seat-gate 的 working/parked 停车模型）与三处一致（引擎落库→闸门→治理器 setRunBound+seed），否则只改调度器上界对已在飞的 ask 无效。
  - → 全部归入 **D8②**。
- **退避侧可低成本对齐官方两点**：429 加向后抖动（≤min(0.2×retryAfter,5s)，防同批同毫秒醒来再撞限流）与普通指数退避的 0.5-1.0 乘性抖动 → **未入册 → R4**。

### 3.4 S4·facade 未宣传原语与 caps 全量清单 — behind

- **官方 facade 四大「未广泛宣传」原语族中我方缺三个**：
  - (1) **channel/future 纯 cell 原语**整个缺席（我方 facade/child-main/lower 均无）——无站点、不落 journal 的纯 promise 机制 + setImmediate 停滞检测，移植成本低且能补齐流水线语义（**D8③**）；
  - (2) **model()/ModelRef 路由**缺席——我方用 agent(name,{provider}) 走 provider 维度（9014 字面量规则），官方是 model() 封闭集 9010 + 宿主目录解析 9011 + 三档特异性匹配，两条路由维度不可互相替代（**D8③**）；
  - (3) **artifact preset 门类**（chart/table/metrics/board）缺席，我方只有 file/markdown 两个 content 成员（**D8③**）。
- **caps 数字大体 par**（32/16/65,536/1GiB/16MiB/512KB/300s/2000 全对齐）但四处小修：① 20,000,000→20*1024*1024、256,000→256*1024、1,000,000→1024*1024（KB/KiB 对齐）；② engine.ts:658 git.log 超 100 应结构化拒绝而非 Math.min 静默夹到上限（官方 world-read-caps 明文禁止静默夹）；③ artifact id 缺 `[A-Za-z0-9_.-]{1,64}` 校验；④ grep 语料被 maxFiles:5000 静默截断 → **D8④**。
- **purity ban 我方比官方更严**（显式 AST 9002 清单 + import 全禁 + Date.parse 也禁），但有一个已验证漏洞：compile.ts `isReference`（汇报时点 :334，现 :341——2026-11-01 修订轮核实）把 VariableDeclaration 的 initializer 也排除，`const g = globalThis`、`const e = eval` 逃过 9002（eval/globalThis 在 lib.es2022 下类型合法，type-error 通道也拦不住）；修法是 isReference 里对 VariableDeclaration 只排除 name 位 → **D3（15 分钟小修，GAP-02 合入后同文件顺延）**。
- **对照注意事项**：诊断码空间与我方语义冲突（官方 9002=schema、9004=phase、9010=model），对表时勿混用。

---

## 四 PoC 防线对比表

| PoC | 防线（修复前） | 现状 | 缺口 | 修复载体 | 证据 |
|---|---|---|---|---|---|
| **PoC2b/2c 跨 realm Function 逃逸**：args（主机域对象）.constructor.constructor → 宿主 Function → 宿主 process → `process.binding('spawn_sync')` 任意命令执行（辅助：PoC1 构造器链、PoC3 原型链污染、PoC3c 协议畸变、PoC4 microtask 伪造 done 帧） | partial | **静态门已闭合\***：constructor/__proto__/prototype 链（含括号形式、any-cast 变体）compile 期 9002 拒绝（GAP-02）；对抗测试 skip 已转正且 **3 pass/0 fail（本节点实测）**。**动态层未修**：宿主域对象图仍整图注入 realm | VM 预Seed（child-main.ts:107 宿主域 JSON.parse 后注入） | GAP-02（静态）＋ **D1**（动态预Seed 重构，最高优先·安全） | 逃逸实测（修复前）：`node bin/workflow.js run-script xrealm2.facade.ts --args '{"a":1}'` 返回 `object:C:\...\issue-28-goal-e2e-pentest` 且 check 放行；official 同型 side-by-side 返回 undefined；`goal-poc2-crossrealm-function.test.ts:56` 仍 describe.skip（BREACHED 记录，D1 DoD 含转正）；`goal-poc4-microtask-escape.test.ts:23` 仍 skip（→ R4） |
| **PoC-1/2/3 协议投毒**：child NDJSON 帧撕裂/粘包/伪造帧、控制字符注入 ask/log 通道、1MB/>32MB 超限报文 | partial | 未修（GAP-01 保持未收 runInfo 的直接 spawn 行为不变：goal-poc1-ndjson-protocol / goal-poc2-crossrealm-function / goal-poc2-control-char-injection 三文件 strip-types 直跑 **9 pass/0 fail**） | 字节预算缺失、畸形帧静默 continue、stdin EPIPE 竞态、洪泛饿死事件循环 | **D4**（skip 转正作 DoD） | 上游实测洪泛 213.1s 饿死 timers；仍 skip：`goal-poc1-ndjson-protocol.test.ts:136`、`goal-poc3-oversize-frames.test.ts:149` [已验证] |
| **PoC1/2/3 资源炸弹三连**（TEST-GOAL 4.2）：① 500 深递归类型 ask&lt;T&gt; 编译期炸弹；② 3000 文件 files.glob 炸弹；③ 64 并发 mock agent 风暴 + 1000-call 熔断 | **held** | held（防线实测有效） | — | — | TEST-GOAL 4.2 实测（上游）；对应 fixtures `goal-poc1-deep-type.ts`、`goal-poc2-glob-*.ts`、`goal-poc3-agent-storm.ts`、`goal-poc3-cap-*.ts` 在 tests/adversarial/fixtures/ |
| **凭据窥探三向量**：process.env 直读 / world.run 侧信道 / files.grep·read 扫 .env ＋ 错误路径外泄加测 | partial | **主向量已闭合\***（GAP-03）：CLI stdout 双通道 0 明文（log/report/result 全 `***REDACTED***`）、events data_json / dwf_nodes result_json 泄漏 0（**场景限定**：files-grep 场景；world-run 探针场景中短裸 sk-decoy-123 按上游 ask 契约原样保留，见 §2.6①——不计入「泄漏」）；goal-poc3-files-grep skip 转正 **tests 2 / pass 2 / fail 0 / skipped 0**；无回归：goal-poc2-worldrun-sidechannel 2/0、goal-poc1-env-read 1/0 | 短裸 sk- 值形（{20,} 下限，刻意保留）、args_json 入参（R2）、非敏感键值形（R3） | GAP-03；残余 R2/R3 | journal triage-fix-3.db node:sqlite 断言全过（上游 GAP-03 实测）；错误路径外泄：engine.ts `:943 redactText((err as Error).message)` 在位 [已验证] |

\* 见状态总注记：worktree 已修、未提交。

---

## 五 补强施工结果（GAP-01..06，全部 done·未提交）

### GAP-01 log/report 边界签名修复 + runInfo 补投（A 类）

- **改动文件**：`src/dwf/child-main.ts`、`src/dwf/runner.ts`、探针 `.scratch-gap01/gap01-logreport.facade.ts`
- **根因复核 [已验证·worktree 实读]**：lower.ts（:139-141 一带）把 log/report 降级为 `__host.log("log#N", 正文)` / `__host.report("report#N", item)`；旧 child-main.ts:95-96 签名 `(message)/(item)` 把 siteId 当载荷转发、真实正文在边界被丢；engine.ts:209-210 log 只消费 p[0]、:211-212 report 消费 frame.siteId+p[0]。另 lower.ts:49-51 把裸 run 改写为 `__host.run`，旧 `__host` 无 run 属性。
- **任务外新事实 [已验证]**：全仓 src/ 无任何 runInfo 发送方——对 bea9a05/8402d76/fa274e5/HEAD 四个提交点逐一 grep 计数均 0；bea9a05 提交信息自称 "the parent pushes runInfo right after spawn" 但从未实现；child 的接收路径（child-main.ts:277-280）是死代码；pushToChild 唯一流量是 budgetSync（runner.ts:327）。
- **改动**：
  1. child-main.ts:96（现 :97）`log:(siteId:string, message:unknown)=>callHost('log',siteId,message)`；
  2. child-main.ts:97（现 :98）`report:(siteId:string, item:unknown)=>callHost('report',siteId,item)`（`__fanout` 内部直接 `callHost('log',undefined,…)` 的四处 dist:146/150/181/185 不受影响，已核）；
  3. child-main.ts:110-112 `__host` 补 `get run(){return runState}` + :280 runInfo 首次赋值后 `Object.freeze(runState)`；
  4. **扩权改动** runner.ts：pushToChild 赋值（:453-456）后补唯一一处 `pushToChild({t:'notify',op:'runInfo',runId,resumedFrom:amendedFrom ?? priorRunParent})`（现 :461；报文形状与 child 接收路径 protocol.ts:64-79 逐字段一致；每 child 恰好一次——child 冻结后二次 push 会 throw，故只此一处；resumedFrom 刻意镜像 saveDwfRun 的 parentRunId 血缘表达式 :475/:481）。**扩权依据**：探针首轮实证 run.id=''（CLI 输出 `result:{"runIdSeenByScript":""}`），仅改 child-main.ts 不可能满足 DoD 第 1 条（'hello dwfrun-…' 真实 runId）；经升级提问、主代理裁决选 A 后实施。engine.ts/lower.ts 零改动；runner.ts 中并行兄弟代理的 fillHole 改动未被触碰。
- **探针自测 [已验证]**：check 干净（3 sites: phase#1/log#2/report#3）；`run-script --db .workflow/triage-fix-1.db` 首跑 `dwfrun-mvxu6hyu-1a1070` completed（修复前此场景 crash 'Cannot read properties of undefined (reading id)'）；node:sqlite readOnly 三断言全过：ASSERT1 `dwf_log.message="hello dwfrun-mvxu6hyu-1a1070"`（真实正文+真实 runId）；ASSERT2 `dwf_report.item={"k":1}`（修复前 `{"item":"report#N"}`）；ASSERT3 dwf_nodes 行 site_id='report#3'、result_json='{"k":1}'，site_id='undefined' 计数=0。血缘附加验证：--amend 该 run 得 fork `dwfrun-mvxu8mqj-00bdd1`，脚本内 `run.resumedFrom='dwfrun-mvxu6hyu-1a1070'`（正确定位 lineage parent，符合 facade-dts.ts:56 语义）。
- **残留特性（如实报告）**：同步顶层读 run.id（任何 await 之前）仍为空串 [已验证·两轮实测]——runInfo 走 stdin 帧在事件循环才被应用，永远赶不上脚本同步 prologue；这是 bea9a05 push 式设计的固有属性，经第一次真实 host round-trip 后按帧序保证 run.id 正确（探针因此先 `await phase('probe')` 再读）。修复后不再 crash（空串回退），满足裁决条件②的旧路径容忍。
- **测试 [已执行]**：tsc --noEmit -p worktree/tsconfig.json 三次全过（child-main 改后 / runner 改后 / 最终态，EXIT=0）；build 过且 `dist/src/dwf/child-main.js:84/:99/:279` 已核实含修复；`node --test` domain.test.js + dwf-compiler.test.js + dwf-replay.test.js 最终合并跑 **tests 42 / pass 42 / fail 0**（事件类型白名单无回归）；直接 spawn child 的对抗测试（goal-poc1-ndjson-protocol / goal-poc2-crossrealm-function / goal-poc2-control-char-injection，strip-types 源跑）**tests 9 / pass 9 / fail 0**——未收 runInfo 的直接 spawn 行为不变（裁决条件②）。tests/unit/fixtures 干净，无需 git restore。
- **收口提示**：无 git commit（留给收口层）；探针与 journal `.workflow/triage-fix-1.db` 为未跟踪中间产物，供收口层复核后按 §1.5 清理；PR 需在「刻意未改/扩权说明」留痕：runner.ts 的 runInfo push 系完成 bea9a05 承诺的父进程半边，经主代理裁决扩权（子代理 GAP-01 于 2026-11-01 升级请示，裁决选 A）。

### GAP-02 constructor 链静态 9002 规则（A 类）

- **改动文件**：`src/dwf/compile.ts`、`tests/unit/dwf/dwf-compiler.test.ts`（worktree 分支 feat/issue-28-goal-e2e-pentest，未 commit）
- **改动**（最小改动、无格式化夹带，git diff --stat 确认仅限范围内文件）：
  1. compile.ts:38-39（现 :39）新增 `PROTOTYPE_CHAIN_PROPS`；
  2. compile.ts:169-180（现 :170/:176）isPropertyAccessExpression 分支内（Date/Math 规则之后）三属性名 → 9002 purity-ban（消息 "…constructor-chain access can rebuild Function from nothing; facade primitives only."）；兄弟块 ElementAccess+StringLiteral 同集合（`obj["constructor"]`）；isReference 未触碰（`const e=eval` 漏网属 D3 范围）；
  3. 测试 +44 行 5 条（v1-v4 ok:false 9002、v1 另断言 TS2591、v5 ok:false 消息含 constructor-chain、括号形式 ok:false、正向对照 ok:true）。
- **检查 [已验证]**（GAP-02 会话内，命令与结果）：
  - 修复前基线：v5 CLI check exit 0 clean（缺口复现）；进程内探针 v1=[TS2591,9002]、v2/v3/v4=[9002]、v5=ok:true、clean=ok:true——与 ask 根因精确吻合；
  - `node node_modules/typescript/bin/tsc --noEmit -p <wt>/tsconfig.json` exit 0；`tsc -p` build exit 0（dist 是测试+CLI 实际加载路径，bin/workflow.js 优先 dist/）；
  - `node --test dist/tests/unit/dwf/dwf-compiler.test.js` **tests 14 / pass 14 / fail 0**；dwf 全目录 10 文件 **tests 70 / pass 70 / fail 0**；
  - CLI check × 5 inv1 变体全部 exit 1；v5 明细：`v5-constructor-chain.ts:7:17 purity-ban(9002): "constructor" property access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`；
  - 无回归 DoD：4 demos facade（demos/capabilities-tour 的 gate/budget/growth/lineage.facade.ts）check 全 exit 0；全仓 grep .constructor/.prototype/.__proto__/bracket 访问：仅 tests/adversarial PoC fixtures（应拒样本），无正当脚本受影响；
  - 附加证据：`node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc1-constructor-escape.ts` → ok=false，diagnostics=[(9002, purity-ban)]——满足对抗测试文件记载的断言。
- **披露**：ask 指定的 `node --experimental-strip-types <test file>` 直跑因 pre-existing 结构性原因不可用（测试 import '../../../src/dwf/compile.js' 仅能经编译 dist 解析，直跑 ERR_MODULE_NOT_FOUND，改前已验证），改用 dist 编译路径（npm run test:unit 同款机制）；共享工作树上 package-lock.json、run-script.ts、runner.ts、untracked scratch/* 系并行代理改动，未触碰；本任务探针为内联 node -e，无临时文件。**A 类（完成且通过验证）**。
- **本节点补充 [已验证]**：该对抗测试文件的 skip 块现已在工作树转为正式断言（文件 :79-84 注释载明 "Formerly a .skip block documenting the gap … re-measured 2026-11-01 … converted to real assertions"），且 strip-types 直跑 **3 pass / 0 fail**（§〇 #10）；转化发生在 GAP-02 汇报之后、由并行任务完成（具体执行者 [未知]），文件为未跟踪状态，是否纳入本次提交由收口层决定。

### GAP-03 world.run argv 脱敏 + 完成值边界掩码（A 类）

- **改动文件**：`src/dwf/engine.ts`、`src/dwf/redact.ts`、`tests/unit/dwf/redact.test.ts`、`tests/adversarial/goal-poc3-files-grep.test.ts`
- **改动**（①③与计划逐字一致，②为已验证的必要扩展）：
  1. engine.ts:783 `emit('dwf_world_run',{cmd, args: args.map((a)=>redactText(String(a)))})`；:784 spawn 仍用原始 args（observability-only）；:20 导入补 redactValue。
  2. journalled 完成路径（现 :967-972）：在 saveDwfNode 之前与 return 之前 `value = redactValue(value)`，`resultJson: JSON.stringify(value ?? null)` 持久化的即掩码值（与计划字面 `JSON.stringify(redactValue(value ?? null))` 语义完全等价，redactValue 幂等）。**计划偏差·当场指出**：计划的②只改 resultJson 一行不足以通过 DoD——基线实测（改动前 dist 跑 goal-cred-snoop-3-files-grep 场景）证明 CLI stdout 唯一泄漏通道是 result: 行（脚本返回值经 runner.ts:431 frame.value 原样到 run-script.ts:128 打印，journal-only 掩码下转正测试的 `!out.includes(DECOY)` 必红）；且 ask 引用的 redact.ts:5-8 契约本身明确覆盖「随 run 结果返回的字符串」。故在 journalled 边界先掩码再持久化+返回（journal 即权威值、重放/脚本视图/CLI 全链路继承掩码），是满足 DoD 的最小扩展（同文件 1 行 + 注释）。
  3. redact.ts:39 `CREDENTIAL_TOKEN_SHAPES` 增补 `sk-[A-Za-z0-9]{20,}`（保留长度下限，短示例串不被吞）。
- **证据 [已验证]**（GAP-03 会话内）：
  - 基线（改动前）：CLI stdout 经 result: 行泄漏 sk-decoy-123×2 + hunter2×1；journal dwf_nodes.result_json 泄漏 2 行（worldread#2#1 / worldread#3#1）。
  - 改动后（独立 journal `.workflow/triage-fix-3.db`，`node bin/workflow.js run-script tests/adversarial/fixtures/goal-cred-snoop-3-files-grep.ts`，decoy workspace 在 tmp）：(a) node:sqlite 断言——events 表 dwf_world_run 中 sk-decoy-123 出现 0 次（该场景无 world.run 行，总数 0）；全部 events data_json 泄漏 0；dwf_nodes.result_json 泄漏 0、***REDACTED*** 出现 3 个节点；(b) CLI stdout 双通道 0 明文——log/report/result 全部显示 `GOAL_POC_TOKEN=***REDACTED***` 与 `postgres://***:***@`。
  - ①独立探针（world.run args 携带三种形状，journal triage-fix-3-probe.db）：events 表 dwf_world_run args 实测 `['GOAL_POC_TOKEN=***REDACTED***','***REDACTED***','sk-decoy-123']`——KV 形状与长裸 sk- 被掩码；短裸 sk-decoy-123 按③刻意下限原样保留（redactText 契约内、ask 明文「勿吞短示例串」，如实报告非隐藏）；dwf_nodes 泄漏 0。
- **门禁与测试 [已验证]**：tsc --noEmit exit 0；`npm.cmd run build` dist 重建 20:50:01；node --test redact.test.js **tests 12 / pass 12 / fail 0**（含新增 sk- 形状用例：长裸 sk- 掩码 + sk-decoy-123 短串保留 + 幂等 + redactValue 结构路径）；dwf-replay 6/0；**goal-poc3-files-grep.test.ts describe.skip 已转正 → tests 2 / pass 2 / fail 0 / skipped 0**（error path + value path 全绿，DoD 达成）；goal-poc2-worldrun-sidechannel 2/0、goal-poc1-env-read 1/0（①③无回归守卫）；另跑 dist/tests/unit/dwf 全目录回归 **tests 71 / pass 71 / fail 0**。tests/unit/fixtures/ 干净（git status 空）。
- **如实说明**：(1) worktree 为多 agent 共享，run-script.ts/child-main.ts/compile.ts/runner.ts/inspect.ts/cli index.ts/dwf-compiler.test.ts/package-lock.json 存在并行 agent 的未提交改动，未触碰；tsc/build/测试在合并工作树上进行。(2) 中间产物已清理：.scratch-gap03/、tmp 诱饵 workspace、自建 3 个 journal（triage-fix-3*.db）均已删除；.workflow/ 剩余 db 属并行 agent，未动。(3) 未跑全量门禁套件（test:pbt / e2e runner / governance）——按 ask 约束只跑直接相关最小集 + dwf 全目录，全量由收口层统一执行。(4) 若收口层认为②不应掩码返回值（仅 journal 掩码），回退方式：删除 engine.ts:972 一行，但转正测试将转红（CLI result 行复漏）——两者不可兼得，已按 DoD 优先取之。

### GAP-04 run-script journal 路径显示（A 类）

- **改动文件**：`src/cli/commands/run-script.ts`（单行，:129）
- **改动 [已验证]**：``console.log(`  journal: ${options.dbPath ?? path.join('.workflow', 'dwf.sqlite')}`)``——与 runner.ts:112 的解析规则 `options.dbPath ?? path.join(cwd, '.workflow', 'dwf.sqlite')` 对齐（CLI 未传 cwd，cwd=process.cwd()）。git diff 确认仅此一行、无格式化夹带；path import 仍被 fallback 分支使用。
- **自测 [已验证]**（先 tsc --noEmit → TSC_OK；因 bin/workflow.js 优先加载旧 dist，重新 `tsc -p tsconfig.json` 编译后用真实 CLI 验证；最小探针 scratch-gap04/probe.ts 零 provider 调用）：
  1. `node bin/workflow.js run-script scratch-gap04/probe.ts --db .workflow/triage-fix-4.db` → 尾行 `journal: .workflow/triage-fix-4.db`；node:sqlite 实读该库：events 表含所显示 run `dwfrun-mvxt98pj-5e1453` 的 dwf_log/dwf_report/dwf_completed 三行 → 显示=实际写入库 ✅
  2. 不传 --db → 尾行 `journal: .workflow\dwf.sqlite`；node:sqlite 实读默认库：含所显示 run `dwfrun-mvxtb89o-06d249` 的同三行事件 ✅
  - DoD 两种路径均满足。
- **说明**：传 --db 时显示的是用户传入字符串原样（`.workflow/triage-fix-4.db` 正斜杠），非反斜杠规范化形式（计划里预写为 `.workflow\triage-fix-4.db`）——原样回显与实际落盘文件逐字一致，DoD「显示与实际写入库一致」成立且更忠实。
- **说明**：tests/ 内无任何单测覆盖 executeRunScript 的显示行（仅 src/cli/index.ts 调用它），故直接相关验证 = tsc 门禁 + 上述两分支 CLI 探针 + node:sqlite 交叉实读，全部本会话实际执行。
- **清理**：探针目录 scratch-gap04/ 与自定义库 triage-fix-4.db 已删除；.workflow/ 整体 gitignore，工作区无本次新增脏文件；共享默认库 dwf.sqlite 保留未删（并发共用 journal）。未 git commit。worktree 中 compile.ts/runner.ts/dwf-compiler.test.ts/package-lock.json 的未提交改动为并发其他修复代理所有，未触碰。

### GAP-05 fill 对非 parked run 拒绝（A 类）

- **改动文件**：`src/dwf/runner.ts`（+10/-1，git diff 已核，无夹带无格式化）
- **根因复核 [已验证·实读]**：runner.ts fillHoleAndRun(:556) 原有守卫仅覆盖 run 不存在(:563-566)、running 收敛后仍在跑(:567-572)、无源码(:573-575)，唯独不拒 `status!=='parked'`——已完成 run 再 fill 会落第二条 hole 节点行(:630-639, 同 inputHash)、标 completed(:640)、再 fork amend(:644-652)。DwfRunRow.status 合法值 'running'|'completed'|'failed'|'stopped'|'parked'（src/domain/workflow-types.ts:349）。fill.ts:68-74 refused→stderr+exit1 通道现成，CLI 零改动 [已验证·实读]。
- **修复 [已验证]**：
  1. running 收敛块后插入守卫 `if (prior.status !== 'parked') return { status:'refused', error: \`run "${options.runId}" is ${prior.status} — only a parked run can be filled; start a fresh run or fill the forked amend instead\` }`（措辞按 ask 计划原文；现位于 :584，本节点 grep 已核实）；
  2. 因 convergeOrphanRun(:105) 只把 DB 写成 'stopped' 而不改本地 prior，收敛后回读 store 刷新本地视图（const→let + 一次 getDwfRun 回读），否则守卫对「死 pid 收敛为 stopped」的 run 会误报 'is running'。两处均为守卫正确性所需的最小改动。
- **门禁 [已验证]**：tsc --noEmit exit 0；随后 tsc -p 重建 dist（bin/workflow.js 优先加载 dist/src/cli/index.js，stale dist 不含守卫——实读 bin/workflow.js:11-21 确认），grep 确认 dist/src/dwf/runner.js 含守卫。
- **自测 [已验证·mock 全程、真实 CLI]**：独立 journal `.workflow/triage-fix-5.db`（scratch-gap05/ws 内，与其他并发任务隔离），driver selftest.mjs **23/23 ALL PASS**：
  - A1 探针脚本首跑至 parked（dwfrun-mvxtmby8-c48d12）；
  - A2 fill 一次 accepted、fork（dwfrun-mvxtken-1d19ab）completed、parent=R、hole 节点行=1；
  - A3 对原 runId 二次 fill 同名洞 → exit 1、stderr `✖ fill refused: run "…" is completed — only a parked run can be filled; start a fresh run or fill the forked amend instead`，且 node:sqlite 断言：该 runId hole kind 节点行仍=1、节点总行数 2→2 不变、parent_run_id=R 的 fork 数 1→1 不变（无第二个 amend）、run 行仍 completed、script.effective.ts sha256(26dc2947…bd5a) 字节级不变且不含第二次 body('SECOND_ATTEMPT')；
  - B 链路：park→fill→再 park→再 fill 完好——chain 脚本 first-hole fill 后 fork dwfrun-mvxtmu15-21d625 落库 status='parked'（runner.ts:468-472 终态落库），对 parked fork 再 fill accepted → 终值 {first:{step:1},second:{done:true}}；
  - digest C4 [已验证·行为面]：「对已完成 run 再次 fill」现被拒且退出码 1、零副作用（上述 A3 全套证据）；注：C4 原文未在 worktree 中检索到，按 ask 对该项的描述复核。
- **相关既有测试 [已验证]**：`node --test dist/tests/integration/dwf-holes.test.js dist/tests/integration/dwf-branch-parking.test.js` → **tests 5 / pass 5 / fail 0 / skipped 0, cancelled 0**（dwf-holes 4 项 + branch-parking 1 项，全部既守卫行为兼容）。
- **边界与诚实声明**：① 共享 worktree，git status 中 run-script.ts、{child-main,compile,engine,redact}.ts、dwf-compiler.test.ts 及 tests/adversarial/* 未跟踪文件系其他并行任务所改/所建，零触碰；dist 重建产物因此含其进行中改动（dist 已 gitignore）。② 未跑全量套件（收口层职责），仅跑 ask 指定的最小相关测试。③ 严禁 commit 已遵守，改动留在工作区待收口层统一提交。④ 自测 driver/fixture/journal 临时目录 scratch-gap05 已当场整目录删除（§1.5），主仓全程只读未动。

### GAP-06 inspect --db facade 支持（A 类）

- **改动文件**：`src/cli/commands/inspect.ts`（+102/-4）、`src/cli/index.ts`（+1）；worktree 分支 feat/issue-28-goal-e2e-pentest，未 git commit（HEAD 仍为 30eb54f），主仓未触碰（git status 对两文件无匹配）
- **改动**：
  1. inspect.ts：① InspectCommandOptions 增 `db?`；② dbPath 解析：`options?.db` 显式优先，否则维持原两级回退（runs/&lt;runId&gt;/checkpoints.db → runs.db，逐字不变）；③ 打开 store（cast 为 SQLiteStateStore & DwfJournalStore）后先试 `getDwfRun(runId)`（sqlite-store.ts:480 已有读口），命中走新增 `renderFacadeInspect`（渲染 run.status/parentRunId、dwf_nodes 逐行 `[STATUS] siteId(#ordinal) kind (durationMs)` 摘要、kind×status 计数表、`--events` 时 events 流；`--json` 输出同构 JSON）；未命中落回原 builder 逻辑（零行为变更）。依据：SQLiteStateStore 构造时对所有 db 一律 CREATE TABLE IF NOT EXISTS dwf_runs/dwf_nodes（sqlite-store.ts:82-93），builder 老库上 getDwfRun 安全返回 null；复用 view.ts:21 的 `opts.db ?? 默认` 同型模式。
  2. cli/index.ts：inspect 命令补 `.option('--db <path>', 'Journal database path (facade runs)')`；action 已有 {...opts} 透传，无需额外接线。
- **自测证据 [已验证]**（worktree scratch-gap06 内，node bin/workflow.js，dist 由 tsc -p 重建）：
  - 改前盲区实拍：`inspect dwfrun-mvxttjat-3add42 --db .workflow/triage-fix-6.db` → `error: unknown option --db`，exit 1；
  - facade 自测：mock run（run-script hello.workflow.ts --db triage-fix-6.db，默认 mock provider）产出 dwfrun-mvxttjat-3add42（completed，2 个 ask 节点）与 dwfrun-mvxttrlg-16bb2d（hole 脚本 park）。改后：inspect completed → 'Overall Status: completed' + 节点行 `✔ [COMPLETED] ask#2(#1) ask` + `Nodes by kind × status: ask: 2 completed`，exit 0；inspect parked → 'Overall Status: parked'，exit 0（DoD parked/completed 状态与节点行均满足）；--json 同构正常；--events 列出 13 条 dwf_* 事件流；inspect 不存在 runId → 'Run ID not found in database'，exit 1；
  - builder 回归：用 SQLiteStateStore API 预制 builder 老库（runs.db：upsertRun+2 checkpoints+2 events+1 artifact），改动前先捕获 5 种变体输出（plain/--json/--events/--step step-a/missing-run），改动后重跑逐一 diff，**5/5 字节级一致**；missing-run exit code 改前改后均 1；无 --db 时默认两级回退行为不变（facade runId 不带 --db 仍报 Run not found，与计划一致）；
  - 门禁：tsc --noEmit EXIT 0；tsc -p 全量构建 EXIT 0；
  - 最小相关测试：`node --test dist/tests/unit/cli.test.js` → **tests 8 / pass 8 / fail 0**；`dist/tests/unit/sqlite-store.test.js` → **tests 5 / pass 5 / fail 0**（测试向 tests/unit/fixtures/ 写入的副产物已按纪律 git restore 还原）。
- **边界与裁剪说明**：--events 渲染已实现（未触发 30 分钟降档）；[推断] parked run 的 hole 节点行在 fill 前不存在于 dwf_nodes（runner.ts:639 仅 fill 时 saveDwfNode 落行），故 inspect 对 parked run 显示 0 节点属如实反映 journal，非缺陷；[已验证] 默认路径（无 --db）不会自动发现 .workflow/dwf.sqlite 中的 facade run——按计划刻意不扩展，消除残余盲区应另立项；MCP 侧（src/mcp/server.ts:239-246）未改动（→ D2）；scratch-gap06（含 before/after 证据与 mock 脚本、builder fixture 生成器）保留在 worktree 供收口层核查，可随统一清理删除。

---

## 六 未修复项与后续计划（deferred）

### 6.1 D1..D10（上游 deferred 清单）

| # | 主题 | 规模/优先级 | 内容 | DoD/验证 |
|---|---|---|---|---|
| **D1** | **VM realm 预Seed 重构（最高优先·安全，PoC2b/2c 跨 realm Function 逃逸的主破口）** | 约 0.5-1 天 + 全量门禁；**需独立 Issue** | child-main.ts:107 args 在宿主域 JSON.parse 后整对象图注入 realm（实测 args.constructor.constructor 可达宿主 process/cwd），对齐官方 child-source.ts:202-206——传 `__argsJson` 字符串进 realm、realm 内 `Object.freeze(JSON.parse(...))` 重建 args/run、`__host` 于 BOOTSTRAP 内重建、外层只递 send(string) | xrealm2 探针 + `tests/adversarial/goal-poc2-crossrealm-function.test.ts` skip（:56）转正回归 |
| D2 | 遥测挂接全量 | 约 0.5-1 天；建议 GAP-06 合入后接力 | list.ts --db + sqlite-store 新增 listDwfRuns 查询（facade runId 进 list 输出，integration gap2）；MCP workflow_inspect 的 dwf journal 分支（src/mcp/server.ts:239-246 固定 getAllCheckpoints，integration gap1）；view/graph 对 facade 的 graph 导出（基6 实测 graph 仅支持 builder 模式） | list/inspect/view/graph 四处 facade journal 可见 |
| D3 | compile.ts isReference 初始化位漏网 | **15 分钟小修**；GAP-02 合入后同文件顺延 | compile.ts `isReference`（汇报时点 :334，现 :341）对 VariableDeclaration 整体排除引用判定，`const e=eval` / `const g=globalThis` 逃过 9002（type-error 通道也拦不住；PENETRATION 修订轮双探针复现 ok:true）；修法是 VariableDeclaration 仅排除 name 位 | 补两条对应断言进同一测试文件 |
| D4 | runner 协议加固三件（PoC 协议投毒①② + inv3②） | 约 0.5 天 | runner.ts:373-390 行拆分加单行/总量字节预算（对齐官方 1MB 帧/16MB 消息，超限 killTree+命名错误）；stdout data 同步循环让位（setImmediate/pause，实测洪泛 213.1s 饿死 timers）；:384-387 畸形帧静默 continue 改计数并在 run 结束 emit 诊断事件；另给 child.stdin 挂 error 监听防 EPIPE（runner.ts:449-456 竞态窗） | goal-poc1-ndjson / goal-poc3-oversize-frames 的 skip（:136/:149）转正作 DoD |
| D5 | 停靠语义与快路径 | 约 0.5 天 | C2 parked 终态事件是 dwf_failed{data.status:"parked"}（按事件类型统计会误计失败，需引入 dwf_parked 或消费方甄别约定+治理测试）；B3 escalate-only 停靠走 10s 兜底而非 750ms（[推断] realmIdle()=pending.size===0&&openHoles>0 的定义不含 escalation，扩展属行为变更需设计）；C4 fill 拒绝退出码复核（GAP-05 自测将顺带闭合大半，剩余 answer 命令同型复核） | 事件统计不误计 parked；escalate 快路径 |
| D6 | probe 脱敏收敛（integration gap4） | 约 0.5 天 | workflow_probe 同时下发未脱敏 env 与 sanitizedEnv 两份快照且 IGCCSVC_DB 明文——收敛为仅返回脱敏快照属 API 形状变更（MCP/下游需评审）；IGCCSVC_DB 纳入 src/prober/sanitizer.ts SENSITIVE_KEY_REGEX | probe 仅返回脱敏快照 |
| D7 | child-main stdin 'close' 父死退出（inv4①，与 GAP-01 同文件故顺延） | **10 分钟级**；建议 GAP-01 合入后立即接力 | child-main.ts:250 readline 无 close 处理器，父进程被强杀时子进程在本机靠宿主 Job 耦合兜底、引擎自身无保证 | driver.mjs 直驱 child-main 验证 stdin EOF→退出；在无 Job 耦合的干净宿主复跑不变量4 |
| D8 | 官方对齐 backlog（逆向四区，逐项立项、多天工程） | 多天；逐项立项 | ① per-actor 具名缓存（名字+persona 匹配、对 site 重编号免疫）替代按 siteId 键控的池——amend 命中率天花板，前置依赖持久 actor 会话（静止探针/消息边界/转录种子整层同此前置）；② 限流四层纪律（governor 桶键升 providerId/modelId、epoch 与 lastGood/lastBad 双档、AbortError 改 ended 语义、rpc 重试不持 AIMD 槽、retune 三处一致+席位门）；③ channel/future 纯 cell 原语、model()/ModelRef 路由、artifact preset 门类；④ caps 四处小修：engine.ts:658 git.log>100 改结构化拒绝（禁静默夹）、artifact id 补 `[A-Za-z0-9_.-]{1,64}` 校验、grep maxFiles:5000 静默截断改显式、20MB/256KB/1MB 的 KB/KiB 常量对齐 | 按区逐项 Issue + 对照测试 |
| D9 | A4 块注释内 glob 误终止（authoring 体验） | 低危；与 GAP-02 同文件故顺延 | 注释中 `src/**/*.ts` 的 `*/` 提前终止 /* */，check 诊断指向注释后伪代码（11 条错位）；修复在 compile.ts 注释扫描/诊断映射层 | 注释内 glob 诊断不再错位 |
| D10 | 全量构建门禁回归 | 收口层独占窗口 | `node node_modules/typescript/bin/tsc -p <wt>/tsconfig.json` 与 `npm.cmd run test:unit/test:pbt` 全量回归——本阶段各 GAP 仅跑最小相关集；且 worktree 内有并发代理未跟踪产物（.scratch-inv6/、examples/ 等），跑 tsc 会写 dist/ 有冲突风险——应由主代理在独占窗口执行（[推断]，沿 digest integration gap5） | 全量门禁绿 + 真实指纹入 PR（P0 红线 4） |

### 6.2 建议执行序（按依赖与成本）

1. **D7**（10 分钟级，不变量4 主缺口；GAP-01 同文件已在工作树就绪，可立即接力）；
2. **D3**（15 分钟，同文件顺延 GAP-02；两断言进 dwf-compiler.test.ts）;
3. **D1**（最高优先·安全，0.5-1 天 + 全量门禁，需独立 Issue）；
4. **D4**（0.5 天，协议投毒防线 + 不变量3②）；
5. **D2**（0.5-1 天，GAP-06 合入后接力）；
6. **D5、D6**（各 0.5 天）；
7. **D8**（多天，逆向四区逐项立项，执行时顺带落 R1）；
8. **D9**（低危，随 GAP-02/D3 同文件顺延）；
9. **D10**（收口层独占窗口，本次 PR 合入前必做）。

### 6.3 矩阵梳理中发现的未入册残余（R 项）

- **R1 逆向底稿修正（文档级，随 D8① 执行时一并处理）**：切片1 实测推翻底稿三处（2.3-⑤ settle-order 应为「首生结算次序」而非「按启动顺序重放」；2.3-⑦ 血缘指针在 dwf_run 列/stopped 结算同一笔，非 run-launched 事件；2.4-2 三元组共用需限定为「官方位置优先+哈希防御，池化仅在 world 导入队列」），并需深化两处（ImportedInFlightAsk in-flight ask 接续、import-closure 关门）。另：若保留内容池方案，应修正 engine.ts 头注释滞后的「mismatch fails loudly」表述或补显式纯度契约。
- **R2 不变量6③ run 入参脱敏**：dwf_runs.args_json 与 `.workflow/runs/<runId>/args.json` 无脱敏（resume 需要入参）；建议至少对命中 SENSITIVE_KEY_REGEX 的入参键掩码。未入 D 表，建议并入 D6 或独立小项。
- **R3 不变量6② 值形收紧（可选）**：非敏感键名下 `bare=sk-decoy-123` 不掩码系 redact.ts:20-25 明文权衡（已知边界非缺陷）；如需收紧对 sk-/ghp_ 等前缀形值加 shape 规则（注意 GAP-03 的 {20,} 下限：短示例串刻意保留）。
- **R4 逆向/PoC 未入册残余**：① 切片2-④ cell 停滞检测（official 每条 response 后 setImmediate 查 pending，无在飞即 ScriptStalled/ChannelDeadlock error-complete；我方零宿主调用的死等脚本挂满 600s 整跑超时）；② 切片2-⑤ host 错误线形态只带 name 丢 code/violations/finalText（畸形帧计数部分已入 D4，完整对齐官方「停 run 并点名该行」随 D4/D8 决定）；③ 切片3 退避抖动两点（429 向后抖动 ≤min(0.2×retryAfter,5s)、指数退避 0.5-1.0 乘性抖动）；④ **PoC4 microtask 伪造 done 帧**（`goal-poc4-microtask-escape.test.ts:23` describe.skip BREACHED 记录，未入 D1..D10，建议与 D1/D4 一并立项：done 帧鉴权/序号防伪造）。以上建议并入 D8 对应区或随 D1/D4 顺带立项。

---

## 七 收口清单（给收口层 / PR）

1. **提交范围**（GAP-01..06 changedFiles 并集，全部已在工作树、本节点 git status 已核实为 modified）：
   `src/dwf/child-main.ts`、`src/dwf/compile.ts`、`src/dwf/engine.ts`、`src/dwf/redact.ts`、`src/dwf/runner.ts`、`src/cli/commands/run-script.ts`、`src/cli/commands/inspect.ts`、`src/cli/index.ts`、`tests/unit/dwf/dwf-compiler.test.ts`、`tests/unit/dwf/redact.test.ts`、`tests/adversarial/goal-poc3-files-grep.test.ts`；另注意：`tests/adversarial/goal-poc1-constructor-escape.test.ts`（skip 已转正、实测 3/3 pass）与全部 `tests/adversarial/fixtures/*`、`tests/adversarial/*.test.ts` 目前为**未跟踪**状态，是否纳入本次提交由收口层决定。
2. **PR 留痕（刻意未改/扩权说明）**：
   - GAP-01：runner.ts runInfo push 系完成 bea9a05 承诺的父进程半边，经主代理裁决扩权（2026-11-01 子代理升级请示，裁决选 A）；同步顶层读 run.id 仍为空串为 push 式设计固有属性（首次 host round-trip 后正确）；
   - GAP-03：② journalled 边界先掩码再持久化+返回（超出计划 resultJson 单行），否则 DoD 转正测试必红——偏差与「两者不可兼得」关系需在 PR 写明；
   - GAP-02：上游建议②（inv1-v5.db run 级 compile_failed 复跑）未单独执行，以 5 变体 CLI check exit 1 作等效静态验证。
3. **测试转正状态与待办**（本节点 grep 扫描 + 实测，§〇 #10/#11）：
   - 已转正且绿：`goal-poc1-constructor-escape.test.ts`（3 pass / 0 fail 实测）、`goal-poc3-files-grep.test.ts`（GAP-03 会话内 2 pass / 0 skipped）；
   - 仍 skip、转正有明确归属：`goal-poc1-ndjson-protocol.test.ts:136`、`goal-poc3-oversize-frames.test.ts:149`（→ D4 DoD）；`goal-poc2-crossrealm-function.test.ts:56`（→ D1 DoD）；
   - 仍 skip、可提前转正：`goal-poc2-control-char-injection.test.ts:160`（log/report round-trip 载荷断言——GAP-01 修复已就绪，其探针 ASSERT1/2/3 即该断言的手工证据，建议收口层转正验证）；
   - 仍 skip、未入册：`goal-poc4-microtask-escape.test.ts:23`（→ R4④）。
4. **中间产物清理（§1.5，随本 issue 收尾/PR 合入执行）**：`.scratch-gap01/`（gap01-logreport.facade.ts）、`.workflow/triage-fix-1.db`、`scratch-gap06/`、`.scratch-inv6/`、`.workflow/inv6.db`、`.workflow/inv6b.db`、`scratch-inv5/`、`scratch-pentest/`（ndjson 复现材料，如需留证先归档再删）、`.workflow/ndjson-inv.db`、`.workflow/inv1.db`、`.workflow/inv1-v5.db`；已删：scratch-gap04/、triage-fix-4.db、scratch-gap05/、.scratch-gap03/ 与 GAP-03 自建 journal，以及 `scratch-audit-41/`（PENETRATION 文档任务用后即删）与 `.scratch-b41doc/`（BENCHMARK 文档任务用后即删）——二者经 2026-11-01 修订轮 `git status --porcelain` 复核均无残留。其余 untracked（`examples/`、`demos/repo-migration-engine/fixtures/legacy-aws-sdk-app/package-lock.json` 等）属其他并行任务，不在本矩阵清理范围。
5. **全量门禁（D10）**：本阶段各 GAP 仅跑最小相关集；`tsc -p` 全量、`npm.cmd run test:unit`、`test:pbt`、e2e runner、governance 由收口层在独占窗口执行，PR 附真实构建与测试输出指纹（P0 红线 4，严禁占位符）。
6. **fixtures**：GAP-03 / GAP-06 会话内已 `git restore tests/unit/fixtures/` 还原；本矩阵任务为纯文档写入，未运行引擎写库（除 #10 对抗测试读取既有 fixture、写 `.workflow/escape-poc1-test.db` 测试自身 db）。
7. **inv1 变体入库建议（2026-11-01 修订新增）**：不变量1 的 5 个变体脚本仅存于仓库外 `<local-machine>/.zcode/workflow-drafts/goal-mission/inv1/`（存在性与文件名已核实），第三方无法直接复跑 §2.1 主证据链（5 变体 CLI check 全 exit 1）；建议收口层将其入库为 `tests/adversarial/fixtures/inv1-v1..v5.ts`（或在对抗测试内联），入库前该条证据仅限本机复核。

---

## 附：证据文件索引（相对路径以 worktree 为根）

| 类别 | 路径 | 本节点核实 |
|---|---|---|
| 不变量1 变体脚本（仓库外，按任务指令存放） | `<local-machine>/.zcode/workflow-drafts/goal-mission/inv1/`（v1-process-exit / v2-eval / v3-date-now / v4-math-random / v5-constructor-chain） | 存在性与文件名已核实（2026-11-01 修订轮）；**仓库外，第三方不可直接复跑**——入库建议见 §七 #7 |
| 跨 realm 逃逸探针 | `xrealm2.facade.ts`——临时探针（§3.2/§四 引用），未入库、审计后已删（2026-11-01 修订轮 `find . -maxdepth 2 -name "xrealm2*"` 零命中）；复现：将 §3.2 所引单行脚本存为 facade 文件后 `node bin/workflow.js run-script xrealm2.facade.ts --args '{"a":1}'` | 已删（本行 2026-11-01 修订补记） |
| 不变量1 journal | `.workflow/inv1.db`、`.workflow/inv1-v5.db` | ✅ 存在 |
| 不变量2/5 分诊 journal | `.workflow/inv2-schemaheal.db`、`.workflow/inv5-baseline.db`、`.workflow/inv5-replay.db`、`.workflow/inv5-view-resume.html` | ✅ 存在 |
| 不变量3 NDJSON 复现材料 | `scratch-pentest/ndjson/{ndjson-probe.facade.ts,verify.mjs,driver.mjs,gen-payload.mjs,payload-100kb.txt}`；`.workflow/ndjson-inv.db` | 已随原逆向 worktree 清理、第三方不可达；结论以本文与测试套件为准（2026-11-20 清洁室修订） |
| 不变量6 副产物 | `.scratch-inv6/`、`.workflow/inv6.db`、`.workflow/inv6b.db` | ✅ 存在 |
| GAP-01 探针/journal | `.scratch-gap01/gap01-logreport.facade.ts`、`.workflow/triage-fix-1.db` | ✅ 存在 |
| GAP-03 journal | 自建 triage-fix-3*.db 已删除（证据以本文与测试文件为准） | — |
| GAP-05/06 自测 | `scratch-gap06/`（保留供核查）；scratch-gap05 已删 | ✅ 存在 |
| 对抗测试与 fixtures | `tests/adversarial/*.test.ts`、`tests/adversarial/fixtures/*`（均未跟踪） | ✅ 存在 |
| 逆向对照材料 | 探针 workflow-driver-quiescence.ts、导入构建 dynamic-workflow-import.ts（官方侧逐函数读码，见 §3.1） | 上游实测，未核实 |
