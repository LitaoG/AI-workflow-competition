/* workflow
name: growth-tour
description: Parks at a hole mid-run; fill it with a body that asks an agent
*/
phase("Observe");
const reading = await agent("scout").ask<Reading>("inspect health report of the service");
const plan = await hole<Plan>("plan-remediation", `reading: ${JSON.stringify(reading)}`);
log(`plan: ${plan.action}`);
return { reading, plan };

interface Reading {
  healthStatus: string;
}
interface Plan {
  action: string;
  owner: string;
}
