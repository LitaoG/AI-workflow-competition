#!/usr/bin/env node
/**
 * postinstall 钩子：为迁移 demo 的 fixture 安装离线 SDK 桩。
 *
 * 状态（2026-11，Issue #240）：该 demo 已迁出本仓（由下游展示仓持有），demo fixture
 * 目录不存在时本脚本按下方行为约定静默退出 —— 保留以维持 postinstall 门禁链稳定。
 *
 * 背景：demos/repo-migration-engine/fixtures/legacy-aws-sdk-app 是一个模拟
 * "遗留 AWS SDK v2 企业应用" 的练习靶子，其 package.json 声明了 aws-sdk@^2
 * 真实依赖；fixture 的单元测试与迁移后验证（npm test 的 Demo 2 集成套件、
 * facade 迁移用例）都需要该依赖与 @aws-sdk v3 客户端可解析。离线演示不
 * 安装真实的 AWS SDK（v2 全量包体积巨大且测试完全使用注入的 mock client），
 * 因此 fixture 附带 sdk-stubs/ 目录（入库的最小离线桩，接口与真实包对齐），
 * 由本脚本幂等复制到 fixture 的 node_modules/ 下。
 *
 * 行为约定：
 * - 仅在本仓库开发环境中生效：demo fixture 目录不存在时（例如 npm 发布后
 *   被下游安装的场景）立即静默退出。
 * - 目标已存在（真实安装或先前引导）：跳过，绝不覆盖。
 */
import { cpSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'demos', 'repo-migration-engine', 'fixtures', 'legacy-aws-sdk-app');
const stubsDir = path.join(fixture, 'sdk-stubs');
const nmDir = path.join(fixture, 'node_modules');

if (!existsSync(stubsDir)) {
  // 非仓库开发环境（如下游 npm 安装本包）：无事可做，静默退出。
  process.exit(0);
}

const stubPackages = [
  'aws-sdk',
  path.join('@aws-sdk', 'client-s3'),
  path.join('@aws-sdk', 'client-dynamodb'),
  path.join('@aws-sdk', 'client-sqs'),
  path.join('@aws-sdk', 'lib-dynamodb'),
];

let installed = 0;
for (const pkg of stubPackages) {
  const dest = path.join(nmDir, pkg);
  if (existsSync(dest)) continue;
  cpSync(path.join(stubsDir, pkg), dest, { recursive: true });
  installed += 1;
}

console.log(`[bootstrap-fixtures] 离线 SDK 桩就绪（本次新装 ${installed}/${stubPackages.length} 个）。`);
