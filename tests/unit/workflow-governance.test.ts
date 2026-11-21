import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(startDir, '../..');
}

const REPO_ROOT = findRepoRoot(__dirname);
const gateScriptUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts/pr_review_gate.mjs')).href;
const baselineSampleUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts/baseline_sample.mjs')).href;
const {
  checkIssueLinkage,
  checkFingerprint,
  checkTapLogBinding,
  checkFailureNaming,
  checkCoolingPeriod,
  checkReviewComments,
  checkNoCommentClaims,
  checkWorktreeCleanliness,
  checkCiGateConclusion,
  findOrphanWorktrees,
} = await import(gateScriptUrl);
const { parseTapSummary, formatRoundFingerprint } = await import(baselineSampleUrl);

// Issue #68: behavior locks import the real behavior surfaces from the dist
// build. The governance test must run both from src under strip-types and
// compiled from dist under plain node — a literal .ts specifier would break
// the latter, so dist is the only import path that works in both modes (the
// §4 gate chain runs build first, so it is fresh). The imports ride VARIABLE
// module URLs (same pattern as the gate script import above): a literal dist
// specifier would drag the dist tree into tsc's input set and trip TS5055
// (declaration emit would overwrite its own outputs).
const distEventsUrl = pathToFileURL(path.join(REPO_ROOT, 'dist/src/domain/events.js')).href;
const distProjectionUrl = pathToFileURL(path.join(REPO_ROOT, 'dist/src/dag/journal-projection.js')).href;
const { WORKFLOW_EVENT } = await import(distEventsUrl) as { WORKFLOW_EVENT: Record<string, string> };
const { projectEventsToGraph } = await import(distProjectionUrl) as {
  projectEventsToGraph: (events: Array<Record<string, unknown>>) => { status: string };
};

describe('Workflow & Governance Specification Suite Invariant Locks', () => {

  const requiredFiles = [
    'AGENTS.md',
    'docs/WORKFLOW.md',
    'docs/README.md',
    'docs/AI-PITFALLS.md',
    'docs/AI-EVIDENCE-STANDARD.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/governance.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    'scripts/pr_review_gate.mjs',
    'scripts/baseline_sample.mjs',
  ];

  test('Tier 1: All required workflow governance files must physically exist', () => {
    for (const relPath of requiredFiles) {
      const fullPath = path.join(REPO_ROOT, relPath);
      assert.ok(
        fs.existsSync(fullPath),
        `Required workflow governance file missing: "${relPath}" at ${fullPath}`
      );
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 50, `Governance file "${relPath}" is unexpectedly small (${stat.size} bytes)`);
    }
  });

  test('Tier 1: Issue-Driven & "无 Issue 不开工" rule must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '无 Issue 不开工',
      'gh issue create',
      'issue-',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Issue-Driven token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Issue-Driven token: "${token}"`);
    }

    // Verify branch naming convention is explicitly documented
    assert.ok(
      workflowMd.includes('feat/issue-') || workflowMd.includes('issue-<id>'),
      'docs/WORKFLOW.md must document issue-based branch naming format'
    );

    // Issue #68: the "Closes #" discipline is BEHAVIOR-locked against the
    // gate's exported check, not doc-text-locked — deleting the AGENTS.md
    // phrase used to leave the enforcement path free to regress silently
    // (the old token assertion stayed green while pr_review_gate.mjs:66
    // was neutered). A PR body without an issue linkage must produce a
    // violation; a linked body must pass.
    const unlinked = checkIssueLinkage('## 变更说明\n\n修复了一个缺陷，未声明关联 Issue。');
    assert.ok(
      unlinked.violations.length > 0,
      'a PR body without "Closes #NNN" must violate the Issue-Driven gate'
    );
    assert.match(unlinked.violations.join('\n'), /Issue/, 'the violation names the missing Issue linkage');
    const linked = checkIssueLinkage('## 变更说明\n\n修复缺陷。\n\nCloses #123');
    assert.equal(linked.violations.length, 0, 'a body carrying Closes #NNN passes the linkage gate');
  });

  test('Tier 1: Issue Template configuration must be well-formed', () => {
    const configPath = path.join(REPO_ROOT, '.github/ISSUE_TEMPLATE/config.yml');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    assert.ok(configContent.includes('blank_issues_enabled: false'), 'config.yml must disable blank issues');
  });

  test('Tier 1: Remote CI must exist and mirror the local gate chain (restored 2026-11-14, Issue #7)', () => {
    // 2026-11-09 用户拍板移除 CI（Issue #203：私有仓 Actions 额度频繁耗尽）。
    // 2026-11-14 用户重新拍板恢复（Issue #7）：比赛仓库为公开仓，GitHub Actions
    // 对公开仓免费（runner 分钟数只对私有仓计费），额度前提不复存在，且 Linux
    // 侧验证此前零覆盖。本机门禁链（AGENTS.md §四）仍是合入放行的第一判据，
    // 远端 CI 是公开可信信号与跨平台验证面——两链并存，互不替代。
    const ciPath = path.join(REPO_ROOT, '.github/workflows/ci.yml');
    assert.ok(
      fs.existsSync(ciPath),
      '.github/workflows/ci.yml must exist: remote CI was restored by user decision ' +
      '(Issue #7, 2026-11-14) and must mirror the local gate chain.'
    );
    const ciYml = fs.readFileSync(ciPath, 'utf-8');
    const requiredSteps = [
      'npm run test:unit',
      'npm run test:integration',
      'npm run test:pbt',
      'npm run test:governance',
      'npm run test:e2e',
      'npm run test:adversarial',
      'scripts/demo.sh',
    ];
    for (const step of requiredSteps) {
      assert.ok(ciYml.includes(step), `ci.yml must mirror the local gate step: ${step}`);
    }

    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    assert.ok(
      agentsMd.includes('Issue #7'),
      'AGENTS.md must record the CI restoration decision (Issue #7, 2026-11-14)'
    );
    const readmeMd = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    assert.ok(
      readmeMd.includes('actions/workflows/ci.yml/badge.svg'),
      'README.md must surface the CI badge (restored per Issue #7)'
    );
  });

  test('Tier 1: Docs-First lookup obligation must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '查阅文档优先',
      'docs/README.md',
      '代码优先于文档',
      '明说不确定并问人',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Docs-First token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Docs-First token: "${token}"`);
    }
  });

  test('Tier 1: AI Pitfalls ledger obligations must be locked in AGENTS.md, WORKFLOW.md, and AI-PITFALLS.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');
    const pitfallsMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-PITFALLS.md'), 'utf-8');

    const expectedTokens = [
      'docs/AI-PITFALLS.md',
      'G1 反复',
      'G2 单次高代价',
      'G3 已成强制',
      '只增不删',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Pitfalls token: "${token}"`);
      assert.ok(pitfallsMd.includes(token), `docs/AI-PITFALLS.md must include Pitfalls token: "${token}"`);
    }

    assert.ok(workflowMd.includes('docs/AI-PITFALLS.md'), 'docs/WORKFLOW.md must reference docs/AI-PITFALLS.md');
    assert.ok(pitfallsMd.includes('P-ENV-1'), 'AI-PITFALLS.md must contain P-ENV-1');
    assert.ok(pitfallsMd.includes('P-ENV-2'), 'AI-PITFALLS.md must contain P-ENV-2');
    assert.ok(pitfallsMd.includes('P-GIT-1'), 'AI-PITFALLS.md must contain P-GIT-1');
    assert.ok(pitfallsMd.includes('P-TEST-1'), 'AI-PITFALLS.md must contain P-TEST-1');
    assert.ok(pitfallsMd.includes('P-TEST-2'), 'AI-PITFALLS.md must contain P-TEST-2');
    assert.ok(pitfallsMd.includes('P-BUILD-1'), 'AI-PITFALLS.md must contain P-BUILD-1');
    assert.ok(pitfallsMd.includes('P-SEC-1'), 'AI-PITFALLS.md must contain P-SEC-1');
  });

  test('Tier 1: Subagent orchestration rules must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = ['总代理', '子代理', '抽查复核'];
    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Subagent Orchestration token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Subagent Orchestration token: "${token}"`);
    }
  });

  test('Tier 1: Minimal change two-tier discipline must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '最小改动',
      '两档制',
      '常规档',
      '重构档',
      '就地改',
      '不新建',
      '不夹带',
      'git diff --stat',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Minimal Change token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Minimal Change token: "${token}"`);
    }
  });

  test('Tier 1: Artifact cleanup and "用完即删" discipline must be locked', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    assert.ok(agentsMd.includes('用完即删'), 'AGENTS.md must include "用完即删"');
    assert.ok(agentsMd.includes('中间产物'), 'AGENTS.md must include "中间产物"');
    assert.ok(workflowMd.includes('用完即删'), 'docs/WORKFLOW.md must include "用完即删"');
  });

  test('Tier 1: User error correction obligation must be locked', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    assert.ok(agentsMd.includes('假定用户会出错'), 'AGENTS.md must include "假定用户会出错"');
    assert.ok(agentsMd.includes('当场指出'), 'AGENTS.md must include "当场指出"');
    assert.ok(agentsMd.includes('指出 ≠ 越权'), 'AGENTS.md must include "指出 ≠ 越权"');
    assert.ok(workflowMd.includes('假定用户会出错'), 'docs/WORKFLOW.md must include "假定用户会出错"');
  });

  test('Tier 1: Evidence-driven standards and 3-tier assertions must be locked', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');
    const evidenceMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-EVIDENCE-STANDARD.md'), 'utf-8');

    const expectedTokens = [
      '证据驱动',
      '已验证',
      '推断',
      '未知',
      '人数不是证据',
      '3 次失败停机',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Evidence token: "${token}"`);
      assert.ok(evidenceMd.includes(token), `docs/AI-EVIDENCE-STANDARD.md must include Evidence token: "${token}"`);
    }

    assert.ok(workflowMd.includes('三档主张'), 'docs/WORKFLOW.md must include 三档主张');
    assert.ok(evidenceMd.includes('A 类'), 'docs/AI-EVIDENCE-STANDARD.md must include A 类');
    assert.ok(evidenceMd.includes('E 类'), 'docs/AI-EVIDENCE-STANDARD.md must include E 类');
  });

  test('Tier 1: Git Worktree physical isolation discipline must be locked', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '主仓',
      'worktree',
      'git branch --show-current',
      'gh pr merge',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Worktree token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Worktree token: "${token}"`);
    }

    // Forbidden anti-patterns
    const forbidden = [
      '可以直接在主仓改',
      '允许在主仓修改',
      '不必建 worktree',
      '无需 worktree',
    ];

    for (const phrase of forbidden) {
      assert.ok(!agentsMd.includes(phrase), `AGENTS.md must NOT contain anti-pattern: "${phrase}"`);
      assert.ok(!workflowMd.includes(phrase), `docs/WORKFLOW.md must NOT contain anti-pattern: "${phrase}"`);
    }
  });

  test('Tier 1: Review comment duty must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '主动回看',
      '逐条甄别',
      '必回一条回音',
      '已处理',
      '刻意不改',
      '需人拍板',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Review Duty token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Review Duty token: "${token}"`);
    }
  });

  test('Tier 1: Post-merge closeout 3 actions must be locked in AGENTS.md and WORKFLOW.md', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    const expectedTokens = [
      '收尾必做三件事',
      '清理中间产物',
      '该评论则评论',
      '该关闭则关闭',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Closeout token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Closeout token: "${token}"`);
    }
  });

  test('Tier 1: Doc-sync discipline must be locked in AGENTS.md, WORKFLOW.md, and PR template', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');
    const prTemplate = fs.readFileSync(path.join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf-8');

    const expectedTokens = [
      '文档同步',
      '受影响文档',
      '过时文档',
      '无文档影响',
    ];

    for (const token of expectedTokens) {
      assert.ok(agentsMd.includes(token), `AGENTS.md must include Doc-Sync token: "${token}"`);
      assert.ok(workflowMd.includes(token), `docs/WORKFLOW.md must include Doc-Sync token: "${token}"`);
    }

    // The PR template must operationalize AGENTS.md §1.11 as a pre-PR self-check item
    assert.ok(prTemplate.includes('§1.11'), '.github/PULL_REQUEST_TEMPLATE.md must reference AGENTS.md §1.11 doc-sync duty');
    assert.ok(prTemplate.includes('无文档影响'), '.github/PULL_REQUEST_TEMPLATE.md must offer the "无文档影响" declaration path');
  });

  test('Tier 2: Strict exclusion of trading/stock/crypto domain contamination', () => {
    const filesToCheck = [
      'AGENTS.md',
      'docs/WORKFLOW.md',
      'docs/README.md',
      'docs/AI-PITFALLS.md',
      'docs/AI-EVIDENCE-STANDARD.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
    ];

    const forbiddenDomainKeywords = [
      'crypto',
      'binance',
      '开仓',
      '平仓',
      '杠杆',
      '止损',
      '两本账',
      '实盘战绩',
      '顺风车阶梯',
      '跌幅保护',
      'paper broker',
      'trading-rules',
    ];

    for (const relPath of filesToCheck) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8').toLowerCase();
      for (const kw of forbiddenDomainKeywords) {
        assert.ok(
          !content.includes(kw.toLowerCase()),
          `Contamination detected: File "${relPath}" must NOT contain trading keyword "${kw}"`
        );
      }
    }
  });

  test('Tier 2: Windows PowerShell npm.cmd invocation guidelines must be enforced', () => {
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');
    const pitfallsMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-PITFALLS.md'), 'utf-8');

    assert.ok(workflowMd.includes('npm.cmd run build'), 'docs/WORKFLOW.md must mandate "npm.cmd run build"');
    assert.ok(workflowMd.includes('npm.cmd run test:unit'), 'docs/WORKFLOW.md must mandate "npm.cmd run test:unit"');
    assert.ok(pitfallsMd.includes('npm.cmd'), 'docs/AI-PITFALLS.md must specify npm.cmd in P-ENV-1');
  });

  test('Tier 2: offline SDK fixture bootstrap must precede the integration gate script (Issue #233)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const integrationScript: string = pkg.scripts['test:integration'];
    assert.ok(
      integrationScript.startsWith('node scripts/bootstrap-fixtures.mjs && '),
      'package.json test:integration must bootstrap the offline SDK fixture stubs before running (P-ENV-4, Issue #233)',
    );
    const pitfallsMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-PITFALLS.md'), 'utf-8');
    assert.ok(pitfallsMd.includes('P-ENV-4'), 'docs/AI-PITFALLS.md must contain P-ENV-4');
  });

  test('Tier 2: package.json must provide cross-platform demo and demo:nine-acts entries (Issue #179)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.equal(
      pkg.scripts['demo'],
      'node bin/workflow.js demo',
      'package.json must provide "demo": "node bin/workflow.js demo" for cross-platform execution (Issue #179)',
    );
    assert.equal(
      pkg.scripts['demo:nine-acts'],
      'bash scripts/demo.sh',
      'package.json must provide "demo:nine-acts": "bash scripts/demo.sh" for the full nine-act suite (Issue #179)',
    );
    const readmeMd = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    assert.ok(
      readmeMd.includes('node bin/workflow.js demo') && readmeMd.includes('npm run demo'),
      'README.md must guide judges with cross-platform node bin/workflow.js demo and npm run demo (Issue #179)',
    );
    const submissionMd = fs.readFileSync(path.join(REPO_ROOT, 'SUBMISSION.md'), 'utf-8');
    assert.ok(
      submissionMd.includes('node bin/workflow.js demo') && submissionMd.includes('npm run demo'),
      'SUBMISSION.md must guide judges with cross-platform node bin/workflow.js demo and npm run demo (Issue #179)',
    );
  });

  test('Tier 2: WORKFLOW.md must prescribe per-worktree npm ci and forbid node_modules junction sharing (P-ENV-3, Issue #15)', () => {
    const workflowMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/WORKFLOW.md'), 'utf-8');

    assert.ok(
      !workflowMd.includes('mklink /J'),
      'docs/WORKFLOW.md must NOT recommend node_modules junction sharing: the shared node_modules/ai-workflow ' +
      'self-link resolves imports to another checkout dist (version skew, fake-green fingerprints — P-ENV-3)',
    );
    assert.ok(
      workflowMd.includes('npm.cmd ci'),
      'docs/WORKFLOW.md must prescribe per-worktree "npm.cmd ci" (postinstall self-link + fixture bootstrap)',
    );
    const pitfallsMd = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-PITFALLS.md'), 'utf-8');
    assert.ok(
      pitfallsMd.includes('P-ENV-3') && pitfallsMd.includes('2026-11-15，Issue #15'),
      'docs/AI-PITFALLS.md P-ENV-3 must record the 3rd instance and its status update (trigger removed)',
    );
  });

  test('Tier 2: .kiro/mcp/mcp-server.json tool face is locked to TOOL_CATALOG (Issue #118)', async () => {
    // The Kiro MCP manifest used to register only the 5 legacy tools while the
    // served catalog grew to 10 (the facade face was missing) — and nothing
    // locked it, unlike .codex/tools.json which is byte-identical-locked.
    //
    // TOOL_CATALOG is loaded from dist via a runtime file-URL import: this gate
    // runs directly on the source tree with --experimental-strip-types, where
    // static `.js` specifiers do not rewrite to `.ts`, and a static import of
    // the excluded dist tree breaks `tsc` (Issue #118 follow-up). dist is
    // produced by gate 1 before this gate runs.
    const manifestPath = path.join(REPO_ROOT, '.kiro', 'mcp', 'mcp-server.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      mcpServers?: Record<string, { tools?: Array<{ name: string }> }>;
    };
    const catalogUrl = pathToFileURL(path.join(REPO_ROOT, 'dist', 'src', 'mcp', 'tool-catalog.js')).href;
    const catalogModule = (await import(catalogUrl)) as { TOOL_CATALOG: Array<{ name: string }> };
    const declared = (manifest.mcpServers?.['ai-workflow-engine']?.tools ?? [])
      .map((tool) => tool.name)
      .sort();
    const catalog = catalogModule.TOOL_CATALOG.map((tool: { name: string }) => tool.name).sort();
    assert.deepStrictEqual(
      declared,
      catalog,
      'the Kiro MCP manifest must register exactly the TOOL_CATALOG tool face (Issue #118) — ' +
        'add/remove tools in both places together',
    );
  });

  test('Tier 2: registry completeness reverse check — every docs/ markdown must be registered in docs/README.md (Issue #25)', () => {
    // docs/README.md §三.1 claims the governance gate verifies registry
    // completeness ("校验登记完整性，防止文档游离失管"). The forward check
    // (requiredFiles → exists) alone does not make that claim true: Issue #25
    // found 7 research documents living under docs/research/ unregistered.
    // This is the reverse direction: every markdown document under docs/ must
    // be registered in the docs/README.md index — either by its own path
    // token (e.g. `docs/research/X.md`) or by a deliberate directory token
    // for its parent (e.g. `docs/i18n/`). Reasonable scope: markdown
    // documents only — binary/static resources (docs/assets/*.png) and test
    // fixtures/runtime artifacts are not registry objects and stay out.
    const indexContent = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'README.md'), 'utf-8');
    const registryTokens = new Set<string>();
    for (const m of indexContent.matchAll(/`(docs\/[A-Za-z0-9._\-/]+)`/g)) {
      registryTokens.add(m[1]);
    }

    const unregistered: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.md')) {
          const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
          const parentRel = rel.slice(0, rel.lastIndexOf('/'));
          const registered =
            registryTokens.has(rel) ||
            (parentRel !== 'docs' && registryTokens.has(parentRel + '/'));
          if (!registered) unregistered.push(rel);
        }
      }
    };
    walk(path.join(REPO_ROOT, 'docs'));
    assert.deepStrictEqual(
      unregistered,
      [],
      'Markdown documents under docs/ must be registered in docs/README.md (reverse registry check, Issue #25). Unregistered: ' + unregistered.join(', ')
    );
  });

  test('Tier 3: PR Review Gate script functionality - checkIssueLinkage', () => {
    // Valid: Closes #18
    const r1 = checkIssueLinkage('Fixes the bug.\n\nCloses #18');
    assert.ok(r1.valid, 'Closes #18 should pass issue linkage check');
    assert.equal(r1.issueNumber, '18');

    // Valid: Fixes #42
    const r2 = checkIssueLinkage('Resolves issue\n\nFixes #42');
    assert.ok(r2.valid, 'Fixes #42 should pass issue linkage check');
    assert.equal(r2.issueNumber, '42');

    // Valid: GitHub full URL
    const r3 = checkIssueLinkage('Related: https://github.com/LitaoG/AI-workflow/issues/99');
    assert.ok(r3.valid, 'GitHub URL should pass issue linkage check');
    assert.equal(r3.issueNumber, '99');

    // Invalid: No issue link
    const r4 = checkIssueLinkage('Just some changes without issue reference.');
    assert.ok(!r4.valid, 'Missing issue link should fail checkIssueLinkage');
    assert.ok(r4.violations.some((v: string) => v.includes('缺少对 Issue 的明确关联')));
  });

  test('Tier 3: PR Review Gate script functionality - checkFingerprint', () => {
    // Valid fingerprint without placeholders (fail-accounted shape only —
    // Issue #158 dropped the fail-blind "Ran N tests" shape)
    const validContent = `
# Title
pass 42, fail 0
All verified cleanly.
`;
    const res1 = checkFingerprint(validContent);
    assert.ok(res1.valid, 'Valid fingerprint should pass checkFingerprint');

    // Invalid: missing fingerprint
    const noFpContent = `
# Title
Code changes completed.
`;
    const res2 = checkFingerprint(noFpContent);
    assert.ok(!res2.valid, 'Missing fingerprint should fail checkFingerprint');
    assert.ok(res2.violations.some((v: string) => v.includes('测试输出指纹')));

    // Issue #158: the fail-blind "Ran N tests" shape is hand-forgable and no
    // longer accepted — a lone forged line must be rejected.
    const forgedContent = `
# Title
Ran 500 tests
`;
    const forged = checkFingerprint(forgedContent);
    assert.ok(!forged.valid, 'the fail-blind "Ran N tests" shape must be rejected');
    assert.ok(forged.violations.some((v: string) => v.includes('Ran N tests')));

    // Invalid: contains placeholder
    const placeholderContent = `
# Title
pass 10, fail 0
{{PLACEHOLDER_DESCRIPTION}}
`;
    const res3 = checkFingerprint(placeholderContent);
    assert.ok(!res3.valid, 'Contains placeholder should fail checkFingerprint');
    assert.ok(res3.violations.some((v: string) => v.includes('占位符')));
  });

  test('Tier 3: PR Review Gate script functionality - checkTapLogBinding (Issue #158)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-tap-binding-'));
    try {
      const tapPath = path.join(dir, 'tap.log');
      // Missing tap.log: the gate refuses to trust a body that never faced a run.
      const missing = checkTapLogBinding('tests 42\npass 42, fail 0', tapPath);
      assert.ok(!missing.valid, 'a missing .gate/tap.log must block the fingerprint');
      assert.ok(missing.violations.some((v: string) => v.includes('npm test')));

      fs.writeFileSync(tapPath, [
        'TAP version 13',
        '# Subtest: something',
        'ok 1 - something',
        '# tests 42',
        '# pass 42',
        '# fail 0',
        '',
      ].join('\n'));

      // Matching numbers pass; a mismatched or forged body is refused.
      const bound = checkTapLogBinding('# Title\n\ntests 42 / pass 42, fail 0\n', tapPath);
      assert.ok(bound.valid, `a body matching the TAP summary must pass: ${JSON.stringify(bound.violations)}`);
      assert.ok(bound.tap && bound.tap.tests === 42 && bound.tap.fail === 0);
      const tapForm = checkTapLogBinding('# Title\n\n# tests 42 / # pass 42 / # fail 0\n', tapPath);
      assert.ok(tapForm.valid, `the verbatim npm-test TAP output form must pass: ${JSON.stringify(tapForm.violations)}`);

      const mismatch = checkTapLogBinding('# Title\n\ntests 500 / pass 500, fail 0\n', tapPath);
      assert.ok(!mismatch.valid, 'hand-forged numbers that disagree with the TAP must be refused');
      assert.ok(mismatch.violations.some((v: string) => v.includes('不一致')));

      fs.writeFileSync(tapPath, [
        'TAP version 13',
        'not ok 1 - something failed',
        '# tests 42',
        '# pass 41',
        '# fail 1',
        '',
      ].join('\n'));
      const red = checkTapLogBinding('# Title\n\ntests 42 / pass 41, fail 1\n', tapPath);
      assert.ok(!red.valid, 'a failing run must not be merged');
      assert.ok(red.violations.some((v: string) => v.includes('fail 1')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Tier 3: PR Review Gate script functionality - checkFailureNaming (Issue #32)', () => {
    // Invalid: non-zero fail count without not ok lines (the Issue #32 defect)
    const failWithoutNames = `
基线门禁指纹:
tests 238 pass 237, fail 1
`;
    const r1 = checkFailureNaming(failWithoutNames);
    assert.ok(!r1.valid, 'fail>0 without not ok names must be rejected');
    assert.ok(r1.violations.some((v: string) => v.includes('not ok 行名')));

    // Valid: non-zero fail count WITH not ok names
    const failWithNames = `
基线门禁指纹:
tests 238 pass 237, fail 1
not ok 42 - stdio e2e: real spawn lists all seven tools
`;
    const r2 = checkFailureNaming(failWithNames);
    assert.ok(r2.valid, 'fail>0 with not ok names must pass');
    assert.equal(r2.failedCount, 1);

    // Valid: all green (fail 0) needs no not ok lines
    const allGreen = `
tests 212 pass 212, fail 0
`;
    const r3 = checkFailureNaming(allGreen);
    assert.ok(r3.valid, 'fail=0 needs no not ok lines');
    assert.equal(r3.failedCount, 0);

    // Invalid: multiple fingerprints where a later one is red (first-match-only would miss it)
    const greenThenRed = `
修复后 pass 342, fail 0
修复前 pass 237, fail 1
`;
    const r4 = checkFailureNaming(greenThenRed);
    assert.ok(!r4.valid, 'any red fingerprint must be enforced, not just the first one');
    assert.equal(r4.failedCount, 1);

    // Anchored match only: 'not ok' mid-sentence must NOT count as a name record
    const midSentence = `
baseline shows the not ok lines were lost, tests 10 pass 9, fail 1
`;
    const r5 = checkFailureNaming(midSentence);
    assert.ok(!r5.valid, 'prose mentioning "not ok" must not satisfy the anchored name requirement');
  });

  test('Tier 3: PR Review Gate judgment hardening (Issue #109) — case1: an unrelated comment cannot clear a review finding', () => {
    // A review finding is only cleared by a later NON-review comment that cites
    // the finding id (F1…) AND carries a三态 keyword — a keyword-free remark
    // about anything else must leave the finding unresolved.
    const comments = [
      { body: '## 监督席\nF1 close 排空会派发 ask', createdAt: '2026-11-08T01:00:00Z' },
      { body: 'CI 的 node 版本已改为 22', createdAt: '2026-11-08T02:00:00Z' },
    ];
    const res = checkReviewComments(comments as never);
    assert.ok(!res.valid, 'case1: a keyword-free unrelated comment must NOT clear the finding');
    assert.ok(res.unresolvedCount >= 1, 'the F1 finding must remain unresolved');
  });

  test('Tier 3: PR Review Gate judgment hardening (Issue #109) — case2: one reply clears only the finding it cites', () => {
    // Two rounds of findings; the author replied to F2 only. F1 stays open
    // even though the reply contains a resolve keyword.
    const comments = [
      { body: '## 审查意见\nF1 第一步的输入没有落盘', createdAt: '2026-11-08T01:00:00Z' },
      { body: '## 审查意见\n第二轮 F2 回滚顺序不对', createdAt: '2026-11-08T01:30:00Z' },
      { body: 'F2 已处理 @abc123', createdAt: '2026-11-08T02:00:00Z' },
    ];
    const res = checkReviewComments(comments as never);
    assert.ok(!res.valid, 'case2: an uncited finding must stay unresolved');
    assert.equal(res.unresolvedCount, 1, 'only F1 remains');
    assert.match(JSON.stringify(res.unresolvedReviews), /F1/);
  });

  test('Tier 3: PR Review Gate judgment hardening (Issue #109) — case4: a later comment reply clears an earlier REVIEW-form finding', () => {
    // Reviews arrive before comments in the merged timeline (reviews carry
    // submittedAt) — a comment reply must be able to clear a review-form
    // finding without --ack.
    const items = [
      { body: '## 监督席\nF3 停车重放会漏记预算', submittedAt: '2026-11-08T01:00:00Z' },
      { body: 'F3 已处理，commit abc1234', createdAt: '2026-11-08T02:00:00Z' },
    ];
    const res = checkReviewComments(items as never);
    assert.ok(res.valid, 'case4: the merged timeline must let a comment clear an earlier review finding');
    assert.equal(res.unresolvedCount, 0);
  });

  test('Tier 3: PR Review Gate judgment hardening (Issue #109) — fingerprint: a bare "passed" word is not evidence', () => {
    const res = checkFingerprint('Closes #1\n测试还没跑，等 CI passed 再补');
    assert.ok(!res.valid, 'case3: the /passed/i fallback must not satisfy the fingerprint check');
  });

  test('Tier 3: PR Review Gate claim check (Issue #196 S2) — a false "no comments" claim is intercepted', () => {
    // #164/#165/#190 pattern: the body claims the linked issue has no comments
    // while the timeline says otherwise.
    const res = checkNoCommentClaims('Closes #110\n- 已回看：#110 无评论', [
      { body: 'early comment', author: { login: 'someone' }, createdAt: '2026-11-07T10:00:00Z', fromIssue: '110' },
    ]);
    assert.ok(!res.valid, 'a false no-comment claim must fail the gate');
    assert.match(res.violations[0], /#110 实有 1 条评论/);
    assert.match(res.violations[0], /#196 S2/);
  });

  test('Tier 3: PR Review Gate claim check (Issue #196 S2) — a true claim passes and absence of a claim is a no-op', () => {
    const ok = checkNoCommentClaims('Closes #9\n- 该 Issue 无评论', []);
    assert.ok(ok.valid, 'a true no-comment claim passes');
    const noop = checkNoCommentClaims('Closes #9\n- 已逐条交代以下意见：…', [
      { body: 'a comment', author: { login: 'someone' }, createdAt: '2026-11-07T10:00:00Z', fromIssue: '9' },
    ]);
    assert.ok(noop.valid, 'no claim in the body means the check does not fire');
  });

  test('Tier 3: baseline_sample.mjs TAP collector must preserve not ok names (Issue #32)', () => {
    const tap = `
TAP version 13
ok 1 - some passing case
not ok 2 - stdio e2e: real spawn lists all seven tools
  ---
  duration_ms: 30000.1
  ...
# tests 238
# pass 237
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 60196.0531
`;
    const parsed = parseTapSummary(tap);
    assert.equal(parsed.tests, 238);
    assert.equal(parsed.pass, 237);
    assert.equal(parsed.fail, 1);
    assert.ok(parsed.complete, 'complete TAP summary must be detected');
    assert.equal(parsed.notOkLines.length, 1, 'not ok names must be captured, never dropped');
    assert.ok(parsed.notOkLines[0].includes('stdio e2e: real spawn lists all seven tools'));

    // Fingerprint line for a failing round MUST carry the not ok names
    const fp = formatRoundFingerprint(3, parsed);
    assert.ok(fp.includes('fail=1'), 'fingerprint must keep the fail count');
    assert.ok(fp.includes('not_ok=['), 'fingerprint must carry not ok section');
    assert.ok(fp.includes('stdio e2e: real spawn lists all seven tools'), 'fingerprint must name the failing case');

    // Incomplete round (hang truncated by guard) must be flagged, never reported green
    const truncated = parseTapSummary('TAP version 13\nok 1 - partial\n# Subtest: stdio e2e: real spawn lists all seven tools\n');
    assert.ok(!truncated.complete, 'missing TAP summary must be marked INCOMPLETE');
    const fp2 = formatRoundFingerprint(4, truncated);
    assert.ok(fp2.includes('INCOMPLETE'), 'incomplete round fingerprint must say INCOMPLETE');
    assert.ok(fp2.includes('stdio e2e: real spawn lists all seven tools'), 'incomplete round must name the last subtest (hang point)');

    // Zero-test "green" (dist missing / glob matched nothing) must be INCOMPLETE, never green
    // (评审第 1 轮实测: node --test 于空目录 exit 0 且输出 "# tests 0 / # fail 0")
    const zeroRun = parseTapSummary('TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n');
    assert.ok(!zeroRun.complete, 'tests=0 must be marked INCOMPLETE (zero-test false green)');
    const fp4 = formatRoundFingerprint(6, zeroRun);
    assert.ok(fp4.includes('INCOMPLETE'), 'zero-test round fingerprint must say INCOMPLETE');

    // All-green round needs no not ok section
    const greenTap = parseTapSummary('ok 1 - a\n# tests 1\n# pass 1\n# fail 0\n');
    const fp3 = formatRoundFingerprint(5, greenTap);
    assert.ok(fp3.includes('fail=0') && !fp3.includes('not_ok='), 'green round has no not_ok section');
  });

  test('Tier 3: PR Review Gate script functionality - checkCoolingPeriod', () => {
    const now = new Date('2026-11-01T12:00:00Z');

    // Case 1: Fresh PR created 100 seconds ago (must fail)
    const recentPr = new Date('2026-11-01T11:58:20Z').toISOString();
    const res1 = checkCoolingPeriod(recentPr, { now, minSeconds: 900 });
    assert.ok(!res1.valid, 'PR created 100s ago should fail 900s cooling period');
    assert.ok(res1.remainingSeconds > 700);

    // Case 2: Mature PR created 1000 seconds ago (must pass)
    const maturePr = new Date('2026-11-01T11:40:00Z').toISOString();
    const res2 = checkCoolingPeriod(maturePr, { now, minSeconds: 900 });
    assert.ok(res2.valid, 'PR created 1200s ago should pass 900s cooling period');

    // Case 3: Bypassed with reason
    const res3 = checkCoolingPeriod(recentPr, { now, bypassReason: 'P0 hotfix approved by lead' });
    assert.ok(res3.valid, 'Bypassed cooling period should pass');
    assert.equal(res3.bypassed, true);
  });

  test('Tier 3: PR Review Gate script functionality - checkReviewComments', () => {
    // Case 1: Unresolved review comment
    const comments1 = [
      { user: 'reviewer_1', body: '## 审阅意见: 请补充对空输入的边界测试' },
      { user: 'author_1', body: '收到，我看看' },
    ];
    const res1 = checkReviewComments(comments1);
    assert.ok(!res1.valid, 'Review without three-state resolution keyword should fail');
    assert.equal(res1.unresolvedCount, 1);

    // Case 2: Resolved review comment with "已处理"
    const comments2 = [
      { user: 'reviewer_1', body: '## 审阅意见: 请补充对空输入的边界测试' },
      { user: 'author_1', body: '已处理：在 commit 8f9a2b 中添加了空输入单元测试用例' },
    ];
    const res2 = checkReviewComments(comments2);
    assert.ok(res2.valid, 'Review with "已处理" should pass');

    // Case 3: Resolved review comment with "刻意不改" + reason
    const comments3 = [
      { user: 'reviewer_1', body: '## 审查意见: 建议抽取全局单例' },
      { user: 'author_1', body: '刻意不改：当前模块遵循无状态纯函数设计，引入单例会导致并发测试相互污染' },
    ];
    const res3 = checkReviewComments(comments3);
    assert.ok(res3.valid, 'Review with "刻意不改" should pass');

    // Case 4 (Issue #124): bracket-form supervisor markers count as review opinions.
    // Issue #121 caught a real miss: "[监督席·只读复核] …" carries no "## " prefix,
    // so the substring marker list skipped it and the PR merged 103s later silently.
    const comments4 = [
      { user: 'LitaoG', body: '[监督席·只读复核] 本轮窗口抓到一处 §1.9 执行漏洞，聚焦机制，不涉及代码对错。' },
      { user: 'LitaoG', body: '收到，我看看' },
    ];
    const res4 = checkReviewComments(comments4);
    assert.ok(!res4.valid, 'Bracket-form supervisor comment without three-state reply should fail');
    assert.equal(res4.unresolvedCount, 1);

    const comments5 = [
      { user: 'LitaoG', body: '[监督席·只读复核] 本轮窗口抓到一处 §1.9 执行漏洞，聚焦机制，不涉及代码对错。' },
      { user: 'LitaoG', body: '已处理：DoD 已同步，PR 评论已补三态交代（issuecomment 6959991711）' },
    ];
    const res5 = checkReviewComments(comments5);
    assert.ok(res5.valid, 'Bracket-form supervisor comment with a later "已处理" reply should pass');
  });

  test('Tier 3: PR Review Gate script functionality - checkCiGateConclusion (Issue #136)', () => {
    // B③ (#130 建议 3): a failure conclusion on the head commit's CI gate run is a
    // mechanical merge block — the #119 red-gate merge class.
    const failed = checkCiGateConclusion('failure');
    assert.ok(!failed.valid, 'CI gate conclusion "failure" must block the merge');
    assert.ok(failed.violations[0].includes('红门禁止合入'), 'the violation must name the red-gate rule');

    // success / pending (null) / no check-run (null) must NOT block —
    // enforce_admins covers the pending window on the GitHub side.
    assert.ok(checkCiGateConclusion('success').valid, '"success" must pass');
    assert.ok(checkCiGateConclusion(null).valid, 'null (pending / no run) must not block');
    assert.ok(checkCiGateConclusion(undefined).valid, 'undefined must not block');
  });

  test('Tier 3: PR Review Gate script functionality - checkWorktreeCleanliness', () => {
    const res = checkWorktreeCleanliness(REPO_ROOT);
    assert.equal(typeof res.clean, 'boolean');
    assert.ok(Array.isArray(res.violations));
  });

  test('Tier 4: no orphan worktree shells rot beside the repo (Issue #68, probe from #67)', () => {
    // The old Tier 4 defined `evaluateWorktreeIsolation` inside the test body
    // and called it twice with literals — deleting the function changed no
    // real behavior (Issue #68: a self-test, not a lock). The real worktree
    // hygiene invariant is the one #67 wired into the cleanliness gate: a
    // directory under the sibling AI-workflow-worktrees/ root that no longer
    // resolves to a git worktree is a shell that must be deleted on sight.
    // The same exported probe is asserted here so the unit suite also fails
    // while a shell rots (on CI clones the sibling root does not exist and
    // the probe is a no-op empty list).
    const orphans = findOrphanWorktrees(REPO_ROOT);
    assert.equal(
      orphans.length,
      0,
      `orphan worktree shells must be deleted on sight (AGENTS.md §1.5): ${orphans.join(', ')}`,
    );
  });

  test('Tier 3: pr_review_gate.d.ts declares exactly the functions the .mjs exports (Issue #124/#128)', () => {
    // Issue #128 shipped a d.ts that silently missed findOrphanWorktrees while
    // its PR body claimed "declaration surface matches the implementation" —
    // the supervisor caught it on PR #129. This machine check makes the two
    // export-function sets a hard equality so the drift class is closed.
    const mjs = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'pr_review_gate.mjs'), 'utf8');
    const dts = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'pr_review_gate.d.ts'), 'utf8');
    const mjsFns = [...new Set([...mjs.matchAll(/^export function (\w+)/gm)].map((m) => m[1]))].sort();
    const dtsFns = [
      ...new Set([...dts.matchAll(/^export (?:declare )?function (\w+)/gm)].map((m) => m[1])),
    ].sort();
    assert.ok(mjsFns.length >= 8, `the .mjs export-function scan must actually match (found ${mjsFns.length})`);
    assert.deepStrictEqual(
      dtsFns,
      mjsFns,
      'pr_review_gate.d.ts must declare exactly the functions pr_review_gate.mjs exports — ' +
        `missing: [${mjsFns.filter((f) => !dtsFns.includes(f)).join(', ')}], ` +
        `extra: [${dtsFns.filter((f) => !mjsFns.includes(f)).join(', ')}]`,
    );
  });

  test('Tier 3: dwf parking semantics must be locked (Issue #35)', () => {
    // ① The canonical event vocabulary carries dwf_parked as its own terminal —
    //    a parked run must never be countable as a failure by event type.
    //    Issue #68: locked against the SHIPPED constant (dist build), not the
    //    source text — rewriting the source line without changing the built
    //    vocabulary cannot go unnoticed anymore.
    assert.equal(WORKFLOW_EVENT.DWF_PARKED, 'dwf_parked', 'the canonical vocabulary must carry DWF_PARKED: dwf_parked');

    // ② The runner emits the park terminal as dwf_parked (payload keeps
    //    data.status "parked" for consumers keyed on it). Source lock kept:
    //    the terminal selection has no exported pure surface, and the
    //    emission behavior is already behaviorally pinned end-to-end by
    //    tests/integration/dwf-branch-parking.test.ts (dwf_parked payload
    //    assertions) — this regex only guards the emit-site ternary shape.
    const runnerSource = fs.readFileSync(path.join(REPO_ROOT, 'src/dwf/runner.ts'), 'utf8');
    assert.ok(/result\.status === 'parked' \? 'dwf_parked' : 'dwf_failed'/.test(runnerSource), 'runner terminal emit must select dwf_parked for parked runs');

    // ③ The projection folds dwf_parked to paused — Issue #68: locked by
    //    BEHAVIOR through the shipped projector (a parked stream folds to a
    //    paused graph), not by matching a case-label text; the legacy
    //    dwf_failed{status:"parked"} fold stays covered by
    //    tests/unit/dag-journal-projection.test.ts.
    const parkedStream: Array<Record<string, unknown>> = [
      { id: 'e1', workflowId: 'facade-script', runId: 'dwfrun-gov-parked', type: 'dwf_parked', timestamp: '2026-01-01T00:00:00.000Z', data: { status: 'parked' } },
    ];
    assert.equal(projectEventsToGraph(parkedStream).status, 'paused', 'the shipped projection folds a dwf_parked stream to paused');

    // ④ answer refuses non-parked runs with the same refusal family as fill.
    const answerSource = fs.readFileSync(path.join(REPO_ROOT, 'src/cli/commands/answer.ts'), 'utf8');
    assert.ok(/run\.status !== 'parked'/.test(answerSource), 'answer must guard on a parked run');
    assert.ok(answerSource.includes('only a parked run can be answered'), 'answer refusal must name the non-parked guard');

    // ⑤ The escalate fast-path design conclusion stays on record (measured:
    //    hole-only 10521ms / escalation-only 10436ms — the childIdle signal never
    //    fires for any park, the 10s fallback is the operative path; making the
    //    signal live is a parking-latency behavior change needing its own design).
    assert.ok(runnerSource.includes('Issue #35 design conclusion'), 'runner.ts must carry the Issue #35 parking design conclusion');
    assert.ok(runnerSource.includes('stays until then'), 'the keep-the-10s-fallback decision must be stated');
  });

  test('Tier 3: unit suite keeps pure isolation semantics — no async child-process trees (Issue #198)', () => {
    // Issue #198 root cause (PR#197 four-round bisect): node --test runs each
    // unit file in its own subprocess; a unit test that leaves sandbox/
    // jobhelper subprocess trees alive makes the file process wait for the
    // tree to drain at exit — the whole unit suite hangs. Option A ruling:
    // runner-level (real subprocess tree) coverage lives in tests/integration
    // (serial); tests/unit must not create async OS child-process trees.
    // Mechanical proxy: ban async spawn entry points. Bounded sync forms
    // (spawnSync/execSync) cannot outlive the call and stay allowed.
    const unitDir = path.join(REPO_ROOT, 'tests', 'unit');
    const bannedPatterns: Array<[RegExp, string]> = [
      [/\bspawn\(/, 'async child_process.spawn( — runner-level subprocess tree; move the test to tests/integration (Issue #198)'],
      [/\bexecFile\(/, 'async child_process.execFile( — runner-level subprocess tree; move the test to tests/integration (Issue #198)'],
      [/\bfork\(/, 'async child_process.fork( — runner-level subprocess tree; move the test to tests/integration (Issue #198)'],
      [/\bspawnSupervised\b/, 'spawnSupervised creates supervised child trees (jobhelper) — integration face only (Issue #198)'],
      [/\bspawnJobGuarded\b/, 'spawnJobGuarded creates jobguard child trees (jobhelper) — integration face only (Issue #198)'],
      [/\badoptPidIntoJobGuard\b/, 'adoptPidIntoJobGuard manages jobguard-guarded trees — integration face only (Issue #198)'],
      [/['"]\.\.\/src\/process-supervision\.js['"]/, 'tests/unit must not import src/process-supervision.js — integration face only (Issue #198)'],
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // fixtures are data, not suites.
          if (entry.name === 'fixtures') continue;
          walk(full);
        } else if (entry.name.endsWith('.test.ts')) {
          // The gate file itself carries the banned literals in its own
          // assertions — exclude it by name (stable across source runs via
          // --experimental-strip-types and compiled runs via dist).
          if (entry.name === 'workflow-governance.test.ts') continue;
          const src = fs.readFileSync(full, 'utf8');
          for (const [re, why] of bannedPatterns) {
            if (re.test(src)) offenders.push(path.relative(REPO_ROOT, full) + ' -> ' + why);
          }
        }
      }
    };
    walk(unitDir);
    assert.deepStrictEqual(offenders, [], 'unit suite must keep pure isolation semantics (Issue #198): ' + offenders.join(' | '));
  });

  test('Tier 1: no merge-conflict markers survive in any tracked text file (upstream Issue #277, ported via comp Issue #17)', () => {
    // Upstream Issue #277: conflict markers (`<<<<<<< HEAD` / `>>>>>>> origin/main`)
    // survived in README for 3 days 18 hours across 25 merges while every local
    // gate stayed green — no gate scanned plain-text files for merge corruption.
    // The scanner below closes that blind spot at Tier 1. execSync is the
    // P-TEST-5 sanctioned bounded sync form (it cannot outlive the call).
    const CONFLICT_MARKER = /^<<<<<<< |^>>>>>>> /;
    const scanConflictMarkers = (relPath: string, content: string): string[] => {
      const hits: string[] = [];
      content.split('\n').forEach((line, index) => {
        if (CONFLICT_MARKER.test(line)) hits.push(`${relPath}:${index + 1} ${line.trimEnd()}`);
      });
      return hits;
    };

    // Reverse discrimination (in-repo, no filesystem pollution): hostile
    // content must be caught with file path + line number. `=======` alone is
    // deliberately NOT flagged — a bare separator is a common markdown
    // horizontal rule; only the real GitHub marker shapes fire.
    const hostileHits = scanConflictMarkers(
      'hostile/README.md',
      ['intro paragraph', '<<<<<<< HEAD', '=======', '>>>>>>> origin/main'].join('\n'),
    );
    assert.deepStrictEqual(
      hostileHits,
      ['hostile/README.md:2 <<<<<<< HEAD', 'hostile/README.md:4 >>>>>>> origin/main'],
      'the scanner must catch injected conflict markers with path + line number',
    );

    const tracked = execSync('git ls-files -z', { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const binaryExt = /\.(png|jpe?g|gif|bmp|ico|webp|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|7z|xz|pdf|exe|dll|node|wasm|bin|mp4|webm|mov|sqlite|db)$/i;
    const violations: string[] = [];
    let scanned = 0;
    for (const rel of tracked) {
      if (binaryExt.test(rel)) continue; // binary data, not text
      if (rel.includes('/fixtures/')) continue; // fixtures are data, not prose (Issue #277 mandate)
      let content: string;
      try {
        content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // unreadable at scan time — not a conflict-marker violation
      }
      scanned += 1;
      violations.push(...scanConflictMarkers(rel, content));
    }
    assert.deepStrictEqual(
      violations,
      [],
      'merge-conflict markers must never reach main (Issue #277): ' + violations.join(' | '),
    );
    assert.ok(scanned > 100, `conflict-marker scan must actually cover the tracked tree (scanned ${scanned}/${tracked.length} files)`);
  });

  test('Tier 1: no machine-local user paths survive in any tracked text file (Issue #48)', () => {
    // Issue #48: 15 tracked files carried `C:\Users\<user>\…` absolute paths while
    // README's compliance section claims zero private data leakage — the claim was
    // contradicted by the repo's own artifacts (the same self-contradiction shape as
    // the fingerprint drift, Issue #27). This scanner closes the blind spot at
    // Tier 1: drive-letter user profiles, /Users/<name>/ and /home/<name>/ shapes
    // are banned in every tracked text file. execSync is the P-TEST-5 sanctioned
    // bounded sync form.
    // The patterns are assembled from char codes so this test's own source never
    // contains a matchable literal (the same self-flag avoidance the conflict
    // marker scan uses with ^ anchors).
    const BS = String.fromCharCode(92);
    const FS = String.fromCharCode(47);
    const sep = '[' + BS + BS + FS + ']+';
    const LOCAL_PATH = new RegExp(
      '(^|[^A-Za-z0-9])('
        + '[A-Za-z]:' + sep + 'Users' + sep + '[^' + BS + FS + ':*?"<>|\\s]+'
        + '|' + FS + 'home' + FS + '[A-Za-z0-9._-]+' + FS
        + '|' + FS + 'Users' + FS + '[A-Za-z0-9._-]+' + FS
        + ')',
    );
    const scanLocalPaths = (relPath: string, content: string): string[] => {
      const hits: string[] = [];
      content.split('\n').forEach((line, index) => {
        if (LOCAL_PATH.test(line)) hits.push(`${relPath}:${index + 1} ${line.trimEnd().slice(0, 160)}`);
      });
      return hits;
    };

    // Reverse discrimination: hostile content must be caught with path + line.
    const hostileContent = [
      'clean line',
      'see C:' + BS + 'Users' + BS + 'alice' + BS + 'Desktop' + BS + 'notes.md for context',
      FS + 'home' + FS + 'bob' + FS + 'secret',
      FS + 'Users' + FS + 'carol' + FS + 'x',
    ].join('\n');
    const hostileHits = scanLocalPaths('hostile/README.md', hostileContent);
    assert.equal(hostileHits.length, 3, 'the scanner must catch injected local paths with path + line number: ' + hostileHits.join(' | '));

    const tracked = execSync('git ls-files -z', { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const binaryExt = /\.(png|jpe?g|gif|bmp|ico|webp|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|7z|xz|pdf|exe|dll|node|wasm|bin|mp4|webm|mov|sqlite|db)$/i;
    const violations: string[] = [];
    let scannedLocal = 0;
    for (const rel of tracked) {
      if (binaryExt.test(rel)) continue; // binary data, not text
      if (rel.includes('/fixtures/')) continue; // fixtures are data, not prose (Issue #277 mandate)
      let content: string;
      try {
        content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // unreadable at scan time — not a local-path violation
      }
      scannedLocal += 1;
      violations.push(...scanLocalPaths(rel, content));
    }
    assert.deepStrictEqual(
      violations,
      [],
      'machine-local user paths must never reach main (Issue #48): ' + violations.join(' | '),
    );
    assert.ok(scannedLocal > 100, `local-path scan must actually cover the tracked tree (scanned ${scannedLocal} files)`);
  });

  test('Tier 1: test `finally` blocks must never contain abrupt completions (Issue #36, family of upstream #312)', () => {
    // JS spec semantics: an abrupt completion inside a `finally` block
    // silently OVERRIDES any exception thrown by the guarded `try` body —
    // including AssertionError. Measured live (upstream #308): a test whose
    // body threw still reported `pass`, because the cleanup helper `return`
    // inside the rmSync retry loop swallowed the failure. This scanner locks
    // the surface across all tracked test sources.
    //
    // Precisely flagged (override semantics):
    //   - a `return` lexically inside `finally`, outside nested function
    //     bodies (plain nested blocks like try/catch/for do NOT shield it);
    //   - a LABELED `break LABEL;` / `continue LABEL;` inside `finally` whose
    //     label is not declared inside the same finally (it targets past it).
    // Deliberately NOT flagged (bind to a loop INSIDE the finally, cannot
    // override): unlabeled `break;` / `continue;`.
    const scanFinallyAbrupt = (relPath: string, content: string): string[] => {
      const hits: string[] = [];
      type Scope = { kind: 'finally' | 'function'; bodyDepth: number; line: number; startOffset: number };
      const stack: Scope[] = [];
      const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
      let depth = 0;
      let line = 1;
      let pendingFinally = false;
      let pendingFunction = false;
      let lastChar = ''; // last significant char outside strings/comments (regex-start heuristic)
      let i = 0;
      while (i < content.length) {
        const c = content[i]!;
        if (c === '\n') { line++; i++; continue; }
        if (c === '/' && content[i + 1] === '/') { while (i < content.length && content[i] !== '\n') i++; continue; }
        if (c === '/' && content[i + 1] === '*') {
          i += 2;
          while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) { if (content[i] === '\n') line++; i++; }
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          const quote = c;
          i++;
          while (i < content.length && content[i] !== quote) { if (content[i] === '\\') i++; if (content[i] === '\n') line++; i++; }
          i++;
          lastChar = quote;
          continue;
        }
        if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(lastChar)) {
          // Regex literal (classic heuristic: a `/` after a value char is division).
          let j = i + 1;
          let closed = false;
          while (j < content.length && content[j] !== '\n') {
            if (content[j] === '\\') { j += 2; continue; }
            if (content[j] === '/') { closed = true; break; }
            j++;
          }
          if (closed) {
            i = j + 1;
            while (i < content.length && /[a-z]/i.test(content[i]!)) i++;
            lastChar = '/';
            continue;
          }
        }
        if (isIdent(c)) {
          let j = i;
          while (j < content.length && isIdent(content[j]!)) j++;
          const word = content.slice(i, j);
          if (word === 'finally') {
            pendingFinally = true;
          } else if (word === 'function') {
            pendingFunction = true;
          } else if (word === 'return') {
            const innermost = stack[stack.length - 1];
            if (innermost && innermost.kind === 'finally') {
              hits.push(`${relPath}:${line} return inside finally (overrides the guarded try's exceptions)`);
            }
          } else if (word === 'break' || word === 'continue') {
            let k = j;
            while (k < content.length && /\s/.test(content[k]!)) k++;
            if (k < content.length && isIdent(content[k]!) && content[k + 1] !== '(' && content[k + 1] !== '=') {
              let m = k;
              while (m < content.length && isIdent(content[m]!)) m++;
              const label = content.slice(k, m);
              // Only a labeled break/continue can cross the finally boundary.
              const fin = [...stack].reverse().find((s) => s.kind === 'finally');
              if (fin) {
                const body = content.slice(fin.startOffset, i);
                if (!new RegExp(`\\b${label}\\s*:`).test(body)) {
                  hits.push(`${relPath}:${line} ${word} ${label} crosses the finally boundary (overrides the guarded try's exceptions)`);
                }
              }
              j = m;
            }
          }
          lastChar = content[j - 1]!;
          i = j;
          continue;
        }
        if (c === '{') {
          depth++;
          if (pendingFinally) {
            stack.push({ kind: 'finally', bodyDepth: depth, line, startOffset: i + 1 });
            pendingFinally = false;
            pendingFunction = false;
          } else if (pendingFunction) {
            stack.push({ kind: 'function', bodyDepth: depth, line, startOffset: i + 1 });
            pendingFunction = false;
          }
          lastChar = c;
          i++;
          continue;
        }
        if (c === '}') {
          depth--;
          while (stack.length && stack[stack.length - 1]!.bodyDepth === depth + 1) stack.pop();
          lastChar = c;
          i++;
          continue;
        }
        if (c === '=' && content[i + 1] === '>') {
          pendingFunction = true;
          lastChar = '=';
          i += 2;
          continue;
        }
        if (/\S/.test(c)) {
          // Any other significant token cancels a dangling `finally` keyword
          // (the `{` must follow it); a dangling arrow/function opener is
          // cancelled by tokens that cannot precede its block body.
          if (pendingFinally) pendingFinally = false;
          if (pendingFunction && (c === ';' || c === ',' || c === ')')) pendingFunction = false;
          lastChar = c;
        }
        i++;
      }
      return hits;
    };

    // Reverse discrimination (synthetic, no filesystem pollution).
    const violating = [
      'test("x", () => {',
      '  try {',
      '    assert.equal(1, 2);',
      '  } finally {',
      '    fs.rmSync(dir, { recursive: true });',
      '    return;',
      '  }',
      '});',
    ].join('\n');
    assert.ok(
      scanFinallyAbrupt('hostile/a.test.ts', violating).some((h) => h.startsWith('hostile/a.test.ts:6')),
      'a return inside finally must be flagged with path + line',
    );
    const retryPattern = [
      '} finally {',
      '  for (let attempt = 0; attempt < 5; attempt++) {',
      '    try {',
      '      fs.rmSync(dir, { recursive: true, force: true });',
      '      return;',
      '    } catch {',
      '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);',
      '    }',
      '  }',
      '}',
    ].join('\n');
    assert.ok(
      scanFinallyAbrupt('hostile/b.test.ts', retryPattern).some((h) => h.startsWith('hostile/b.test.ts:5')),
      'the live rmSync-retry helper-return pattern must be flagged',
    );
    const arrowShield = [
      '} finally {',
      '  const cleanup = () => {',
      '    if (bad) return;',
      '  };',
      '  cleanup();',
      '}',
    ].join('\n');
    assert.deepStrictEqual(
      scanFinallyAbrupt('clean/arrow.test.ts', arrowShield),
      [],
      'a return inside a nested function body belongs to that function — not flagged',
    );
    const loopBreak = [
      '} finally {',
      '  for (const item of items) {',
      '    if (item.skip) continue;',
      '    if (item.last) break;',
      '  }',
      '}',
    ].join('\n');
    assert.deepStrictEqual(
      scanFinallyAbrupt('clean/loop.test.ts', loopBreak),
      [],
      'unlabeled break/continue bind to the loop inside the finally — cannot override, not flagged',
    );
    const labelCrossing = [
      'outer: for (const batch of batches) {',
      '  try {',
      '    drain(batch);',
      '  } finally {',
      '    for (const c of children) {',
      '      if (c.dead) break outer;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    assert.ok(
      scanFinallyAbrupt('hostile/label.test.ts', labelCrossing).some((h) => h.includes('break outer crosses')),
      'a labeled break whose label lives outside the finally must be flagged',
    );
    const withRegexAndString = [
      '} finally {',
      '  log("cleanup { done"); // comment } here',
      '  const re = /rm\\s+-rf/i;',
      '  rmTemp(dir);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(
      scanFinallyAbrupt('clean/strings.test.ts', withRegexAndString),
      [],
      'braces inside strings, comments and regex literals must not corrupt the brace tracker',
    );

    // In-repo sweep: every tracked test source must be free of finally-abrupt
    // completions. Unit/integration/adversarial suites plus the .kiro/pbt
    // property tests (they run under `npm run test:pbt`).
    const tracked = execSync('git ls-files -z', { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const isTestSource = (rel: string) =>
      (rel.startsWith('tests/') || rel.startsWith('.kiro/pbt/')) && /\.(ts|js|mjs|cjs)$/.test(rel) && !rel.includes('/fixtures/');
    const violations: string[] = [];
    let scanned = 0;
    for (const rel of tracked) {
      if (!isTestSource(rel)) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      violations.push(...scanFinallyAbrupt(rel, content));
    }
    assert.deepStrictEqual(
      violations,
      [],
      'finally-block abrupt completions must never reach main (Issue #36): ' + violations.join(' | '),
    );
    assert.ok(
      scanned > 100,
      `finally-abrupt scan must actually cover the tracked test tree (scanned ${scanned}/${tracked.length} files)`,
    );
  });
});
