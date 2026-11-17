#!/usr/bin/env node
/**
 * Gate 失败命名采集层 (capture-failure-names.mjs)
 *
 * 规则本体：Issue #65、docs/AI-PITFALLS.md P-TEST-3（失败即失名禁止）。
 *
 * 缺口根因：`npm run gate` 的 test 段原本是裸 `npm test`——红一次只在人类
 * 滚动缓冲里留下计数与散落的 spec 输出，#32 建立的 not-ok 行名采集器
 * （baseline_sample.mjs）从未被接进本地门禁路径，「下次复现按配方抓名」
 * 只能靠人的记忆。本包装层让失败名采集成为结构性事实：
 *
 * 1. `npm test` 自身经双 reporter 无条件把 TAP 落盘到 `.gate/tap.log`
 *    （spec 走 stdout 给人看，tap 走文件给机器看——每一次运行都留档）；
 * 2. 本脚本 spawn 同一条 `npm run test`（单一事实源仍是 package.json 的
 *    test 脚本），结束后用 baseline_sample 导出的 parseTapSummary /
 *    formatRoundFingerprint 提取计数与全部 not ok 行名并内联展示；
 * 3. 以测试的真实退出码退出——gate 链语义与裸 `npm test` 完全一致。
 *
 * spawn 经 shell（仅 win32）：Node ≥20.12 出于 CVE-2024-27980 拒绝无 shell
 * 直接 spawn `.cmd`（P-ENV-1 家族）；命令串为常量，无注入面。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseTapSummary, formatRoundFingerprint } from './baseline_sample.mjs';

const isWin = process.platform === 'win32';
const proc = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'test'], {
  encoding: 'utf-8',
  shell: isWin,
});

if (proc.error) {
  console.error(`[capture] 无法启动 npm run test: ${proc.error.message}`);
  process.exit(1);
}

const tapPath = '.gate/tap.log';
if (!fs.existsSync(tapPath)) {
  console.error('[capture] .gate/tap.log 不存在——本轮 npm test 未产生 TAP 留档（P-TEST-3 缺口，必须调查 reporter 配置）。');
} else {
  const result = parseTapSummary(fs.readFileSync(tapPath, 'utf8'));
  console.log(formatRoundFingerprint(1, result));
  if ((result.fail ?? 0) > 0 && (result.notOkLines ?? []).length === 0) {
    console.error('[capture] fail > 0 但未提取到任何 not ok 行名——采集器缺陷，必须调查（P-TEST-3）。');
  }
}

process.exit(proc.status ?? 1);
