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
 */
import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { FACADE_DTS } from './facade-dts.js';
import { FacadeAnalysis, FacadeDiagnostic, FacadeSite } from './diagnostics.js';
import { synthesizeSchema } from './schema-synth.js';

const SCRIPT_VIRTUAL_NAME = '__facade_script__.ts';
const FACADE_VIRTUAL_NAME = 'workflow-facade.d.ts';
const PRELUDE_LINES = 1; // async function __workflowScript__() {

const require_ = createRequire(import.meta.url);
const TS_LIB_DIR = path.dirname(require_.resolve('typescript/package.json'));

/** Facade identifiers a script must never shadow. */
const FACADE_IDENTIFIERS = new Set(['agent', 'phase', 'log', 'report', 'args', 'budget', 'files', 'git', 'world', 'artifact', 'Node', 'Agent', 'sessions', 'fanout', 'run', 'workflow']);

/** Banned global identifiers (purity / determinism). */
const BANNED_IDENTIFIERS = new Set(['globalThis', 'eval', 'Function', 'process', 'require', 'fetch', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', '__dirname', '__filename']);

/** Property names whose access can rebuild Function from nothing (({}).constructor.constructor) — banned on any object. */
const PROTOTYPE_CHAIN_PROPS = new Set(['constructor', '__proto__', 'prototype']);

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

/** Analyze a facade script: type diagnostics + authorization rules + site table. */
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
  visit(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      push(node, 9006, 'facade-misuse', 'import/export is banned in facade scripts — the script is a closed world (facade primitives only).');
      return;
    }
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text) && isReference(node)) {
      push(node, 9002, 'purity-ban', `"${node.text}" is banned — facade scripts are deterministic and sandboxed; pass what you need via args.`);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // Date.now / Math.random / Date.parse-style purity bans
      const obj = node.expression;
      if (ts.isIdentifier(obj) && obj.text === 'Date' && (node.name.text === 'now' || node.name.text === 'parse')) {
        push(node, 9002, 'purity-ban', `Date.${node.name.text}() is banned — pass timestamps via args so relaunch replays byte-identical.`);
        return;
      }
      if (ts.isIdentifier(obj) && obj.text === 'Math' && node.name.text === 'random') {
        push(node, 9002, 'purity-ban', 'Math.random() is banned — pass randomness via args so relaunch replays byte-identical.');
        return;
      }
      // constructor/__proto__/prototype chain — rebuilds Function from nothing (({}).constructor.constructor)
      if (PROTOTYPE_CHAIN_PROPS.has(node.name.text)) {
        push(node, 9002, 'purity-ban', `"${node.name.text}" property access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`);
        return;
      }
    }
    // bracket-form equivalent: obj["constructor"] / obj["__proto__"] / obj["prototype"]
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && PROTOTYPE_CHAIN_PROPS.has(node.argumentExpression.text)) {
      push(node, 9002, 'purity-ban', `"${node.argumentExpression.text}" index access is banned — constructor-chain access can rebuild Function from nothing; facade primitives only.`);
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date' && (node.arguments?.length ?? 0) === 0) {
      push(node, 9002, 'purity-ban', 'new Date() without arguments is banned — pass the timestamp via args so relaunch replays byte-identical.');
      return;
    }
    if (ts.isVariableDeclarationList(node) || ts.isParameter(node)) {
      for (const nameNode of declarationsOf(node)) {
        if (FACADE_IDENTIFIERS.has(nameNode)) {
          push(node, 9004, 'facade-misuse', `"${nameNode}" shadows a facade primitive — pick another name.`);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      handleCall(node);
    }
    ts.forEachChild(node, visit);
  }

  function handleCall(node: ts.CallExpression): void {
    const expr = node.expression;
    // import(...) — dynamic import ban
    if (expr.kind === ts.SyntaxKind.ImportKeyword) {
      push(node, 9006, 'facade-misuse', 'dynamic import() is banned in facade scripts.');
      return;
    }
    // agent(...) — opts?.provider recorded when a string literal
    if (ts.isIdentifier(expr) && expr.text === 'agent') {
      const id = `actor#${++siteCounter}`;
      const nameArg = node.arguments[0];
      const optsArg = node.arguments[1];
      let provider: string | undefined;
      if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
        for (const prop of optsArg.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'provider' && ts.isStringLiteral(prop.initializer)) {
            provider = prop.initializer.text;
          } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'provider') {
            push(node, 9014, 'facade-misuse', 'agent() provider option must be a compile-time string literal — provider routing is part of the approved run shape.');
          }
        }
      }
      sites.push({ siteId: id, kind: 'actor', line: lineOf(node), actorName: isPlainLiteral(nameArg) ? literalValue(nameArg) : undefined, provider });
      if (isPlainLiteral(nameArg) && !actors.includes(literalValue(nameArg))) actors.push(literalValue(nameArg));
      return; // arguments still visited by forEachChild for nested bans
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
        push(node, 9003, 'literal-rule', 'phase() name must be a compile-time string literal — the approval graph is drawn from it.');
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
        push(node, 9003, 'literal-rule', 'hole() name must be a compile-time string literal — it labels the fill station and the CLI command.');
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
    // log(...) / report(...)
    if (ts.isIdentifier(expr) && (expr.text === 'log' || expr.text === 'report')) {
      sites.push({ siteId: `${expr.text}#${++siteCounter}`, kind: expr.text as 'log' | 'report', line: lineOf(node) });
      return;
    }
    // artifact.file / artifact.markdown
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'artifact') {
      if (expr.name.text === 'file' || expr.name.text === 'markdown') {
        sites.push({ siteId: `artifact#${++siteCounter}`, kind: 'artifact', line: lineOf(node) });
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
        push(node, 9003, 'literal-rule', 'world.run command must be a compile-time string literal — the command set is shown for approval before the run. Put runtime values in the args array.');
      } else {
        const cmd = literalValue(cmdArg);
        sites.push({ siteId: `worldrun#${++siteCounter}`, kind: 'worldRun', line: lineOf(node), command: cmd });
        if (!commands.includes(cmd)) commands.push(cmd);
      }
      return;
    }
    // <x>.ask<T>(prompt) — captured for lowering + schema synthesis
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'ask') {
      const typeArg = node.typeArguments?.[0];
      const site: FacadeSite = { siteId: `ask#${++siteCounter}`, kind: 'ask', line: lineOf(node) };
      if (typeArg) {
        site.typeArgText = typeArg.getText(sourceFile);
        const synth = synthesizeSchema(checker, typeArg, sourceFile, site.siteId);
        diagnostics.push(...synth.diagnostics.map((d) => ({ ...d, line: Math.max(1, d.line - PRELUDE_LINES) })));
        if (synth.schema) site.schema = synth.schema;
      }
      sites.push(site);
      return;
    }
  }

  function push(node: ts.Node, code: number, category: string, message: string): void {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({ tag: 'CompileError', line: Math.max(1, line + 1 - PRELUDE_LINES), column: character + 1, code, category, message });
  }

  function lineOf(node: ts.Node): number {
    return Math.max(1, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 - PRELUDE_LINES);
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

/**
 * D9 (GAP-MATRIX): a glob pattern inside a block comment contains the comment
 * terminator (the two stars of a double-star glob segment plus the path slash) —
 * the comment ends there (src/star-star/star.ts and src/star-star/main.ts alike),
 * the rest leaks into the parse as pseudo-code, and check's diagnostics land on
 * comment text. Two evidence lines, both required, so legal scripts that merely
 * close a comment with star-star-slash stay clean:
 *   1. the comment content ends in a star (it was closed by a double-star-slash
 *      glob) while still carrying non-star, non-blank text — this excludes the
 *      pure star-rule separator comments written as runs of stars;
 *   2. an ORPHAN terminator follows before any new comment opens: the author's
 *      intended closing star-slash leaked into the code as a syntax wound. A
 *      star-slash that belongs to a LATER legal comment (a new comment opens
 *      first) is not evidence — such scripts are legal and stay clean.
 * A script that trips both lines cannot compile (the orphan terminator alone is
 * a syntax error), so the single precise diagnostic replaces the flood with zero
 * false rejections.
 */
function findGlobBrokenComments(sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.text;
  const out: ts.CommentRange[] = [];
  const seen = new Set<number>();
  const scan = (node: ts.Node): void => {
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
    if (ranges) {
      for (const r of ranges) {
        if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia || seen.has(r.pos)) continue;
        seen.add(r.pos);
        if (text[r.end - 3] !== '*' || !/[^\s*]/.test(text.slice(r.pos + 2, r.end - 2))) continue;
        // evidence 2: orphan terminator — closes before any new comment opens
        const nextClose = text.indexOf('*' + '/', r.end);
        const nextOpen = text.indexOf('/' + '*', r.end);
        if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) out.push(r);
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(sourceFile);
  return out;
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  // property access on someone else (obj.xyz), declarations, import names are not references
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (parent && ts.isPropertySignature(parent)) return false;
  if (parent && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))) return false;
  // D3 (GAP-MATRIX): a VariableDeclaration excludes only its NAME position — the
  // initializer is a reference, so `const e = eval` / `const g = globalThis` hit 9002.
  if (parent && (ts.isParameter(parent) || (ts.isVariableDeclaration(parent) && parent.name === node) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || (ts.isPropertyAssignment(parent) && parent.name === node))) return false;
  return true;
}

function declarationsOf(node: ts.Node): string[] {
  const names: string[] = [];
  if (ts.isVariableDeclarationList(node)) {
    for (const decl of node.declarations) {
      collectNames(decl.name, names);
    }
  } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
    names.push(node.name.text);
  }
  return names;
}

function collectNames(name: ts.Node, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectNames(el.name, out);
    }
  }
}

function isPlainLiteral(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  return false;
}

/**
 * True when the node stands inside a function that is an argument to an array-method
 * call (map/forEach/filter/flatMap/reduce/some/every) — where a hole's fill would be
 * owed while the items already run (diagnostic 9012).
 */
function insideFanoutCallback(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      const fnParent = current.parent;
      if (fnParent && ts.isCallOrNewExpression(fnParent) && fnParent.arguments?.some((a) => containsDescendant(a, current!))) {
        const callee = fnParent.expression;
        const methodName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (FANOUT_ARRAY_METHODS.has(methodName)) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

const FANOUT_ARRAY_METHODS = new Set(['map', 'forEach', 'filter', 'flatMap', 'reduce', 'reduceRight', 'some', 'every']);

function containsDescendant(root: ts.Node, target: ts.Node): boolean {
  if (root === target) return true;
  let found = false;
  root.forEachChild((child) => {
    if (found) return;
    if (containsDescendant(child, target)) found = true;
  });
  return found;
}

function literalValue(node: ts.Node): string {
  return (node as ts.StringLiteral).text;
}
