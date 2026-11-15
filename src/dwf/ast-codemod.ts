/**
 * Facade-script AST Codemod: pre-pass desugaring and auto-healing for common
 * LLM syntax violations (such as facade namespace destructuring and agent destructuring).
 *
 * Background (Issue #300):
 * LLMs authoring .facade.ts scripts frequently write destructuring assignments such as:
 *   const { glob, read } = files;
 *   const { ask } = agent('coder');
 * which trigger 9001 facade siting errors because facade callables/namespaces are extracted
 * into intermediate variables rather than called directly.
 *
 * This pre-pass transformer desugars these destructuring patterns into canonical direct
 * calls before strict AST authorization (analyzeFacadeScript) and lowering (lowerFacadeScript).
 * Compliant scripts pass through completely untouched (modified: false).
 */
import ts from 'typescript';

const FACADE_NAMESPACES = new Set([
  'files',
  'git',
  'world',
  'artifact',
  'budget',
  'sessions',
  'fanout',
]);

export interface CodemodResult {
  code: string;
  modified: boolean;
}

interface ReplacementInfo {
  kind: 'namespace' | 'agentCall' | 'agentVar';
  target: string | ts.CallExpression;
  propName: string;
}

/** Check if an identifier is in an expression value position (not a declaration or member name). */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (
    ts.isParameter(parent) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  return true;
}

/**
 * Pre-pass AST codemod for dynamic workflow facade scripts.
 *
 * Desugars:
 *   - const { glob, read } = files; -> removes declaration, rewrites glob(...) -> files.glob(...)
 *   - const { ask } = agent('foo'); -> removes declaration, rewrites ask(...) -> agent('foo').ask(...)
 *   - const p = agent('foo'); const { ask } = p; -> removes declaration, rewrites ask(...) -> p.ask(...)
 *
 * Returns `{ code: source, modified: false }` if no patterns were found.
 */
export function codemodFacadeScript(source: string): CodemodResult {
  const sf = ts.createSourceFile('__facade_codemod__.ts', source, ts.ScriptTarget.ES2022, true);

  // 1. Collect agent variables bound directly to agent(...)
  const agentVars = new Set<string>();
  const scanAgentVars = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'agent'
      ) {
        agentVars.add(node.name.text);
      }
    }
    ts.forEachChild(node, scanAgentVars);
  };
  scanAgentVars(sf);

  // 2. Collect destructuring declarations to rewrite
  const replacements = new Map<string, ReplacementInfo>();
  const declarationsToRemove = new Set<ts.VariableDeclaration>();
  const statementsToRemove = new Set<ts.VariableStatement>();

  const scanDestructuring = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      let matchedCount = 0;
      for (const decl of node.declarationList.declarations) {
        if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
          const init = decl.initializer;
          let baseInfo: { kind: 'namespace' | 'agentCall' | 'agentVar'; target: string | ts.CallExpression } | null = null;

          if (ts.isIdentifier(init) && FACADE_NAMESPACES.has(init.text)) {
            baseInfo = { kind: 'namespace', target: init.text };
          } else if (
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === 'agent'
          ) {
            baseInfo = { kind: 'agentCall', target: init };
          } else if (ts.isIdentifier(init) && agentVars.has(init.text)) {
            baseInfo = { kind: 'agentVar', target: init.text };
          }

          if (baseInfo) {
            declarationsToRemove.add(decl);
            matchedCount++;
            for (const elem of decl.name.elements) {
              if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
                const localName = elem.name.text;
                const propName =
                  elem.propertyName && ts.isIdentifier(elem.propertyName)
                    ? elem.propertyName.text
                    : localName;
                replacements.set(localName, { ...baseInfo, propName });
              }
            }
          }
        }
      }

      if (matchedCount > 0 && matchedCount === node.declarationList.declarations.length) {
        statementsToRemove.add(node);
      }
    }
    ts.forEachChild(node, scanDestructuring);
  };
  scanDestructuring(sf);

  // If no destructuring patterns were found, return the exact original source untouched.
  if (replacements.size === 0) {
    return { code: source, modified: false };
  }

  // 3. Preserve leading comments from completely removed statements
  const bufferedComments: Array<{
    kind: ts.CommentKind;
    text: string;
    hasTrailingNewLine?: boolean;
  }> = [];

  for (const stmt of statementsToRemove) {
    const ranges = ts.getLeadingCommentRanges(source, stmt.getFullStart());
    if (ranges) {
      for (const r of ranges) {
        const text = source.substring(r.pos, r.end);
        const isSingle = r.kind === ts.SyntaxKind.SingleLineCommentTrivia;
        const stripped = isSingle
          ? text.replace(/^\/\/\s?/, '')
          : text.replace(/^\/\*\s?/, '').replace(/\s?\*\/$/, '');
        bufferedComments.push({ kind: r.kind, text: stripped, hasTrailingNewLine: r.hasTrailingNewLine ?? true });
      }
    }
  }

  // 4. Transform AST: remove destructuring declarations and rewrite identifier references
  const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    let commentsAttached = false;
    const scopeStack: Array<Set<string>> = [new Set()];

    const visitor: ts.Visitor = (node) => {
      // If statement is marked for total removal
      if (ts.isVariableStatement(node) && statementsToRemove.has(node)) {
        return undefined;
      }

      // If statement has partial declaration removal
      if (ts.isVariableStatement(node)) {
        const remaining = node.declarationList.declarations.filter((d) => !declarationsToRemove.has(d));
        if (remaining.length < node.declarationList.declarations.length) {
          if (remaining.length === 0) {
            return undefined;
          }
          const updatedList = ctx.factory.updateVariableDeclarationList(node.declarationList, remaining);
          return ctx.factory.updateVariableStatement(node, node.modifiers, updatedList);
        }
      }

      // Attach buffered leading comments to the first retained statement
      if (ts.isStatement(node) && !commentsAttached && bufferedComments.length > 0) {
        commentsAttached = true;
        for (const c of bufferedComments) {
          ts.addSyntheticLeadingComment(node, c.kind, c.text, c.hasTrailingNewLine);
        }
      }

      // Manage lexical scope for shadowing checks
      let pushedScope = false;
      if (ts.isBlock(node) || ts.isFunctionLike(node)) {
        scopeStack.push(new Set());
        pushedScope = true;
        if (ts.isFunctionLike(node)) {
          for (const param of node.parameters) {
            if (ts.isIdentifier(param.name)) {
              scopeStack[scopeStack.length - 1].add(param.name.text);
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !declarationsToRemove.has(node)) {
        scopeStack[scopeStack.length - 1].add(node.name.text);
      }

      // Check identifier replacement
      if (ts.isIdentifier(node) && isReference(node) && replacements.has(node.text)) {
        const isShadowed = scopeStack.some((s) => s.has(node.text));
        if (!isShadowed) {
          const info = replacements.get(node.text)!;
          let replacementExpr: ts.Expression | undefined;

          if (info.kind === 'namespace') {
            replacementExpr = ctx.factory.createPropertyAccessExpression(
              ctx.factory.createIdentifier(info.target as string),
              info.propName
            );
          } else if (info.kind === 'agentCall') {
            replacementExpr = ctx.factory.createPropertyAccessExpression(
              info.target as ts.CallExpression,
              info.propName
            );
          } else if (info.kind === 'agentVar') {
            replacementExpr = ctx.factory.createPropertyAccessExpression(
              ctx.factory.createIdentifier(info.target as string),
              info.propName
            );
          }

          if (replacementExpr) {
            if (pushedScope) scopeStack.pop();
            return replacementExpr;
          }
        }
      }

      const visited = ts.visitEachChild(node, visitor, ctx);
      if (pushedScope) scopeStack.pop();
      return visited;
    };

    return (sfNode) => ts.visitNode(sfNode, visitor, ts.isSourceFile) as ts.SourceFile;
  };

  const transformed = ts.transform(sf, [transformer]);
  const transformedSf = transformed.transformed[0];

  // If the transformed file is empty but comments were buffered, emit them
  if (transformedSf.statements.length === 0 && bufferedComments.length > 0) {
    transformed.dispose();
    const commentLines = bufferedComments.map((c) =>
      c.kind === ts.SyntaxKind.SingleLineCommentTrivia ? `// ${c.text}` : `/* ${c.text} */`
    );
    return { code: commentLines.join('\n') + '\n', modified: true };
  }

  const printer = ts.createPrinter({ removeComments: false });
  const code = printer.printFile(transformedSf);
  transformed.dispose();

  return { code, modified: true };
}
