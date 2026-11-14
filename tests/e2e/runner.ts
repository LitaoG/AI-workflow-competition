import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * AI-Workflow E2E Test Suite Master Runner
 * 4-Tier Verification Architecture:
 * - Tier 1: Feature Coverage (50 tests)
 * - Tier 2: Boundary & Corner Cases (50 tests)
 * - Tier 3: Cross-Feature Combinations (15 tests)
 * - Tier 4: Real-World Application Scenarios (6 tests)
 * Total: 121 tests
 */

async function main() {
  const rootDir = path.resolve(import.meta.dirname || process.cwd(), '..', '..');
  const e2eDir = path.join(rootDir, 'tests', 'e2e');

  console.log('================================================================');
  console.log('   AI-WORKFLOW OPAQUE-BOX E2E TEST SUITE RUNNER');
  console.log('   Architecture: 4-Tier Systematic Requirement-Driven Verification');
  console.log('   Mode: Offline Mock Engine (--mock) · Zero API Key Dependency');
  console.log('================================================================\n');

  const tier1Files = fs.readdirSync(path.join(e2eDir, 'tier1-features'))
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => path.join(e2eDir, 'tier1-features', f));

  const tier2Files = fs.readdirSync(path.join(e2eDir, 'tier2-boundaries'))
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => path.join(e2eDir, 'tier2-boundaries', f));

  const tier3Files = fs.readdirSync(path.join(e2eDir, 'tier3-combinations'))
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => path.join(e2eDir, 'tier3-combinations', f));

  const tier4Files = fs.readdirSync(path.join(e2eDir, 'tier4-scenarios'))
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => path.join(e2eDir, 'tier4-scenarios', f));

  const tiers = [
    { name: 'Tier 1 — Feature Coverage (10 Features × 5 Tests)', files: tier1Files, expected: 50 },
    // 47, not 50: t2-10-kiro was rewritten (2026-11-14 repair round) from five
    // cannot-fail subtests to two real executed hook-contract tests — the old
    // expected count was inflated by tests that could never fail.
    { name: 'Tier 2 — Boundary & Corner Cases', files: tier2Files, expected: 47 },
    { name: 'Tier 3 — Cross-Feature Combinations (15 Pairwise Suites)', files: tier3Files, expected: 15 },
    { name: 'Tier 4 — Real-World Application Scenarios (6 Workloads)', files: tier4Files, expected: 6 },
  ];

  let totalExecuted = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let incompleteTiers = 0;
  const tierResults: Array<{ name: string; total: number; pass: number; fail: number; durationMs: number }> = [];

  const overallStart = Date.now();

  for (const tier of tiers) {
    console.log(`>>> Running ${tier.name}...`);
    const tierStart = Date.now();

    const spawnArgs = [
      '--experimental-strip-types',
      '--test',
      // Force TAP output explicitly: node >= 26 pipes spec-format output by
      // default (no ok/not ok lines), which this parser cannot read — the
      // drift was the root cause of the fabricated 50/50 green (CI run
      // 41750103636). node22's piped default is already TAP, so CI output
      // shape is unchanged by this flag.
      '--test-reporter=tap',
      ...tier.files
    ];

    const proc = spawnSync(process.execPath, spawnArgs, {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000
    });

    const tierDuration = Date.now() - tierStart;
    const stdout = proc.stdout || '';
    const stderr = proc.stderr || '';

    // Count ok and not ok
    const okMatches = (stdout.match(/^\s*ok\s+\d+\s+-\s+T[1-4]/gm) || []).length;
    const notOkMatches = (stdout.match(/^\s*not ok\s+\d+\s+-\s+T[1-4]/gm) || []).length;

    // Fallback parsing for scenario 4 which has descriptive names
    const scenarioOkMatches = (stdout.match(/^\s*ok\s+\d+\s+-\s+Scenario/gm) || []).length;
    const scenarioNotOkMatches = (stdout.match(/^\s*not ok\s+\d+\s+-\s+Scenario/gm) || []).length;

    const passCount = okMatches + scenarioOkMatches;
    const failCount = notOkMatches + scenarioNotOkMatches;
    const reportedTotal = passCount + failCount;

    // 失败即失名（AI-PITFALLS P-TEST-3）：收集全部 not ok 行名，失败汇总必须
    // 指认到具体用例，严禁只报计数。
    const notOkNames = (stdout.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/gm) || [])
      .map((line) => line.replace(/^\s*not ok\s+\d+\s+-\s+/, '').trim());

    // 不得伪装成绿：解析数 ≠ tier.expected（报告器格式漂移导致 0 解析、子进程
    // 崩溃或超时截断导致部分执行）一律判 INCOMPLETE 并置红。旧代码用
    // `reportedTotal > 0 ? reportedTotal : tier.expected` 把 0 解析回填成全绿，
    // 是 CI run 41750103636 假绿的根因。
    const incomplete = reportedTotal !== tier.expected;
    if (incomplete) incompleteTiers += 1;

    const actualCount = Math.max(tier.expected, reportedTotal);
    const actualPass = passCount;
    const actualFail = failCount + Math.max(0, tier.expected - reportedTotal);

    totalExecuted += actualCount;
    totalPassed += actualPass;
    totalFailed += actualFail;

    tierResults.push({
      name: tier.name,
      total: actualCount,
      pass: actualPass,
      fail: actualFail,
      durationMs: tierDuration
    });

    if (incomplete) {
      console.error(`  ⚠ INCOMPLETE (parsed ${reportedTotal}/${tier.expected} TAP cases, ${failCount} failed — not fabricating a pass; ${tierDuration}ms)`);
      // P-TEST-3：附最后一个 # Subtest 行指认断点（超时/崩溃定位）。
      const lastSubtest = (stdout.match(/^\s*# Subtest: (.+)$/gm) || []).pop();
      if (lastSubtest) console.error(`    last subtest: ${lastSubtest.trim()}`);
      for (const name of notOkNames) console.error(`    ✖ ${name}`);
      if (stderr) console.error(stderr);
    } else if (actualFail > 0) {
      console.error(`  ✖ FAIL (${actualFail} failed, ${actualPass} passed, ${tierDuration}ms)`);
      for (const name of notOkNames) console.error(`    ✖ ${name}`);
      if (stderr) console.error(stderr);
    } else {
      console.log(`  ✔ PASS (${actualPass}/${actualCount} passed, ${tierDuration}ms)`);
    }
  }

  const overallDuration = Date.now() - overallStart;

  console.log('\n================================================================');
  console.log('   E2E TEST EXECUTION SUMMARY REPORT');
  console.log('================================================================');
  console.log('| Tier | Target | Executed | Passed | Failed | Duration |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: |');

  for (const r of tierResults) {
    console.log(`| ${r.name.padEnd(52)} | ${String(r.total).padEnd(6)} | ${String(r.pass).padEnd(6)} | ${String(r.fail).padEnd(6)} | ${(r.durationMs + 'ms').padEnd(8)} |`);
  }

  console.log('----------------------------------------------------------------');
  console.log(`Total Test Cases Executed: ${totalExecuted}`);
  console.log(`Total Test Cases Passed:   ${totalPassed}`);
  console.log(`Total Test Cases Failed:   ${totalFailed}`);
  console.log(`Total Wall Clock Duration: ${overallDuration}ms`);
  console.log('================================================================\n');

  if (totalFailed > 0 || incompleteTiers > 0) {
    if (incompleteTiers > 0) {
      console.error(`[TEST_RUNNER_INCOMPLETE] ${incompleteTiers} tier(s) could not be fully parsed from TAP output — treating as failure.`);
    }
    console.error(`[TEST_RUNNER_FAILURE] ${totalFailed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log('[TEST_RUNNER_SUCCESS] 100% of E2E tests passed! Test suite is ready.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
