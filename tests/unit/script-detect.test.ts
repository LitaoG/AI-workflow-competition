import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { looksLikeFacadeScript } from '../../src/cli/commands/script-detect.js';

function writeTmp(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-detect-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('facade scripts are detected by bare facade globals or top-level return', () => {
  const facade = writeTmp(
    'facade.facade.ts',
    `phase('Inspect');
const health = await agent('inspector').ask('inspect the service');
report({ health });
return { health };
`,
  );
  assert.equal(looksLikeFacadeScript(facade), true);

  // Top-level `return` is decisive even without other facade globals (native
  // ESM import would throw a SyntaxError on it).
  const topLevelReturn = writeTmp('ret.facade.ts', `const x = 1;\nreturn x;\n`);
  assert.equal(looksLikeFacadeScript(topLevelReturn), true);

  const holeScript = writeTmp('hole.facade.ts', `const h = hole<string>('fill me');\n`);
  assert.equal(looksLikeFacadeScript(holeScript), true);
});

test('builder workflows (defineWorkflow / new Workflow) are never facade — property-access agent() included', () => {
  // The exact class of fixture that gate round 1 misrouted into the sandbox
  // compiler: a builder workflow whose step bodies call ctx.agent(...).ask(...).
  const builder = writeTmp(
    'builder.workflow.ts',
    `export default {
  name: 'multi-agent-workflow',
  steps: [
    {
      id: 'step-triage',
      execute: async (ctx) => {
        const triage = await ctx.agent('inspector').ask('Analyze incoming alert telemetry', {
          schema: { type: 'object' },
        });
        return triage;
      },
    },
  ],
};
`,
  );
  assert.equal(looksLikeFacadeScript(builder), false);

  const defineWorkflowFile = writeTmp(
    'dw.workflow.ts',
    `import { defineWorkflow } from 'ai-workflow';
export default defineWorkflow({ name: 'x', steps: [] });
`,
  );
  assert.equal(looksLikeFacadeScript(defineWorkflowFile), false);

  const newWorkflowFile = writeTmp(
    'nw.workflow.ts',
    `import { Workflow } from 'ai-workflow';
export default new Workflow({ name: 'x' });
`,
  );
  assert.equal(looksLikeFacadeScript(newWorkflowFile), false);
});

test('unreadable files are not facade scripts', () => {
  assert.equal(looksLikeFacadeScript(path.join(os.tmpdir(), 'script-detect-does-not-exist.ts')), false);
});
