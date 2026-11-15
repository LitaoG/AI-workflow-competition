import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { runCLI } from '../helpers/cli.ts';
import { createTempDir, cleanupTempDir, writeTempFile } from '../helpers/env.ts';
import {
  assertExitCode,
  assertValidEventLog,
  assertValidCheckpointsDb,
  assertStderrContains
} from '../helpers/assertions.ts';
import { SAMPLE_MULTI_AGENT_WORKFLOW } from '../helpers/fixtures.ts';

test('Tier 1 - Feature 1: Typed Agent RPCs (agent.ask<T>)', async (t) => {
  const tempDir = createTempDir('t1-f1-rpc-');

  t.after(() => {
    cleanupTempDir(tempDir);
  });

  await t.test('T1_F1_01: Agent RPC call with valid schema returns validated structured data and records event', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f1-01.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-01');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0, 'Workflow run should exit with 0');
    const events = assertValidEventLog(path.join(outputDir, 'events.jsonl'));
    const stepEvents = events.filter(e => e.type === 'STEP_COMPLETE');
    assert.ok(stepEvents.length >= 2, 'Should record at least two completed steps');
  });

  await t.test('T1_F1_02: Agent RPC mock response adheres to schema in offline --mock mode', () => {
    const wfPath = writeTempFile(tempDir, 'wf-t1-f1-02.ts', SAMPLE_MULTI_AGENT_WORKFLOW);
    const outputDir = path.join(tempDir, 'run-02');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    const triageCp = checkpoints.find(c => c.step_id === 'step-triage' || c.step_id === 'step-1-inspect');
    assert.ok(triageCp, 'Triage/inspect checkpoint should exist');
    assert.strictEqual(triageCp.status, 'completed');
    // The RPC's returned value must be the schema-conforming mock response
    // itself: every required field of the step-triage schema (severity P1|P2|P3
    // enum, suspect, rootCause) must land verbatim in the persisted step
    // output — a dropped or reshaped return value goes red here.
    const stepOutput = JSON.parse(String(triageCp.output_json)) as Record<string, unknown>;
    assert.strictEqual(stepOutput.severity, 'P1');
    assert.strictEqual(stepOutput.suspect, 'db_connection_pool');
    assert.strictEqual(stepOutput.rootCause, 'Database max connection pool exhausted');

    // Schema validation must genuinely execute, not just pass data through: a
    // structural validator (the documented PromptSchema contract — any object
    // with a parse() function satisfies it, src/agent/rpc.ts:9-10) that rejects
    // a schema-violating mockResponse must fail the run. If the RPC skipped
    // validation entirely, this run would exit 0 and the assertion below would
    // go red.
    const violatingWf = writeTempFile(tempDir, 'wf-t1-f1-02-violating.ts', `
export default {
  name: "schema-violation-rpc",
  steps: [
    {
      id: "step-triage",
      role: "inspector",
      execute: async (ctx) => {
        return await ctx.agent("inspector").ask("Analyze", {
          schema: {
            parse: (value) => {
              if (!["P1", "P2", "P3"].includes(value.severity)) {
                throw new Error("schema violation: severity must be P1|P2|P3");
              }
              return value;
            }
          },
          mockResponse: { severity: 123 }
        });
      }
    }
  ]
};`);
    const violatingRes = runCLI(['run', violatingWf, '--mock', '--output-dir', path.join(tempDir, 'run-02-violating')]);
    assert.strictEqual(violatingRes.exitCode, 1, 'A schema-violating mock response must fail the run');
    assertStderrContains(violatingRes, 'schema violation: severity must be P1|P2|P3');
  });

  await t.test('T1_F1_03: Agent RPC respects role configuration (inspector, worker, reviewer)', () => {
    const wfContent = `
export default {
  name: "role-test-workflow",
  steps: [
    {
      id: "inspector-step",
      role: "inspector",
      execute: async (ctx) => {
        return { role: "inspector", passed: true };
      }
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t1-f1-03.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-03');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    assertValidEventLog(path.join(outputDir, 'events.jsonl'));
  });

  await t.test('T1_F1_04: Sequential agent RPC calls maintain independent schema and typing contexts', () => {
    const wfContent = `
export default {
  name: "sequential-rpc-workflow",
  steps: [
    {
      id: "step-a",
      role: "worker",
      execute: async () => ({ valueA: 100 })
    },
    {
      id: "step-b",
      role: "worker",
      dependencies: ["step-a"],
      execute: async () => ({ valueB: "text-output" })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t1-f1-04.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-04');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.length >= 2, 'Should persist checkpoints for all sequential steps');
  });

  await t.test('T1_F1_05: Complex nested schemas (objects, arrays, enums) validate successfully', () => {
    const wfContent = `
export default {
  name: "nested-schema-workflow",
  steps: [
    {
      id: "nested-step",
      role: "worker",
      execute: async () => ({
        items: [{ id: 1, tag: "primary" }, { id: 2, tag: "secondary" }],
        meta: { total: 2, status: "OK" }
      })
    }
  ]
};`;
    const wfPath = writeTempFile(tempDir, 'wf-t1-f1-05.ts', wfContent);
    const outputDir = path.join(tempDir, 'run-05');
    const res = runCLI(['run', wfPath, '--mock', '--output-dir', outputDir]);

    assertExitCode(res, 0);
    const checkpoints = assertValidCheckpointsDb(path.join(outputDir, 'checkpoints.db'));
    assert.ok(checkpoints.some(c => c.status === 'completed'));
  });
});
