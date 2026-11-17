<!-- AI-workflow PR 提交模板：严禁占位符，必附测试指纹与审查自检 -->

## 开 PR 前自检（必须全数满足方可开 PR / 合入）

- [ ] 「验证」段**绝无任何占位符**（严禁出现 `{{...}}`、`PLACEHOLDER_*`、「待填」、「稍后补充」等空头承诺）
- [ ] 已完整贴出 **TypeScript 构建检查**输出（`npm.cmd run build` 退出码 0）
- [ ] 已完整贴出 **§4.1 早筛清单**与本机测试指纹（`Ran N tests` / `pass N, fail 0`，附带真实用例数）
- [ ] 已确认测试副产物已还原，工作区干净（已执行 `git restore tests/ artifacts/`，`git status --porcelain` 为空）
- [ ] 已核对 `git diff` 中 `package-lock.json` 的变更仅来自本次依赖变更（未触及依赖时 lockfile 应零变更——extraneous 条目翻转防护，#196 S4；触及依赖须同 PR 提交 package.json 与 package-lock.json）
- [ ] 已回看**本 PR 自身与关联 Issue** 的全部评论并逐条交代（已处理 / 刻意不改+理由 / 需人拍板；监督席/评审的方括号体标题如「[监督席·只读复核] …」同样按审查意见计；见 AGENTS.md §1.9）
- [ ] 已按 **AGENTS.md §1.11 文档同步**排查：全部受影响文档已在同一次 PR 内更新，或已在正文声明「无文档影响」（无影响时附一句理由）

---

## 1. 变更背景与 Issue 关联

- 关联 Issue：Closes #<!-- 真实 Issue 编号，禁止脑补 -->
- 变更说明：简述本次改动的核心问题与目标。

---

## 2. 改动分档与范围（二选一）

- [ ] **常规档（改动运行时行为）**：已遵循最小改动原则就地修改，无新建平行实现，无无关格式化或夹带。
- [ ] **重构档（零行为变更）**：纯搬迁与模块解耦，对外可观察行为零变更，单内聚单元独立 PR。

改动文件统计（`git diff --stat`）：
```text
<!-- 粘贴 git diff --stat 真实输出 -->
```

---

## 3. 本机验证指纹（必须真实运行并贴出输出）

### 3.1 静态构建检查（`npm.cmd run build`）
```text
<!-- 粘贴构建输出或 tsc exit code 0 -->
```

### 3.2 单元测试（`npm.cmd run test:unit`）
```text
<!-- 粘贴 pass N, fail 0 输出指纹 -->
```

### 3.3 集成测试（`npm.cmd run test:integration`；触及 src/dwf、src/mcp、src/cli/commands、src/state 或 tests/integration/** 时必跑）
```text
<!-- 粘贴 pass N, fail 0 输出指纹；未适用时写 N/A + 一句理由 -->
```

### 3.4 治理规则锁死测试（`node --experimental-strip-types tests/unit/workflow-governance.test.ts`）
```text
<!-- 粘贴 governance test pass 输出 -->
```

---

## 4. 剩余风险与盲区（A-E 交付分档）

- 本次交付分档：A 类（已完成且通过验证）/ 其他
- 剩余风险与说明：<!-- 若无，填写无 -->
