import * as fs from 'node:fs';
import * as path from 'node:path';
import { t, resolveLang } from '../i18n/index.js';

export interface InitCommandOptions {
  dir?: string;
  lang?: string;
  force?: boolean;
}

export async function executeInit(template: string, options?: InitCommandOptions): Promise<number> {
  const lang = resolveLang(options?.lang);

  if (!template || (template !== 'basic' && template !== 'multi-agent')) {
    console.error(t('ERR_TEMPLATE_INVALID', { template: template ?? 'undefined' }, lang));
    return 1;
  }

  const targetDir = path.resolve(process.cwd(), options?.dir ?? `./${template}-workflow`);

  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir);
    if (files.length > 0 && !options?.force) {
      console.error(t('ERR_DIR_NOT_EMPTY', { dir: targetDir }, lang));
      return 1;
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    const pkgName = path.basename(targetDir) || `${template}-workflow`;

    const workflowContent =
      template === 'multi-agent'
        ? `// Scaffolding template: multi-agent
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
`
        : `// Scaffolding template: basic
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
`;

    fs.writeFileSync(path.join(targetDir, 'workflow.ts'), workflowContent, 'utf-8');
    fs.writeFileSync(
      path.join(targetDir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '1.0.0', type: 'module' }, null, 2) + '\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(targetDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2) + '\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(targetDir, 'README.md'),
      `# ${template} dynamic workflow\n\nRun with \`workflow run workflow.ts --mock\`\n`,
      'utf-8'
    );
    fs.writeFileSync(path.join(targetDir, '.gitignore'), 'node_modules/\n.workflow/\ndist/\n', 'utf-8');

    console.log(`[AI-Workflow] Successfully scaffolded "${template}" template into: ${targetDir}`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${path.relative(process.cwd(), targetDir) || '.'}`);
    console.log(`  workflow run workflow.ts --mock`);
    return 0;
  } catch (err: any) {
    console.error(`Init Error: ${err.message}`);
    return 1;
  }
}
