/* workflow
name: lineage-tour
description: Two asks whose second one gets edited to demo amend lineage
*/
phase("Base work");
const fact = await agent("scout").ask<Fact>("inspect health report of the service");
phase("Derive");
const verdict = await agent("analyst").ask<Verdict>(`Assess this reading: ${JSON.stringify(fact)}`);
report(verdict);
return { fact, verdict };

interface Fact {
  /** Deterministic mock health verdict. */
  healthStatus: string;
}
interface Verdict {
  /** What the reading means operationally. */
  assessment: string;
  /** 0..1 certainty of the assessment. */
  confidence: number;
}
