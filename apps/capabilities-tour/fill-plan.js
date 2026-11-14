// The planner routes to the mock's runbook payload; translate it into the hole's Plan.
const p = await agent("planner").ask<PlanJson>(`Plan the remediation for: ${JSON.stringify(reading)}`);
return { action: p.strategy, owner: "planner" };

interface PlanJson {
  strategy: string;
}
