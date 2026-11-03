phase("Survey");
const survey = await agent("inspector").ask<Survey>("inspect health report of the service");
phase("Approve");
const approval = await escalate(`Service is ${survey.healthStatus}. Approve auto-remediation? (yes/no + reason)`);
log(`owner said: ${approval}`);
return { survey, approval };

interface Survey {
  healthStatus: string;
}
