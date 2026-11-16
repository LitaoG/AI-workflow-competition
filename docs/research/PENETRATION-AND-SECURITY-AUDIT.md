# 渗透与安全审计报告（TEST-GOAL 4.1）

> **四大攻防用例：沙箱逃逸 · NDJSON 协议投毒 · DoS 资源炸弹 · 凭据窃取**
> 每个用例给出：攻击向量 → 实测记录 → 官方对比 → 防线状态 → PoC 代码位置；
> 文末给出安全边界总结论与加固清单。
> **文档分工（2026-11-01 修订确立）**：本文只做安全判定与攻击面实测；所有缺口/修复的**唯一状态登记处**是同目录 `WORKFLOW-GAP-MATRIX.md`（D#/R#/GAP-# 条目号）——本文 §7 加固清单每行注明对应 GAP 条目，状态冲突时以该矩阵为准。
> **行号基准**：本文行号基于 worktree HEAD `30eb54f`；「审计时 vs 撰写时」行号按 §0.3 约定标注，冲突时以符号名为准。
> **修订记录（2026-11-01，修订员）**：沙箱逃逸终态与 GAP-MATRIX 统一为 partial（机制根因口径）；补记静态层 isReference 初始化位漏网（GAP-MATRIX D3，修订轮双探针复现）；PoC4 三处状态统一为「已知 BREACHED 缺口＝GAP-MATRIX R4④」；凭据窃取终态标注残余 R2 并补未测面披露；governor 自述转述纠正；AIMD 常量补齐五参；213s/120s 反直觉读数标注机理未查；env 隔离结论降级 [推断]；印刷命令改为实际执行形态；skip 计数统一 `tests N / pass N / fail 0 / skipped K` 格式；§0.3 补用例-章节对照。未改动任何实测数字。

---

## 0. 元信息、方法与时效性

### 0.1 审计对象与环境

| 项 | 值 |
|---|---|
| 被审计系统 | AI-workflow 动态工作流引擎（facade 脚本 编译→降级→VM 沙箱→引擎→journal 全链路） |
| worktree | `<workspace-worktrees>/issue-28-goal-e2e-pentest`（分支 `feat/issue-28-goal-e2e-pentest`） |
| 审计时 HEAD | `30eb54f`（Merge pull request #27 from LitaoG/fix/mcp-serve-lifetime） |
| Node 版本 | v22.23.2（实测） |
| 引擎 CLI | `node bin/workflow.js <命令>`（check / run-script，离线无真实 provider） |
| 主仓约束 | 主仓 `<workspace>` 全程只读未动（审计全程仅读 worktree 与官方研究快照） |
| 官方对照源码 | `<official-zcode-clone>`（apps/zcode-cli/packages/...，只读快照） |

### 0.2 方法学与证据纪律

- 全部攻击用例走**离线 mock provider**，无任何真实模型调用；涉及真实 provider 的行为一律标 `[未知]`。
- 全部结论按 `[已验证]`（本轮或审计时以具体命令复现）/ `[推断]`（给出推断链）/ `[未知]`（写明缺口与掌握者）三档标注；严禁把 mock 输出说成真实模型行为。
- 并发跑引擎各用独立 journal（`--db .workflow/<代号>.db`）；临时 scratch 用完即删。
- 严禁提交必红测试：已知缺口按纪律沉淀为 `describe.skip` 注释档（写明根因与转正条件）。

### 0.3 时效性说明（必读）

**本 worktree 为多代理共享。** 审计执行时（四路攻防子代理实测）HEAD 为 `30eb54f`；文档撰写时（本文"当前状态"复核时点，2026-11-01），worktree 中已由兄弟代理**落地了一批未提交修复**，恰好对应本文四个用例的 gapHint：

| 未提交修复（撰写时已在 worktree src 中，未 commit） | 位置 | 封住的缺口 |
|---|---|---|
| `PROTOTYPE_CHAIN_PROPS` 静态禁令（`constructor`/`__proto__`/`prototype`，点号+方括号双形态，9002） | `src/dwf/compile.ts:38-39`、`compile.ts:169-179` | 用例一全部静态缺口（PoC1/2b/2c/3/3b/3c/4 的构造器链与原型链面） |
| journal 持久化前 `redactValue` 边界（GAP-03） | `src/dwf/engine.ts:967-972`（`value = redactValue(value)` 先于 `saveDwfNode`） | 用例四 `files.read/grep` → journal/CLI/返回值泄露面 |
| `dwf_world_run` 事件 args 脱敏 | `src/dwf/engine.ts:818-822` | 用例四事件通道旁路 |
| `CREDENTIAL_TOKEN_SHAPES` 增补 `sk-` 家族 | `src/dwf/redact.ts:38-39` | 用例四 `sk-proj-…` 长键形状 |
| `__host.log/report` 改 `(siteId, payload)` 双参转发 | `src/dwf/child-main.ts:95-98` | 用例一/二/三共报的 log/report 载荷丢失 G2 回归 |

因此本文采用**两层时点标注**：

- **【审计时】**＝四路攻防子代理在 `30eb54f`（部分未提交修复尚未落地）上的实测记录，命令与输出逐条给出；
- **【当前】**＝本文档撰写时的独立复核（`node node_modules/typescript/bin/tsc -p tsconfig.json` 重建 dist 后逐项复跑），结果见各用例 §x.6 与 §8 证据台账。用例-章节对照：**用例一（沙箱逃逸）→ §2；用例二（协议投毒）→ §3；用例三（DoS 资源炸弹）→ §4；用例四（凭据窃取）→ §5**。

另注：审计时引用的行号对应审计时快照；撰写时部分行号因上述未提交修复而漂移，本文已按当前文件逐一重新核对并标注当前行号（例如 `child-main.ts` 的 `args` 现为 `:109`、`codeGeneration` 现为 `:296-300`；`engine.ts` 的 NUL 哈希模板现为 `:889`）。全文行号标注约定：凡未加「现」字者为审计时（HEAD `30eb54f`）行号；撰写时核对过的以「现 ：NNN」标注；行号仅供定位，冲突时以符号名为准。

---

## 1. 执行摘要

| # | 用例 | 防线状态（审计时） | 主破口 | 当前状态（撰写时复核） |
|---|---|---|---|---|
| 一 | 沙箱逃逸（跨 realm Function / 构造器链 / 原型链污染 / 微任务伪造） | **partial** | `args` 被降级为主机域对象，`.constructor.constructor` 直达宿主 Function → 宿主 process → `process.binding('spawn_sync')` 任意命令执行 | **终态 partial（与 GAP-MATRIX §1.2 统一，口径=机制根因是否消除）**：静态缺口已收口——构造器链/原型链全部被 9002 拒绝（check 矩阵 10/10 ok:false），运行时 `codeGeneration:{strings:false}` 层仍在；但 D1 根因（宿主域对象图注入 realm）未修，静态层另余 isReference 初始化位漏网（GAP-MATRIX D3，修订轮探针复现，10/10 矩阵未覆盖）；微任务伪造（PoC4）主获取路径暂被静态门遮断、纵深防御未修（＝GAP-MATRIX R4④，见 §7 #10） |
| 二 | 协议投毒（NDJSON 帧撕裂/粘包/伪造帧、控制字符注入、超限报文） | **partial** | 无帧长上限（33MB 帧被接受）；持续输出洪泛饿死事件循环使超时上界失效（10s 上界实测 213s）；log/report 载荷丢失致审计通道失明 | **洪泛与帧长缺口仍在**；log/report 载荷丢失已修复（端到端探针验证内容到达）；三处 describe.skip 未转正 |
| 三 | DoS 资源炸弹（深递归类型 / glob 炸弹 / 并发风暴） | **held** | 无主破口——编译期诊断、2000-cap、1000-call 熔断全线守住 | **复核通过**：9/9 回归通过，行为与审计时一致 |
| 四 | 凭据窃取（env 直读 / world.run 侧信道 / files.grep·read 扫 .env / 错误路径） | **partial** | `files.grep`/`files.read` 把工作区 `.env`（含 URI 凭据）原文写进 CLI 结果与 journal | **泄露面已收口（终态 held·残余 R2）**：journal 持久化前 `redactValue` 落地，原 skip 泄露档已转正为真断言并通过（5/5）；已知残余：run 入参 args_json 明文落库未修（GAP-MATRIX §2.6③/R2，本用例未测该向量），未测面见 §5.7 #4 |

**一句话总结论**：双方实现头注释均自认隔离目标是"故障隔离与确定性，非安全边界"；本审计仍以可利用链标准从严实测，找到 1 条完整沙箱逃逸链与 1 条凭据泄露面，并在撰写时点确认二者的已知利用链已被未提交修复遮断——但按「机制根因是否消除」口径（与 GAP-MATRIX 统一），沙箱逃逸终态为 **partial**（D1 根因未修＋静态层 isReference 初始化位漏网 D3），凭据窃取为 **held（残余 R2：run 入参明文落库）**。剩余真实缺口集中在 **NDJSON 通道的资源型缺口**（帧长上限、洪泛活性）、**入站帧 schema 校验**、静态层初始化位漏网（D3）与 run 入参明文落库（R2），见 §7 加固清单。

---

## 2. 用例一：沙箱逃逸（跨 realm Function / 构造器链 / 原型链污染 / 微任务伪造）

### 2.1 攻击向量

**PoC2b/PoC2c — 跨 realm Function 逃逸**：`args`（主机域对象）`.constructor.constructor` → 宿主 Function → 宿主 process → `process.binding('spawn_sync')` 任意命令执行。
（辅助 PoC：PoC1 构造器链、PoC3 原型链污染、PoC3c 协议畸变、PoC4 microtask 伪造 done 帧）

具体在 facade 脚本内：

1. `({}).constructor.constructor("return process")()`——realm 自身 Function；
2. `args.constructor.constructor("return process")()`——lowering 把 facade 常量 `args` 重写为 `__host.args = JSON.parse(argsJson)`（审计时 `src/dwf/child-main.ts:107`，**主机域对象**），其 `.constructor.constructor` 是宿主 Function，VM-context 级 `codeGeneration:{strings:false}`（审计时 `child-main.ts:288-292`）对它无效；`args.__proto__` 直达宿主 `Object.prototype`（原型链污染）；
3. 拿到宿主 process 后 `process.binding('spawn_sync').spawn` 任意执行（无需 mainModule/require/import——ESM 下 mainModule undefined、`import()` 报 no-callback）；
4. `Promise.resolve().then` 微任务在脚本 return（审计点）之后用同一逃逸向子进程 stdout 伪造 `{t:'done'}` 帧，父进程以攻击者值收尾并静默丢弃真实 done 帧（`src/dwf/runner.ts` handleChildFrame settled 早退）。

### 2.2 实测记录【审计时】

全部实测于 worktree `feat/issue-28-goal-e2e-pentest`（node v22.23.2）。

**防线① check 静态（审计时矩阵）**：

- `node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc1-constructor-escape.ts` → **ok:true**（构造器链零诊断——TS 5.9.3 `--strict --lib es2022` 对 Function 类型值的调用无错，scratch 中 tsc exit 0 已复核）；
- `goal-poc2-crossrealm-function.ts`（Date.parse 路由）→ ok:false，**3× code 9002 purity-ban**「Date.parse() is banned」；
- `goal-poc2b/2c/3/3b/3c/4`（args 路由）→ **全部 ok:true（静态缺口）**。

**防线② run-script 运行时（审计时矩阵）**：

| PoC | 结果 | 判定 |
|---|---|---|
| poc1 / poc1b | 「✖ run ... failed: script error: Code generation from strings disallowed for this context」exit 1，0.31-0.37s 干净退出无挂起（子进程被正常收割） | 【防线有效】 |
| poc2b | 「✔ run ... completed」result=`{"hostProcess":"object","mainModule":"mainModule-undefined","exec":"exec-err:TypeError:A dynamic import callback was not specified."}`（**宿主 process 对象到手**） | 【突破】 |
| poc2c | completed，result=`{"spawnSync":"EXIT42:42:FILEWRITE-STATUS:0"}`，且 scratch 目录出现 `PWNED-SPAWNSYNC-ESCAPE` 文件（**工作区外任意命令执行实证**） | 【突破】 |
| poc3 | completed，result=`{"hostProof":"PWNED-PROTOTYPE-POLLUTION"}`（宿主 Object.prototype 被污染并被宿主编译函数读回） | 【突破】 |
| poc3c | 「✖ failed: sandbox child exited before finishing (code 0)」（脚本正常 return 但 done 帧被 toJSON 污染畸变） | 【突破】 |
| poc4 | completed，result=`"MT-FORGED-DONE"`（脚本明明 return "POC4-benign-main"，**微任务伪造 done 帧被采信**） | 【突破】 |
| poc3b（对照组，仅 realm 内污染） | completed result="POC3B-realm-polluted"（realm 内污染被隔离，证明 PoC3 效果确为跨 realm） | 【防线有效】 |

**附带发现（审计时）**：

- lowering 产 `__host.log(siteId,msg)` / `__host.report(siteId,item)`，而 child-main 端 log/report 只收一个参数（审计时 `src/dwf/child-main.ts:95-96`），siteId 被当消息、真实内容丢弃——CLI 日志只见「log: log#1」，**审计通道实际失明**（该缺陷同见于用例二缺口 I、用例三副产缺陷；撰写时已修复，见 §2.6）；
- lowering 对作为 VariableDeclaration 直接子节点的 args 不重写（`src/dwf/lower.ts` isArgsReference），`const x=args;` 运行时报 `args is not defined`（**fail-closed，非漏洞**）。

**回归（审计时）**：`node --experimental-strip-types --test tests/adversarial/goal-poc1-constructor-escape.test.ts tests/adversarial/goal-poc2-crossrealm-function.test.ts tests/adversarial/goal-poc3-proto-pollution.test.ts tests/adversarial/goal-poc4-microtask-escape.test.ts`（上列四文件枚举即实际执行形态；原稿印刷的 brace-glob 缩写 `goal-poc{1,2,3,4}-*.test.ts` 实际会展开为 13 个 test 文件、不可能产出本行计数——2026-11-01 修订轮 `ls tests/adversarial/*.test.ts` 核实共 13 个）→ tests 4 / pass 4 / fail 0 / skipped 4（4 个 describe.skip 缺口档未计入 tests），3.0s；构建门禁 `node node_modules/typescript/bin/tsc -p tsconfig.json` exit 0。

### 2.3 官方对比

官方源码：`<official-zcode-clone>/apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-source.ts`。

1. **跨 realm 收敛契约**（头注释 21-24 行）明确「防原型泄漏/prototype pollution：脚本触及的一切都在 context 内构造，跨界值仅一个 `__send(string)` 外层函数」——args 在 context 内 JSON.parse 构造（`child-source.ts:202-206`，`var __args = Object.freeze(JSON.parse(__argsJson))`），context-native，原型链不掺外层 intrinsics。我方 child-main 把主机域 args 对象直接放进 sandbox，正是 PoC2b/2c/3/3c/4 的破口 → **此轴我方【落后】**。（撰写时抽查官方源码逐行核实，见 §8。）
2. **realm 硬化**：官方 `createContext(sandbox,{name:"workflow-sandbox"})`（`child-source.ts:332`）**无 codeGeneration 限制**，且经 `runInContext` 字符串编译 lowered 体（`child-source.ts:339`，头注释 26-28 自认 eval/Function 可用、仅 `import()` 抛 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`）→ 官方对 PoC1 直接构造器链向量**无运行时屏障**；我方 `child-main.ts:296-300`（当前行号）`codeGeneration:{strings:false,wasm:false}` 实测拦截（EvalError）→ **此轴我方【领先】**。
3. **静态层**：官方 `compiler/compile.ts:117-122` 纯 TS 诊断（`types:[]`，`compile.ts:56-59` 注释「process,fetch,require 等 fail typechecking」），另有 analysis/interpret+taint 语义解释器（**未实测其是否拦构造器链，[未知]**）；我方 `compile.ts:36` + 9002 文本禁令实测拦下 Date.parse 路由——但审计时构造器链/字符串内嵌代码两层都无规则（官方 [推断] 同样放行：同为 lib.es2022+facade d.ts 构型）→ **此轴我方【持平偏领先】**（审计时判定；撰写时该轴已收口为明确领先——该状态变化登记于 §2.4/§2.6，不在正文内联展开）。

**总评**：双方头注释均自认「隔离目标是故障隔离与确定性，非安全边界」；但官方的边界卫生（跨界值最小化）优于我方，我方的 realm 硬化（codeGeneration 禁令）优于官方——各自堵住了对方的一个面，而 **args 主机对象泄漏是我方独有的主破口**。

### 2.4 防线状态

**审计时：partial。** 运行时第二层（codeGeneration）与 realm 内污染隔离有效；静态层对构造器链/原型链全盲、`args` 主机域对象把全部跨 realm 向量放行到运行时（PoC2b/2c/3/3c/4 五连突破）。

**撰写时：整体判 partial（与 GAP-MATRIX §1.2 统一口径）。** 按「已知利用链可否打穿」口径，静态收口后可判 held；但本文与 GAP-MATRIX 统一采用「机制根因是否消除」口径，理由三点：① D1 根因——宿主域对象图注入 realm（context-native 化）尚未改，防线依赖静态层（见 §7 第 1 条）；② 静态层另余 **isReference 初始化位漏网**（GAP-MATRIX D3）：`compile.ts` 的 `isReference` 把 VariableDeclaration 的 initializer 也排除在引用判定外，`const e = eval;`、`const g = globalThis;` 形态逃过 9002（2026-11-01 修订轮双探针复现，见 §2.6 第 6 条）——本轮 10/10 check 矩阵不含此形态，「10/10 全拒」推不出「静态收口」；③ PoC4 状态统一为「已知 BREACHED 缺口，主获取路径暂被静态门遮断，纵深防御未修」，唯一登记条目 GAP-MATRIX R4④。构造器链与原型链（点号+方括号双形态、类型无关）在编译期即 9002 拒绝、运行时层保留作纵深，此部分收口成立。

### 2.5 PoC 代码位置

```text
tests/adversarial/fixtures/goal-poc1-constructor-escape.ts        # ({})  .constructor.constructor 直链
tests/adversarial/fixtures/goal-poc1b-constructor-escape-anycast.ts # any-cast 变体（曾静态不可见）
tests/adversarial/fixtures/goal-poc2-crossrealm-function.ts       # Date.parse 路由（静态可拦样本）
tests/adversarial/fixtures/goal-poc2b-crossrealm-args.ts          # args → 宿主 Function → 宿主 process
tests/adversarial/fixtures/goal-poc2c-spawn-sync.ts               # process.binding('spawn_sync') 任意命令执行
tests/adversarial/fixtures/goal-poc3-proto-pollution.ts           # 跨 realm 原型链污染
tests/adversarial/fixtures/goal-poc3b-proto-pollution-realm-only.ts # 对照组：realm 内污染（被隔离）
tests/adversarial/fixtures/goal-poc3c-proto-pollution-tojson.ts   # toJSON 协议畸变
tests/adversarial/fixtures/goal-poc4-microtask-escape.ts          # 微任务伪造 done 帧
tests/adversarial/goal-poc1-constructor-escape.test.ts            # 回归：编译期拒绝断言（撰写时形态）
tests/adversarial/goal-poc2-crossrealm-function.test.ts           # 回归：Date.parse 9002 + PoC2b 缺口档（skip）
tests/adversarial/goal-poc3-proto-pollution.test.ts               # 回归：静态收口断言
tests/adversarial/goal-poc4-microtask-escape.test.ts              # 回归：缺口档（skip，含转正模板）
```

### 2.6 当前状态复核【撰写时，本文档代理独立实测】

1. **构建门禁**：`node node_modules/typescript/bin/tsc -p tsconfig.json` → **exit 0**。
2. **check 静态矩阵全面翻转**：对 10 个 fixture 复跑 `node bin/workflow.js check -j <fixture>`，全部 **ok:false** 且诊断均为 9002 purity-ban：
   - poc1、poc1b、poc2b、poc2c、poc4 各 1×「"constructor" property access is banned」；poc2 4×9002（Date.parse 路由 + 构造器链）；poc3 2×、poc3b 1×、poc3c 1×「"__proto__" property access is banned」；
   - `goal-cred-snoop-1-env-read.ts` → 2591（TS "Cannot find name 'process'"，types:[] 构型）+ 9002 `"process" is banned`。
   - **审计时的静态缺口（poc1/2b/2c/3/3b/3c/4 全 ok:true）已由 compile.ts PROTOTYPE_CHAIN_PROPS（`src/dwf/compile.ts:38-39,169-179`，未提交）收口。**
3. **run-script 行为**：`node bin/workflow.js run-script tests/adversarial/fixtures/goal-poc2b-crossrealm-args.ts --db .workflow/audit41-poc2b.db` → 「✖ facade script failed compilation — 1 diagnostic(s): …20:16 purity-ban(9002): "constructor" property access is banned…」exit 1；poc4 同形（15:20 处拒绝）exit 1。**逃逸链在编译期即死，不再进入沙箱。**
4. **回归套件（重建 dist 后）**：`node --experimental-strip-types --test tests/adversarial/goal-poc1-constructor-escape.test.ts tests/adversarial/goal-poc2-crossrealm-function.test.ts tests/adversarial/goal-poc3-proto-pollution.test.ts tests/adversarial/goal-poc4-microtask-escape.test.ts` → **tests 7 / pass 7 / fail 0 / skipped 2**（3.7s；2 个 skip 缺口档未计入 tests）。测试已在静态收口后由兄弟代理转正：PoC1/PoC1b/PoC3/PoC3b/PoC3c 断言"编译期拒绝"；仍保留两个 skip 缺口档——PoC2 defense②（args 运行时根因未改，`__host.args` 仍是主机域对象）与 PoC4 defense②（微任务伪造，注释含转正模板）。
5. **log/report 审计通道**：探针 `scratch-audit-41/logprobe.facade.ts`（log("CANARY-LOG-CONTENT") + report({canary}) + return）经 `node bin/workflow.js run-script … --db .workflow/audit41-log.db` → CLI 输出 `log: CANARY-LOG-CONTENT` 与 `report: {"canary":"CANARY-REPORT-ITEM"}`，run completed，result "CANARY-RETURN"。**审计通道失明已修复**（`child-main.ts:95-98` 双参，未提交），但用例二的对应 describe.skip 标签仍写「[缺口未修复]」，属测试债（见 §7 第 8 条）。
6. **静态残余探针（2026-11-01 修订轮，GAP-MATRIX D3）**：`isReference` 初始化位漏网复现——`const e = eval; return typeof e;` 与 `const g = globalThis; return typeof g;` 两个临时探针经 `node bin/workflow.js check -j` 均 **ok:true、零诊断、exit 0**；同命令对照组 `goal-poc2b-crossrealm-args.ts` → ok:false / 9002 / exit 1（门禁在位，唯独初始化位形态漏网）。即：本节第 2 条的「10/10 全拒」矩阵不含初始化位形态，**静态收口不覆盖 `const e = eval` 一族**；修复载体 GAP-MATRIX D3（15 分钟小修），加固清单见 §7 #14。探针临时文件用后即删，未留痕。

### 2.7 缺口与修复建议（原 gapHint）

1. **（主破口·根因）让 `__host.args` 变为 context-native**——对齐官方 `child-source.ts:202-206`：把 `__argsJson` 字符串传入 realm、在 realm 内 `JSON.parse`（可同时封死 PoC2b/2c/3/3c/4 全链路的运行时根因）。静态收口（已落地）挡住了文本面，但这是**按形状拒绝**，真正的跨 realm 收敛仍需此项。
2. **静态补规则**——compile.ts AST 遍历对 `<expr>.constructor.constructor` 链与未知全局上的 Function 型调用出 9002 类诊断（审计时仅文本禁令）。**撰写时已落地**（PROTOTYPE_CHAIN_PROPS，点号+方括号双形态），但"字符串内嵌代码"仍无规则（PoC1b 曾利用 any-cast，现被 property-access 禁令间接覆盖）。
3. **log/report 参数序不一致**（lower.ts:137-141 发射双参、child-main 只收单参）导致审计通道失明——应修齐，这也是逃逸检测的前置可观测性。**撰写时已落地并经探针验证。**
4. runner.ts 对「child 退出码 0 但无 done 帧」的情况应区分协议畸变（PoC3c）与普通崩溃（现统一报 "sandbox child exited before finishing (code 0)"）。
5. 微任务伪造 done（PoC4）：**已知 BREACHED 缺口，未修**——主获取路径（经构造器链取得宿主写权限后向 stdout 伪造 done 帧）暂被静态门遮断（GAP-02），但 skip 注释仍标 BREACHED（`tests/adversarial/goal-poc4-microtask-escape.test.ts:23`）；可在 sendToParent 帧上附加进程内校验标记（如 journal 侧 HMAC）做纵深防御。唯一登记条目：GAP-MATRIX R4④（本文 §7 #10 与之对齐）。
6. 回归测试已按缺口档沉淀：skip 注明根因与转正条件，修复后按注释内模板转为真断言（撰写时 PoC1/3 组已转正，PoC2b/PoC4 档仍保留）。

---

## 3. 用例二：协议投毒（NDJSON 帧撕裂 / 粘包 / 伪造帧 / 控制字符注入 / 超限报文）

### 3.1 攻击向量

1. **恶意/失控沙箱子进程**：经 `RunFacadeOptions.childEntryPath`（`src/dwf/runner.ts:53` 测试钩子）顶替真实子进程，向父端解析器（`src/dwf/runner.ts:373-390`，当前行号已核对）投喂 `\r\n`、`\x00-\x1f` 垃圾行、跨 chunk 撕裂帧、伪造 `{t:"done"}` 终态帧、5MB stderr 洪泛、静默挂起、200MB 输出洪泛；
2. **门面脚本作者**：compile 不禁 console（`compile.ts:36` BANNED_IDENTIFIERS 无 console）但 vm realm 的 console 输出不连 fd1/fd2，无法借道伪造帧；
3. **控制字符载荷**（315KB，含 `\r\n`/`\x00`/`\x1f`/`\u2028`/`\u2029`）经 `--args` 注入 ask 提示与 log 通道打穿 compile→lower→sandbox→engine→journal 全链；
4. **超限报文**：1MB / 33MB（34,603,008 字符）单帧 log 调用与 33MB ask 提示。

### 3.2 实测记录【审计时】

[已验证] 全部实测于 worktree @ `30eb54f`，dist 以 `node node_modules/typescript/bin/tsc -p tsconfig.json` 重建后测试。最终门禁：

```text
node --experimental-strip-types --test tests/adversarial/goal-poc1-ndjson-protocol.test.ts
     tests/adversarial/goal-poc2-control-char-injection.test.ts
     tests/adversarial/goal-poc3-oversize-frames.test.ts
→ tests 12 / pass 12 / fail 0 / skipped 3 / duration 17.4s
（3 个 describe.skip 缺口档未计入 tests，按纪律记录缺口，未提交必红测试）
```

**防线成立项（审计时逐项实测）**：

- **A) 垃圾行/NUL/断裂 JSON/错误形态行被静默丢弃**（`runner.ts:385-387` catch→continue），合法帧逐字节到达；
- **B) 跨 3 chunk 撕裂帧完整重组**（'torn-frame-reassembled-intact' 精确收到），raw NUL 楔入与裸控制字节载荷（非法 JSON）整行拒绝不崩溃；
- **C) 静默子进程** runTimeoutMs=12000 → status=failed，error="run exceeded the whole-run timeout (12000ms)"，wall=15345ms≈上界（可捕获错误非挂死）；
- **D) 315KB 控制字符载荷经 ask 通道 journal inputHash 逐字节一致**（sha256(`ask\0ask#N\0PAYLOAD`) EXACT=true；`engine.ts` 模板内是**字面 NUL 字节**——初读像空格，用 node 按码点验证后纠正；撰写时复核：`engine.ts:889` 模板 idx 58/68 两处 charCode 0）；
- **E) 5MB stderr 洪泛**被 `runner.ts:394-400` 的 4000 字符尾部截断吸收，run 完成；
- **F) vm realm console 是黑洞**：伪造 `{"t":"done"}` 经 console.log 送达不了 stdout（child-main 实测 stdout 仅 1 帧且 stderr 空）。

**防线缺失项（审计时逐项实测）**：

- **G) 无帧长上限**：1MB 帧被接受（488ms）、33MB=34,603,008 字符帧被接受（4.6s）、33MB ask 提示被接受——无帧长上限、无命名拒绝；
- **H) 持续输出洪泛打破超时上界**：runTimeoutMs=10_000 时 flood 场景 runFacadeScript 返回耗时 **213.1s**（有界 200MB）与 **120.4s**（无界），3s 间隔心跳全程缺失→持续可读管道的 data 事件饿死 libuv timers 阶段，killTimer（`runner.ts:354-357`）无法到点（注：有界 200MB 反而比无界慢 93s 的机理未查 `[未知]`——或有界生成器的节流/背压节奏所致，本轮未验证；两读数共同支撑的结论仅是「远超 10s 上界」）；
- **I) [G2 级回归] log/report 载荷丢失**：`lower.ts:138-141`（自 bea9a05 'P3 hygiene batch' 起）发射 `__host.log(siteId, message)`/`__host.report(siteId, item)`，而 `child-main.ts:95-96` 签名仍为 (message)/(item) 只转发第一参——实测帧抓取 `__host.log("log#1","hello world")` 上线帧为 `{"op":"log","payload":["log#1"]}`：用户 log 载荷、report 条目被静默替换为 site 标签，dwf_log 事件 message="log#N"，且 report() 的 ReportCapExceeded 1MB/条 上限（`engine.ts:452-456`）端到端不可达（引擎只查得到 10 字符标签）；
- **J) 伪造 `{t:"done"}` 被接受为终态**（实测 value=`{"forged":"FORGED_DONE"}`）——信任边界，与官方 fault-isolation 立场同构，settled 门（`runner.ts:406`）正确丢弃其后所有帧。

主仓只读未动：git status 与会话起始快照完全一致。

### 3.3 官方对比

官方源码 `<official-zcode-clone>` 防线（path:line，撰写时已抽查 core/transport/telemetry 等承重点）：

1. **帧长/消息硬上限+先计量后解析**：`packages/shared/src/zcode-protocol-v4/core.ts:65`（`maxFrameBytes: 1024*1024` 物理帧 1MB）、`packages/shared/src/web-remote-control-rpc-transport.ts:10-16`（`maxMessageBytes: 16MB`、`maxFragments: 64`、`assemblyTimeoutMs: 30s`）、`web-remote-control-rpc-transport.ts:229-235`（`parseWebRemoteControlRpcRelayEnvelopeJson` 在 JSON.parse **之前**按 utf8 字节数硬闸拒绝 `remote.rpcFrame.envelopeTooLarge` terminal fault）、`:50-58`（isCanonicalBase64 先字符串长度硬闸再 decode，防分配放大）、`:627-635`（messageTooLarge/fragmentLimitExceeded/envelopeTooLarge 命名拒绝）；
2. **schema 校验**：`packages/server/src/entry-stdio.ts:122-128`（hello-ack 经 zod safeParse，格式错误显式拒绝）；
3. **超时上界**：`entry-stdio.ts:108-110`（handshake 10s timeout → 可捕获 Error）；
4. **噪声容忍**：`packages/server/src/source-server/sourceServerTransportRuntime.ts:23-39`（readLastJsonLine 跳过非 JSON 噪声行，注释明言 SSH 堡垒机 stderr 混流场景）、`:104`（行尾 `\r` 剥离）；
5. **分片组装超时**：`web-remote-control-rpc-transport.ts:595-600`（expire() 30s → terminal fault）。

**逐项对比结论**：

| 维度 | 结论 |
|---|---|
| 帧边界/控制字符/撕裂粘包容忍 | **持平**（双方同为 JSON 行协议+噪声行跳过；我方 315KB 控制字符载荷字节级 round-trip 验证通过） |
| 静默对端超时上界 | **持平**（我方 runTimeoutMs killTimer 产生可捕获错误，官方 10s handshake timeout） |
| 帧长上限与超限干净拒绝 | **落后**（官方 1MB 物理帧+16MB 消息+parse 前字节硬闸+命名 fault；我方无任何上限，33MB 帧被直接接受） |
| 持续洪泛下的活性 | **落后**（官方以 parse 前硬闸+组装超时约束资源；我方 stdoutBuffer 无字节预算且同步行循环饿死 killTimer，10s 上界实测 213s） |
| 协议伪造 | **持平偏落后**（双方均信任对端进程——我方 child-main.ts:5-6 明示 'NOT a security boundary'；但官方入站帧逐帧 zod schema 校验，我方 handleChildFrame 只按 t 字段分支、无 schema 校验，结构畸形帧靠运行时抛错兜底） |
| 我方领先点 | journal inputHash 模板内字面 NUL 分隔符（`engine.ts:889`，天然防提示含分隔符的哈希歧义碰撞）、settled 门丢弃终态后帧（`runner.ts:406`）、world 输出 16MB/512KB 'rejects, never truncates' 上限（`engine.ts:42-43`）与 report 三重上限（1MB/条、65536 条、1GiB，`engine.ts:452-466`）的命名拒绝体系（审计时 report 端到端被缺口 I 中性化；缺口 I 修复状态见 §3.6——状态变化登记于该节，此处只记审计时事实） |

### 3.4 防线状态

**partial**（审计时；撰写时洪泛 H 与帧长 G 两缺口仍未修，I 已修复——见 §3.6）。

### 3.5 PoC 代码位置

```text
tests/adversarial/fixtures/goal-poc1-frame-poison-child.mjs   # 恶意子进程（childEntryPath 顶替），毒化字节流发射器
tests/adversarial/goal-poc1-ndjson-protocol.test.ts           # 帧撕裂/粘包/垃圾行/伪造帧/静默超时（+洪泛缺口 skip 档）
tests/adversarial/goal-poc2-control-char-injection.test.ts    # 315KB 控制字符全链 round-trip（+log/report 缺口 skip 档）
tests/adversarial/goal-poc3-oversize-frames.test.ts           # 1MB/33MB 超限帧（+帧长上限缺口 skip 档）
```

### 3.6 当前状态复核【撰写时，本文档代理独立实测】

1. **回归套件**：`node --experimental-strip-types --test`（同上三文件，重建 dist 后）→ **tests 12 / pass 12 / fail 0 / 17.0s**。三处缺口档仍为 `describe.skip`，标签分别为：
   - 「已知缺口: 持续输出洪泛打破超时上界 [缺口未修复]」（真实缺口：`runner.ts:373-390` 同步行循环无字节预算，killTimer 饿死——源码复核未变）；
   - 「已知缺口: log()/report() 通道载荷丢失回归 [缺口未修复]」（**标签已过时**：`child-main.ts:95-98` 双参修复已落地未提交，本文探针实测 `log: CANARY-LOG-CONTENT` 端到端到达，见 §2.6 第 5 条；skip 未按其注释内转正条件改写）；
   - 「已知缺口: NDJSON 通道无帧长上限，超限无"干净拒绝" [缺口未修复]」（真实缺口：1MB/33MB 帧被接受，无命名拒绝）。
2. **源码复核**：`runner.ts:373-390` stdout 解析循环与审计时逐字一致（无预算上限）；`runner.ts:394-400` stderr 4000 字符截断+redactText 累积；`runner.ts:340-352` finish/settled+SIGKILL 收割；`runner.ts:402-406` settled 早退门。未提交的 runner.ts 修改（runInfo push、parked-only guard）与协议投毒面无关。

### 3.7 缺口与修复建议（原 gapHint）

三个可修缺口（均已写进对应 describe.skip 注释，含修复方向）：

1. **【帧长上限】**`runner.ts:373-390` 行拆分循环加单行/总量字节预算（对齐官方 1MB 物理帧/16MB 消息），超限 killTree+命名错误（如 `ChildFrameLimitExceeded`），并在 ask/log 入口加同款上限——修复后把 goal-poc3 的 skip 改为真实断言；
2. **【洪泛活性】**stdout data 处理同步循环饿死 timers：行间 `setImmediate` 让位或流 `pause()`/字节预算+超限杀树——修复后把 goal-poc1 的 flood skip（实测 213.1s vs 10s 上界）改为真实断言；
3. **【log/report 载荷丢失回归，G2 级】**bea9a05 起 lower.ts 发射双参而 child-main 只收单参：改 child-main 签名转发（或改 lower 回单参），同步验证 report 的 ReportCapExceeded 端到端可达——**撰写时 child-main 侧已落地，skip 转正待做**（见 §7 第 8 条）。

另有低危：入站帧无 zod schema 校验（官方逐帧 safeParse）。

> 注意：本 worktree 为多代理共享（期间有兄弟代理重建过 dist、留下 scratch-inv5/6 等），测试依赖 dist/src 与 src 同步，合入前建议按 AGENTS.md §四 以 `npm.cmd run build` 重建后再跑一遍三个 goal-poc*.test.ts（本文档撰写时已以 tsc 重建并复跑，见 §3.6）。

---

## 4. 用例三：DoS 资源炸弹（深递归类型 / glob 炸弹 / 并发风暴）

### 4.1 攻击向量

1. 对 facade 编译器喂 **500 层嵌套 interface 链**（A499→…→A0）与真自引用类型，试图耗尽 check 编译期或烧穿 schema 合成递归栈；
2. 在 run cwd 造 **3000 个文件**后 facade `files.glob('*.txt')` 冲击 2000-cap；
3. **64 个 mock agent 并发 ask** + 64×20=1280 次 ask 循环冲击调度（seat gate/AIMD）与 1000-call 熔断。

全部走离线 mock provider，无真实模型调用。

### 4.2 实测记录【审计时】

[已验证] 全部实测于 worktree：

- **PoC①（cwd=worktree，`node bin/workflow.js check tests/adversarial/fixtures/goal-poc1-deep-type.ts`）**：exit 1、实测墙钟 **1188ms**（120s 看门狗未触发），单条诊断 `508:18 schema-synth(9005): ask<T> type nests deeper than 8 levels`——形态=**编译期诊断**（工具层可捕获，run 不启动），不挂死；超时上界：实测 ~1.2s，回归测试断言 60s 上界（余量说明 `[推断]`：60s ≈ 本机实测 ~1.2s 的 50×，按 CI 慢机余量取档；测试原始设计意图未查证 `[未知]`）。真循环变体 `goal-poc1-recursive-cycle.ts` → `16:3 schema-synth(9015): recursive type at site ask#3: Chain`（1177ms），精确点名站点与类型。
- **PoC②（scratch 造 3000 文件，run-script --db 独立 journal）**：未捕获 → `✖ run dwfrun-… failed in 0.40s: script error: files.glob matched more than 2000 files — narrow the pattern`（**结构性 fail run**）；try/catch 捕获 → `✔ run … completed in 0.40s`（Promise reject 可捕获、run 存活）；边界 2000 文件 → 完成且 matched=2000 不拒（cap+1 判据）。
- **PoC③（-c 4）**：64 agent ×1 ask → `✔ completed in 0.38s`、`asks: 64`、journal dwf_nodes `kind=ask,status=completed,n=64`；64×20=1280 捕获 → `asks: 1000` **恰好截停**、capName=WorkflowAgentCapError、run 存活（0.97s）；未捕获 → 结构性 fail（0.74s）。
- **副产缺陷（审计时）**：child realm 丢弃 log/report 载荷——从 `.workflow/runs/<id>/script.js` 实读降级产物为 `__host.log("log#4", 'reply: ' + r)`（双参），而 child-main.ts:95-96 的 realm helper 只收一参，站点 id 字符串被当 payload 转发（CLI 只显示 `log: log#4`、report item 变成 'report#N'、节点 siteId='undefined'）；实测 `log('CANARY-LOG-CONTENT')` 输出 `log: log#2` 无内容，而脚本 return 值完好（`result: {"marker":"CANARY-RETURN-VALUE"}`）——故回归测试一律以 run 返回值断言。**（撰写时该缺陷已修复，探针见 §2.6。）**
- **回归（审计时）**：3 文件 tests 9 / pass 9 / fail 0 / skipped 0、单文件最久 9.9s（均 <60s）：`node --test --experimental-strip-types tests/adversarial/goal-pocN-*.test.ts`。
- **构建门禁（审计时）**：`node node_modules/typescript/bin/tsc -p <worktree>/tsconfig.json` exit 0；主仓 git status 与任务前快照一致（未动）；scratch dos/ 目录（3000+2000 炸弹文件、临时脚本）已整目录删除。
- **[推断]** AIMD 熔断（multiplicative decrease/Retry-After）未被实测触发：`governor.ts:4` 自述 mock 无信号永不触发，本轮也未注入故障 provider。**[未知]** 真实 provider 下的调度/AIMD 行为。

### 4.3 官方对比

**① ask<T> 深递归/递归类型**

- 我方：`src/dwf/schema-synth.ts:23-25`（MAX_DEPTH=8/MAX_PROPS=64/MAX_UNION=24）、`:28`（RECURSION_CODE 9015）、`:56`+`:132`（路径域 seen-set 判环）、`:70`（超深→9005 诊断）。
- 官方：`apps/zcode-cli/packages/dynamic-workflow/src/schema/emit.ts:96-103` 与 `:134-144` 用 `$defs/$ref` 支持递归类型（合成栈 inProgress→requested→提升 def），synthesize.ts 全文 170 行**无任何深度上限**，union 上限 100（`src/schema/types.ts:90`，emit.ts:168-172 强制）。
- 结论：**深链资源炸弹我方领先**（官方无深度上限，500 层非循环具名类型会被内联成 500 层 JSON Schema 直接发给模型；我方 8 层即 9005 拒绝）；**递归类型表达力官方领先**（$ref 合法，我方一律 9015 拒绝）；双方编译期均终止不 hang（我方实测 ~1.2s）。

**② files.glob cap**

- 我方：`src/dwf/engine.ts:595-599`（globFiles maxFiles:2000 + files.length>2000 即 throw）+ `src/dwf/glob.ts:46,61`（walk 超采 1 条即中止，等效官方 cap+1 探测）。
- 官方：`apps/zcode-cli/packages/bootstrap/src/app/workflow-world-read.ts:112-123` worldGlob（`:117` maxResults: cap+1；`:119-120` 超限或 truncated 即 throw）、cap 常量 `apps/zcode-cli/packages/dynamic-workflow/src/facade/world-read-caps.ts:28`（`globMaxFiles: 2000`）、结构化拒绝（WorldReadCapExceeded，附「拒绝不截断」契约注释）。
- 结论：**持平**——同数字 2000、同 cap+1 判据、同可捕获 reject 形态（未捕获均结构性 fail）；官方契约表述更明确。

**③ 并发风暴**

- 我方：`src/dwf/engine.ts:36`（默认 min(16,max(2,cores-2))）、`:418-431`（withAskSeat FIFO 信号量）、`:124`+`:286-294`（AGENT_CALL_CAP=1000 → WorkflowAgentCapError）、`src/dwf/governor.ts:49-52`（AIMD 五参 8/4/0.75/5min/floor 1——撰写时核对 governor.ts:14-23,48-52,97 默认值 maxPerProvider 8 / increaseAfter 4 / decreaseFactor 0.75 / idleReset 5min、floor 1（:97 `Math.max(1, …)`），成立；官方侧起始 cap 未载 `[未知]`）。
- 官方：`apps/zcode-cli/packages/dynamic-workflow/src/engine/concurrency.ts:25,33,35,37`（同参 AIMD：0.75 减速、+1/4 成功、floor 1、300s 空闲重置——撰写时逐行核实）、`src/engine/types.ts:134-136` Caps 仅剩 maxConcurrency、`:126-128` 注释明言「token 预算与节点上限已整体移除……取消才是控制面」、facade/dts.ts 已无 budget 声明。
- 结论：**调度层持平**（我方 `governor.ts:2-6` 自述恰为**补齐三层**——"completing the three-layer concurrency model (ask seat gate → run seat gate → process governor in ZCode)"，含进程级治理器，与官方三层一一对应；但官方围绕 AIMD 公式的四层纪律我方全缺，见 GAP-MATRIX §3.3/D8②。首稿括号把该自述误转述为「只补两层」，与源码注释相反，修订更正）；**熔断层我方领先**——我方保留 1000-call 硬熔断（`engine.ts:124,286-294`）+ token 预算硬顶（`engine.ts` budgetTotal/预算执行器；Issue #73 后预算改为 run 级只读注入，已无 `setBudgetTotal` setter）（实测 1280 恰截停于 1000 且脚本可捕获），官方已整体移除该防线，风暴无硬停（官方哲学：资源控制靠用户取消）。

### 4.4 防线状态

**held**（审计时即全线守住；撰写时复核 9/9 依旧通过）。

### 4.5 PoC 代码位置

```text
tests/adversarial/fixtures/goal-poc1-deep-type.ts          # 500 层嵌套 interface 链
tests/adversarial/fixtures/goal-poc1-recursive-cycle.ts    # 真自引用类型（9015 环诊断）
tests/adversarial/fixtures/goal-poc2-glob-uncaught.ts      # 3000 文件 glob，未捕获
tests/adversarial/fixtures/goal-poc2-glob-caught.ts        # 3000 文件 glob，try/catch 捕获
tests/adversarial/fixtures/goal-poc3-agent-storm.ts        # 64 mock agent 并发
tests/adversarial/fixtures/goal-poc3-cap-caught.ts         # 1280 ask 捕获（1000 熔断截停）
tests/adversarial/fixtures/goal-poc3-cap-uncaught.ts       # 1280 ask 未捕获（结构性 fail）
tests/adversarial/goal-poc1-deep-type.test.ts              # 回归
tests/adversarial/goal-poc2-glob-bomb.test.ts              # 回归
tests/adversarial/goal-poc3-agent-storm.test.ts            # 回归
```

### 4.6 当前状态复核【撰写时，本文档代理独立实测】

- 回归套件：`node --test --experimental-strip-types tests/adversarial/goal-poc1-deep-type.test.ts tests/adversarial/goal-poc2-glob-bomb.test.ts tests/adversarial/goal-poc3-agent-storm.test.ts` → **tests 9 / pass 9 / fail 0 / skipped 0**（11.2s）。与审计时一致。
- 源码复核：`schema-synth.ts:23-28`（8/64/24 上限与 9015）、`engine.ts:597-598`（2000-cap throw）、`engine.ts:36-44`（WORLD_OUTPUT_CAP 16MiB / GIT_DIFF_CAP 512KB 等 'rejects, never truncates' 族）、`governor.ts:1-6,49-52`（AIMD 默认参数）均在位。

### 4.7 缺口与修复建议（原 gapHint）

1. **副产缺陷修复**：lower.ts 给 log/report 降级时前置 siteId，但 child-main 的 realm helper 只收一参并把它当 payload 转发，导致 log 内容/report item 全丢、report 节点 siteId 变 'undefined'——修法二选一（realm helper 改双参转发 payload，或降级不再前置 siteId）；该缺陷同样使 CLI 的 log 展示失去内容。**撰写时已按修法一落地（child-main 双参），探针验证内容端到端到达。**
2. **给后续 PoC 作者**：child 在外层 context 重建 host 错误（child-main.ts:263-267 一带），vm realm 内 `err instanceof Error` 为 false，请结构化读取 err.name/message。
3. **[未知/未测]** 真实 provider 与故障注入下的 AIMD 降级/Retry-After 冷却（mock 永不触发，governor.ts:1-6 自述）；建议后续用注册故障 provider 的单测补一条 AIMD 熔断回归。

---

## 5. 用例四：凭据窃取（GOAL_POC_TOKEN 诱饵三向量 + 错误路径加测）

### 5.1 攻击向量

工作目录=worktree，主仓只读未动。在父 shell 注入 `GOAL_POC_TOKEN=sk-decoy-123` 后逐向量实跑引擎 CLI：

1. **向量1（env 直读）**：`node bin/workflow.js check tests/adversarial/fixtures/goal-cred-snoop-1-env-read.ts` → 编译期被静态拦（purity-ban 9002 `"process" is banned`，EXIT=1，脚本从未进沙箱）；
2. **向量2（world.run 侧信道）**：`GOAL_POC_TOKEN=sk-decoy-123 node bin/workflow.js run-script tests/adversarial/fixtures/goal-cred-snoop-2-worldrun.ts --db .workflow/cred-snoop.db`（run dwfrun-mvxr600i-9895ec，completed）→ world.run 孙进程输出 `TOKEN=***REDACTED***`，ENV_KEYS 键清单=[COMSPEC,HOMEDRIVE,HOMEPATH,LOGONSERVER,PATH,PATHEXT,PROGRAMFILES,PROGRAMFILES(X86),SYSTEMDRIVE,SYSTEMROOT,TEMP,TMP,USERDOMAIN,USERNAME,USERPROFILE,WINDIR]，GOAL_POC_TOKEN 不在其中——**白名单+源头脱敏双层防线均守住**，journal result_json 存的是掩码值；
3. **向量3（files.grep·read 扫 .env）**：同命令跑 `goal-cred-snoop-3-files-grep.ts`（cwd=含 .env 的 decoy workspace，run dwfrun-mvxr8jgi-4c03b4）→ **泄露**：CLI result 行原样返回 `"text":"GOAL_POC_TOKEN=sk-decoy-123"` 与整份 .env（连 `postgres://app:hunter2@...` URI 凭据都未掩码），且 journal dwf_nodes.result_json 持久化了原始值（worldread#2/#3）；
4. **加测（错误路径）**：`goal-cred-snoop-4-error-path.ts`（run dwfrun-mvxrb8cc-45b103，failed）→ 抛错携带 .env 内容，CLI 显示 `GOAL_POC_TOKEN=***REDACTED***`、`postgres://***:***@localhost:5432/db`，journal dwf_failed 事件无原始值——**错误通道防线守住**。

附注：实测 Windows/libuv 对显式 env 仍回注 USERPROFILE 等 7 键（env-probe 实测），故白名单精确性受 OS 限制，但诱饵键未穿透。

### 5.2 实测记录【审计时】

**静态读码（审计时行号，撰写时已按当前文件复核）**：

- `src/dwf/compile.ts:36`（BANNED_IDENTIFIERS 含 process）；
- `src/process-supervision.ts:55-89`+`:129-144`（buildSanitizedEnv 白名单/spawnSupervised）；
- `src/dwf/runner.ts:242-253`+`:521-523`（沙箱 env=buildSandboxEnv）；
- `src/dwf/engine.ts:792-796`（world.run envAllowlist；撰写时当前行号 `:798`）；
- `src/dwf/engine.ts:819`（spawnCaptured 输出 redactText；撰写时当前行号 `:822`）；
- `src/dwf/engine.ts:601-609`+`:672-705`（files.read/grepWorkspace 返回**原始文本**——泄露根因）；
- `src/dwf/engine.ts:964-973`（journalled 存 resultJson 未 redactValue——审计时泄露边界；撰写时已加 `value = redactValue(value)`，当前 `engine.ts:967-972`）；
- `src/dwf/redact.ts:38-79`；`src/prober/sanitizer.ts:3-7`。

**实测矩阵（审计时）**：

| 向量 | 命令与结果 | 判定 |
|---|---|---|
| 1 env 直读 | check 输出 `purity-ban(9002): "process" is banned`，exit 1 | 【防线有效】 |
| 2 world.run 侧信道 | CLI result 行含 `TOKEN=***REDACTED***` 且 ENV_KEYS 无 GOAL_POC_TOKEN | 【防线有效】 |
| 3 files.grep 扫 .env | CLI result 行含 `"text":"GOAL_POC_TOKEN=sk-decoy-123"`，node:sqlite 查 cred-snoop.db dwf_nodes 两条 worldRead 行命中 LEAK | 【泄露】 |
| 4 错误路径 | CLI 错误显示全掩码（KV 形状+URI 形状） | 【防线有效】 |

**回归（审计时）**：`node --test tests/adversarial/goal-poc1-env-read.test.ts tests/adversarial/goal-poc2-worldrun-sidechannel.test.ts tests/adversarial/goal-poc3-files-grep.test.ts` → ok 1..4（tests 4 / pass 4 / fail 0 / skipped 1，其中 ok4=# SKIP——泄露档按纪律挂起），duration 2.1s；构建门禁 `node node_modules/typescript/bin/tsc -p tsconfig.json` EXIT=0；tsconfig include 仅 src/bin/tests/unit/tests/integration，tests/adversarial 不参与编译。中间产物已清理：scratch-cred-snoop/ 与 .workflow 三个 dwfrun-* 目录、cred-snoop.db 均已删除。

### 5.3 官方对比

官方源码 `<official-zcode-clone>` 对应防线：

1. **环境变量隔离**——`packages/shared/src/runtimeEnv.ts:222-235` sanitizeZCodeRuntimeEnv 对继承 env 做已知会话凭据键的**拒绝式剔除**（ZCODE_CUA_PERMISSION_BROKER_TOKEN、ZCODE_OFFICIAL_ENDPOINT_TOKEN 等黑名单），`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:390/:449` spawn 时仅传极小 env（{ELECTRON_RUN_AS_NODE:'1'}）。我方 `src/process-supervision.ts:62-89` buildSanitizedEnv 是平台基座+显式 allowlist 的**白名单制**、`src/dwf/runner.ts:521-523` 再叠 value-masking、`src/dwf/engine.ts:798` 对 world.run 孙进程再加一层 allowlist——对未知键（如 GOAL_POC_TOKEN）官方黑名单拦不住、我方白名单直接丢弃，结论：**[推断] 就已审计面 env 隔离我方领先**——官方黑名单之外是否另有 allowlist 层未逐一审计（[推断]，未审面），故不作无条件断言。
2. **自由文本凭据形状规则**——`packages/shared/src/telemetryRedaction.ts:47-65` redactTelemetryText 含 `sk|rk|pk-[A-Za-z0-9_-]{12,}`→{secret}（`:61`）、ghp_（`:62`）、AKIA（`:63`）、AIza（`:64`）等按值形状脱敏（撰写时逐行核实）；我方 `src/dwf/redact.ts:38-39` CREDENTIAL_TOKEN_SHAPES 审计时缺 sk- 家族、sanitizer.ts:4 SENSITIVE_VALUE_REGEX 亦无（sk-decoy-123 太短两边都拦不住，但真实 sk-proj- 长键官方按形状拦、我方漏），结论：**值形状规则我方落后**（官方仅覆盖遥测通道，非子进程输出边界，标[推断]）。**撰写时我方已增补 `sk-[A-Za-z0-9]{20,}`（redact.ts:39，未提交），形状面已对齐。**
3. **读文件/持久化边界**——官方桌面端无与我方 files.read/files.grep→journal 等价面可逐行对标（[未知]），向量3 泄露以我方 GOAL.md 铁律2『零凭证泄漏』为判据自行成立。

总体：防线 partial——env 双层隔离与错误/子进程输出脱敏领先或持平，workspace 文件读取→journal/返回值边界缺 redactValue 为真实缺口（撰写时已收口）。

### 5.4 防线状态

**审计时：partial**（env/错误路径守住；files.grep/read → CLI+journal 泄露）。
**撰写时：泄露面已收口**（journal 持久化前 redactValue，GAP-03），泄露档 skip 已转正为真断言并通过——见 §5.6。

### 5.5 PoC 代码位置

```text
tests/adversarial/fixtures/goal-cred-snoop-1-env-read.ts        # 向量1：process.env 直读
tests/adversarial/fixtures/goal-cred-snoop-2-worldrun.ts        # 向量2：world.run env 侧信道
tests/adversarial/fixtures/goal-cred-snoop-3-files-grep.ts      # 向量3：files.grep/read 扫 .env
tests/adversarial/fixtures/goal-cred-snoop-4-error-path.ts      # 加测：错误路径外泄
tests/adversarial/goal-poc1-env-read.test.ts                    # 回归（静态拦截）
tests/adversarial/goal-poc2-worldrun-sidechannel.test.ts        # 回归（白名单+脱敏）
tests/adversarial/goal-poc3-files-grep.test.ts                  # 回归（泄露档——撰写时已转正为真断言）
```

### 5.6 当前状态复核【撰写时，本文档代理独立实测】

- **回归套件**：`node --test tests/adversarial/goal-poc1-env-read.test.ts tests/adversarial/goal-poc2-worldrun-sidechannel.test.ts tests/adversarial/goal-poc3-files-grep.test.ts` → **tests 5 / pass 5 / fail 0**（2.5s），0 skip。**审计时的 ok4=# SKIP（泄露档）已由兄弟代理按 GAP-03 转正为真断言并通过**：断言 decoy 值（`sk-decoy-123`）与 `hunter2` 不得出现在 CLI 输出、journal 掩码生效；测试注释记录了修复边界（`journalled()` 在 resultJson 与返回脚本之前掩码一次，CLI/journal/重放全部继承掩码）。
- **源码复核**：`engine.ts:967-972` `value = redactValue(value)` 先于 `saveDwfNode`（未提交）；`engine.ts:818-822` dwf_world_run 事件 args 脱敏；`redact.ts:38-39` sk- 家族形状；`prober/sanitizer.ts:3-5` SENSITIVE_KEY_REGEX 含 token（GOAL_POC_TOKEN 命中 KV 规则）、SENSITIVE_VALUE_REGEX 无 sk-（与官方 telemetryRedaction.ts:61 对比后由 redact.ts 补齐）。

### 5.7 缺口与修复建议（原 gapHint）

1. **修法（一行边界收口）**：在 FacadeEngine.journalled() 持久化前（engine.ts resultJson 处）或 worldRead 返回前套 redactValue/redactText，即可同时封住 files.read/files.grep 的 CLI 与 journal 泄露面，届时把 goal-poc3-files-grep.test.ts 的 describe.skip 解除并启用其断言。**撰写时已落地，skip 已转正并通过。**
2. 次要加固：redact.ts CREDENTIAL_TOKEN_SHAPES 与 sanitizer.ts SENSITIVE_VALUE_REGEX 增补 sk- 家族形状规则（对齐官方 telemetryRedaction.ts:61）。**redact.ts 侧已落地；sanitizer.ts SENSITIVE_VALUE_REGEX 仍无 sk-（影响面：仅 env 值整体形状判定，redactText 路径已由 redact.ts 覆盖）。**
3. 记录在案：Windows/libuv 会向显式 env 回注 USERPROFILE 等 7 键（本机实测），白名单不是字节级精确——报告精确性时应记录该 OS 层行为。
4. **未测面披露（2026-11-01 修订）**：本用例 held 判定不覆盖——(a) **amend 继承链上的 journal 脱敏**（GAP-01 已证明 `--amend` fork 可用，fork 后的泄露面未测）；(b) **run 入参 args_json 明文落库**（= GAP-MATRIX §2.6③/R2，本用例未测该向量）；(c) **MCP 通道**（GAP-MATRIX D2）。如需坐实 held 终态，需补测上述三面。

---

## 6. 安全边界结论

### 6.1 立场坐标

双方实现的头注释均**自认隔离目标是"故障隔离与确定性，非安全边界"**（我方 `src/dwf/child-main.ts:5-6`；官方 `child-source.ts` 顶注与 `__args` 浅冻结注释同义：「它挡的是手滑重新赋值 args，不是一个安全边界」）。本审计不以此为免责——GOAL.md 铁律2『零凭证泄漏』与哲学4『不可逆脱敏』是我方自己的硬承诺——而是以"一条可利用链能否打穿"为标准实测。结果：**找到 1 条完整沙箱逃逸链 + 1 条凭据泄露面，均在撰写时点被未提交修复收口**；DoS 防线全线守住。

### 6.2 分层防线模型得到验证

四层防线各自挡住不同面，**单层失守≠全线失守**：

| 层 | 机制 | 审计时表现 | 撰写时 |
|---|---|---|---|
| 静态层（compile） | 标识符/文本禁令 + 类型检查（types:[]） | 拦下 Date.parse 路由与 process 引用；对构造器链/原型链全盲 | **收口（部分）**：PROTOTYPE_CHAIN_PROPS 9002（点号+方括号），10/10 逃逸 fixture 全拒；**残余：isReference 初始化位漏网**（`const e = eval`/`const g = globalThis` 逃过 9002，GAP-MATRIX D3，修订轮探针复现——10/10 矩阵未覆盖该形态） |
| 运行时层（vm realm） | `codeGeneration:{strings:false,wasm:false}` | 拦下 PoC1 直链（EvalError）；对宿主 Function 无效（PoC2b 突破） | 仍在，作静态层之后的纵深 |
| 资源层（caps/timeout/熔断） | 8 层深度、2000 glob、1000 ask、16MiB/512KB 'rejects never truncates'、runTimeoutMs | **全线守住（held）**；唯洪泛场景超时上界可被饿死 | 不变；洪泛缺口仍在 |
| 脱敏层（redact 边界） | spawnCaptured redactText、stderr 尾部截断+脱敏、env 白名单、错误通道脱敏 | env/错误/子进程输出守住；files.read/grep→journal 泄露 | **收口**：journalled 前 redactValue（GAP-03）+ dwf_world_run args 脱敏 + sk- 形状 |

### 6.3 与官方的攻防互评

- **跨界值卫生：官方领先。** 官方把 args/ Promise/JSON 结果/Error 全部 context-native 化（child-source.ts:202-206 收敛契约），我方把主机域 args 对象直接放入 sandbox——这是 PoC2b/2c/3/3c/4 五连突破的**独有主破口**。静态收口按"形状"挡住了全部已知文本面，但根因（跨 realm 对象泄漏）未改，`__host.args` context-native 化仍是加固清单第 1 条。
- **realm 硬化：我方领先。** 官方 `createContext` 无 codeGeneration 限制且经 `runInContext` 编译字符串（eval/Function 自认可用）；我方 `codeGeneration:{strings:false,wasm:false}` 实测拦截直链构造器逃逸（PoC1 EvalError）。
- **资源防线：我方整体领先。** 深度上限（官方无）、1000-call 硬熔断+token 预算（官方已整体移除、哲学改为"取消才是控制面"）；glob cap 持平（2000+cap+1）；递归类型表达力官方领先（$ref 合法 vs 我方一律 9015 拒绝）。
- **协议防线：官方领先。** 1MB/16MB 硬上限、parse 前字节硬闸、命名 fault、逐帧 zod 校验、30s 组装超时；我方对应面（帧长上限、洪泛活性、schema 校验）截至撰写时仍缺。
- **凭据形状规则：官方领先→已对齐。** 官方 telemetryRedaction 有 sk|rk|pk 家族；我方审计时缺、撰写时 redact.ts 已补。
- **[未知]**：官方 analysis/interpret+taint 语义解释器是否拦构造器链，未实测；真实 provider 下的 AIMD/调度行为，双方均未测。

### 6.4 最终判定

- **以当前 worktree（含未提交修复）为准：沙箱逃逸 = partial（静态收口已落地＋运行时纵深；但 D1 根因待 context-native 化、静态层余 isReference 初始化位漏网 D3——口径=机制根因是否消除，与 GAP-MATRIX §1.2 统一；按「利用链可否打穿」口径则为 held）；协议投毒 = partial（洪泛/帧长/schema 三缺口）；DoS = held；凭据窃取 = held（泄露面收口；已知残余 R2：run 入参 args_json 明文落库未修，GAP-MATRIX §2.6③；未测面见 §5.7 #4，OS 回注行为记录在案）。**
- **以审计时 HEAD（30eb54f 纯净态）为准：partial / partial / held / partial。**
- 上表未提交修复若在合入评审中被撤销，防线状态即回退到审计时判定——**本文档的"当前状态"列以 git diff 中存在的修复为前提**，合入时必须连同修复一起评审（见 §7）。

---

## 7. 加固清单（按优先级合并四用例 gapHint）

| # | 加固项 | 封住的缺口 | 状态（撰写时） | 验证方式 | 对应 GAP-MATRIX 条目 |
|---|---|---|---|---|---|
| 1 | `__host.args` context-native 化：`__argsJson` 字符串传入 realm、realm 内 JSON.parse（对齐官方 child-source.ts:202-206） | 沙箱逃逸**根因**（PoC2b/2c/3/3c/4 全链路；静态收口只是形状拒绝） | **未修**（静态已挡文本面，根因仍在） | 修复后 PoC2b/PoC4 两个 describe.skip 按注释模板转正 | **D1**（最高优先·安全） |
| 2 | compile.ts PROTOTYPE_CHAIN_PROPS 9002（constructor/`__proto__`/prototype，点号+方括号，类型无关） | PoC1/1b/2/2b/2c/3/3b/3c/4 静态面 | **已落地（未提交）**，check 矩阵 10/10 ok:false 实测 | §8 check 静态矩阵（10 fixture 枚举清单） | **GAP-02**（done·未提交） |
| 3 | journal 持久化前 `redactValue`（GAP-03）+ dwf_world_run 事件 args 脱敏 + redact.ts 增补 sk- 家族 | 凭据窃取向量3（files.read/grep → CLI+journal 泄露）与形状面 | **已落地（未提交）**，泄露档 skip 转正后 5/5 通过 | `node --test tests/adversarial/goal-poc3-files-grep.test.ts` | **GAP-03**（done·未提交） |
| 4 | child-main `__host.log/report` 双参转发 | 审计通道失明（log/report 载荷丢失 G2 回归；ReportCapExceeded 端到端不可达） | **已落地（未提交）**，探针实测 `log: CANARY-LOG-CONTENT` 端到端到达 | scratch 探针 + §2.6 第 5 条 | **GAP-01**（done·未提交） |
| 5 | NDJSON 帧长上限：`runner.ts:373-390` 行循环加单行/总量字节预算（对齐官方 1MB/16MB），超限 killTree+命名错误（如 ChildFrameLimitExceeded），ask/log 入口同款上限 | 协议投毒缺口 G（33MB 帧被接受、无命名拒绝） | **未修** | 修复后 goal-poc3-oversize skip 转正 | **D4** |
| 6 | 洪泛活性：stdout data 同步循环让位（行间 setImmediate / 流 pause / 字节预算+杀树） | 协议投毒缺口 H（10s 超时上界实测 213s，killTimer 饿死） | **未修** | 修复后 goal-poc1-ndjson flood skip 转正 | **D4** |
| 7 | 入站帧 schema 校验（官方逐帧 zod safeParse；我方 handleChildFrame 仅按 t 分支） | 协议投毒"持平偏落后"项：结构畸形帧靠运行时抛错兜底 | **未修** | 畸形帧单测 | **D4**（畸形帧计数部分）；逐帧 schema 校验未单列，随 D4 立项时明确 |
| 8 | 测试债：用例二三处 describe.skip 转正——其中 log/report 档的修复（#4）已就绪，转正条件已满足 | 缺口档与实际状态的漂移（skip 标签写"[缺口未修复]"而实已修复） | **待做**（本文档只记录、不越权代改） | 转正后套件计数从 12 变化并在 PR 指纹中体现 | GAP-MATRIX §七 #3（测试转正待办） |
| 9 | runner.ts 对「child 退出码 0 但无 done 帧」区分协议畸变（PoC3c）与普通崩溃 | 可观测性（现统一报 "sandbox child exited before finishing (code 0)"） | **未修**（低危） | 错误分类单测 | 未入册（GAP-MATRIX 无对应条目），建议随 D4 立项 |
| 10 | sendToParent 帧附加进程内校验标记（如 journal 侧 HMAC）做纵深防御 | 微任务伪造 done 帧（PoC4；已知 BREACHED 缺口——主获取路径暂被静态门遮断，纵深防御未修）＝GAP-MATRIX R4④ | **未修**（可选；GAP R4④ 建议与 D1/D4 一并立项） | 伪造帧单测 | **R4④**（唯一登记条目） |
| 11 | AIMD 熔断故障注入回归（注册故障 provider 触发 multiplicative decrease/Retry-After） | [未知] 档：mock 永不触发（governor.ts:1-6 自述） | **未修** | 故障 provider 单测 | **D8②**（AIMD 四层纪律） |
| 12 | 记录在案：Windows/libuv 向显式 env 回注 USERPROFILE 等 7 键——白名单非字节级精确 | 凭据窃取附注（不影响诱饵结论） | 文档化 | 已记录于 §5.1/§5.7 | 无（文档化） |
| 13 | sanitizer.ts SENSITIVE_VALUE_REGEX 增补 sk- 家族（redact.ts 已补） | env 整值形状判定面 | **部分落地** | 形状单测 | **R3**（值形收紧，可选） |
| 14 | compile.ts `isReference` 初始化位漏网修复：VariableDeclaration 仅排除 name 位，initializer 仍参与引用判定 | `const e = eval`／`const g = globalThis` 逃过 9002（GAP-MATRIX D3；修订轮双探针复现 ok:true） | **未修**（15 分钟小修，GAP-02 合入后同文件顺延） | 两探针 `check -j` 转为 ok:false + 断言入 dwf-compiler.test.ts | **D3** |

**合入提醒**：#2/#3/#4 三项修复目前只存在于 worktree 未提交 diff 中，与本报告的"当前状态"判定强耦合；合入 PR 必须包含它们，否则 §6.4 的判定回退到审计时（partial×3 + held×1）。AGENTS.md §四 门禁（build / test:unit / test:pbt / e2e / governance / pr_review_gate --check-clean）在合入前须全量跑一遍。

---

## 8. 本文档证据台账（撰写时本轮独立执行的命令）

以下命令全部于撰写时在 worktree `<workspace-worktrees>/issue-28-goal-e2e-pentest` 执行，输出摘录见各用例 §x.6：

```text
# 构建门禁
node node_modules/typescript/bin/tsc -p tsconfig.json                    → exit 0

# 四组对抗回归（重建 dist 后）
node --experimental-strip-types --test
  tests/adversarial/goal-poc1-constructor-escape.test.ts
  tests/adversarial/goal-poc2-crossrealm-function.test.ts
  tests/adversarial/goal-poc3-proto-pollution.test.ts
  tests/adversarial/goal-poc4-microtask-escape.test.ts                   → tests 7 / pass 7 / fail 0 / skipped 2（2 个 skip 缺口档未计入 tests）

node --experimental-strip-types --test
  tests/adversarial/goal-poc1-ndjson-protocol.test.ts
  tests/adversarial/goal-poc2-control-char-injection.test.ts
  tests/adversarial/goal-poc3-oversize-frames.test.ts                    → tests 12 / pass 12 / fail 0 / skipped 3（3 个 skip 缺口档未计入 tests）

node --test --experimental-strip-types
  tests/adversarial/goal-poc1-deep-type.test.ts
  tests/adversarial/goal-poc2-glob-bomb.test.ts
  tests/adversarial/goal-poc3-agent-storm.test.ts                        → tests 9 / pass 9 / fail 0 / skipped 0

node --test
  tests/adversarial/goal-poc1-env-read.test.ts
  tests/adversarial/goal-poc2-worldrun-sidechannel.test.ts
  tests/adversarial/goal-poc3-files-grep.test.ts                         → tests 5 / pass 5 / fail 0 / skipped 0

# check 静态矩阵（10 fixtures）——全部 ok:false + 9002
# （原稿 brace-glob 缩写 `goal-poc{1,1b,2,2b,2c,3,3b,3c,4}-*.ts` 实际展开为 16 个 fixture、
#   会混入 deep-type/glob/agent-storm 等 DoS 样本而破坏「全部 9002」表述——修订为逐文件枚举；
#   10 文件清单 2026-11-01 修订轮逐一核对存在于 tests/adversarial/fixtures/）
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc1-constructor-escape.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc1b-constructor-escape-anycast.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc2-crossrealm-function.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc2b-crossrealm-args.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc2c-spawn-sync.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc3-proto-pollution.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc3b-proto-pollution-realm-only.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc3c-proto-pollution-tojson.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-poc4-microtask-escape.ts
node bin/workflow.js check -j tests/adversarial/fixtures/goal-cred-snoop-1-env-read.ts

# run-script 编译期拒绝探针
node bin/workflow.js run-script tests/adversarial/fixtures/goal-poc2b-crossrealm-args.ts --db .workflow/audit41-poc2b.db → exit 1（9002）
node bin/workflow.js run-script tests/adversarial/fixtures/goal-poc4-microtask-escape.ts --db .workflow/audit41-poc4.db → exit 1（9002）

# log/report 载荷探针（修复验证）
node bin/workflow.js run-script scratch-audit-41/logprobe.facade.ts --db .workflow/audit41-log.db
  → log: CANARY-LOG-CONTENT / report: {"canary":"CANARY-REPORT-ITEM"} / result: "CANARY-RETURN"

# 源码抽查（当前行号核实）
child-main.ts:95-98,109,296-300 / lower.ts:137-141 / runner.ts:340-352,354-357,373-390,394-400,402-406
compile.ts:33-39,169-179 / engine.ts:36-44,452-466,597-609,795-824,884-889(NUL 字节 idx58/68 按码点核实),967-983
redact.ts:38-79 / prober/sanitizer.ts:3-5 / process-supervision.ts:55-89,129-144
schema-synth.ts:23-28,56,70 / glob.ts:44-47,61 / governor.ts:1-6,49-52

# 官方源码抽查（<official-zcode-clone>，只读）
dynamic-workflow-runtime/src/child-source.ts:21-28,202-206,332-339
zcode-protocol-v4/core.ts:63-67 / web-remote-control-rpc-transport.ts:10-16,229-235
telemetryRedaction.ts:47-65 / dynamic-workflow/src/engine/concurrency.ts:23-38
bootstrap/src/app/workflow-world-read.ts:112-123 / dynamic-workflow/src/facade/world-read-caps.ts:28
```

**未做/无法做的**：官方 analysis/interpret+taint 解释器对构造器链的拦截能力（未实测，[未知]）；真实 provider 下的 AIMD/调度行为（离线 mock 约束，[未知]）；describe.skip 档的转正改写（属兄弟代理/合入 PR 范围，本文档只记录不代改）。

**2026-11-01 修订轮追加执行（修订员）**：D3 探针两组（`const e = eval; return typeof e;` 与 `const g = globalThis; return typeof g;`，临时文件经 `node bin/workflow.js check -j` 均 ok:true / 零诊断 / exit 0）＋对照组 goal-poc2b（同命令 ok:false / 9002 / exit 1）；`ls tests/adversarial/*.test.ts`（13 个 test 文件）与 fixtures 清单核对（§8 各命令的枚举依据）；governor.ts:14-23,48-52,97 / compile.ts:341 / schema-synth.ts:4 / run-script.ts:129 / engine.ts:122,186-194 行号逐行复核；engine.ts emit 事件正则去重（18 种）。修订轮探针临时文件 scratch-revdocs/ 用后即删。

**中间产物清理**：本文档撰写过程中产生的 `scratch-audit-41/`（check JSON、TAP 日志、log 探针）与 `.workflow/audit41-*.db` 已在提交前删除；主仓全程只读未动。
