/**
 * Budget-capped code slices (y.md 支柱二, Issue #157): given a target file and
 * the repomap's relevant symbol names, keep only the top-level declarations
 * that matter — the smallest sufficient answer for an LLM that needs the
 * file's shape, not its full body.
 *
 * The budget is a HARD cap: the text never exceeds it, and truncation is
 * always announced with an in-band marker so a consumer can never mistake a
 * cut for completeness.
 */
import * as ts from 'typescript';
import * as fs from 'node:fs';

export interface SliceResult {
  /** The target file path (workspace-relative, as given). */
  target: string;
  /** The sliced text (never over the budget). */
  text: string;
  /** True when the budget cut the slice short. */
  truncated: boolean;
  /** Names of the top-level declarations that made it into the slice. */
  keptSymbols: string[];
}

export interface SliceOptions {
  /** Hard character cap on the slice text (default 4000). */
  budgetChars?: number;
}

const DEFAULT_BUDGET_CHARS = 4000;
const TRUNCATION_MARKER = '\n[…repomap slice truncated';

interface TopLevelDecl {
  name: string;
  text: string;
}

function topLevelDeclarations(source: ts.SourceFile): TopLevelDecl[] {
  const out: TopLevelDecl[] = [];
  const nameOf = (node: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isClassDeclaration(node) && node.name) return node.name.text;
    if (ts.isInterfaceDeclaration(node)) return node.name.text;
    if (ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isEnumDeclaration(node)) return node.name.text;
    if (ts.isVariableStatement(node)) {
      const first = node.declarationList.declarations[0];
      return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
    }
    return undefined;
  };
  for (const statement of source.statements) {
    const name = nameOf(statement);
    if (name !== undefined) {
      out.push({ name, text: statement.getText(source) });
    }
  }
  return out;
}

/** Slice one file down to its relevant declarations, under a hard budget. */
export function sliceTargetFile(absPath: string, relevantSymbols: ReadonlySet<string>, options: SliceOptions = {}): SliceResult {
  const budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  // The truncation marker rides INSIDE the budget — the returned text never
  // exceeds budgetChars even when it announces its own cut.
  const codeBudget = Math.max(budgetChars - TRUNCATION_MARKER.length - 24, 200);
  const text = fs.readFileSync(absPath, 'utf8');
  const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const decls = topLevelDeclarations(source);

  // Relevant declarations first (map order), then the rest — the file's own
  // shape stays available even when nothing matches, but relevance wins the
  // budget.
  const relevant = decls.filter((d) => relevantSymbols.has(d.name));
  const filler = decls.filter((d) => !relevantSymbols.has(d.name));
  const ordered = [...relevant, ...filler];

  const kept: TopLevelDecl[] = [];
  let acc = '';
  let truncated = false;
  for (const decl of ordered) {
    const candidate = acc.length === 0 ? decl.text : `${acc}\n\n${decl.text}`;
    if (candidate.length <= codeBudget) {
      acc = candidate;
      kept.push(decl);
      continue;
    }
    // The declaration does not fit whole — take a prefix if it still adds
    // signal (never below 400 chars, so a cut is never a stub).
    const room = codeBudget - acc.length;
    if (room >= 400) {
      acc = acc.length === 0 ? decl.text.slice(0, room) : `${acc}\n\n${decl.text.slice(0, room)}`;
      truncated = true;
    }
    break;
  }
  if (kept.length < ordered.length) truncated = true;
  if (acc.length === 0) {
    acc = '// (no top-level declarations found)';
    truncated = ordered.length > 0;
  }

  const finalText = truncated ? `${acc}${TRUNCATION_MARKER} at ${budgetChars} chars (budget)]` : acc;
  return {
    target: absPath,
    text: finalText,
    truncated,
    keptSymbols: kept.map((d) => d.name),
  };
}
