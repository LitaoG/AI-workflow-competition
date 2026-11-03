
import { Workflow, actionStep } from '../../../dist/src/index.js';

const wf = new Workflow({ name: 'CLIRunTestWorkflow' });
wf.addPhase({ id: 'p1', name: 'Phase 1' });
wf.addStep(
  actionStep({
    id: 'step-ok',
    name: 'Step OK',
    phaseId: 'p1',
    action: async () => ({ success: true }),
  })
);
export default wf;
