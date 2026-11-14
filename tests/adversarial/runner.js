/**
 * Adversarial Challenge Test Runner
 * Executes Tier 5 Adversarial Stress Suites:
 * - DAG Topological Sorting & Cycle Detection
 * - Typed Agent RPC Self-Repair Loop
 * - Concurrency & Race Condition Stress
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

const testSuites = [
  'tests/adversarial/dag-stress.test.js',
  'tests/adversarial/dag-visualizer-stress.test.js',
  'tests/adversarial/agent-rpc-stress.test.js',
  'tests/adversarial/concurrency-stress.test.js',
  'tests/adversarial/event-log-crash.test.js',
  'tests/adversarial/replay-checkpoint-stress.test.js',
  'tests/adversarial/prober-sanitizer-stress.test.js',
  'tests/adversarial/cli-subcommands-stress.test.js',
  'tests/adversarial/mcp-server-stress.test.js',
];

console.log('================================================================');
console.log('   AI-WORKFLOW ADVERSARIAL STRESS CHALLENGE RUNNER (TIER 5)');
console.log('   Adversarial hardening suites');
console.log('================================================================\n');

async function runSuite(suitePath) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', suitePath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      const duration = Date.now() - start;
      const passMatches = stdout.match(/^\s*ok\s+\d+\s+-\s+(.+)$/gm) || [];
      const failMatches = stdout.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/gm) || [];

      resolve({
        suitePath,
        code,
        duration,
        passed: passMatches.length,
        failed: failMatches.length,
        total: passMatches.length + failMatches.length,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  const results = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalDuration = 0;

  for (const suite of testSuites) {
    process.stdout.write(`>>> Executing ${suite}... `);
    const res = await runSuite(suite);
    results.push(res);
    totalPassed += res.passed;
    totalFailed += res.failed;
    totalDuration += res.duration;

    if (res.code === 0 && res.failed === 0) {
      console.log(`✔ PASS (${res.passed}/${res.total} passed, ${res.duration}ms)`);
    } else {
      console.log(`✖ FAIL (${res.failed} failed, ${res.passed} passed, ${res.duration}ms)`);
      if (res.stderr) console.error(res.stderr);
    }
  }

  console.log('\n================================================================');
  console.log('   ADVERSARIAL STRESS TEST SUMMARY REPORT');
  console.log('================================================================');
  console.log('| Suite Name | Total | Passed | Failed | Duration | Status |');
  console.log('| :--------- | :---: | :----: | :----: | :------: | :----: |');
  for (const r of results) {
    const suiteName = path.basename(r.suitePath);
    const status = r.code === 0 && r.failed === 0 ? '✔ PASS' : '✖ FAIL';
    console.log(
      `| ${suiteName.padEnd(28)} | ${String(r.total).padEnd(5)} | ${String(r.passed).padEnd(6)} | ${String(r.failed).padEnd(6)} | ${(r.duration + 'ms').padEnd(8)} | ${status} |`
    );
  }
  console.log('----------------------------------------------------------------');
  console.log(`Total Tests Executed: ${totalPassed + totalFailed}`);
  console.log(`Total Tests Passed:   ${totalPassed}`);
  console.log(`Total Tests Failed:   ${totalFailed}`);
  console.log(`Total Wall Clock:     ${totalDuration}ms`);
  console.log('================================================================\n');

  if (totalFailed > 0) {
    console.error(`[ADVERSARIAL_CHALLENGE_FAILED] ${totalFailed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log(`[ADVERSARIAL_CHALLENGE_APPROVED] All ${totalPassed} empirical stress tests PASSED successfully.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
