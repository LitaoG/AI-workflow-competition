#!/usr/bin/env node
/**
 * postinstall 钩子：确保 node_modules/ai-workflow 自链接指向仓库根。
 *
 * 背景：demo 目录下各自带有独立 package.json（@ai-workflow/demo-* 命名），
 * 其包边界会切断 Node 对根包名 'ai-workflow' 的自引用解析；demo 内声明的
 * `workspace:*` 依赖是 pnpm/yarn 语法，npm 不会安装。因此任何干净检出
 * （新 clone / worktree / CI）在 demos 作用域下 `import 'ai-workflow'` 必然
 * 报 ERR_MODULE_NOT_FOUND。本脚本以幂等方式重建自链接（等价于历史上手工
 * 创建的 node_modules/ai-workflow 符号链接），使包名导入在任意 fresh install
 * 后即可解析。
 *
 * 行为约定：
 * - 链接已存在且为符号链接/junction：跳过（幂等）。
 * - node_modules/ai-workflow 是真实目录且内容确为同名包（package.json 的
 *   name 为 ai-workflow）：这是一份会随时间过期的安装拷贝（例如 workspaces
 *   实验残留），对它测试等于测冻结的旧引擎——用指向仓库根的 junction 替换，
 *   保证 demo/测试永远打到当前源码。
 * - 其余真实目录/普通文件：视为调用方有意安排，不动。
 * - Windows 使用 junction（无需管理员权限），POSIX 使用目录符号链接。
 */
import { existsSync, lstatSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 仅在本仓库开发环境生效：demo 目录不存在（例如 npm 发布后被下游安装）时
// 静默退出，绝不改动下游项目的 node_modules。
if (!existsSync(path.join(root, 'demos'))) {
  process.exit(0);
}

const link = path.join(root, 'node_modules', 'ai-workflow');

let existing = null;
try {
  existing = lstatSync(link);
} catch {
  /* 不存在：继续创建 */
}

if (existing !== null && !existing.isSymbolicLink()) {
  // 真实目录：仅当它确是本包的安装拷贝时才替换（stale copy → junction）；
  // 其余安排不动。
  const copyManifest = path.join(link, 'package.json');
  let isOwnCopy = false;
  try {
    isOwnCopy = JSON.parse(readFileSync(copyManifest, 'utf8')).name === 'ai-workflow';
  } catch {
    isOwnCopy = false;
  }
  if (!isOwnCopy) {
    console.log('[link-self] node_modules/ai-workflow 已存在且非本包拷贝，跳过。');
    process.exit(0);
  }
  rmSync(link, { recursive: true, force: true });
} else if (existing !== null) {
  rmSync(link);
}

symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
console.log('[link-self] 已创建 node_modules/ai-workflow -> 仓库根 自链接。');
