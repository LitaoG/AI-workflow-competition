#!/usr/bin/env node
/**
 * PR 审查门禁与合并冷却期自动化校验工具 (pr_review_gate.mjs)
 * 
 * 规则本体：AGENTS.md §1.9、§1.10 与 docs/WORKFLOW.md §1、§7、§8。
 * 核心职责：
 * 1. 校验 PR 正文是否明确关联有效 Issue（如 Closes #123），严禁无 Issue 孤立开工或合入；
 * 2. 校验 PR 正文是否包含真实运行的测试指纹（Ran N tests / pass N, fail 0），且无未替换占位符；
 * 3. 校验 PR 创建时间是否满足 15 分钟（900秒，硬红线 600秒）合并冷却期；
 * 4. 校验 PR 评论与 Review 流中的审查意见是否均已获得作者明确的三态回复（已处理 / 刻意不改+理由 / 需人拍板）；
 * 5. 支持大厂级审查自检、人工授权豁免 (--ack / --bypass-cooling) 与工作区洁净度检查；
 * 6. 校验失败汇总必附 not ok 行名（失败即失名禁止，Issue #32 / AI-PITFALLS P-TEST-3）。
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

  // 2. 检查是否包含测试指纹（Issue #109：删掉 /passed/i 与 100% passed 兜底——
  // 任何含 "passed" 一词的正文都算有指纹等于没有校验）。认三种真实输出形状，
  // 且用例数必须 > 0：
  //   - `Ran N tests`（node:test 的摘要行，N ≥ 1）
  //   - `pass N, fail 0`（同行的全绿摘要，N ≥ 1）
  //   - node:test 的分行摘要：`pass N` 与 `fail 0` 各占一行（ℹ 前缀可有可无）
  const ranTests = /Ran\s+(\d+)\s+tests/i.exec(content);
  const passFail = /pass\s+(\d+),\s*fail\s+0/i.exec(content);
  const passLine = /^\s*(?:ℹ\s+)?pass\s+(\d+)\s*$/m.exec(content);
  const failZeroLine = /^\s*(?:ℹ\s+)?fail\s+0\s*$/m.exec(content);
  const hasFingerprint =
    (ranTests !== null && Number(ranTests[1]) > 0) ||
    (passFail !== null && Number(passFail[1]) > 0) ||
    (passLine !== null && Number(passLine[1]) > 0 && failZeroLine !== null);

  if (!hasFingerprint) {
    violations.push('PR 正文中缺少真实的测试输出指纹（需包含 "Ran N tests" 或 "pass N, fail 0"，且 N > 0；裸 "passed" 一词不算）');
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * 校验门禁失败汇总必须记录 not ok 行名 (Issue #32)
 *
 * 历史教训（AI-PITFALLS P-TEST-3）：基线指纹汇总层只保留计数（tests/pass/fail），
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
 * 判定一条评论是否为「审查类」评论（携带审查标题）。
 * 带审查标题的评论（## 监督席 / ## 审查意见 等）本身就是审查意见——它自己
 * 永远不能充当对别的审查意见的回音（Issue #109：所有会话共用同一账号，
 * 只能靠标题区分角色）。
 */
function isReviewComment(body) {
  const lower = body.toLowerCase();
  return REVIEW_MARKERS.some(marker => lower.includes(marker.toLowerCase()));
}

/** 提取审查意见的编号（仓内惯例 F1、F2…；未编号的审查意见整体作为一条）。 */
function extractFindingIds(body) {
  return [...new Set(body.match(/\bF\d+\b/g) || [])];
}

/**
 * 校验评论流与审查流中审查意见的回复闭环（Issue #109 判定硬化）：
 *
 * 1. 时间线：调用方可能传入未排序的 comments/reviews 合并流——判定前按
 *    createdAt/created_at/submittedAt 升序重排，回音必须发生在意见之后。
 * 2. 编号闭环：审查意见里的编号发现项（F1、F2…）逐条记账；回音必须**同时**
 *    引用对应编号并携带三态关键词（RESOLVE_KEYWORDS），一条回音只消它引用的
 *    编号。未编号的审查意见退回旧规则（后续非审查评论携带任一关键词即可）。
 * 3. 角色判别：带审查标题的评论是意见不是回音——回音扫描会跳过它们。
 */
export function checkReviewComments(comments = []) {
  const ordered = [...comments].sort((a, b) => {
    const ta = new Date(a?.createdAt || a?.created_at || a?.submittedAt || 0).getTime();
    const tb = new Date(b?.createdAt || b?.created_at || b?.submittedAt || 0).getTime();
    return ta - tb;
  });

  const unresolvedReviews = [];

  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i];
    const body = item?.body || '';
    if (item?.replyOnly) continue; // PR 正文等回音位不产生审查意见
    if (!isReviewComment(body)) continue;

    const author = item?.author?.login || item?.user?.login || item?.user || 'unknown';
    const createdAt = item?.createdAt || item?.created_at || item?.submittedAt;
    const findingIds = extractFindingIds(body);
    const findings = findingIds.length > 0
      ? findingIds.map(id => ({ id, snippet: `发现项 ${id}` }))
      : [{ id: null, snippet: body.slice(0, 80).replace(/\r?\n/g, ' ') }];

    for (const finding of findings) {
      let resolved = false;
      for (let j = i + 1; j < ordered.length && !resolved; j++) {
        const replyBody = ordered[j]?.body || '';
        if (isReviewComment(replyBody)) continue; // 审查标题的评论不是回音
        if (!RESOLVE_KEYWORDS.some(kw => replyBody.includes(kw))) continue; // 无三态关键词
        if (finding.id === null || replyBody.includes(finding.id)) resolved = true;
      }

      if (!resolved) {
        unresolvedReviews.push({ author, findingId: finding.id, snippet: finding.snippet, createdAt });
      }
    }
  }

  return {
    valid: unresolvedReviews.length === 0,
    unresolvedCount: unresolvedReviews.length,
    unresolvedReviews,
    violations: unresolvedReviews.map(
      r => `存在未回复的审查意见 (来自 ${r.author}${r.findingId ? `，发现项 ${r.findingId}` : ''}): "${r.snippet}"`
    ),
  };
}

/**
 * S2（Issue #196 系统性发现）：正文声明「关联 Issue 无评论/无意见」时机械核对。
 * #164/#165/#190 三例 PR 正文「Issue 无评论」自检与时间线不符（评论早于 PR
 * 创建十几个小时）。声明存在而任一关联 Issue 实有评论即拦截——自检声明
 * 必须与 `gh` 时间线一致，或更正声明，或逐条三态交代。
 */
const NO_COMMENT_CLAIM_RE = /(无|没有|未发现|未见|零)\s*(其他\s*)?(实质性\s*)?(审查\s*)?(评论|意见)/;

export function checkNoCommentClaims(prBody, issueComments = []) {
  const violations = [];
  const body = prBody || '';
  if (!NO_COMMENT_CLAIM_RE.test(body)) return { valid: violations.length === 0, violations };
  const perIssue = new Map();
  for (const c of issueComments) {
    if (!c?.fromIssue) continue; // 仅统计关联 Issue 来源的评论
    const num = String(c.fromIssue);
    perIssue.set(num, (perIssue.get(num) || 0) + 1);
  }
  for (const [num, count] of perIssue) {
    if (count > 0) {
      violations.push(
        `正文声明「无评论/无意见」，但关联 Issue #${num} 实有 ${count} 条评论——自检声明与时间线不符（Issue #196 S2）。请回看全部评论并逐条三态交代，或更正正文声明`
      );
    }
  }
  return { valid: violations.length === 0, violations };
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

    // 合并普通 comments 与 review comments（reviews 用 submittedAt 统一时间轴），
    // 时间排序由 checkReviewComments 内部完成（Issue #109）。
    const prComments = (prData.comments || []).map(c => ({ ...c, createdAt: c.createdAt || c.created_at }));
    // PR 正文（模板 §5「审查意见逐条交代」）也是合法回音位——以 reply-only 项
    // 并入时间轴（createdAt = PR 创建时刻；不参与审查意见检测，只参与回音扫描）。
    const bodyItem = {
      body: prData.body || '',
      createdAt: prData.createdAt,
      replyOnly: true,
    };
    const reviewItems = (prData.reviews || [])
      .filter(r => r.body && r.body.trim().length > 0)
      .map(r => ({
        body: r.body,
        author: r.author ? { login: r.author.login } : undefined,
        createdAt: r.submittedAt,
      }));

    // F5（Issue #109）：写在关联 Issue 上的审查意见对门禁不可见，冷却期一过
    // 就能带着未回应的审查合入。从 PR 正文的 Closes/Fixes/Resolves 取出 Issue
    // 编号，把该 Issue 的评论并入同一时间轴判定。拉取失败不拦门禁（可用性
    // 优先，PR 内评论照常判定），只留提示。
    const linkedNumbers = new Set(
      [...((prData.body || '').matchAll(/\b(?:Closes|Fixes|Resolves)\s+#(\d+)/gi))].map(m => m[1])
    );
    if (issueRes.issueNumber) linkedNumbers.add(String(issueRes.issueNumber));
    const issueComments = [];
    for (const num of linkedNumbers) {
      try {
        const rawIssue = execFileSync('gh', ['issue', 'view', num, '--json', 'comments'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        for (const c of JSON.parse(rawIssue).comments || []) {
          issueComments.push({ body: c.body, author: c.author, createdAt: c.createdAt, fromIssue: num });
        }
      } catch {
        console.log(`[提示] 关联 Issue #${num} 的评论拉取失败，该 Issue 不参与审查判定`);
      }
    }

    const allComments = [bodyItem, ...prComments, ...reviewItems, ...issueComments];
    const commRes = checkReviewComments(allComments);
    // S2（Issue #196）：「无评论」声明与关联 Issue 时间线机械核对。
    const claimRes = checkNoCommentClaims(prData.body || '', issueComments);

    const allViolations = [
      ...issueRes.violations,
      ...fpRes.violations,
      ...fnRes.violations,
      ...coolRes.violations,
      ...commRes.violations,
      ...claimRes.violations,
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
