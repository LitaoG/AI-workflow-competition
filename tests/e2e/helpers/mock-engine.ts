import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * Reference Test Oracle / Mock Engine for AI-Workflow opaque-box testing.
 * Implements CLI interface contracts specified in TEST_INFRA.md and docs/ARCHITECTURE.md.
 */

export interface RunOptions {
  mock?: boolean;
  lang?: 'en' | 'zh';
  dryRun?: boolean;
  resumeFromFailed?: boolean;
  outputDir?: string;
}

export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const redacted: Record<string, string> = {};
  const secretKeywords = ['KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'AUTH', 'CREDENTIAL'];
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    const isSecret = secretKeywords.some(keyword => k.toUpperCase().includes(keyword));
    redacted[k] = isSecret ? '[REDACTED]' : v;
  }
  return redacted;
}

export function executeProbe(): Record<string, unknown> {
  let isGit = false;
  let branch = 'unknown';
  let commitHash = '0000000000000000000000000000000000000000';
  let isDirty = false;

  try {
    const gitStatus = execSync('git status --porcelain', { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' });
    isGit = true;
    isDirty = gitStatus.trim().length > 0;
    branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
    commitHash = execSync('git rev-parse HEAD', { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
  } catch {
    // Graceful fallback when not in a git repo
  }

  return {
    snapshotId: `probe-${Date.now()}`,
    timestamp: new Date().toISOString(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMB: Math.round(os.freemem() / (1024 * 1024))
    },
    git: {
      isGitRepo: isGit,
      branch,
      commitHash,
      isDirty
    },
    toolchain: {
      nodeVersion: process.version,
      tools: {
        node: { installed: true, version: process.version },
        npm: { installed: true, version: '10.9.8' },
        git: { installed: isGit, version: isGit ? '2.55.0' : undefined }
      }
    },
    env: sanitizeEnv(process.env)
  };
}

export function renderHTMLDAG(workflowName: string, phases: string[], nodes: Array<{ id: string; name: string; phase: string; status: string }>, lang: 'en' | 'zh' = 'en'): string {
  const isZh = lang === 'zh';
  const title = isZh ? `AI-Workflow 执行图 — ${workflowName}` : `AI-Workflow Execution DAG — ${workflowName}`;
  const statusLabel = isZh ? '已完成' : 'Completed';

  // SVG curved Bezier path generation
  const paths = nodes.map((_, i) => {
    const x1 = 100 + i * 180;
    const y1 = 150;
    const x2 = x1 + 180;
    const y2 = y1;
    const cx1 = x1 + 90;
    const cy1 = y1 - 30;
    const cx2 = x2 - 90;
    const cy2 = y2 + 30;
    return `<path d="M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" stroke="#3b82f6" stroke-width="2" fill="none" marker-end="url(#arrow)" />`;
  }).join('\n    ');

  const nodeElements = nodes.map((n, i) => {
    const x = 50 + i * 180;
    return `
    <g transform="translate(${x}, 120)">
      <rect width="140" height="60" rx="8" fill="#1e293b" stroke="#10b981" stroke-width="2" />
      <text x="70" y="25" text-anchor="middle" fill="#f8fafc" font-size="12" font-weight="bold">${n.name}</text>
      <text x="70" y="45" text-anchor="middle" fill="#10b981" font-size="11">✔ ${statusLabel}</text>
    </g>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { font-size: 20px; border-bottom: 1px solid #334155; padding-bottom: 12px; }
    .status-bar { background: #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; font-size: 14px; }
    .dag-container { background: #0b1120; border: 1px solid #334155; border-radius: 8px; padding: 16px; overflow-x: auto; }
    svg { min-width: 800px; height: 320px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="status-bar">
    <strong>${isZh ? '状态' : 'Status'}:</strong> ${phases.length} ${isZh ? '阶段' : 'phases'} · 0 ${isZh ? '活动智能体' : 'active subagents'} · ${isZh ? '就绪' : 'Ready'}
  </div>
  <div class="dag-container">
    <svg width="100%" height="320">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6" />
        </marker>
      </defs>
      ${paths}
      ${nodeElements}
    </svg>
  </div>
</body>
</html>`;
}

export function renderMermaidDAG(workflowName: string, nodes: Array<{ id: string; name: string; dependencies?: string[] }>): string {
  let mm = `flowchart TD\n  %% Workflow: ${workflowName}\n`;
  for (const n of nodes) {
    mm += `  ${n.id}["${n.name}"]\n`;
    if (n.dependencies) {
      for (const dep of n.dependencies) {
        mm += `  ${dep} --> ${n.id}\n`;
      }
    }
  }
  return mm;
}

export function renderASCIIDAG(workflowName: string, phases: string[], nodes: Array<{ id: string; name: string; phase: string }>): string {
  let ascii = `=== ${workflowName} ===\n`;
  for (const phase of phases) {
    ascii += `[Phase: ${phase}]\n`;
    const phaseNodes = nodes.filter(n => n.phase === phase);
    for (const n of phaseNodes) {
      ascii += `  └─ ✔ ${n.name} (id: ${n.id})\n`;
    }
  }
  return ascii;
}

/**
 * Executes a CLI command through the reference engine.
 */
export async function executeMockEngine(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutArr: string[] = [];
  const stderrArr: string[] = [];

  const log = (...msgs: string[]) => stdoutArr.push(msgs.join(' '));
  const errLog = (...msgs: string[]) => stderrArr.push(msgs.join(' '));

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    log('Usage: workflow <command> [options]');
    log('');
    log('Commands:');
    log('  run <file>               Execute dynamic workflow');
    log('  replay <run-id>          Replay or resume workflow execution');
    log('  graph <file>             Generate DAG visualization (html, mermaid, ascii)');
    log('  probe                    Inspect host environment and toolchains');
    log('  list                     List workflow runs');
    log('  inspect <run-id>         Inspect workflow run checkpoints');
    log('  init <template> [dir]    Scaffold new workflow project (basic, multi-agent)');
    log('  mcp <subcommand>         MCP server operations (list, call)');
    log('');
    log('Options:');
    log('  -V, --version            output the version number');
    log('  --lang <lang>            Localization language (en, zh)');
    log('  --mock                   Execute in deterministic offline mock mode');
    return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
  }

  if (args[0] === '--version' || args[0] === '-V') {
    log('ai-workflow 1.0.0');
    return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
  }

  // Handle slash command prefix if passed as `/workflow <cmd>`
  let normalizedArgs = [...args];
  if (normalizedArgs[0] === '/workflow') {
    normalizedArgs.shift();
  }
  if (normalizedArgs.length === 0) {
    log('Usage: workflow <command> [options]');
    return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
  }

  const cmd = normalizedArgs[0];
  const cmdArgs = normalizedArgs.slice(1);

  // Check language flag
  const langIndex = cmdArgs.indexOf('--lang');
  const lang: 'en' | 'zh' = (langIndex !== -1 && cmdArgs[langIndex + 1] === 'zh') ? 'zh' : 'en';
  const isZh = lang === 'zh';

  switch (cmd) {
    case 'probe': {
      const isJson = cmdArgs.includes('--json');
      const snapshot = executeProbe();
      if (isJson) {
        log(JSON.stringify(snapshot, null, 2));
      } else {
        if (isZh) {
          log('================ 环境探测结果 ===============');
          log(`平台: ${(snapshot.system as any).platform} (${(snapshot.system as any).arch})`);
          log(`Git分支: ${(snapshot.git as any).branch}`);
          log(`Git提交: ${(snapshot.git as any).commitHash}`);
          log(`Node版本: ${(snapshot.toolchain as any).nodeVersion}`);
        } else {
          log('================ Environment Probe ===============');
          log(`Platform: ${(snapshot.system as any).platform} (${(snapshot.system as any).arch})`);
          log(`Git Branch: ${(snapshot.git as any).branch}`);
          log(`Git Commit: ${(snapshot.git as any).commitHash}`);
          log(`Node Version: ${(snapshot.toolchain as any).nodeVersion}`);
        }
      }
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'init': {
      const template = cmdArgs[0];
      if (!template || (template !== 'basic' && template !== 'multi-agent')) {
        errLog(isZh ? `错误: 无效的模板 "${template}". 可用模板: basic, multi-agent` : `Error: Invalid template "${template}". Available templates: basic, multi-agent`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const targetDir = cmdArgs[1] || './my-workflow';
      const force = cmdArgs.includes('--force');

      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0 && !force) {
        errLog(isZh ? `错误: 目标目录 "${targetDir}" 不为空. 使用 --force 覆盖.` : `Error: Target directory "${targetDir}" is not empty. Use --force to overwrite.`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'workflow.ts'), `// Scaffolding template: ${template}\nexport default {\n  name: "${template}-workflow",\n  version: "1.0.0",\n  steps: [\n    { id: "step-1", name: "Initial Step", execute: async () => ({ success: true }) }\n  ]\n};\n`);
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ name: path.basename(targetDir), version: '1.0.0', type: 'module' }, null, 2));
      fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2));
      fs.writeFileSync(path.join(targetDir, 'README.md'), `# ${template} dynamic workflow\n\nRun with \`workflow run workflow.ts --mock\`\n`);
      fs.writeFileSync(path.join(targetDir, '.gitignore'), `node_modules/\n.workflow/\n`);

      log(isZh ? `✔ 模板 "${template}" 成功初始化于 ${targetDir}` : `✔ Template "${template}" successfully initialized in ${targetDir}`);
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'graph': {
      const filePath = cmdArgs[0];
      if (!filePath) {
        errLog(isZh ? '错误: 未指定工作流文件' : 'Error: Workflow file path required');
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }
      if (!fs.existsSync(filePath)) {
        errLog(isZh ? `错误: 找不到文件 "${filePath}"` : `Error: File not found: "${filePath}"`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const formatIdx = cmdArgs.indexOf('--format');
      const format = formatIdx !== -1 ? cmdArgs[formatIdx + 1] : 'html';
      const outputIdx = cmdArgs.indexOf('--output');
      const outputPath = outputIdx !== -1 ? cmdArgs[outputIdx + 1] : undefined;

      const phases = ['Phase 1: Setup', 'Phase 2: Execution', 'Phase 3: Verification'];
      const nodes = [
        { id: 'node-1', name: 'Setup', phase: 'Phase 1: Setup', status: 'completed' },
        { id: 'node-2', name: 'Execute', phase: 'Phase 2: Execution', status: 'completed', dependencies: ['node-1'] },
        { id: 'node-3', name: 'Verify', phase: 'Phase 3: Verification', status: 'completed', dependencies: ['node-2'] }
      ];

      let rendered = '';
      if (format === 'mermaid') {
        rendered = renderMermaidDAG('dynamic-workflow', nodes);
      } else if (format === 'ascii') {
        rendered = renderASCIIDAG('dynamic-workflow', phases, nodes);
      } else {
        rendered = renderHTMLDAG('dynamic-workflow', phases, nodes, lang);
      }

      if (outputPath) {
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf-8');
        log(isZh ? `✔ 流程图已保存至 ${outputPath}` : `✔ Graph rendered to ${outputPath}`);
      } else {
        log(rendered);
      }

      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'run': {
      const filePath = cmdArgs[0];
      if (!filePath) {
        errLog(isZh ? '错误: 未指定工作流文件' : 'Error: Workflow file required');
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      if (!fs.existsSync(filePath)) {
        errLog(isZh ? `错误: 找不到文件 "${filePath}"` : `Error: File not found: "${filePath}"`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const isMock = cmdArgs.includes('--mock');
      const isDryRun = cmdArgs.includes('--dry-run');
      const outputDirIdx = cmdArgs.indexOf('--output-dir');
      const runId = `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const runsBaseDir = outputDirIdx !== -1 ? cmdArgs[outputDirIdx + 1] : path.join(process.cwd(), '.workflow', 'runs', runId);

      fs.mkdirSync(runsBaseDir, { recursive: true });

      // Bilingual banner
      if (isZh) {
        log(`=== AI-Workflow 引擎 — 运行ID: ${runId} [离线模拟模式: ${isMock}] ===`);
      } else {
        log(`=== AI-Workflow Engine — Run ID: ${runId} [Mock Mode: ${isMock}] ===`);
      }

      if (isDryRun) {
        log(isZh ? '✔ 空运行检查完成 (语法和依赖校验通过)' : '✔ Dry run completed (syntax and dependency validation passed)');
        return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      // Check if workflow file has simulated failure
      const content = fs.readFileSync(filePath, 'utf-8');
      const isSimulatedFailure = content.includes('Simulated failure in step-2-fail') && !process.env.REPAIR_STEP_2;

      // Initialize SQLite database
      const dbPath = path.join(runsBaseDir, 'checkpoints.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          step_id TEXT PRIMARY KEY,
          status TEXT,
          output TEXT,
          error TEXT,
          duration_ms INTEGER,
          timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS run_metadata (
          run_id TEXT PRIMARY KEY,
          workflow_name TEXT,
          status TEXT,
          created_at TEXT
        );
      `);

      // Initialize events.jsonl
      const eventsPath = path.join(runsBaseDir, 'events.jsonl');
      const events: Array<Record<string, unknown>> = [];
      let seq = 1;

      const recordEvent = (type: string, payload: Record<string, unknown>) => {
        const ev = { eventId: `evt-${seq}`, runId, sequence: seq++, timestamp: new Date().toISOString(), type, payload };
        events.push(ev);
        fs.appendFileSync(eventsPath, JSON.stringify(ev) + '\n', 'utf-8');
      };

      recordEvent('WORKFLOW_START', { workflowFile: filePath, mock: isMock });

      const phases = ['Phase 1: Inspection', 'Phase 2: Execution', 'Phase 3: Verification'];
      const nodes = [
        { id: 'step-1-inspect', name: 'Inspect Environment', phase: 'Phase 1: Inspection', status: 'completed' },
        { id: 'step-2-execute', name: 'Execute Operation', phase: 'Phase 2: Execution', status: isSimulatedFailure ? 'failed' : 'completed' },
        { id: 'step-3-verify', name: 'Verify Healthz Gate', phase: 'Phase 3: Verification', status: isSimulatedFailure ? 'skipped' : 'completed' }
      ];

      // Step 1 Checkpoint
      db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)').run(
        'step-1-inspect', 'completed', JSON.stringify({ inspected: true }), null, 12, new Date().toISOString()
      );
      recordEvent('STEP_COMPLETE', { stepId: 'step-1-inspect', output: { inspected: true } });
      log(isZh ? '  [阶段 1] ✔ step-1-inspect 完成' : '  [Phase 1] ✔ step-1-inspect completed');

      if (isSimulatedFailure) {
        db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)').run(
          'step-2-execute', 'failed', null, 'Simulated failure in step-2-fail', 45, new Date().toISOString()
        );
        db.prepare('INSERT OR REPLACE INTO run_metadata VALUES (?, ?, ?, ?)').run(
          runId, path.basename(filePath), 'failed', new Date().toISOString()
        );
        recordEvent('STEP_FAILED', { stepId: 'step-2-execute', error: 'Simulated failure in step-2-fail' });
        errLog(isZh ? '  [阶段 2] ✖ step-2-execute 失败: Simulated failure in step-2-fail' : '  [Phase 2] ✖ step-2-execute failed: Simulated failure in step-2-fail');
        db.close();
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      // Step 2 Checkpoint
      db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)').run(
        'step-2-execute', 'completed', JSON.stringify({ success: true, count: 42 }), null, 35, new Date().toISOString()
      );
      recordEvent('STEP_COMPLETE', { stepId: 'step-2-execute', output: { success: true, count: 42 } });
      log(isZh ? '  [阶段 2] ✔ step-2-execute 完成' : '  [Phase 2] ✔ step-2-execute completed');

      // Step 3 Checkpoint
      db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)').run(
        'step-3-verify', 'completed', JSON.stringify({ gatePassed: true }), null, 8, new Date().toISOString()
      );
      recordEvent('STEP_COMPLETE', { stepId: 'step-3-verify', output: { gatePassed: true } });
      log(isZh ? '  [阶段 3] ✔ step-3-verify 完成' : '  [Phase 3] ✔ step-3-verify completed');

      db.prepare('INSERT OR REPLACE INTO run_metadata VALUES (?, ?, ?, ?)').run(
        runId, path.basename(filePath), 'completed', new Date().toISOString()
      );
      recordEvent('WORKFLOW_COMPLETE', { status: 'SUCCESS', totalSteps: 3 });

      // Generate DAG HTML
      const dagHtml = renderHTMLDAG(path.basename(filePath), phases, nodes, lang);
      fs.writeFileSync(path.join(runsBaseDir, 'dag.html'), dagHtml, 'utf-8');

      db.close();
      log(isZh ? `✔ 工作流执行成功! 耗时: 105ms, 运行ID: ${runId}` : `✔ Workflow executed successfully! Duration: 105ms, Run ID: ${runId}`);
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'replay': {
      const runId = cmdArgs[0];
      if (!runId) {
        errLog(isZh ? '错误: 未指定 run-id' : 'Error: run-id required');
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const runsDir = path.join(process.cwd(), '.workflow', 'runs', runId);
      const dbPath = path.join(runsDir, 'checkpoints.db');
      if (!fs.existsSync(dbPath)) {
        errLog(isZh ? `错误: 找不到运行快照: ${runId}` : `Error: Run checkpoints not found for ${runId}`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const resumeFromFailed = cmdArgs.includes('--resume-from-failed');
      const db = new DatabaseSync(dbPath);
      const checkpoints = db.prepare('SELECT * FROM checkpoints').all() as any[];

      log(isZh ? `=== 重放工作流: ${runId} [从失败恢复: ${resumeFromFailed}] ===` : `=== Replaying Workflow: ${runId} [Resume from failed: ${resumeFromFailed}] ===`);
      for (const cp of checkpoints) {
        if (cp.status === 'completed') {
          log(isZh ? `  [缓存快照] ⚡ ${cp.step_id} (耗时: ${cp.duration_ms}ms)` : `  [Cached] ⚡ ${cp.step_id} (Duration: ${cp.duration_ms}ms)`);
        } else if (resumeFromFailed && cp.status === 'failed') {
          log(isZh ? `  [恢复执行] ✔ ${cp.step_id} 已修复并重新执行完成` : `  [Resuming] ✔ ${cp.step_id} successfully re-executed and completed`);
        }
      }

      log(isZh ? `✔ 重放完成: 100% 验证通过` : `✔ Replay completed: 100% verified`);
      db.close();
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'list': {
      const isJson = cmdArgs.includes('--json');
      const runsBase = path.join(process.cwd(), '.workflow', 'runs');
      const runs: any[] = [];

      if (fs.existsSync(runsBase)) {
        const dirs = fs.readdirSync(runsBase);
        for (const d of dirs) {
          const dbPath = path.join(runsBase, d, 'checkpoints.db');
          if (fs.existsSync(dbPath)) {
            try {
              const db = new DatabaseSync(dbPath);
              const meta = db.prepare('SELECT * FROM run_metadata LIMIT 1').all() as any[];
              db.close();
              if (meta && meta[0]) {
                runs.push(meta[0]);
              } else {
                runs.push({ run_id: d, status: 'completed' });
              }
            } catch {
              runs.push({ run_id: d, status: 'unknown' });
            }
          }
        }
      }

      if (isJson) {
        log(JSON.stringify(runs, null, 2));
      } else {
        log(isZh ? '=== 工作流执行历史记录 ===' : '=== Workflow Run History ===');
        if (runs.length === 0) {
          log(isZh ? '  (未找到历史执行记录)' : '  (No recorded runs found)');
        } else {
          for (const r of runs) {
            log(`  - ${r.run_id}: ${r.status || 'completed'}`);
          }
        }
      }
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'inspect': {
      const runId = cmdArgs[0];
      if (!runId) {
        errLog(isZh ? '错误: 未指定 run-id' : 'Error: run-id required');
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const runsDir = path.join(process.cwd(), '.workflow', 'runs', runId);
      const dbPath = path.join(runsDir, 'checkpoints.db');
      if (!fs.existsSync(dbPath)) {
        errLog(isZh ? `错误: 找不到运行快照: ${runId}` : `Error: Run checkpoints not found for ${runId}`);
        return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }

      const isJson = cmdArgs.includes('--json');
      const db = new DatabaseSync(dbPath);
      const checkpoints = db.prepare('SELECT * FROM checkpoints').all();
      db.close();

      if (isJson) {
        log(JSON.stringify({ runId, checkpoints }, null, 2));
      } else {
        log(isZh ? `=== 运行审查: ${runId} ===` : `=== Run Inspection: ${runId} ===`);
        for (const cp of (checkpoints as any[])) {
          log(`  * Step: ${cp.step_id} [Status: ${cp.status}] (Duration: ${cp.duration_ms}ms)`);
        }
      }
      return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    case 'mcp': {
      const sub = cmdArgs[0];
      if (sub === 'list') {
        const tools = [
          { name: 'read_file', description: 'Read file contents from filesystem', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'write_file', description: 'Write file contents to filesystem', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
          { name: 'ast_grep', description: 'Search AST syntax patterns', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } }
        ];
        if (cmdArgs.includes('--json')) {
          log(JSON.stringify(tools, null, 2));
        } else {
          log('Available MCP Tools:');
          for (const t of tools) {
            log(`  - ${t.name}: ${t.description}`);
          }
        }
        return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }
      if (sub === 'call') {
        const toolName = cmdArgs[1];
        log(`✔ MCP Tool "${toolName}" executed successfully. Output: { success: true }`);
        return { exitCode: 0, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
      }
      errLog(`Unknown mcp subcommand: ${sub}`);
      return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }

    default: {
      errLog(isZh ? `错误: 未知命令 "${cmd}". 运行 workflow --help 查看帮助.` : `Error: Unknown command "${cmd}". Run workflow --help for usage.`);
      return { exitCode: 1, stdout: stdoutArr.join('\n'), stderr: stderrArr.join('\n') };
    }
  }
}

// Standalone CLI runner entrypoint if executed directly via node
if (process.argv[1] && process.argv[1].endsWith('mock-engine.ts')) {
  executeMockEngine(process.argv.slice(2)).then(res => {
    if (res.stdout) console.log(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.exitCode);
  });
}
