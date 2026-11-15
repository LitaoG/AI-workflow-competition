import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  checkFailureNaming,
  checkCoolingPeriod,
  checkReviewComments,
  checkNoCommentClaims,
  checkWorktreeCleanliness,
} = await import(gateScriptUrl);
const { parseTapSummary, formatRoundFingerprint } = await import(baselineSampleUrl);

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
      'Closes #',
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
    // Valid fingerprint without placeholders
    const validContent = `
# Title
Ran 42 tests
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

    // Invalid: contains placeholder
    const placeholderContent = `
# Title
Ran 10 tests
pass 10, fail 0
{{PLACEHOLDER_DESCRIPTION}}
`;
    const res3 = checkFingerprint(placeholderContent);
    assert.ok(!res3.valid, 'Contains placeholder should fail checkFingerprint');
    assert.ok(res3.violations.some((v: string) => v.includes('占位符')));
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
  });

  test('Tier 3: PR Review Gate script functionality - checkWorktreeCleanliness', () => {
    const res = checkWorktreeCleanliness(REPO_ROOT);
    assert.equal(typeof res.clean, 'boolean');
    assert.ok(Array.isArray(res.violations));
  });

  test('Tier 4: Worktree physical isolation invariant logic check', () => {
    // Simulated check: Verifies logic that catches direct source edits on main checkout in a main repo
    function evaluateWorktreeIsolation({
      branch,
      isMainWorktree,
      modifiedFiles,
    }: {
      branch: string;
      isMainWorktree: boolean;
      modifiedFiles: string[];
    }) {
      if (branch === 'main' && isMainWorktree) {
        const sourceEdits = modifiedFiles.filter((f: string) => 
          f.startsWith('src/') || f.startsWith('docs/') || f === 'package.json' || f === 'AGENTS.md'
        );
        if (sourceEdits.length > 0) {
          return {
            allowed: false,
            violation: `Direct source modifications detected in main checkout on branch main: ${sourceEdits.join(', ')}`,
          };
        }
      }
      return { allowed: true };
    }

    // Violation case: modifying src/ on main branch in main checkout
    const badRun = evaluateWorktreeIsolation({
      branch: 'main',
      isMainWorktree: true,
      modifiedFiles: ['src/engine/workflow.ts', 'docs/README.md'],
    });
    assert.ok(!badRun.allowed, 'Should disallow direct edits on main in main checkout');

    // Allowed case: in isolated worktree on feature branch
    const goodRun = evaluateWorktreeIsolation({
      branch: 'feat/dev-workflow',
      isMainWorktree: false,
      modifiedFiles: ['AGENTS.md', 'docs/WORKFLOW.md'],
    });
    assert.ok(goodRun.allowed, 'Should allow edits in feature worktree');
  });

  test('Tier 3: dwf parking semantics must be locked (Issue #35)', () => {
    // ① The canonical event vocabulary carries dwf_parked as its own terminal —
    //    a parked run must never be countable as a failure by event type.
    const eventsSource = fs.readFileSync(path.join(REPO_ROOT, 'src/domain/events.ts'), 'utf8');
    assert.ok(/DWF_PARKED:\s*'dwf_parked'/.test(eventsSource), 'events.ts must declare DWF_PARKED: dwf_parked');

    // ② The runner emits the park terminal as dwf_parked (payload keeps
    //    data.status "parked" for consumers keyed on it).
    const runnerSource = fs.readFileSync(path.join(REPO_ROOT, 'src/dwf/runner.ts'), 'utf8');
    assert.ok(/result\.status === 'parked' \? 'dwf_parked' : 'dwf_failed'/.test(runnerSource), 'runner terminal emit must select dwf_parked for parked runs');

    // ③ The projection folds dwf_parked to paused and keeps the legacy
    //    dwf_failed{status:"parked"} journal shape folding to paused too.
    const projectionSource = fs.readFileSync(path.join(REPO_ROOT, 'src/dag/journal-projection.ts'), 'utf8');
    assert.ok(/case 'dwf_parked':\s*\n\s*case 'dwf_failed':/.test(projectionSource), 'journal-projection must fold dwf_parked (and the legacy parked shape) to paused');

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
});
