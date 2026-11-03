import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir } from '../helpers/env.ts';
import {
  assertExitCode,
  assertFileExists,
  assertValidDAGHtml,
  assertStdoutContains
} from '../helpers/assertions.ts';

test('Tier 4 - Scenario 4: Greenfield Scaffolding Initialization, Custom Workflow Creation, and DAG Visualization', async (t) => {
  const tempDir = createTempDir('t4-scenario4-greenfield-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('Scenario 4: Scaffolds new project, executes workflow, and generates interactive DAG', () => {
    const projectDir = path.join(tempDir, 'my-greenfield-app');

    // 1. Initialize project
    const resInit = runCLI(['init', 'basic', projectDir]);
    assertExitCode(resInit, 0);
    assertFileExists(path.join(projectDir, 'workflow.ts'));

    // 2. Add custom logic into workflow
    const customWorkflow = `
export default {
  name: "custom-greenfield-workflow",
  version: "1.0.0",
  phases: ["Phase 1: Ingestion", "Phase 2: Processing"],
  steps: [
    {
      id: "ingest",
      name: "Data Ingestion",
      phase: "Phase 1: Ingestion",
      execute: async () => ({ records: 100 })
    },
    {
      id: "process",
      name: "Data Processing",
      phase: "Phase 2: Processing",
      dependencies: ["ingest"],
      execute: async () => ({ processed: 100, status: "SUCCESS" })
    }
  ]
};`;
    fs.writeFileSync(path.join(projectDir, 'workflow.ts'), customWorkflow, 'utf-8');

    // 3. Execute workflow
    const resRun = runCLI(['run', path.join(projectDir, 'workflow.ts'), '--mock']);
    assertExitCode(resRun, 0);
    assertStdoutContains(resRun, '✔');

    // 4. Generate DAG HTML
    const dagOut = path.join(projectDir, 'workflow-dag.html');
    const resGraph = runCLI(['graph', path.join(projectDir, 'workflow.ts'), '--format', 'html', '--output', dagOut]);
    assertExitCode(resGraph, 0);
    assertValidDAGHtml(dagOut);
  });
});
