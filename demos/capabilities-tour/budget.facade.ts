/* workflow
name: budget-tour
description: run with --budget-total 80; the second agent() call trips WorkflowBudgetExceededError
*/
phase("Spend");
// The budget is injected by the run config and is read-only in the script:
//   workflow run-script demos/capabilities-tour/budget.facade.ts --budget-total 80
const first = await agent("spend-a").ask<Reading>("inspect health report of the service");
log(`spent so far: ${budget.spent()} / ${budget.total}`);
let stopped = '';
try {
  await agent("spend-b").ask("inspect health report of the service");
} catch (e) {
  stopped = (e as Error).name;
}
return { first: first.healthStatus, stopped };

interface Reading {
  healthStatus: string;
}
