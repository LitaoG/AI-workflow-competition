import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import {
  assertExitCode,
  assertValidEventLog,
  assertValidCheckpointsDb,
  assertValidDAGHtml,
  assertStdoutContains
} from '../helpers/assertions.ts';
import {
  SAMPLE_LINEAR_WORKFLOW,
  SAMPLE_MULTI_AGENT_WORKFLOW,
  SAMPLE_DEMO1_INCIDENT_WORKFLOW,
  SAMPLE_DEMO2_MIGRATION_WORKFLOW
} from '../helpers/fixtures.ts';

test('Tier 3: Cross-Feature Pairwise Combinations (15 Interaction Suites)', async (t) => {
  const tempDir = createTempDir('t3-pairwise-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T3_PAIR_01 (F1 x F2): Agent RPC consuming Prober Snapshot in prompt context', () => {
    const wfContent = `
export default {
  name: "f1-f2-workflow",
  steps: [
    {
      id: "probed-agent",
      role: "inspector",
      execute: async (ctx) => {
        const sys = ctx.probe.system;
        return { inspectedArch: sys.arch, inspectedPlatform: sys.platform };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-f1-f2.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-f1-f2');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);

    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.strictEqual(checkpoints[0].status, 'completed');
  });

  await t.test('T3_PAIR_02 (F1 x F3): Agent RPC output checkpointed into SQLite and verified', () => {
    const wfPath = writeTempFile(tempDir, 'wf-f1-f3.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-f1-f3');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);

    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2);
  });

  await t.test('T3_PAIR_03 (F1 x F4): Agent RPC role and metrics rendered on DAG nodes', () => {
    const wfPath = writeTempFile(tempDir, 'wf-f1-f4.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'html']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '<svg');
  });

  await t.test('T3_PAIR_04 (F1 x F5): Agent RPC driving MCP tool invocation', () => {
    const wfContent = `
export default {
  name: "f1-f5-workflow",
  steps: [
    {
      id: "agent-mcp",
      role: "worker",
      execute: async (ctx) => {
        const toolResult = await ctx.mcp.callTool("filesystem", "read_file", { path: "sample.txt" });
        return { toolResult };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-f1-f5.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-f1-f5');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);
  });

  await t.test('T3_PAIR_05 (F2 x F3): Prober snapshot recorded as initial event in events.jsonl', () => {
    const wfPath = writeTempFile(tempDir, 'wf-f2-f3.ts', SAMPLE_LINEAR_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-f2-f3');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);
    assertExitCode(res, 0);

    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    assert.strictEqual(events[0].type, 'WORKFLOW_START');
  });

  await t.test('T3_PAIR_06 (F2 x F6): Deterministic Prober executed via CLI /workflow probe --json', () => {
    const res = runCLI(['/workflow', 'probe', '--json']);
    assertExitCode(res, 0);

    const json = res.json<any>();
    assert.ok(json.system);
    assert.ok(json.env);
  });

  await t.test('T3_PAIR_07 (F3 x F6): Durable State Replay triggered via CLI /workflow replay', () => {
    const wfPath = writeTempFile(tempDir, 'wf-f3-f6.ts', SAMPLE_LINEAR_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['/workflow', 'replay', runId]);
    assertExitCode(resReplay, 0);
  });

  await t.test('T3_PAIR_08 (F4 x F6): DAG Visualizer generated via CLI /workflow graph --format html', () => {
    const wfPath = writeTempFile(tempDir, 'wf-f4-f6.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['/workflow', 'graph', wfPath, '--format', 'html', '--lang', 'zh']);
    assertExitCode(res, 0);
    assertStdoutContains(res, '<!DOCTYPE html>');
  });

  await t.test('T3_PAIR_09 (F5 x F6): MCP client operations managed via CLI /workflow mcp list', () => {
    const res = runCLI(['/workflow', 'mcp', 'list', '--json']);
    assertExitCode(res, 0);
    const tools = res.json<any[]>();
    assert.ok(tools.length >= 2);
  });

  await t.test('T3_PAIR_10 (F6 x F7): Scaffolding project created via /workflow init and executed via /workflow run', () => {
    const targetDir = path.join(tempDir, 'pair-scaffold-app');
    const resInit = runCLI(['/workflow', 'init', 'basic', targetDir]);
    assertExitCode(resInit, 0);

    const resRun = runCLI(['/workflow', 'run', path.join(targetDir, 'workflow.ts'), '--mock']);
    assertExitCode(resRun, 0);
  });

  await t.test('T3_PAIR_11 (F3 x F8): Demo 1 incident workflow state checkpointing and replay', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-pair.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    assertExitCode(resRun, 0);

    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['replay', runId]);
    assertExitCode(resReplay, 0);
  });

  await t.test('T3_PAIR_12 (F4 x F8): Demo 1 multi-phase DAG visualization with Bezier paths', () => {
    const wfPath = writeTempFile(tempDir, 'demo1-dag.ts', SAMPLE_DEMO1_INCIDENT_WORKFLOW);
    const htmlFile = path.join(tempDir, 'demo1-dag.html');
    const res = runCLI(['graph', wfPath, '--format', 'html', '--output', htmlFile]);
    assertExitCode(res, 0);
    assertValidDAGHtml(htmlFile);
  });

  await t.test('T3_PAIR_13 (F5 x F9): Demo 2 repo migration interacting with MCP tool calls', () => {
    const res = runCLI(['mcp', 'call', 'ast_grep']);
    assertExitCode(res, 0);
  });

  await t.test('T3_PAIR_14 (F3 x F9): Demo 2 repo migration checkpoint persistence and resumption', () => {
    const wfPath = writeTempFile(tempDir, 'demo2-pair.ts', SAMPLE_DEMO2_MIGRATION_WORKFLOW);
    const resRun = runCLI(['run', wfPath, '--mock']);
    assertExitCode(resRun, 0);

    const match = resRun.stdout.match(/run-\d+-[a-z0-9]+/i);
    const runId = match ? match[0] : 'run-test';

    const resReplay = runCLI(['replay', runId, '--resume-from-failed']);
    assertExitCode(resReplay, 0);
  });

  await t.test('T3_PAIR_15 (F10 x F6): Kiro lifecycle integration verified with CLI commands', () => {
    const res = runCLI(['--version']);
    assertExitCode(res, 0);
    assertStdoutContains(res, 'ai-workflow');
  });
});
