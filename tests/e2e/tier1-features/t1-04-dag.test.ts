import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import { assertExitCode, assertStdoutContains, assertValidDAGHtml } from '../helpers/assertions.ts';
import { SAMPLE_MULTI_AGENT_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 4: ZCode Timeline DAG Visualizer (dag)', async (t) => {
  const tempDir = createTempDir('t1-f4-dag-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F4_01: CLI graph --format html outputs standalone HTML with curved Bezier paths', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f4-01.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'html']);

    assertExitCode(res, 0);
    assertStdoutContains(res, '<!DOCTYPE html>');
    assertStdoutContains(res, '<svg');
    assertStdoutContains(res, 'd="M');
  });

  await t.test('T1_F4_02: CLI graph --format mermaid outputs valid Mermaid syntax', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f4-02.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'mermaid']);

    assertExitCode(res, 0);
    assertStdoutContains(res, 'flowchart TD');
    assertStdoutContains(res, '-->');
  });

  await t.test('T1_F4_03: CLI graph --format ascii outputs terminal ASCII tree with symbols', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f4-03.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'ascii']);

    assertExitCode(res, 0);
    assertStdoutContains(res, '[Phase:');
    assertStdoutContains(res, '└─');
  });

  await t.test('T1_F4_04: CLI graph --output saves rendered visualization to designated file', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f4-04.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const htmlFile = path.join(tempDir, 'custom-dag.html');
    const res = runCLI(['graph', wfPath, '--format', 'html', '--output', htmlFile]);

    assertExitCode(res, 0);
    assertValidDAGHtml(htmlFile);
  });

  await t.test('T1_F4_05: Multi-phase timeline DAG renders phase groupings and node status badges', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f4-05.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const res = runCLI(['graph', wfPath, '--format', 'html']);

    assertExitCode(res, 0);
    assertStdoutContains(res, 'status-bar');
    assertStdoutContains(res, 'phases');
  });
});
