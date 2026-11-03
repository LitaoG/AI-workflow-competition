phase("Survey");
const survey = await agent("inspector").ask<Survey>("inspect health report of the service");
phase("Decide");
const decision = await hole<Decision>("decide-remediation", `survey found: ${JSON.stringify(survey)}`);
log(`decision made: ${decision.action}`);
phase("Report");
report(decision);
return { survey, decision };

interface Survey {
  healthStatus: string;
}
interface Decision {
  action: string;
  owner: string;
}
