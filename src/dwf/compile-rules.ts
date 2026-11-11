/**
 * Facade compile rules — the static authorization vocabulary of the facade
 * compiler: the ban sets (purity 9002, prototype-chain 9002, facade siting
 * 9001, shadowing 9004) and the AST predicate helpers the authorization walk
 * composes. Pure functions over the TypeScript AST; the walk itself lives in
 * compile.ts `analyzeFacadeScript`.
 *
 * The design stance is not a hole-by-hole blacklist but a closed world written
 * as rules: everything a script needs enters through the facade primitives and
 * `args`; the rest of the world does not exist at compile time.
 */
import ts from 'typescript';

/** Facade identifiers a script must never shadow. */
export const FACADE_IDENTIFIERS = new Set(['agent', 'phase', 'log', 'report', 'args', 'budget', 'files', 'git', 'world', 'artifact', 'Node', 'Agent', 'sessions', 'fanout', 'swarm', 'run', 'workflow', 'channel', 'future', 'Channel', 'Future']);

/**
 * 9002 purity ban, identifier half (Date.now/Math.random/prototype-chain are
 * the member half). The list enumerates every known way out of the closed
 * world: code generation and privileged evaluation (eval/Function/globalThis),
 * environment authority (process/require), network and raw bytes
 * (fetch/Buffer), out-of-band scheduling (setTimeout/setInterval/setImmediate/
 * queueMicrotask — execution order would leave the linear site sequence the
 * lowering lays down, breaking replay determinism at the root), and host path
 * leakage (__dirname/__filename). References are intercepted, not binding
 * names: declaration positions are exempt (isReference), every value position
 * is banned — `const e = eval` hits 9002 on the right-hand side.
 */
export const BANNED_IDENTIFIERS = new Set(['globalThis', 'eval', 'Function', 'process', 'require', 'fetch', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', '__dirname', '__filename']);

/**
 * 9002 prototype-chain ban: constructor/__proto__/prototype is the complete
 * ladder from any script-visible value up to the realm Function — the classic
 * zero-import escape `({}).constructor.constructor` reaches it in two steps;
 * __proto__ is an alternate spelling of the same endpoint (and a prototype-
 * pollution write channel); prototype hands over the whole constructor/method
 * table. The ban applies to EVERY object, not a whitelist: the compiler cannot
 * know what hides in a value's prototype chain, so these three names are
 * untouchable outright. Both spellings are intercepted in the authorization
 * walk (dot form on every PropertyAccessExpression named one of the three,
 * string-literal index obj['constructor'] under the same code). Computed keys
 * are the static channel's known boundary — defense in depth layers there:
 * the runtime realm backstop (codeGeneration:{strings:false}) refuses to
 * compile strings even if the ladder is built.
 */
export const PROTOTYPE_CHAIN_PROPS = new Set(['constructor', '__proto__', 'prototype']);

/**
 * 9001 facade siting (official pass1 minimal subset, message verbatim): a facade callable
 * may only appear as the callee of a direct call. Any other position — alias assignment,
 * destructuring extraction, argument passing, bind/call/apply — reifies the callable into
 * a value the lowering never sites, desyncing the static site table from the execution
 * order the journal and replay are keyed on. The official pass is checker-based; this walk
 * is syntactic and matches the facade's own names (functions, namespace objects, their
 * members) — the same name basis the site walk itself uses, so every reference it can
 * express is a reference the lowering would miss. `run`/`args` stay out: they are plain
 * data, not callables.
 */
export const FACADE_FUNCTION_IDENTIFIERS = new Set(['agent', 'phase', 'log', 'report', 'hole', 'escalate', 'workflow', 'channel', 'future', 'swarm']);
export const FACADE_NAMESPACE_IDENTIFIERS = new Set(['files', 'git', 'world', 'artifact', 'budget', 'sessions', 'fanout']);
export const FACADE_NAMESPACE_MEMBERS: Record<string, Set<string>> = {
  files: new Set(['glob', 'read', 'grep', 'map']),
  git: new Set(['changedFiles', 'diff', 'status', 'log']),
  world: new Set(['run']),
  artifact: new Set(['file', 'markdown']),
  budget: new Set(['spent', 'remaining']),
  sessions: new Set(['waitAny', 'race', 'cancel']),
  fanout: new Set(['parallel', 'pipeline']),
};
/** bind/call/apply re-site a callable without calling it — banned on facade callables. */
export const REFLECTION_METHODS = new Set(['bind', 'call', 'apply']);

const FANOUT_ARRAY_METHODS = new Set(['map', 'forEach', 'filter', 'flatMap', 'reduce', 'reduceRight', 'some', 'every']);

export function facadeSitingMessage(name: string): string {
  return `facade function '${name}' may only be called directly; taking a reference to it defeats site identity (journal and replay key off call sites)`;
}

/**
 * D9 (GAP-MATRIX): a glob pattern inside a block comment contains the comment
 * terminator (the two stars of a double-star glob segment plus the path slash) —
 * the comment ends there, the rest leaks into the parse as pseudo-code, and
 * check's diagnostics land on comment text. Two evidence lines, both required,
 * so legal scripts that merely close a comment with star-star-slash stay clean:
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
export function findGlobBrokenComments(sourceFile: ts.SourceFile): ts.CommentRange[] {
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

export function isReference(node: ts.Identifier): boolean {
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

/**
 * 9001 position test for a facade function/namespace identifier: the ONLY legal value
 * position is the callee of a direct call (`agent("x")`). Name positions (declaration
 * names, property/method/interface member names — shadowing is 9004's business) and
 * erased positions (typeof, type references) stay legal; base positions (the `files` in
 * `files.read`) stay legal here because the member rule below governs the harm. A wrapped
 * callee (`(agent)("x")`) fails this test on purpose: the site walk only sites bare
 * callees, so refusing is fail-closed rather than waving an unsited call through.
 */
export function isFacadeReferenceIllegal(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return false;
  if (ts.isBindingElement(p) && p.name === node) return false;
  if (ts.isVariableDeclaration(p) && p.name === node) return false;
  if (ts.isParameter(p) && p.name === node) return false;
  if (ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isTypeReferenceNode(p)) return false;
  if (ts.isCallExpression(p) && p.expression === node) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) return false;
  return true;
}

/** The facade member a property access reifies ("p.ask", "files.read"), or undefined. */
export function facadeMemberName(pa: ts.PropertyAccessExpression, agentVars: Set<string>): string | undefined {
  const base = pa.expression;
  if (ts.isIdentifier(base)) {
    if (agentVars.has(base.text) && pa.name.text === 'ask') return `${base.text}.ask`;
    const members = FACADE_NAMESPACE_MEMBERS[base.text];
    if (members?.has(pa.name.text)) return `${base.text}.${pa.name.text}`;
    return undefined;
  }
  // chained extraction off a direct call: const f = agent("x").ask
  if (pa.name.text === 'ask' && ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === 'agent') {
    return 'agent(...).ask';
  }
  return undefined;
}

/** The facade callable a bind/call/apply receiver reifies, or undefined. */
export function reflectionBaseName(expr: ts.Expression, agentVars: Set<string>): string | undefined {
  if (ts.isIdentifier(expr)) {
    return FACADE_FUNCTION_IDENTIFIERS.has(expr.text) || FACADE_NAMESPACE_IDENTIFIERS.has(expr.text) ? expr.text : undefined;
  }
  if (ts.isPropertyAccessExpression(expr)) return facadeMemberName(expr, agentVars);
  return undefined;
}

/** The facade member a binding element extracts (const { ask } = planner), or undefined. */
export function facadeDestructuredMember(el: ts.BindingElement, agentVars: Set<string>): string | undefined {
  const pattern = el.parent;
  const decl = pattern.parent;
  if (!ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.initializer)) return undefined;
  const source = decl.initializer.text;
  const boundName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
  if (!boundName) return undefined;
  if (agentVars.has(source) && boundName === 'ask') return 'ask';
  if (FACADE_NAMESPACE_IDENTIFIERS.has(source) && FACADE_NAMESPACE_MEMBERS[source]?.has(boundName)) return boundName;
  return undefined;
}

/** Variable names bound to agent(...) results, directly or through alias chains. */
export function collectAgentBoundNames(sourceFile: ts.SourceFile): Set<string> {
  const decls: ts.VariableDeclaration[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) decls.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  const bound = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of decls) {
      const init = d.initializer;
      const isAgentCall = init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'agent';
      const isAgentAlias = init !== undefined && ts.isIdentifier(init) && bound.has(init.text);
      if (!isAgentCall && !isAgentAlias) continue;
      const names: string[] = [];
      collectNames(d.name, names);
      for (const n of names) {
        if (!bound.has(n)) {
          bound.add(n);
          grew = true;
        }
      }
    }
  }
  return bound;
}

export function declarationsOf(node: ts.Node): string[] {
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

export function isPlainLiteral(node: ts.Node | undefined): boolean {
  if (!node) return false;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * True when the node stands inside a function that is an argument to an array-method
 * call (map/forEach/filter/flatMap/reduce/some/every) — where a hole's fill would be
 * owed while the items already run (diagnostic 9012).
 */
export function insideFanoutCallback(node: ts.Node): boolean {
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

function containsDescendant(root: ts.Node, target: ts.Node): boolean {
  if (root === target) return true;
  let found = false;
  root.forEachChild((child) => {
    if (found) return;
    if (containsDescendant(child, target)) found = true;
  });
  return found;
}

export function literalValue(node: ts.Node): string {
  return (node as ts.StringLiteral).text;
}
