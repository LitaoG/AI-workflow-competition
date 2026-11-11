/**
 * Static facade-script detection for the unified `workflow run` entry.
 *
 * 军规（Mission D P0-1）：严禁用 `import()` 探测脚本类型 —— facade 脚本顶层包含
 * `return`（沙箱把脚本体包进 async function 执行），Node 原生 import 会直接抛出
 * 进程级 SyntaxError。这里只做零执行静态扫描：
 * 1. 快路径正则匹配门面全局特征（agent( / phase( / files. / world.run( ...）；
 * 2. 慢路径 TypeScript AST 检查顶层 `return` 语句 —— 它在 facade 沙箱里合法、
 *    在原生 ESM import 下是语法错误，是不执行就能定性的决定性证据。
 * builder 模式标记（defineWorkflow / new Workflow）优先级最高，避免误判。
 */
import * as fs from 'node:fs';
import * as ts from 'typescript';

/**
 * Facade 全局 API 特征（src/dwf/facade.ts 暴露的脚本可见面）。
 * 左边界守卫 (?<![\w$.])：在 \b 之上再排除「前置字符是 . / 标识符字符」的命中，
 * 否则 builder 工作流里 `ctx.agent("inspector").ask(...)` 这类属性访问会被误判为
 * facade 脚本送进沙箱编译器（E2E T1_F1_01/02、T3_PAIR_02 实测回归）。
 */
const FACADE_TRAIT_RE =
  /(?<![\w$.])(?:agent\s*\(|phase\s*\(|escalate\s*\(|hole\s*<|files\s*\.\s*(?:glob|read|write|exists)|world\s*\.\s*run\s*\(|report\s*\(|artifact\s*\.\s*(?:markdown|json|bytes)|budget\s*\.\s*(?:spent|total|check))/;

/** builder 引擎定义标记：出现即按传统 builder 工作流处理。 */
const BUILDER_MARKER_RE = /\b(?:defineWorkflow\s*\(|new\s+Workflow\s*\()/;

/**
 * Decide whether `filePath` is a facade script (route to the DWF sandbox
 * runner) or a builder-mode workflow definition. Never executes the file.
 */
export function looksLikeFacadeScript(filePath: string): boolean {
  let src: string;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  if (BUILDER_MARKER_RE.test(src)) return false;
  if (FACADE_TRAIT_RE.test(src)) return true;
  // AST fallback: a top-level `return` is decisive (see module docstring).
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sf.statements.some((st) => ts.isReturnStatement(st));
}
