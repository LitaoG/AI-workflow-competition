/* workflow
name: gate-tour
description: Parks on a human escalation; workflow answer resumes at zero cost
*/
phase("Observe");
const reading = await agent("scout").ask<Reading>("inspect health report of the service");
const approval = await escalate(`Service is ${reading.healthStatus}. Approve auto-remediation? (yes/no + reason)`);
log(`owner said: ${approval}`);
return { reading, approval };

interface Reading {
  healthStatus: string;
}
