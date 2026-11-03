/* workflow
name: budget-tour
description: budget.total hard-stops the third agent() call (WorkflowBudgetExceededError)
*/
phase("Spend");
budget.total = 80; // mock ask spends 88 completion tokens — the second pre-check trips
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
