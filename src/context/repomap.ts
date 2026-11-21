/**
 * AST symbol map (y.md 支柱二, Issue #157): a TypeScript-compiler-API symbol
 * graph over the workspace — per-file exported symbols, relative-import
 * edges weighted by real identifier usage — reduced to "the files and
 * symbols most relevant to one target file", Aider-repomap style.
 *
 * Zero third-party additions: `typescript` is already a dependency and the
 * graph is built with plain syntax trees (createSourceFile — no type-check,
 * no Program), so a map over a capped file set costs milliseconds.
 *
 * Ranking is weighted degree (usage-weighted in/out edges), documented as
 * such — a full PageRank over workspace-sized graphs is a later refinement
 * and would not change the slice contract.
 */
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepomapFileScore {
  /** Workspace-relative POSIX-ish path. */
  file: string;
  /** Weighted usage score against the target. */
  score: number;
}

export interface Repomap {
  /** Workspace-relative target the map was built for. */
  target: string;
  /** Related files (importers + imports), most relevant first. */
  ranked: RepomapFileScore[];
  /** Exported symbol names of the related files, most-used first (capped). */
  symbols: string[];
}

export interface RepomapOptions {
  /** Hard cap on scanned files (default 500 — a workspace guard, not a limit on correctness). */
  maxFiles?: number;
}

const TS_EXTENSIONS = ['.ts', '.tsx'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', '.workflow', 'build', 'out']);
const MAX_SYMBOLS = 40;
const DEFAULT_MAX_FILES = 500;

function listTsFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (entry.isFile() && TS_EXTENSIONS.includes(path.extname(entry.name))) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Top-level declared symbol names of a source file (functions/classes/interfaces/types/enums/consts). */
export function topLevelSymbolNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
    else if (ts.isClassDeclaration(statement) && statement.name) names.push(statement.name.text);
    else if (ts.isInterfaceDeclaration(statement)) names.push(statement.name.text);
    else if (ts.isTypeAliasDeclaration(statement)) names.push(statement.name.text);
    else if (ts.isEnumDeclaration(statement)) names.push(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    }
  }
  return names;
}

/** Relative-import specifiers of a source file, paired with the named bindings pulled in. */
function importsOf(source: ts.SourceFile): Array<{ specifier: string; names: string[] }> {
  const out: Array<{ specifier: string; names: string[] }> = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const names: string[] = [];
    const clause = statement.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.push(element.name.text);
    }
    if (clause?.name) names.push(clause.name.text);
    out.push({ specifier: statement.moduleSpecifier.text, names });
  }
  return out;
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // bare npm specifiers are out of workspace scope
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...TS_EXTENSIONS.map((ext) => base + ext), ...TS_EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Count identifier usages of `names` in the file body (the edge weight). */
function countUsages(source: ts.SourceFile, names: Set<string>): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Build the symbol map for one target file over the workspace's TS sources. */
export function buildRepomap(rootAbs: string, targetRel: string, options: RepomapOptions = {}): Repomap {
  const root = path.resolve(rootAbs);
  const targetAbs = path.resolve(root, targetRel);
  if (!fs.existsSync(targetAbs)) {
    throw new Error(`repomap: target file "${targetRel}" does not exist under the workspace`);
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = listTsFiles(root, maxFiles);
  if (!files.includes(targetAbs)) files.push(targetAbs);

  const sources = new Map<string, ts.SourceFile>();
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS));
  }
  const targetSource = sources.get(targetAbs);
  if (!targetSource) throw new Error(`repomap: target file "${targetRel}" could not be read`);

  // Export tables + import edges.
  const exportsByFile = new Map<string, Set<string>>();
  for (const [file, source] of sources) {
    exportsByFile.set(file, new Set(topLevelSymbolNames(source)));
  }
  const importersOf = new Map<string, Map<string, number>>(); // imported -> importer -> weight
  const importsOfMap = new Map<string, Map<string, number>>(); // importer -> imported -> weight
  for (const [file, source] of sources) {
    for (const imp of importsOf(source)) {
      const resolved = resolveImport(file, imp.specifier);
      if (!resolved || !sources.has(resolved)) continue;
      const used = new Set(imp.names.filter((n) => exportsByFile.get(resolved)?.has(n)));
      const weight = used.size > 0 ? Math.max(countUsages(source, used), 1) : 1;
      const importers = importersOf.get(resolved) ?? new Map<string, number>();
      importers.set(file, Math.max(importers.get(file) ?? 0, weight));
      importersOf.set(resolved, importers);
      const imports = importsOfMap.get(file) ?? new Map<string, number>();
      imports.set(resolved, Math.max(imports.get(resolved) ?? 0, weight));
      importsOfMap.set(file, imports);
    }
  }

  // Related = importers of the target ∪ files the target imports, weighted.
  const scoreByFile = new Map<string, number>();
  const bump = (file: string, weight: number): void => {
    scoreByFile.set(file, Math.max(scoreByFile.get(file) ?? 0, weight));
  };
  for (const [importer, weight] of importersOf.get(targetAbs) ?? new Map()) bump(importer, weight);
  for (const [imported, weight] of importsOfMap.get(targetAbs) ?? new Map()) bump(imported, weight);

  const ranked: RepomapFileScore[] = [...scoreByFile.entries()]
    .map(([file, score]) => ({ file: toRel(root, file), score }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  // Symbols: the related files' exports, ranked by how heavily the target side uses them.
  const symbolWeight = new Map<string, number>();
  for (const [other, weight] of [...(importersOf.get(targetAbs) ?? new Map()), ...(importsOfMap.get(targetAbs) ?? new Map())]) {
    const source = sources.get(other);
    if (!source) continue;
    const exported = topLevelSymbolNames(source);
    for (const name of exported) {
      symbolWeight.set(name, Math.max(symbolWeight.get(name) ?? 0, weight));
    }
  }
  const symbols = [...symbolWeight.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SYMBOLS)
    .map(([name]) => name);

  return { target: toRel(root, targetAbs), ranked, symbols };
}
