/**
 * Lowering: rewrite the facade calls in a script into `__host.*` boundary calls with
 * compile-time site ids, then transpile TS → plain JS for the sandbox child.
 *
 * Same approach as ZCode's `packages/dynamic-workflow/src/lowering/lower.ts`: the
 * orchestration control flow stays native TS (Promise.all, loops, ternaries are untouched);
 * only facade boundary calls are rewritten, each stamped with a stable site id
 * (`actor#2`, `ask#3`, ...) in AST visit order — the same order the analyzer numbers
 * them, and the key the journal replays by.
 *
 * Output shape (a plain script, no imports/exports):
 *   async function __workflowScript__() { ...lowered body... }
 */
import ts from 'typescript';
import { FacadeAnalysis, FacadeSite } from './diagnostics.js';
import { analyzeFacadeScript, wrapScriptSource } from './compile.js';

export interface LowerResult {
  /** Executable plain JS: the wrapped async function only. */
  js: string;
  analysis: FacadeAnalysis;
}

export function lowerFacadeScript(source: string): LowerResult {
  const analysis = analyzeFacadeScript(source);
  const sites = analysis.sites;

  const wrapped = wrapScriptSource(source);
  const sourceFile = ts.createSourceFile('__lower__.ts', wrapped, ts.ScriptTarget.ES2022, /*setParentNodes*/ true, ts.ScriptKind.TS);

  let siteCursor = 0; // walks `sites` in the same order the transformer meets calls
  const nextSite = (expectedKind: FacadeSite['kind']): FacadeSite => {
    const site = sites[siteCursor++];
    if (!site || site.kind !== expectedKind) {
      throw new Error(`lowering internal error: site#${siteCursor} expected ${expectedKind}, got ${site ? site.kind : 'eof'}`);
    }
    return site;
  };

  const transform: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const visitor: ts.Visitor = (node) => {
      // args → __host.args ; budget → __host.budget
      if (ts.isIdentifier(node) && node.text === 'args' && isArgsReference(node)) {
        return ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier('__host'), 'args');
      }
      if (ts.isIdentifier(node) && node.text === 'budget' && isArgsReference(node)) {
        return ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier('__host'), 'budget');
      }
      if (ts.isIdentifier(node) && node.text === 'run' && isArgsReference(node)) {
        return ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier('__host'), 'run');
      }
      if (ts.isCallExpression(node)) {
        return rewriteCall(node, ctx, visitor, nextSite);
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        // analyzer bans these; keep the lowering total (drop from emitted JS)
        return ctx.factory.createEmptyStatement() as unknown as ts.Statement;
      }
      return ts.visitEachChild(node, visitor, ctx);
    };
    return (sf) => ts.visitNode(sf, visitor, ts.isSourceFile) as ts.SourceFile;
  };

  const { transformed } = ts.transform(sourceFile, [transform]);
  const printed = ts.createPrinter({ omitTrailingSemicolon: false }).printFile(transformed[0]);
  const transpiled = ts.transpileModule(printed, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      inlineSourceMap: false,
    },
    fileName: '__lower__.js',
  });

  return { js: transpiled.outputText, analysis };
}

type NextSite = (expectedKind: FacadeSite['kind']) => FacadeSite;

function rewriteCall(node: ts.CallExpression, ctx: ts.TransformationContext, visitor: ts.Visitor, nextSite: NextSite): ts.Expression {
  const f = ctx.factory;
  const expr = node.expression;
  const visitArgs = () => node.arguments.map((a) => ts.visitNode(a, visitor, ts.isExpression) as ts.Expression);

  const host = (fn: string, ...callArgs: ts.Expression[]) =>
    f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('__host'), fn), undefined, callArgs);

  // dynamic import() ban — analyzer already reported; drop the call
  if (expr.kind === ts.SyntaxKind.ImportKeyword) {
    return host('banned', f.createStringLiteral('dynamic import'));
  }

  // agent(...) → __host.createActor("actor#N", name, provider|null)
  if (ts.isIdentifier(expr) && expr.text === 'agent') {
    const site = nextSite('actor');
    const visited = visitArgs();
    const nameArg = visited[0] ?? f.createStringLiteral('');
    let providerLiteral: ts.Expression | undefined;
    const rawOpts = node.arguments[1];
    if (rawOpts && ts.isObjectLiteralExpression(rawOpts)) {
      for (const prop of rawOpts.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'provider' && ts.isStringLiteral(prop.initializer)) {
          providerLiteral = f.createStringLiteral(prop.initializer.text);
        }
      }
    }
    return host('createActor', f.createStringLiteral(site.siteId), nameArg, providerLiteral ?? f.createNull());
  }

  // escalate(question) → __host.escalate(siteId, question)
  if (ts.isIdentifier(expr) && expr.text === 'escalate') {
    const site = nextSite('escalate');
    const args = visitArgs();
    return host('escalate', f.createStringLiteral(site.siteId), args[0] ?? f.createStringLiteral(''));
  }

  // phase(...) → __host.enterPhase(name)
  if (ts.isIdentifier(expr) && expr.text === 'phase') {
    const phaseSite = nextSite('phase');
    return host('enterPhase', ...visitArgs(), f.createNumericLiteral(phaseSite.phaseIndex ?? 0));
  }

  // workflow(name) → __host.workflow(siteId, name)
  if (ts.isIdentifier(expr) && expr.text === 'workflow') {
    const site = nextSite('workflow');
    const args = visitArgs();
    return host('workflow', f.createStringLiteral(site.siteId), args[0] ?? f.createStringLiteral(''));
  }

  // hole(name, prompt?) → __host.hole(siteId, name, prompt)
  if (ts.isIdentifier(expr) && expr.text === 'hole') {
    const site = nextSite('hole');
    const args = visitArgs();
    return host('hole', f.createStringLiteral(site.siteId), args[0] ?? f.createStringLiteral(''), args[1] ?? f.createStringLiteral(''));
  }

  // log(...) / report(...) — report carries its siteId for per-item journaling
  if (ts.isIdentifier(expr) && (expr.text === 'log' || expr.text === 'report')) {
    const site = nextSite(expr.text);
    return host(expr.text, f.createStringLiteral(site.siteId), ...visitArgs());
  }

  // artifact.file / artifact.markdown
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'artifact' && (expr.name.text === 'file' || expr.name.text === 'markdown')) {
    const site = nextSite('artifact');
    return host('artifact', f.createStringLiteral(site.siteId), f.createStringLiteral(expr.name.text), f.createArrayLiteralExpression(visitArgs(), true));
  }

  // files.* / git.* → __host.worldRead(siteId, op, [args])
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && (expr.expression.text === 'files' || expr.expression.text === 'git')) {
    const site = nextSite('worldRead');
    const readOp = `${expr.expression.text}.${expr.name.text}`;
    return host('worldRead', f.createStringLiteral(site.siteId), f.createStringLiteral(readOp), f.createArrayLiteralExpression(visitArgs(), true));
  }

  // world.run(cmd, args, opts) → __host.worldRun(siteId, cmd, args, opts)
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'world' && expr.name.text === 'run') {
    const site = nextSite('worldRun');
    return host('worldRun', f.createStringLiteral(site.siteId), ...visitArgs());
  }

  // sessions.* / fanout.* → local realm helpers (no site: pure child-realm
  // coordination; cancellation crosses to the parent as a notify, not a journalled call)
  const realmHelpers: Array<[string, string[]]> = [
    ['sessions', ['waitAny', 'cancel']],
    ['fanout', ['parallel', 'pipeline']],
  ];
  for (const [host, fns] of realmHelpers) {
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === host && fns.includes(expr.name.text)) {
      return f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(`__${host}`), f.createIdentifier(expr.name.text)), undefined, visitArgs());
    }
  }

  // <x>.ask<T>(prompt) → __host.ask(siteId, x, prompt, schemaJson|null)
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'ask') {
    const site = nextSite('ask');
    const receiver = ts.visitNode(expr.expression, visitor, ts.isExpression) as ts.Expression;
    const promptArg = visitArgs()[0] ?? f.createStringLiteral('');
    const schemaArg: ts.Expression = site.schema
      ? f.createStringLiteral(JSON.stringify(site.schema))
      : f.createNull();
    return host('ask', f.createStringLiteral(site.siteId), receiver, promptArg, schemaArg);
  }

  // not a facade call: recurse into receiver + arguments
  return f.createCallExpression(
    ts.visitNode(expr, visitor, ts.isExpression) as ts.Expression,
    undefined,
    visitArgs(),
  );
}

/** `args` is rewritten only where it refers to the facade constant, never property names. */
function isArgsReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  // declarations named args are banned by the analyzer; leave them untouched so the
  // compiler diagnostics (not the lowering) carry the error
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) return false;
  return true;
}

/**
 * Splice a fill body into the author's source, replacing the `hole("<name>", ...)` call
 * with an async IIFE standing exactly where the hole stood — so the body sees every
 * binding declared before it and its await is the hole's value. Returns null when no
 * hole with that name exists.
 */
export function spliceHoleBody(source: string, holeName: string, body: string): string | null {
  const sf = ts.createSourceFile('__fill__.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let target: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (target) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'hole' &&
      node.arguments[0] &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      (node.arguments[0] as ts.StringLiteral).text === holeName
    ) {
      target = node;
      return;
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  if (!target) return null;
  const replacement = `(async () => {\n${body}\n})()`;
  return source.slice(0, target.getStart(sf)) + replacement + source.slice(target.getEnd());
}
