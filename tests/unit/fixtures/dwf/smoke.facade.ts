phase("Triage incident");
const triage = await agent("triage-agent").ask<Triage>(`Triage the incident: ${String(args.incident ?? "healthz failing, P1 burst traffic")}`);
phase("Safety review");
const review = await agent("safety-reviewer").ask<Review>(`Safety review this triage result: ${JSON.stringify(triage)}`);
report(review);
return { triage, review };

interface Triage {
  /** The incident identifier. */
  incidentId: string;
  /** Severity bucket. */
  severity: "P1" | "P2" | "P3";
  /** One-sentence root cause. */
  rootCause: string;
}
interface Review {
  isApproved: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}
