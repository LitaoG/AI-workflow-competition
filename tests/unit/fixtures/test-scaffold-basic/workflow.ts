// Scaffolding template: basic
export default {
  name: 'basic-workflow',
  version: '1.0.0',
  phases: ['Phase 1: Execution'],
  steps: [
    {
      id: 'step-1',
      name: 'Initial Step',
      phase: 'Phase 1: Execution',
      role: 'inspector',
      execute: async () => ({ success: true }),
    },
  ],
};
