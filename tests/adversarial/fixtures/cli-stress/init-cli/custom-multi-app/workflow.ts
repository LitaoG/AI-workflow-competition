// Scaffolding template: multi-agent
export default {
  name: 'multi-agent-workflow',
  version: '1.0.0',
  phases: ['Phase 1: Planning', 'Phase 2: Execution', 'Phase 3: Review'],
  steps: [
    {
      id: 'planner',
      name: 'Planner Agent',
      phase: 'Phase 1: Planning',
      role: 'planner',
      execute: async () => ({ plan: 'Initial execution plan' }),
    },
    {
      id: 'worker',
      name: 'Worker Agent',
      phase: 'Phase 2: Execution',
      role: 'worker',
      dependencies: ['planner'],
      execute: async () => ({ result: 'Work completed' }),
    },
    {
      id: 'reviewer',
      name: 'Reviewer Agent',
      phase: 'Phase 3: Review',
      role: 'reviewer',
      dependencies: ['worker'],
      execute: async () => ({ approved: true }),
    },
  ],
};
