// planBody.ts — hole "repair-plan" 的填洞体（splice body）。
// 该文件的语句会被原位嫁接到 case-c-hole.ts 中 hole<ExecutionPlan>("repair-plan")
// 所在的位置（包成 async IIFE），可见洞前全部绑定（如 brief），可调用 facade 原语。
// 嫁接后整个有效脚本必须通过编译，否则 fill 拒绝且不落任何改动。

log(`fill body executing at the hole site; prefix brief still in scope: ${brief.strategy}`);

return {
  target: "connection pool exhaustion under burst traffic",
  steps: [
    "Apply hotfix to connection pool configuration",
    "Restart pool workers one at a time",
    "Verify healthz returns 200 for 5 consecutive probes",
  ],
  riskLevel: "LOW",
};
