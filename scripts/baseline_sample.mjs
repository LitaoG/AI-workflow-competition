#!/usr/bin/env node
/**
 * 基线瞬态采样与指纹汇总层 (baseline_sample.mjs)
 *
 * 规则本体：Issue #32、docs/AI-PITFALLS.md P-TEST-3。
 * 核心职责：
 * 1. 对 unit+integration 全量门禁（node --test 加 dist/tests/unit 与 dist/tests/integration
 *    两个目录下递归的全部 *.test.js，见 TEST_GLOB_ARGS）
 *    连续采样多轮（默认 5 轮），逐轮留存真实指纹（tests/pass/fail + duration_ms）；
 * 2. 失败即失名缺口闭合：任一轮 fail > 0 时，必须提取并输出该轮全部 not ok 行名
 *    （历史教训：指纹汇总层只存计数，失败用例失名，追因成本被放大——Issue #32）；
 * 3. 挂起检测：单轮真实挂起（无超时保护的 spawn 类测试在负载下 connect 可无限等待）
 *    会被 --timeout-ms 护栏截断，该轮标记为 INCOMPLETE 并计入失败，杜绝"假等待"伪装成绿。
 *
 * 用法:
 *   node scripts/baseline_sample.mjs [--rounds N] [--timeout-ms N] [--out <file.json>]
 *
 * 退出码: 全部轮次全绿且完整 = 0；任一轮 fail > 0 或 INCOMPLETE = 1。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ROUNDS = 5;
export const DEFAULT_ROUND_TIMEOUT_MS = 300000;
export const TEST_GLOB_ARGS = [
  'dist/tests/unit/**/*.test.js',
  'dist/tests/integration/**/*.test.js',
];

/**
 * 解析 node --test 的 TAP 输出，提取计数摘要与全部 not ok 行名。
 * 返回 { tests, pass, fail, durationMs, notOkLines, lastSubtest, complete }；
 * complete=false 表示 TAP 摘要缺失（轮次被截断/挂起）或 tests=0
 * （dist 未 build / glob 无匹配时 node --test 仍 exit 0 并输出 "# tests 0"，
 * 评审第 1 轮实测——零测试绝不允许报告为"全绿"），计数视为不可信。
 */
export function parseTapSummary(tapText) {
  const text = tapText || '';
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const tests = num(/^# tests (\d+)\s*$/m);
  const pass = num(/^# pass (\d+)\s*$/m);
  const fail = num(/^# fail (\d+)\s*$/m);
  const durationMs = num(/^# duration_ms ([\d.]+)\s*$/m);
  const notOkLines = (text.match(/^\s*not ok\s+\d+.*$/gm) || [])
    .map((l) => l.trim())
    .map((l) => l.replace(/\s+# (SKIP|TODO).*$/, ''));
  const subtests = text.match(/^# Subtest: .*$/gm) || [];
  const lastSubtest = subtests.length > 0 ? subtests[subtests.length - 1].replace(/^# Subtest: /, '') : null;
  const complete = tests !== null && pass !== null && fail !== null && tests > 0;
  return { tests, pass, fail, durationMs, notOkLines, lastSubtest, complete };
}

/** 格式化单轮指纹行（失败必附 not ok 行名） */
export function formatRoundFingerprint(round, result) {
  if (!result.complete) {
    const where = result.lastSubtest ? ` — last subtest: "${result.lastSubtest}"` : '';
    return `[round ${round}] INCOMPLETE (TAP summary missing — likely hang/truncation)${where}`;
  }
  const base =
    `[round ${round}] tests=${result.tests} pass=${result.pass} fail=${result.fail}` +
    ` duration_ms=${result.durationMs ?? 'n/a'}`;
  if (result.fail > 0) {
    const names = result.notOkLines.length > 0
      ? result.notOkLines.join(' | ')
      : '(no not ok lines captured — collector defect, MUST investigate)';
    return `${base} not_ok=[${names}]`;
  }
  return base;
}

function runOnce(round, timeoutMs) {
  const start = Date.now();
  const proc = spawnSync(process.execPath, ['--test', ...TEST_GLOB_ARGS], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const durationMs = Date.now() - start;
  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  const result = parseTapSummary(stdout);

  if (proc.error || proc.signal || !result.complete) {
    // 轮次异常（挂起被护栏截断 / 进程崩溃 / tests=0 假绿）：TAP 不可信，判 INCOMPLETE；
    // 仍须指认挂点——取 stdout 最后一个 # Subtest 行（挂起形态的"行名"）
    result.complete = false;
    result.reason = proc.signal
      ? `killed by ${proc.signal} after ${durationMs}ms (hang guard)`
      : (proc.error
          ? proc.error.message
          : (result.tests === 0
              ? 'tests=0 — nothing ran (dist missing or glob matched nothing)'
              : `exit=${proc.status} without TAP summary`));
    result.stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
  } else {
    result.exitCode = proc.status;
  }
  return { round, durationMs, ...result };
}

function main() {
  const args = process.argv.slice(2);
  const roundsArg = args.includes('--rounds') ? Number(args[args.indexOf('--rounds') + 1]) : DEFAULT_ROUNDS;
  const timeoutArg = args.includes('--timeout-ms') ? Number(args[args.indexOf('--timeout-ms') + 1]) : DEFAULT_ROUND_TIMEOUT_MS;
  const outIdx = args.includes('--out') ? args.indexOf('--out') + 1 : -1;
  const outFile = outIdx !== -1 ? args[outIdx] : null;

  if (!Number.isInteger(roundsArg) || roundsArg < 1) {
    console.error('错误: --rounds 必须为正整数');
    process.exit(2);
  }
  if (!Number.isFinite(timeoutArg) || timeoutArg < 1000) {
    console.error('错误: --timeout-ms 必须为 >= 1000 的数值');
    process.exit(2);
  }

  console.log(`基线瞬态采样: ${roundsArg} 轮 × (unit + integration)，单轮护栏 ${timeoutArg}ms`);
  console.log(`命令: ${process.execPath} --test ${TEST_GLOB_ARGS.join(' ')}\n`);

  const rounds = [];
  let badRounds = 0;
  for (let i = 1; i <= roundsArg; i++) {
    const r = runOnce(i, timeoutArg);
    rounds.push(r);
    console.log(formatRoundFingerprint(i, r));
    if (r.reason) console.log(`  reason: ${r.reason}`);
    if (!r.complete || r.fail > 0) {
      badRounds++;
      if (r.stderrTail) console.log(`  stderr tail:\n${r.stderrTail}`);
    }
  }

  const totalFailRounds = rounds.filter((r) => !r.complete || r.fail > 0).length;
  console.log('\n==== 基线采样汇总 ====');
  console.log(`rounds=${roundsArg} green=${roundsArg - totalFailRounds} bad=${totalFailRounds}`);
  const allNotOk = rounds.flatMap((r) => (r.notOkLines || []).map((l) => `[round ${r.round}] ${l}`));
  if (allNotOk.length > 0) {
    console.log('not ok 行名（失败必附行名，禁止只报计数）:');
    allNotOk.forEach((l) => console.log(`  ${l}`));
  }

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ rounds, allNotOk }, null, 2));
    console.log(`留档已写入: ${outFile}`);
  }

  if (totalFailRounds > 0) {
    console.error(`\n[采样失败] ${totalFailRounds}/${roundsArg} 轮存在失败或挂起，见上方 not ok 行名。`);
    process.exit(1);
  }
  console.log(`\n[采样通过] ${roundsArg} 轮全量 unit+integration 全绿且完整。`);
}

if (process.argv[1] && process.argv[1].endsWith('baseline_sample.mjs')) {
  main();
}
