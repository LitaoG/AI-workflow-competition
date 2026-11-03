// 用例 C（TEST-GOAL 阶段2 业务用例实测）：类型化洞 + 热嫁接填洞。
//
// 流程：
//   ① Triage 相：向 planner 子代理要一份修复计划简报（typed ask，mock provider 离线命中）；
//   ② 在 hole<ExecutionPlan>("repair-plan") 处停靠 —— ExecutionPlan 为自定义 interface，
//      含 3 个必填字段（target / steps / riskLevel）；
//   ③ 停靠后由 `node bin/workflow.js fill <runId> repair-plan planBody.ts` 把洞体热嫁接
//      到洞位（洞体可见洞前全部绑定，如 brief），流程以 amend fork 续跑；
//   ④ Execute 相：按补全的 plan 打印日志并发布 artifact.markdown（写文件类执行步骤）。
//
// 运行方式（在 worktree 根目录）：
//   node bin/workflow.js check  examples/goal-e2e/case-c-hole.ts
//   node bin/workflow.js run-script examples/goal-e2e/case-c-hole.ts --db .workflow/case-c.db
//   node bin/workflow.js fill <runId> repair-plan examples/goal-e2e/planBody.ts --db .workflow/case-c.db

phase("Triage");
const brief = await agent("planner").ask<PlanBrief>(
  "produce a remediation plan brief for the connection pool exhaustion incident",
);
log(`brief: ${brief.strategy} (${brief.steps.length} steps, ~${brief.estimatedMinutes}min)`);

phase("Repair");
// 类型化洞：填洞体必须产出 ExecutionPlan 值（洞体编译不过则拒绝嫁接、不落任何改动）。
const plan = await hole<ExecutionPlan>("repair-plan", "请补全修复计划：给出目标、步骤与风险等级");
log(`plan accepted: target=${plan.target} risk=${plan.riskLevel} steps=${plan.steps.length}`);

phase("Execute");
// 执行步骤 1：按 plan 打印逐条步骤。
for (let i = 0; i < plan.steps.length; i++) {
  log(`step ${i + 1}/${plan.steps.length}: ${plan.steps[i]}`);
}
// 执行步骤 2：按 plan 发布最终产物（markdown 工件，内容入 journal artifacts 表）。
const markdown = [
  "# 修复计划（case C）",
  "",
  `- 目标: ${plan.target}`,
  `- 风险等级: ${plan.riskLevel}`,
  "",
  "## 步骤",
  ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
].join("\n");
await artifact.markdown("repair-plan", markdown, { title: "Repair Plan (case C)" });
report({ brief, plan });
return { brief, plan };

interface PlanBrief {
  strategy: string;
  steps: string[];
  estimatedMinutes: number;
}

interface ExecutionPlan {
  /** 修复目标 */
  target: string;
  /** 有序修复步骤 */
  steps: string[];
  /** 风险等级（LOW / MEDIUM / HIGH） */
  riskLevel: string;
}
