/**
 * Facade-script compiler: strict in-memory TS check against the facade d.ts, plus
 * AST-level authorization rules and the site table.
 *
 * Design copied from ZCode's `packages/dynamic-workflow/src/compiler/compile.ts`:
 *  - The script is wrapped in `async function __workflowScript__() { ... }` so
 *    top-level await/return are legal inside a plain function body.
 *  - A virtual CompilerHost serves the script, the facade d.ts and lib files from a
 *    map (lib files fall through to the typescript package directory on disk).
 *  - `types: []` — no ambient @types; the purity contract starts at compile time.
 *  - `noUncheckedIndexedAccess` is intentionally OFF: model-authored TS assumes it,
 *    and enabling it produced a flood of undefined-family false positives upstream.
 *  - Diagnostics are mapped back to the author's original line numbers (minus one
 *    prelude line) and never shown to the user un-mapped.
 *
 * 【安全审计与纯度契约（Channel 2 的攻防设计）】：
 * 编译期安全审计（Channel 2 授权规则）背后是一条硬契约——脚本必须是
 * (脚本源码, args) 的纯函数：
 *  - 纯度契约（Purity Contract）：墙钟（Date.now/Date.parse/无参 new Date()）、
 *    熵源（Math.random）与 process/eval 族标识符在 9002 拒收。动机是重放的
 *    字节级一致性：引擎 journal 以 (runId, siteId, ordinal) + inputHash 键控
 *    （见 engine.ts），两次执行一旦各自读钟/掷骰，同一 run 的重放即静默分叉。
 *    合法的时间与随机性只能经 args 注入；Date/Math 标识符本身不在禁令内——
 *    禁令是成员粒度的最小约束，注入的时间戳仍可正常取值与格式化。
 *  - 9002 原型链禁令（PROTOTYPE_CHAIN_PROPS）：constructor/__proto__/prototype
 *    是从任意对象爬升到 realm Function 的梯子，({}).constructor.constructor
 *    即零 import 逃逸。点号与字符串字面量下标双语法在 AST 层一并拒收，构成
 *    沙箱纵深防御的第一道刚性防线；静态语法通道枚举不了的计算型键（a[v]）
 *    交给 child-main 的运行时 realm 兜底（codeGeneration:{strings:false}——
 *    即便 Function 被触及，字符串造码也以 EvalError 拒绝）。
 */
import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { FACADE_DTS } from './facade-dts.js';
import { FacadeAnalysis, FacadeDiagnostic, FacadeSite } from './diagnostics.js';
import { synthesizeSchema } from './schema-synth.js';
import {
  BANNED_IDENTIFIERS,
  FACADE_FUNCTION_IDENTIFIERS,
  FACADE_IDENTIFIERS,
  FACADE_NAMESPACE_IDENTIFIERS,
  PROTOTYPE_CHAIN_PROPS,
  REFLECTION_METHODS,
  collectAgentBoundNames,
  declarationsOf,
  facadeDestructuredMember,
  facadeMemberName,
  facadeSitingMessage,
  findGlobBrokenComments,
  insideFanoutCallback,
  isFacadeReferenceIllegal,
  isPlainLiteral,
  isReference,
  literalValue,
  reflectionBaseName,
} from './compile-rules.js';

const SCRIPT_VIRTUAL_NAME = '__facade_script__.ts';
const FACADE_VIRTUAL_NAME = 'workflow-facade.d.ts';
const PRELUDE_LINES = 1; // async function __workflowScript__() {

const require_ = createRequire(import.meta.url);
const TS_LIB_DIR = path.dirname(require_.resolve('typescript/package.json'));

/** Wrap the author's source so top-level await/return typecheck inside a function body. */
export function wrapScriptSource(source: string): string {
  return `async function __workflowScript__() {\n${source}\n}`;
}

/** sha256 of the exact author source — the run's script identity. */
export function hashScriptSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

interface ProgramBundle {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile; // the wrapped script
}

let cachedBundle: { key: string; bundle: ProgramBundle } | null = null;

/** Build (or reuse) the in-memory program for one script text. */
function buildProgram(source: string): ProgramBundle {
  const key = hashScriptSource(source);
  if (cachedBundle && cachedBundle.key === key) return cachedBundle.bundle;

  const wrapped = wrapScriptSource(source);
  const virtualFiles = new Map<string, string>([
    [SCRIPT_VIRTUAL_NAME, wrapped],
    [FACADE_VIRTUAL_NAME, FACADE_DTS],
  ]);

  const options: ts.CompilerOptions = {
    strict: true,
    noImplicitAny: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: [],
    noEmit: true,
    noUncheckedIndexedAccess: false, // intentional, see file header
    skipLibCheck: true,
  };

  const host = ts.createCompilerHost(options, /*setParentNodes*/ true);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const resolveVirtual = (fileName: string): string | undefined => {
    if (fileName === SCRIPT_VIRTUAL_NAME || fileName === FACADE_VIRTUAL_NAME) return fileName;
    return undefined;
  };
  host.readFile = (fileName: string) => {
    const v = resolveVirtual(fileName);
    if (v) return virtualFiles.get(v);
    // lib.*.d.ts resolves against the typescript package (in-memory contract, on-disk libs)
    const base = path.basename(fileName);
    if (/^lib\.[a-z0-9.]+\.d\.ts$/i.test(base)) {
      const p = path.join(TS_LIB_DIR, base);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return baseReadFile(fileName);
  };
  host.fileExists = (fileName: string) => {
    if (resolveVirtual(fileName)) return true;
    const base = path.basename(fileName);
    if (/^lib\.[a-z0-9.]+\.d\.ts$/i.test(base)) return fs.existsSync(path.join(TS_LIB_DIR, base));
    return baseFileExists(fileName);
  };
  // The script is a closed world: nothing resolves, imports are banned (rule pass).
  host.resolveModuleNames = (moduleNames: string[]) => moduleNames.map(() => undefined);

  const program = ts.createProgram([SCRIPT_VIRTUAL_NAME, FACADE_VIRTUAL_NAME], options, host);
  const bundle: ProgramBundle = { program, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(SCRIPT_VIRTUAL_NAME)! };
  cachedBundle = { key, bundle };
  return bundle;
}

/**
 * Analyze a facade script: type diagnostics + authorization rules + site table.
 *
 * Two audit channels share one cached program. Channel 1 is the TS type check
 * against the facade d.ts (diagnostics mapped back through the one-line prelude);
 * Channel 2 is the AST authorization walk — the static security audit. One
 * traversal fuses the whole rulebook: 9002 purity bans (banned identifiers,
 * Date.now/parse, Math.random, no-arg new Date(), and the constructor/
 * __proto__/prototype chain ban in dot and bracket spellings), 9001 facade
 * siting (a facade callable may only be the callee of a direct call — aliasing,
 * destructuring or bind/call/apply reifies it into a value the lowering never
 * sites, desyncing the site table the journal and replay key on), 9003/9004
 * literal and shadowing rules, and site-table capture (actor/phase/hole/ask/
 * escalate/world ops ...) that feeds lowering and ask<T> schema synthesis.
 * Fail-closed by construction: any diagnostic leaves ok=false, and the D9
 * broken-comment pre-check replaces the corrupt-parse diagnostic flood with one
 * precise error.
 */
export function analyzeFacadeScript(source: string): FacadeAnalysis {
  const { checker, sourceFile } = buildProgram(source);
  const diagnostics: FacadeDiagnostic[] = [];
  const sites: FacadeSite[] = [];
  const phases: string[] = [];
  const commands: string[] = [];
  const actors: string[] = [];
  let siteCounter = 0;
  const holeNames = new Set<string>();

  // ---- D9: glob inside a block comment ends the comment early → one precise diagnostic ----
  const brokenComments = findGlobBrokenComments(sourceFile);
  if (brokenComments.length > 0) {
    const mapped: FacadeDiagnostic[] = brokenComments.map((r) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(r.pos);
      return {
        tag: 'CompileError',
        line: Math.max(1, line + 1 - PRELUDE_LINES),
        column: character + 1,
        code: 9016,
        category: 'facade-misuse',
        message: 'a glob pattern inside this block comment contains the comment terminator ("*/" inside "**/") — the comment ends early there, and the closing terminator this comment still carries leaks into the code as syntax errors. Put globs in a string or a // line comment.',
      };
    });
    // The parse below the early terminator is corrupt — the type channel and the
    // AST rules would report against pseudo-code, so the precise diagnostics
    // replace the flood. Fail-closed: the script still cannot pass the check.
    return { ok: false, diagnostics: mapped, sites, phases, commands, actors };
  }

  // ---- Channel 1: TS type diagnostics (script file only, mapped -1 prelude line) ----
  const { program } = { program: cachedBundle!.bundle.program };
  const tsDiagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
  for (const d of tsDiagnostics) {
    const { line, character } = d.file && d.start !== undefined
      ? d.file.getLineAndCharacterOfPosition(d.start)
      : { line: 0, character: 0 };
    diagnostics.push({
      tag: 'CompileError',
      line: Math.max(1, line + 1 - PRELUDE_LINES),
      column: character + 1,
      code: d.code,
      category: 'type-error',
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    });
  }

  // ---- Channel 2: authorization rules over the AST ----
  // Names bound (directly or via alias chains) to agent(...) calls — their `.ask` is a
  // facade callable. Collected up front: binding and use may appear in any order.
  const agentVars = collectAgentBoundNames(sourceFile);
  // Issue #38 D8-③ compile state: declared artifact ids per member kind (for
  // the 9007 kind-mismatch rule), pending report() tags, and the node ancestry
  // stack (for the 9008 preset-hoisting rule).
  const artifactKindById = new Map<string, string>();
  const artifactContentIds = new Set<string>();
  const presetDeclarations: Array<{ node: ts.CallExpression; id: string; kind: string }> = [];
  const reportTagSites: Array<{ node: ts.CallExpression; tag: string }> = [];
  const ancestry: ts.Node[] = [];
  visit(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      push(
        node, 9006, 'facade-misuse',
        'import/export is banned in facade scripts — the script is a closed world (facade primitives only).',
        'Quick Fix: delete the import — everything the script may call is already a facade global (agent, phase, files, git, world, artifact, log, report, args).',
      );
      return;
    }
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text) && isReference(node)) {
      push(
        node, 9002, 'purity-ban',
        `"${node.text}" is banned — facade scripts are deterministic and sandboxed; pass what you need via args.`,
        'Quick Fix: reach for facade primitives only (agent().ask, files.read, world.run); external values arrive through `args`.',
      );
      return;
    }
    // 9001: a facade function/namespace referenced anywhere but the callee of a direct call.
    if (ts.isIdentifier(node) && (FACADE_FUNCTION_IDENTIFIERS.has(node.text) || FACADE_NAMESPACE_IDENTIFIERS.has(node.text)) && isFacadeReferenceIllegal(node)) {
      push(node, 9001, 'facade-misuse', facadeSitingMessage(node.text));
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // 9002 purity bans, member-granular: the Date/Math identifiers stay legal so
      // an args-injected timestamp/seed remains usable — only the clock/entropy
      // spellings (Date.now/Date.parse, Math.random) are rejected. The clock must
      // be an input (via args), never an observation.
      const obj = node.expression;
      if (ts.isIdentifier(obj) && obj.text === 'Date' && (node.name.text === 'now' || node.name.text === 'parse')) {
        push(
          node, 9002, 'purity-ban',
          `Date.${node.name.text}() is banned — pass timestamps via args so relaunch replays byte-identical.`,
          "Quick Fix: `const now = args.timestamp ?? '<fixed-iso-string>';` — inject time instead of reading the wall clock.",
        );
        return;
      }
      if (ts.isIdentifier(obj) && obj.text === 'Math' && node.name.text === 'random') {
        push(
          node, 9002, 'purity-ban',
          'Math.random() is banned — pass randomness via args so relaunch replays byte-identical.',
          'Quick Fix: `const seed = args.seed ?? 42;` — derive pseudo-randomness from an arg so replays stay identical.',
        );
        return;
      }
      // 9002 prototype-chain ban, dot form (see PROTOTYPE_CHAIN_PROPS): any access
      // named constructor/__proto__/prototype, on ANY object, is rejected — the
      // bracket twin is intercepted below.
      if (PROTOTYPE_CHAIN_PROPS.has(node.name.text)) {
        push(
          node, 9002, 'purity-ban',
          `"${node.name.text}" property access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`,
          'Quick Fix: call the facade API you actually need (agent().ask / files.read / world.run) instead of reaching through an object graph.',
        );
        return;
      }
      // 9001: a facade member (p.ask, files.read, budget.spent, ...) outside the callee of
      // a direct call — method extraction desyncs the site table exactly like aliasing.
      if (!(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const member = facadeMemberName(node, agentVars);
        if (member) {
          push(node, 9001, 'facade-misuse', facadeSitingMessage(member));
          return;
        }
      }
      // 9001: bind/call/apply on a facade callable or facade member.
      if (REFLECTION_METHODS.has(node.name.text)) {
        const base = reflectionBaseName(node.expression, agentVars);
        if (base) {
          push(node, 9001, 'facade-misuse', facadeSitingMessage(base));
          return;
        }
      }
    }
    // 9002 prototype-chain ban, bracket form — the twin of the dot-form check above:
    // obj["constructor"] / obj["__proto__"] / obj["prototype"] is the same ladder,
    // so a string-literal index is rejected under the same code. Only literal keys
    // are enumerable statically; computed keys fall to the runtime realm backstop.
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && PROTOTYPE_CHAIN_PROPS.has(node.argumentExpression.text)) {
      push(
        node, 9002, 'purity-ban',
        `"${node.argumentExpression.text}" index access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`,
        'Quick Fix: call the facade API you actually need (agent().ask / files.read / world.run) instead of indexing into constructors.',
      );
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date' && (node.arguments?.length ?? 0) === 0) {
      push(
        node, 9002, 'purity-ban',
        'new Date() without arguments is banned — pass the timestamp via args so relaunch replays byte-identical.',
        "Quick Fix: `const now = args.timestamp ?? '<fixed-iso-string>';` — inject time instead of reading the wall clock.",
      );
      return;
    }
    if (ts.isVariableDeclarationList(node) || ts.isParameter(node)) {
      for (const nameNode of declarationsOf(node)) {
        if (FACADE_IDENTIFIERS.has(nameNode)) {
          push(
            node, 9004, 'facade-misuse',
            `"${nameNode}" shadows a facade primitive — pick another name.`,
            `Quick Fix: rename the local (e.g. \`my${String(nameNode)}\`) so the facade primitive stays reachable.`,
          );
        }
      }
    }
    // 9001: destructuring extraction (const { ask } = planner; const { read } = files).
    if (ts.isBindingElement(node)) {
      const member = facadeDestructuredMember(node, agentVars);
      if (member) push(node, 9001, 'facade-misuse', facadeSitingMessage(member));
    }
    if (ts.isCallExpression(node)) {
      handleCall(node);
    }
    ancestry.push(node);
    ts.forEachChild(node, visit);
    ancestry.pop();
  }

  function handleCall(node: ts.CallExpression): void {
    const expr = node.expression;
    // import(...) — dynamic import ban
    if (expr.kind === ts.SyntaxKind.ImportKeyword) {
      push(
        node, 9006, 'facade-misuse',
        'dynamic import() is banned in facade scripts.',
        'Quick Fix: delete it — the sandbox is a closed world; facade globals (agent, files, world, …) are already in scope.',
      );
      return;
    }
    // agent(...) — opts?.provider / opts?.tier recorded when string literals
    if (ts.isIdentifier(expr) && expr.text === 'agent') {
      const id = `actor#${++siteCounter}`;
      const nameArg = node.arguments[0];
      const optsArg = node.arguments[1];
      let provider: string | undefined;
      let tier: 'fast' | 'deep' | undefined;
      let model: string | undefined;
      if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
        for (const prop of optsArg.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'provider') {
            if (ts.isStringLiteral(prop.initializer)) {
              provider = prop.initializer.text;
            } else {
              push(node, 9014, 'facade-misuse', 'agent() provider option must be a compile-time string literal — provider routing is part of the approved run shape.');
            }
          } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'model') {
            // Issue #38: the model binding must be a string literal or an inline
            // model("id") call — the id rides the approved run shape.
            const init = prop.initializer;
            if (ts.isStringLiteral(init) && init.text.length > 0) {
              model = init.text;
            } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'model'
              && ts.isStringLiteral(init.arguments[0]) && (init.arguments[0] as ts.StringLiteral).text.length > 0) {
              model = (init.arguments[0] as ts.StringLiteral).text;
            } else {
              push(node, 9015, 'facade-misuse', 'agent() model option must be a compile-time string literal or a model("id") call — model routing is part of the approved run shape (Issue #38).');
            }
          } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'tier') {
            if (ts.isStringLiteral(prop.initializer) && (prop.initializer.text === 'fast' || prop.initializer.text === 'deep')) {
              tier = prop.initializer.text;
            } else {
              push(node, 9014, 'facade-misuse', 'agent() tier option must be a compile-time "fast" | "deep" string literal — tier routing is part of the approved run shape.');
            }
          }
        }
      }
      sites.push({ siteId: id, kind: 'actor', line: lineOf(node), actorName: isPlainLiteral(nameArg) ? literalValue(nameArg) : undefined, provider, tier, model });
      if (isPlainLiteral(nameArg) && !actors.includes(literalValue(nameArg))) actors.push(literalValue(nameArg));
      return; // arguments still visited by forEachChild for nested bans
    }
    // model("id") — only legal as the agent() opts.model initializer (Issue #38);
    // a ModelRef in any value position is the official 9010 value-position ban.
    if (ts.isIdentifier(expr) && expr.text === 'model') {
      const arg = node.arguments[0];
      if (!ts.isStringLiteral(arg) || (arg as ts.StringLiteral).text.length === 0) {
        push(node, 9015, 'literal-rule', 'model() requires a non-empty compile-time string literal — "modelId" or "providerId/modelId", optional "$level" suffix (Issue #38).');
      }
      const objLit = node.parent;
      const prop = objLit !== undefined && ts.isPropertyAssignment(objLit) ? objLit : undefined;
      const agentCall = prop !== undefined && ts.isObjectLiteralExpression(prop.parent) ? prop.parent.parent : undefined;
      const legal = prop !== undefined && ts.isIdentifier(prop.name) && prop.name.text === 'model'
        && agentCall !== undefined && ts.isCallExpression(agentCall)
        && ts.isIdentifier(agentCall.expression) && agentCall.expression.text === 'agent';
      if (!legal) {
        push(node, 9015, 'facade-misuse', 'model() is only valid as the agent() opts.model binding — a ModelRef has no value semantics outside it (Issue #38).');
      }
      return;
    }
    // workflow(name | {scriptPath}) — compose a saved workflow as a child run
    if (ts.isIdentifier(expr) && expr.text === 'workflow') {
      sites.push({ siteId: `workflow#${++siteCounter}`, kind: 'workflow', line: lineOf(node) });
      return;
    }
    // escalate(question) — a blocking question to the run owner
    if (ts.isIdentifier(expr) && expr.text === 'escalate') {
      sites.push({ siteId: `escalate#${++siteCounter}`, kind: 'escalate', line: lineOf(node) });
      return;
    }
    // phase(...)
    if (ts.isIdentifier(expr) && expr.text === 'phase') {
      const nameArg = node.arguments[0];
      if (!isPlainLiteral(nameArg)) {
        push(
          node, 9003, 'literal-rule',
          'phase() name must be a compile-time string literal — the approval graph is drawn from it.',
          "Quick Fix: phase('Review') with a fixed title — pick the phase from a static table if it varies by scenario.",
        );
      } else {
        const name = literalValue(nameArg);
        sites.push({ siteId: `phase#${++siteCounter}`, kind: 'phase', line: lineOf(node), phaseName: name, phaseIndex: phases.length });
        if (!phases.includes(name)) phases.push(name);
      }
      return;
    }
    // hole<T>(name, prompt?) — the run-parking typed gap
    if (ts.isIdentifier(expr) && expr.text === 'hole') {
      const nameArg = node.arguments[0];
      const typed = node.typeArguments?.[0] !== undefined;
      if (!typed) {
        push(node, 9010, 'hole-rule', 'hole<T> requires an explicit type argument — the fill body must produce that type.');
      }
      let holeName: string | undefined;
      if (!isPlainLiteral(nameArg)) {
        push(
          node, 9003, 'literal-rule',
          'hole() name must be a compile-time string literal — it labels the fill station and the CLI command.',
          "Quick Fix: hole<Plan>('decide-plan', '…') — a fixed name keeps `workflow fill <runId> <name>` stable.",
        );
      } else {
        holeName = literalValue(nameArg);
        if (phases.includes(holeName) || holeNames.has(holeName)) {
          push(node, 9013, 'hole-rule', `hole name "${holeName}" is already used by another hole or a phase() — names must be unique.`);
        } else {
          holeNames.add(holeName);
        }
      }
      if (insideFanoutCallback(node)) {
        push(node, 9012, 'hole-rule', 'hole() must not stand inside a fan-out callback (.map/.forEach/.filter/...) — the fill would be owed while the items already run.');
      }
      sites.push({ siteId: `hole#${++siteCounter}`, kind: 'hole', line: lineOf(node), holeName, typed });
      return;
    }
    // log(...) / report(...) — report(item, tag?) carries a preset artifact tag
    if (ts.isIdentifier(expr) && (expr.text === 'log' || expr.text === 'report')) {
      sites.push({ siteId: `${expr.text}#${++siteCounter}`, kind: expr.text as 'log' | 'report', line: lineOf(node) });
      if (expr.text === 'report' && node.arguments[1] !== undefined) {
        const tagArg = node.arguments[1];
        if (!ts.isStringLiteral(tagArg) || (tagArg as ts.StringLiteral).text.length === 0) {
          push(node, 9007, 'literal-rule', 'report() artifact tag must be a non-empty compile-time string literal naming a declared preset (Issue #38).');
        } else {
          reportTagSites.push({ node, tag: (tagArg as ts.StringLiteral).text });
        }
      }
      return;
    }
    // artifact.file / artifact.markdown / artifact.chart|table|metrics|board (Issue #38)
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'artifact') {
      const member = expr.name.text;
      if (member === 'file' || member === 'markdown') {
        sites.push({ siteId: `artifact#${++siteCounter}`, kind: 'artifact', line: lineOf(node) });
        checkArtifactId(node, member);
      } else if (member === 'chart' || member === 'table' || member === 'metrics' || member === 'board') {
        sites.push({ siteId: `artifact#${++siteCounter}`, kind: 'artifact', line: lineOf(node) });
        const idArg = checkArtifactId(node, member);
        // 9008 (official ARTIFACT_HOISTING): preset declarations are top-level —
        // banned inside loops, callbacks and conditionals (hole bodies are exempt:
        // the spliced fill body recompiles at fill time and is judged there).
        if (inBannedDeclarationScope()) {
          push(node, 9008, 'facade-misuse', `artifact.${member}() is a declaration, not an effect — declare it once at the top level of the script body; declarations inside loops, callbacks or conditionals are banned (Issue #38).`);
        }
        if (idArg !== undefined) {
          const id = (idArg as ts.StringLiteral).text;
          const prior = artifactKindById.get(id);
          if (prior !== undefined && prior !== member) {
            push(node, 9007, 'facade-misuse', `artifact id "${id}" is already used as ${prior} — an id belongs to one artifact member for the whole run; use a different id (Issue #38).`);
          } else {
            artifactKindById.set(id, member);
          }
          presetDeclarations.push({ node, id, kind: member });
        }
      }
      return;
    }
    // files.* / git.* world reads
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && (expr.expression.text === 'files' || expr.expression.text === 'git')) {
      const readOp = `${expr.expression.text}.${expr.name.text}`;
      sites.push({ siteId: `worldread#${++siteCounter}`, kind: 'worldRead', line: lineOf(node), readOp });
      return;
    }
    // world.run(cmd, ...)
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'world' && expr.name.text === 'run') {
      const cmdArg = node.arguments[0];
      if (!isPlainLiteral(cmdArg)) {
        push(
          node, 9003, 'literal-rule',
          'world.run command must be a compile-time string literal — the command set is shown for approval before the run. Put runtime values in the args array.',
          "Quick Fix: world.run('node', ['--version', extra]) — literal command, values ride in the args array.",
        );
      } else {
        const cmd = literalValue(cmdArg);
        sites.push({ siteId: `worldrun#${++siteCounter}`, kind: 'worldRun', line: lineOf(node), command: cmd });
        if (!commands.includes(cmd)) commands.push(cmd);
      }
      return;
    }
    // <x>.ask<T>(prompt) — captured for lowering + schema synthesis
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'ask') {
      recordAskSite('ask', node);
      return;
    }
    // swarm<T>(agents, tasks) — one ask site that every task goes through, so the
    // journal numbers the turns by task order exactly like an ask in a loop
    if (ts.isIdentifier(expr) && expr.text === 'swarm') {
      recordAskSite('swarm', node);
      return;
    }
  }

  /** An ask-kind site; its type argument T becomes the schema every answer must match. */
  function recordAskSite(prefix: 'ask' | 'swarm', node: ts.CallExpression): void {
    const typeArg = node.typeArguments?.[0];
    const site: FacadeSite = { siteId: `${prefix}#${++siteCounter}`, kind: 'ask', line: lineOf(node) };
    if (typeArg) {
      site.typeArgText = typeArg.getText(sourceFile);
      const synth = synthesizeSchema(checker, typeArg, sourceFile, site.siteId);
      diagnostics.push(...synth.diagnostics.map((d) => ({ ...d, line: Math.max(1, d.line - PRELUDE_LINES) })));
      if (synth.schema) site.schema = synth.schema;
    }
    sites.push(site);
  }

  function push(node: ts.Node, code: number, category: string, message: string, hint?: string): void {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({ tag: 'CompileError', line: Math.max(1, line + 1 - PRELUDE_LINES), column: character + 1, code, category, message, ...(hint ? { hint } : {}) });
  }

  function lineOf(node: ts.Node): number {
    return Math.max(1, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 - PRELUDE_LINES);
  }

  /** 9007 shared id checker: non-empty literal, <=64 chars of [A-Za-z0-9_.-]. Returns the literal when valid. */
  function checkArtifactId(node: ts.CallExpression, member: string): ts.Expression | undefined {
    const idArg = node.arguments[0];
    if (!ts.isStringLiteral(idArg) || (idArg as ts.StringLiteral).text.length === 0) {
      push(node, 9007, 'literal-rule', `artifact.${member}() id must be a non-empty compile-time string literal (Issue #38).`);
      return undefined;
    }
    const id = (idArg as ts.StringLiteral).text;
    if (id.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(id)) {
      push(node, 9007, 'literal-rule', `artifact id "${id}" must be at most 64 characters of [A-Za-z0-9_.-] (Issue #38).`);
      return undefined;
    }
    if (member === 'file' || member === 'markdown') {
      artifactContentIds.add(id);
      // content ids register in the same kind map: an id belongs to ONE
      // member for the whole run, across the content/preset divide too.
      const prior = artifactKindById.get(id);
      if (prior !== undefined && prior !== member) {
        push(node, 9007, 'facade-misuse', `artifact id "${id}" is already used as ${prior} — an id belongs to one artifact member for the whole run; use a different id (Issue #38).`);
      } else {
        artifactKindById.set(id, member);
      }
    }
    return idArg;
  }

  /** 9008 scope check: does the declaration sit inside a loop, callback or conditional? Hole bodies are exempt (the spliced fill body recompiles). */
  function inBannedDeclarationScope(): boolean {
    for (let i = ancestry.length - 1; i >= 0; i--) {
      const n = ancestry[i];
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)
        || ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isSwitchStatement(n)) return true;
      if (ts.isFunctionLike(n)) {
        // callback: a function expression/arrow passed as a call argument
        const p = n.parent;
        if (p !== undefined && ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
          // hole() bodies are exempt: they splice to the top level on fill and recompile there.
          const callee = p.expression;
          if (ts.isIdentifier(callee) && callee.text === 'hole') return false;
          return true;
        }
      }
    }
    return false;
  }

  // ---- Issue #38 post-pass: report tags and the 9009 primary conflict ----
  for (const tag of reportTagSites) {
    if (!artifactKindById.has(tag.tag)) {
      push(tag.node, 9007, 'facade-misuse', `report() tag "${tag.tag}" does not name a declared artifact preset — declare artifact.chart/table/metrics/board("${tag.tag}") before reporting into it (Issue #38).`);
    } else if (artifactContentIds.has(tag.tag)) {
      push(tag.node, 9007, 'facade-misuse', `report() tag "${tag.tag}" names a content artifact id — tags feed preset declarations only (Issue #38).`);
    }
  }
  {
    let primaryHolder: string | undefined;
    for (const decl of presetDeclarations) {
      const spec = decl.node.arguments[1];
      if (spec !== undefined && ts.isObjectLiteralExpression(spec)) {
        const primaryProp = spec.properties.find((sp) => ts.isPropertyAssignment(sp) && ts.isIdentifier(sp.name) && sp.name.text === 'primary');
        if (primaryProp !== undefined && ts.isPropertyAssignment(primaryProp) && primaryProp.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          if (primaryHolder !== undefined && primaryHolder !== decl.id) {
            push(decl.node, 9009, 'facade-misuse', `artifact ids "${primaryHolder}" and "${decl.id}" both declare literal primary: true — at most one id per run is the primary (Issue #38).`);
          } else {
            primaryHolder = decl.id;
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqueDiagnostics = diagnostics.filter((d) => {
    const key = `${d.line}:${d.column}:${d.code}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ok: uniqueDiagnostics.length === 0,
    diagnostics: uniqueDiagnostics,
    sites,
    phases,
    commands,
    actors,
  };
}

