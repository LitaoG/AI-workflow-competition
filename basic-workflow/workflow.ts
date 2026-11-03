import { defineWorkflow, z } from 'ai-workflow';

// Define the structured schema for the inspector's output
const InspectionReportSchema = z.object({
  healthStatus: z.enum(['HEALTHY', 'WARNING', 'CRITICAL']),
  scannedFiles: z.number().int().nonnegative(),
  summary: z.string(),
  recommendations: z.array(z.string()),
});

export type InspectionReport = z.infer<typeof InspectionReportSchema>;

export default defineWorkflow({
  name: 'Basic Health & Inspection Workflow',
  description: 'Minimal starter workflow with typed agent RPC and environment probe',
  version: '1.0.0',
  phases: ['Environment Probe', 'Inspector Agent', 'Artifact Generation'],
  steps: [
    {
      id: 'probe-environment',
      name: 'Probe System & Git Environment',
      phase: 'Environment Probe',
      role: 'inspector',
      async execute(ctx) {
        const probeResult = await ctx.probe();
        ctx.log(`Target Platform: ${probeResult.system.platform} (${probeResult.system.arch})`);
        ctx.log(`Git Commit: ${probeResult.git.commit || 'Not a git repo'}`);
        return probeResult;
      },
    },
    {
      id: 'inspector-agent',
      name: 'Run Inspector Agent RPC',
      phase: 'Inspector Agent',
      role: 'inspector',
      dependencies: ['probe-environment'],
      async execute(ctx) {
        const probeData = ctx.getOutput('probe-environment');

        const prompt = `Inspect the project environment and report system health. Platform: ${JSON.stringify(probeData)}`;
        const report = await ctx.agent('inspector').ask(prompt, InspectionReportSchema, {
          temperature: 0.2,
          mockResponse: {
            healthStatus: 'HEALTHY',
            scannedFiles: 42,
            summary: 'Environment verified. All runtimes and toolchains conform to requirements.',
            recommendations: ['Enable TypeScript strict mode', 'Verify git working tree status'],
          },
        });

        ctx.log(`Inspector Report: ${report.healthStatus} - ${report.summary}`);
        return report;
      },
    },
    {
      id: 'generate-artifact',
      name: 'Persist Inspection Artifact',
      phase: 'Artifact Generation',
      role: 'coordinator',
      dependencies: ['inspector-agent'],
      async execute(ctx) {
        const report = ctx.getOutput<InspectionReport>('inspector-agent');
        await ctx.recordArtifact('inspection-report.json', JSON.stringify(report, null, 2));
        ctx.log('Inspection report saved to artifacts.');
        return { artifactWritten: true };
      },
    },
  ],
});
