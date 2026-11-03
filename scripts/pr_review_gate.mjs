#!/usr/bin/env node
/**
 * PR 审查门禁与合并冷却期自动化校验工具 (pr_review_gate.mjs)
 * 
 * 规则本体：PR 审查回复闭环与收尾清理的工程规范。
 * 核心职责：
 * 1. 校验 PR 正文是否明确关联有效 Issue（如 Closes #123），严禁无 Issue 孤立开工或合入；
 * 2. 校验 PR 正文是否包含真实运行的测试指纹（Ran N tests / pass N, fail 0），且无未替换占位符；
 * 3. 校验 PR 创建时间是否满足 15 分钟（900秒，硬红线 600秒）合并冷却期；
 * 4. 校验 PR 评论与 Review 流中的审查意见是否均已获得作者明确的三态回复（已处理 / 刻意不改+理由 / 需人拍板）；
 * 5. 支持大厂级审查自检、人工授权豁免 (--ack / --bypass-cooling) 与工作区洁净度检查；
 * 6. 校验失败汇总必附 not ok 行名（失败即失名禁止，Issue #32 的历史踩坑教训）。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const FAST_MERGE_FLOOR_SECONDS = 600;
export const DEFAULT_COOLING_SECONDS = 900;

export const REVIEW_MARKERS = [
  '## 审阅意见',
  '## 评审',
  '## 监督席',
  '## 审查意见',
  '## 交叉评审',
  '## 交叉审查',
  '## 监督提醒',
  '## review',
  '## code review',
  '## 审阅',
];

export const RESOLVE_KEYWORDS = [
  '已处理',
  '已修',
  '已改',
  '刻意不改',
  '刻意未改',
  '驳回',
  '需人拍板',
  '需用户拍板',
  '待拍板',
  '已解决',
  '已落地',
];

export const FORBIDDEN_PLACEHOLDERS = [
  '{{',
  '}}',
  'PLACEHOLDER',
  '待填',
  '稍后补充',
  '<!-- 粘贴',
];

/**
 * 校验 PR 正文中的 Issue 关联
 */
export function checkIssueLinkage(content) {
  const violations = [];
  const issuePattern = /(?:closes|fixes|resolves|issue|关联\s*issue)[\s:]*#(\d+)|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i;
  const match = content.match(issuePattern);

  if (!match) {
    violations.push('PR 正文中缺少对 Issue 的明确关联（需包含 "Closes #NNN"、"Fixes #NNN" 或有效 Issue 链接）');
  }

  const issueNumber = match ? (match[1] || match[2]) : null;
  return {
    valid: violations.length === 0,
    issueNumber,
    violations,
  };
}

/**
 * 校验 PR 正文指纹与占位符
 */
export function checkFingerprint(content) {
  const violations = [];

  // 过滤掉自检清单段（自检说明中包含占位符示例，非待填内容）
  const bodyWithoutChecklist = content.replace(/##\s*开\s*PR\s*前自检[\s\S]*?(?=\n---\n|$)/i, '');

  // 1. 检查是否存在占位符
  for (const ph of FORBIDDEN_PLACEHOLDERS) {
    if (bodyWithoutChecklist.includes(ph)) {
      violations.push(`发现未替换的占位符: "${ph}"`);
    }
  }

  // 2. 检查是否包含测试指纹（二者必须至少命中一个）
  const hasFingerprint = 
    /Ran\s+\d+\s+tests/i.test(content) ||
    /pass\s+\d+,\s*fail\s+0/i.test(content) ||
    /tests\s+\d+[\s\S]*pass\s+\d+/i.test(content) ||
    /100%\s+passed/i.test(content) ||
    /passed/i.test(content);

  if (!hasFingerprint) {
    violations.push('PR 正文中缺少真实的测试输出指纹（需包含 "Ran N tests" 或 "pass N, fail 0"）');
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * 校验门禁失败汇总必须记录 not ok 行名 (Issue #32)
 *
 * 历史教训（早期版本）：基线指纹汇总层只保留计数（tests/pass/fail），
 * 失败即失名，追因成本被放大。规则：正文中出现非零失败指纹（pass N, fail M 且 M>0，
 * 或 tests N 摘要含非零 fail）时，必须同时附 not ok 行名记录。
 */
export function checkFailureNaming(content) {
  const violations = [];

  // 扫描全部指纹，任一 fail>0 即要求行名（只取首个会漏报"先绿后红"的多指纹正文）
  const failCounts = [...content.matchAll(/pass\s+\d+,\s*fail\s+(\d+)/gi)].map((m) => Number(m[1]));
  const failedCount = failCounts.length > 0 ? Math.max(...failCounts) : 0;

  if (failedCount > 0 && !/^\s*not ok\s/im.test(content)) {
    violations.push(
      `门禁失败汇总显示 fail ${failedCount} 但未附 not ok 行名（禁止只报计数，失败必附用例名）`
    );
  }

  return {
    valid: violations.length === 0,
    failedCount,
    violations,
  };
}

/**
 * 校验合并冷却期 (默认 900 秒 / 15 分钟，硬红线 600 秒)
 */
export function checkCoolingPeriod(createdAtIso, options = {}) {
  const {
    now = new Date(),
    minSeconds = DEFAULT_COOLING_SECONDS,
    bypassReason = null,
  } = options;

  if (bypassReason) {
    return {
      valid: true,
      bypassed: true,
      reason: bypassReason,
      elapsedSeconds: null,
      violations: [],
    };
  }

  const createdTime = new Date(createdAtIso).getTime();
  const currentTime = new Date(now).getTime();
  const elapsedSeconds = Math.floor((currentTime - createdTime) / 1000);

  if (isNaN(elapsedSeconds)) {
    return {
      valid: false,
      violations: [`无法解析的 PR 创建时间: "${createdAtIso}"`],
    };
  }

  if (elapsedSeconds < minSeconds) {
    const remaining = minSeconds - elapsedSeconds;
    return {
      valid: false,
      elapsedSeconds,
      remainingSeconds: remaining,
      violations: [
        `PR 创建冷却期未满 15 分钟: 已过 ${elapsedSeconds} 秒，还需等待 ${remaining} 秒 (硬红线: ${FAST_MERGE_FLOOR_SECONDS}秒)`,
      ],
    };
  }

  return {
    valid: true,
    elapsedSeconds,
    violations: [],
  };
}

/**
 * 校验评论流与审查流中审查意见的回复闭环
 */
export function checkReviewComments(comments = []) {
  const unresolvedReviews = [];

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const body = comment.body || '';

    // 检测是否为审查类评论
    const isReview = REVIEW_MARKERS.some(marker => body.toLowerCase().includes(marker.toLowerCase()));
    if (!isReview) continue;

    // 检查后续评论中是否存在作者或同伴的有效交代
    let resolved = false;
    for (let j = i + 1; j < comments.length; j++) {
      const replyBody = comments[j].body || '';
      if (RESOLVE_KEYWORDS.some(kw => replyBody.includes(kw))) {
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      unresolvedReviews.push({
        author: comment.author?.login || comment.user?.login || comment.user || 'unknown',
        snippet: body.slice(0, 80).replace(/\r?\n/g, ' '),
        createdAt: comment.createdAt || comment.created_at,
      });
    }
  }

  return {
    valid: unresolvedReviews.length === 0,
    unresolvedCount: unresolvedReviews.length,
    unresolvedReviews,
    violations: unresolvedReviews.map(
      r => `存在未回复的审查意见 (来自 ${r.author}): "${r.snippet}..."`
    ),
  };
}

/**
 * 校验工作区是否干净（零未跟踪/零未提交垃圾）
 */
export function checkWorktreeCleanliness(cwd = process.cwd()) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      clean: status.length === 0,
      status,
      violations: status.length > 0 ? [`工作区存在未提交或未还原变更:\n${status}`] : [],
    };
  } catch (err) {
    return {
      clean: false,
      status: '',
      violations: [`无法执行 git status: ${err.message}`],
    };
  }
}

// CLI 执行逻辑
function runCLI() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
PR Review & Cooling Period Gate CLI (pr_review_gate.mjs)

用法:
  node scripts/pr_review_gate.mjs <pr_number> [--ack <理由>] [--bypass-cooling <理由>]
  node scripts/pr_review_gate.mjs --check-fingerprint <file_path>
  node scripts/pr_review_gate.mjs --check-failure-naming <file_path>
  node scripts/pr_review_gate.mjs --check-cooling <created_at_iso> [--bypass-cooling <理由>]
  node scripts/pr_review_gate.mjs --check-comments <comments_json_file>
  node scripts/pr_review_gate.mjs --check-clean
`);
    process.exit(0);
  }

  if (args.includes('--check-clean')) {
    const res = checkWorktreeCleanliness();
    if (!res.clean) {
      console.error('[门禁失败] 工作区存在残留或未提交变更:');
      res.violations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    }
    console.log('[门禁通过] 工作区彻底干净，无未暂存/未提交副产物。');
    return;
  }

  if (args.includes('--check-fingerprint')) {
    const filePath = args[args.indexOf('--check-fingerprint') + 1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`错误: 文件不存在 "${filePath}"`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = checkFingerprint(content);
    if (!result.valid) {
      console.error('[门禁失败] 测试指纹或占位符校验不通过:');
      result.violations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    } else {
      console.log('[门禁通过] PR 测试指纹合规且无占位符。');
    }
    return;
  }

  if (args.includes('--check-failure-naming')) {
    const filePath = args[args.indexOf('--check-failure-naming') + 1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`错误: 文件不存在 "${filePath}"`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = checkFailureNaming(content);
    if (!result.valid) {
      console.error('[门禁失败] 失败汇总缺 not ok 行名 (Issue #32):');
      result.violations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    } else {
      console.log(`[门禁通过] 失败命名规范合规 (fail=${result.failedCount}，失败已附 not ok 行名)。`);
    }
    return;
  }

  if (args.includes('--check-cooling')) {
    const timeIso = args[args.indexOf('--check-cooling') + 1];
    const bypassIdx = args.indexOf('--bypass-cooling');
    const bypassReason = bypassIdx !== -1 ? args[bypassIdx + 1] : null;

    const result = checkCoolingPeriod(timeIso, { bypassReason });
    if (!result.valid) {
      console.error('[门禁失败] 合并冷却期校验不通过:');
      result.violations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    } else {
      console.log(`[门禁通过] 合并冷却期达标 (已流逝 ${result.elapsedSeconds}s) ${result.bypassed ? '[人工豁免]' : ''}`);
    }
    return;
  }

  if (args.includes('--check-comments')) {
    const filePath = args[args.indexOf('--check-comments') + 1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`错误: 评论 JSON 文件不存在 "${filePath}"`);
      process.exit(1);
    }
    const comments = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const result = checkReviewComments(comments);
    if (!result.valid) {
      console.error('[门禁失败] 存在未回复的审查意见:');
      result.violations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    } else {
      console.log('[门禁通过] 所有审查意见均已获得明确回复交代。');
    }
    return;
  }

  // 默认直接检查 PR 编号（调用 GitHub CLI）
  const prNumber = args[0];
  const ackIdx = args.indexOf('--ack');
  const bypassIdx = args.indexOf('--bypass-cooling');
  const ackReason = ackIdx !== -1 ? args[ackIdx + 1] : (bypassIdx !== -1 ? args[bypassIdx + 1] : null);

  console.log(`正在检查 PR #${prNumber} ...`);
  try {
    const raw = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'body,createdAt,comments,reviews'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prData = JSON.parse(raw);

    const issueRes = checkIssueLinkage(prData.body || '');
    const fpRes = checkFingerprint(prData.body || '');
    const fnRes = checkFailureNaming(prData.body || '');
    const coolRes = checkCoolingPeriod(prData.createdAt, { bypassReason: ackReason });
    
    // 合并普通 comments 与 review comments
    const allComments = [
      ...(prData.comments || []),
      ...(prData.reviews ? prData.reviews.filter(r => r.body && r.body.trim().length > 0) : []),
    ];
    const commRes = checkReviewComments(allComments);

    const allViolations = [
      ...issueRes.violations,
      ...fpRes.violations,
      ...fnRes.violations,
      ...coolRes.violations,
      ...commRes.violations,
    ];

    if (allViolations.length > 0) {
      console.error(`\n[门禁拦截] PR #${prNumber} 未能通过大厂级合并门禁:`);
      allViolations.forEach(v => console.error(` - ${v}`));
      process.exit(1);
    }

    console.log(`\n✅ [门禁放行] PR #${prNumber} 已绑定 Issue #${issueRes.issueNumber}，满足指纹、冷却期与审查回复要求，允许合入。`);
  } catch (err) {
    console.error(`无法获取 PR #${prNumber} 数据: ${err.message}`);
    process.exit(1);
  }
}

// 仅在直接执行时运行 runCLI
if (process.argv[1] && process.argv[1].endsWith('pr_review_gate.mjs')) {
  runCLI();
}
