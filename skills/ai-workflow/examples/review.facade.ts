// Example facade script for the ai-workflow skill: scan a workspace for
// marked lines, fan out typed reviews, adversarially verify, gate, report.
//
//   workflow run skills/ai-workflow/examples/review.facade.ts \
//     --cwd <workspace-root> --args '{"glob":"src/**/*.ts","gate":"node"}'

interface Marked {
  /** The marked line's text. */
  text: string;
  severity: 'low' | 'medium' | 'high';
}

interface Review {
  findings: Marked[];
  /** One-sentence overall verdict. */
  summary: string;
}

interface Verdict {
  /** True when the independent reviewer reproduces the finding. */
  confirmed: boolean;
  /** One sentence of evidence or refutation. */
  evidence: string;
}

const glob = (args.glob as string | undefined) ?? 'src/**/*.ts';

phase('Scan');
const matches = await files.grep('TODO|FIXME|HACK', glob);
if (matches.length === 0) {
  log(`No marked lines under ${glob} — nothing to review.`);
  return { findings: 0, confirmed: 0 };
}
log(`Scan found ${matches.length} marked line(s); fanning out reviews.`);

phase('Review');
const reviewer = agent('code-reviewer');
const review = await reviewer.ask<Review>(
  `Review these marked lines for real problems (ignore style). Marked lines: ${JSON.stringify(matches.slice(0, 40))}`,
);

phase('Verify');
const verifier = agent('adversarial-verifier');
const verdicts = await Promise.all(
  review.findings.map((f) =>
    verifier.ask<Verdict>(
      `Independently confirm or refute this finding by reading the code yourself: ${JSON.stringify(f)}`,
    ),
  ),
);
const confirmed = verdicts.filter((v) => v.confirmed).length;

phase('Gate');
const gate = await world.run('node', ['--version'], { timeoutMs: 30_000 });
if (gate.exitCode !== 0) throw new Error(`toolchain gate failed: ${gate.stderr}`);

phase('Report');
const markdown = [
  `# Review: ${confirmed}/${review.findings.length} findings confirmed`,
  '',
  `- **Verdict**: ${review.summary}`,
  ...review.findings.map((f, i) => `- ${verdicts[i]!.confirmed ? '✔' : '✖'} [${f.severity}] ${f.text} — ${verdicts[i]!.evidence}`),
].join('\n');
await artifact.markdown('review', markdown, { title: 'Marked-line review' });
report({ confirmed, total: review.findings.length });

return { findings: review.findings.length, confirmed, verdict: review.summary };
