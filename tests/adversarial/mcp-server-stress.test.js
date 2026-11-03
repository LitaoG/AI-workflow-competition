import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BuiltinWorkflowMCPServer } from '../../dist/src/mcp/server.js';
import { computeFingerprint } from '../../dist/src/prober/index.js';

test('MCP Server Stress: BuiltinWorkflowMCPServer comprehensive tool suite via InMemoryTransport', async (t) => {
  const server = new BuiltinWorkflowMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.start(serverTransport);

  const client = new Client(
    { name: 'stress-tester-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  let executedRunId = '';
  const testTmpDir = path.resolve(process.cwd(), 'tests', 'adversarial', 'fixtures', `mcp-stress-${Date.now()}`);
  fs.mkdirSync(testTmpDir, { recursive: true });
  // Disposable runtime state, not a fixture: remove it when the parent test
  // ends (success or failure) so repeated runs do not accumulate dirs. Windows
  // may hold the SQLite WAL handle for a moment after close — retry once.
  t.after(() => {
    const rm = () => {
      try {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
    if (!rm()) {
      const retry = setTimeout(rm, 500);
      retry.unref?.();
    }
  });
  const customDb = path.join(testTmpDir, 'mcp-test.db');
  const customOut = path.join(testTmpDir, 'artifacts');

  // Subtest 1: Tool Catalog & Schema Exposing
  await t.test('1. Tool Catalog exposing the 10 required tools with proper JSON schema', async () => {
    const listRes = await client.listTools();
    const tools = listRes.tools;
    assert.equal(tools.length, 10);

    const toolNames = tools.map((t) => t.name);
    // The five original core tools…
    assert.ok(toolNames.includes('workflow_run'), 'Must expose workflow_run');
    assert.ok(toolNames.includes('workflow_probe'), 'Must expose workflow_probe');
    assert.ok(toolNames.includes('workflow_inspect'), 'Must expose workflow_inspect');
    assert.ok(toolNames.includes('workflow_replay'), 'Must expose workflow_replay');
    assert.ok(toolNames.includes('workflow_graph'), 'Must expose workflow_graph');
    // …plus the facade-script surface (run_script / inspect_run / get_run) and
    // the script authoring tools.
    assert.ok(toolNames.includes('workflow_script_check'), 'Must expose workflow_script_check');
    assert.ok(toolNames.includes('workflow_script_run'), 'Must expose workflow_script_run');
    assert.ok(toolNames.includes('workflow_run_script'), 'Must expose workflow_run_script');
    assert.ok(toolNames.includes('workflow_inspect_run'), 'Must expose workflow_inspect_run');
    assert.ok(toolNames.includes('workflow_get_run'), 'Must expose workflow_get_run');

    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 10);
    }
  });

  // Subtest 2: workflow_probe tool
  await t.test('2. workflow_probe handles normal and customized options with secret redaction', async () => {
    // Normal probe
    const probeRes = await client.callTool({
      name: 'workflow_probe',
      arguments: {},
    });
    assert.ok(!probeRes.isError);
    assert.equal(probeRes.content[0].type, 'text');
    const data = JSON.parse(probeRes.content[0].text);
    assert.ok(data.snapshotId);
    assert.ok(data.timestamp);
    assert.ok(data.system.platform);
    assert.ok(data.system.arch);
    assert.ok(data.toolchain.node);

    // Compute fingerprint from probe data
    const fp = computeFingerprint(data);
    assert.ok(fp && fp.length === 64, 'SHA-256 fingerprint must be 64 hex chars');

    // Probe with custom directory
    const probeDirRes = await client.callTool({
      name: 'workflow_probe',
      arguments: {
        targetDir: 'basic-workflow',
        sanitizeEnv: true,
      },
    });
    assert.ok(!probeDirRes.isError);
    const dataDir = JSON.parse(probeDirRes.content[0].text);
    assert.ok(dataDir.system.platform);
  });

  // Subtest 3: workflow_run tool & error boundaries
  await t.test('3. workflow_run executes valid workflow and rejects invalid files cleanly', async () => {
    // A. Normal execution with custom DB and outDir
    const runRes = await client.callTool({
      name: 'workflow_run',
      arguments: {
        workflowPath: './basic-workflow/workflow.ts',
        mock: true,
        dbPath: customDb,
        outDir: customOut,
      },
    });

    assert.ok(!runRes.isError);
    const runData = JSON.parse(runRes.content[0].text);
    assert.equal(runData.status, 'completed');
    assert.ok(runData.runId);
    assert.ok(runData.checkpointsCount > 0);
    assert.ok(runData.completedSteps.length > 0);
    assert.equal(runData.failedSteps.length, 0);
    assert.equal(runData.artifactsDir, customOut);
    assert.ok(fs.existsSync(customDb), 'SQLite database must be created');

    executedRunId = runData.runId;

    // B. Error boundary: non-existent file
    const notFoundRes = await client.callTool({
      name: 'workflow_run',
      arguments: {
        workflowPath: './non-existent-workflow-404.ts',
        mock: true,
      },
    });
    assert.ok(notFoundRes.isError);
    assert.ok(notFoundRes.content[0].text.includes('Workflow file not found'));

    // C. Error boundary: invalid module (valid JS file but does not export a Workflow)
    const invalidModRes = await client.callTool({
      name: 'workflow_run',
      arguments: {
        workflowPath: './tests/adversarial/fixtures/not-a-workflow.js',
        mock: true,
      },
    });
    assert.ok(invalidModRes.isError);
    assert.ok(invalidModRes.content[0].text.includes('does not export a valid Workflow'));
  });

  // Subtest 4: workflow_inspect tool & filtering
  await t.test('4. workflow_inspect returns run status, checkpoints, and handles 404', async () => {
    // Inspect completed run
    const inspectRes = await client.callTool({
      name: 'workflow_inspect',
      arguments: {
        runId: executedRunId,
        dbPath: customDb,
        includeEvents: true,
      },
    });

    assert.ok(!inspectRes.isError);
    const inspectData = JSON.parse(inspectRes.content[0].text);
    assert.equal(inspectData.runId, executedRunId);
    assert.equal(inspectData.status, 'completed');
    assert.ok(inspectData.checkpointsCount > 0);
    assert.ok(Array.isArray(inspectData.events), 'Events must be included when requested');
    assert.ok(inspectData.events.length > 0);

    // Inspect non-existent runId
    const inspect404 = await client.callTool({
      name: 'workflow_inspect',
      arguments: {
        runId: 'fake-ghost-run-404',
        dbPath: customDb,
      },
    });
    assert.ok(inspect404.isError);
    assert.ok(inspect404.content[0].text.includes('Run not found'));
  });

  // Subtest 5: workflow_replay tool
  await t.test('5. workflow_replay analyzes idempotency and supports resume', async () => {
    // Replay analysis
    const replayRes = await client.callTool({
      name: 'workflow_replay',
      arguments: {
        runId: executedRunId,
        dbPath: customDb,
        resumeFromFailed: true,
      },
    });

    assert.ok(!replayRes.isError);
    const replayData = JSON.parse(replayRes.content[0].text);
    assert.equal(replayData.runId, executedRunId);
    assert.equal(replayData.resumable, false); // already completed
    assert.ok(replayData.stepsToSkip.length > 0);
    // Every MCP response crosses the irreversible redaction boundary; the key
    // name `tokensSavedEstimate` matches the sensitive-key regex (token), so
    // the value is masked wholesale by design (over-redaction trade-off).
    assert.equal(replayData.tokensSavedEstimate, '***REDACTED***');
    // Replay with resumeFromFailed: the tool ANALYZES the journal and says so —
    // it never writes fake completed checkpoints (honest-replay contract).
    assert.equal(replayData.resumeFromFailedRequested, true);
    assert.ok(replayData.resumeHint.includes('resume'), 'the hint points at the real re-execution path');

    // Replay with forceRecompute
    const forceRes = await client.callTool({
      name: 'workflow_replay',
      arguments: {
        runId: executedRunId,
        dbPath: customDb,
        forceRecompute: true,
      },
    });
    assert.ok(!forceRes.isError);
    const forceData = JSON.parse(forceRes.content[0].text);
    assert.ok(forceData.stepsToExecute.length > 0, 'forceRecompute must mark steps to execute');

    // Replay non-existent run
    const replay404 = await client.callTool({
      name: 'workflow_replay',
      arguments: {
        runId: 'non-existent-run-404',
        dbPath: customDb,
      },
    });
    assert.ok(replay404.isError);
    assert.ok(replay404.content[0].text.includes('Run not found'));
  });

  // Subtest 6: workflow_graph tool formats
  await t.test('6. workflow_graph renders HTML, Mermaid, and ASCII with bilingual support', async () => {
    // HTML format
    const htmlRes = await client.callTool({
      name: 'workflow_graph',
      arguments: {
        workflowPath: './basic-workflow/workflow.ts',
        format: 'html',
        lang: 'en',
      },
    });
    assert.ok(!htmlRes.isError);
    const html = htmlRes.content[0].text;
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('AI-Workflow Visualizer'));
    assert.ok(!/https?:\/\//i.test(html), 'Zero external CDN dependencies in MCP graph tool');

    // HTML Chinese
    const htmlZhRes = await client.callTool({
      name: 'workflow_graph',
      arguments: {
        workflowPath: './basic-workflow/workflow.ts',
        format: 'html',
        lang: 'zh',
      },
    });
    assert.ok(!htmlZhRes.isError);
    assert.ok(htmlZhRes.content[0].text.includes('个阶段'));

    // Mermaid format
    const mermaidRes = await client.callTool({
      name: 'workflow_graph',
      arguments: {
        workflowPath: './basic-workflow/workflow.ts',
        format: 'mermaid',
      },
    });
    assert.ok(!mermaidRes.isError);
    assert.ok(mermaidRes.content[0].text.startsWith('flowchart'));

    // ASCII format
    const asciiRes = await client.callTool({
      name: 'workflow_graph',
      arguments: {
        workflowPath: './basic-workflow/workflow.ts',
        format: 'ascii',
      },
    });
    assert.ok(!asciiRes.isError);
    assert.ok(asciiRes.content[0].text.length > 20);

    // Non-existent file
    const graph404 = await client.callTool({
      name: 'workflow_graph',
      arguments: {
        workflowPath: './missing-graph-workflow.ts',
      },
    });
    assert.ok(graph404.isError);
    assert.ok(graph404.content[0].text.includes('Workflow file not found'));
  });

  // Subtest 7: High Concurrency stress
  await t.test('7. Concurrency stress: 20 parallel MCP requests resolve cleanly without hang', async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        client.callTool({
          name: 'workflow_probe',
          arguments: { sanitizeEnv: true },
        })
      );
      promises.push(
        client.callTool({
          name: 'workflow_graph',
          arguments: {
            workflowPath: './basic-workflow/workflow.ts',
            format: 'ascii',
          },
        })
      );
    }

    const results = await Promise.all(promises);
    assert.equal(results.length, 20);
    for (const res of results) {
      assert.ok(!res.isError, 'All concurrent tool calls must succeed');
    }
  });

  await client.close();
});
