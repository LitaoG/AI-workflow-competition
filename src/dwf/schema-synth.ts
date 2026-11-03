/**
 * Compile-time synthesis of a JSON schema from a script's ask<T>() type argument.
 *
 * Mirrors ZCode's `schema/synthesize.ts`: the subagent sees the schema, the parent
 * validates the reply against it, and JSDoc on a property becomes the field description
 * the model actually reads — the cheapest quality lever in the surface.
 *
 * Supported subset: primitives, string/number-literal unions (enums), arrays, nested
 * objects with optionality, null unions. Everything else (functions, classes, Map/Set,
 * Date, any/unknown, index signatures) is a hard diagnostic — fail loudly, never guess.
 *
 * Recursion: a seen-set over the types on the current expansion path detects cycles, so
 * a recursive reference reports the precise diagnostic 9015
 * ("recursive type at site ask#N: <typeName>" — site and culprit type named) instead of
 * burning the whole depth stack and reporting the generic overflow. The seen-set is
 * path-scoped: a named type legitimately reused across sibling branches (or at several
 * acyclic depths, up to MAX_DEPTH - 1) still expands freely; only a type re-entering
 * its own expansion — a true cycle — is diagnosed.
 */
import ts from 'typescript';
import { FacadeDiagnostic } from './diagnostics.js';

const MAX_DEPTH = 8;
const MAX_PROPS = 64;
const MAX_UNION = 24;

/** Precise recursion diagnostic: a cycle, not a merely deep shape (which stays 9005). */
const RECURSION_CODE = 9015;

export interface SchemaSynthResult {
  schema: Record<string, unknown> | null;
  diagnostics: FacadeDiagnostic[];
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: Array<string | number>;
  additionalProperties?: boolean;
  description?: string;
  anyOf?: JsonSchemaNode[];
}

/** Entry: synthesize from a type node in the script source. */
export function synthesizeSchema(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  siteId?: string,
): SchemaSynthResult {
  const diagnostics: FacadeDiagnostic[] = [];
  // Types on the CURRENT expansion path (added on entry, removed on exit). Re-entry of
  // one of these is a cycle; the same type on a sibling branch is not.
  const seen = new Set<ts.Type>();
  // " at site ask#N" — the ask site named exactly as the site table names it.
  const sitePart = siteId ? ` at site ${siteId}` : '';
  const type = checker.getTypeAtLocation(typeNode);
  const schema = fromType(type, typeNode, 0);
  return { schema: schema as Record<string, unknown> | null, diagnostics };

  function fail(node: ts.Node, message: string, code = 9005): null {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    diagnostics.push({ tag: 'CompileError', line: line + 1, column: character + 1, code, category: 'schema-synth', message });
    return null;
  }

  function fromType(type: ts.Type, node: ts.Node, depth: number): JsonSchemaNode | null {
    if (depth > MAX_DEPTH) return fail(node, `ask<T> type nests deeper than ${MAX_DEPTH} levels`);

    // Null / undefined unions
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.flags & ts.TypeFlags.Undefined || type.flags & ts.TypeFlags.Void) {
      return fail(node, 'ask<T> result type must not include undefined');
    }

    // boolean is internally the union `true | false` — catch the members and the
    // intrinsic form before the generic union path
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };

    // Literal unions → enum; other unions → anyOf
    if (type.isUnion()) {
      const members = type.types;
      if (members.length > MAX_UNION) return fail(node, `union of ${members.length} members exceeds ${MAX_UNION}`);
      if (members.every((m) => m.flags & ts.TypeFlags.BooleanLiteral)) return { type: 'boolean' };
      // Optional properties surface as `T | undefined`; JSON Schema has no undefined and
      // the optionality is already carried by the property itself (left out of
      // `required`), so undefined members drop out instead of failing synthesis.
      const present = members.filter((m) => !(m.flags & ts.TypeFlags.Undefined || m.flags & ts.TypeFlags.Void));
      if (present.length === 0) return fail(node, 'ask<T> type resolves to never/void');
      const parts: JsonSchemaNode[] = [];
      for (const m of present) {
        const part = fromType(m, node, depth + 1);
        if (!part) return null;
        parts.push(part);
      }
      if (parts.every((p) => p.enum && p.enum.length === 1)) {
        return { enum: parts.map((p) => (p.enum as Array<string | number>)[0]) };
      }
      if (parts.length === 2) {
        const nullable = parts.findIndex((p) => p.type === 'null');
        if (nullable >= 0) {
          const other = parts[1 - nullable] as JsonSchemaNode;
          return { ...other, type: Array.isArray(other.type) ? [...other.type, 'null'] : [other.type as string, 'null'] };
        }
      }
      return { anyOf: parts };
    }

    // String / number literals (single)
    if (type.flags & ts.TypeFlags.StringLiteral) return { enum: [String((type as ts.LiteralType).value)] };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { enum: [(type as ts.LiteralType).value as number] };
    if (type.flags & ts.TypeFlags.String) return { type: 'string' };
    if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };

    // Arrays
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const indexInfo = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (!indexInfo) return fail(node, 'array element type could not be resolved');
      const items = fromType(indexInfo, node, depth + 1);
      return items ? { type: 'array', items } : null;
    }

    // Objects / interfaces
    if (type.flags & ts.TypeFlags.Object) {
      // Cycle check before anything else: a type re-entering its own expansion is a
      // recursion — reported precisely (site + type name, 9015) even when the re-entry
      // depth would also have tripped the generic depth cap below.
      if (seen.has(type)) {
        return fail(node, `recursive type${sitePart}: ${checker.typeToString(type)}`, RECURSION_CODE);
      }
      seen.add(type);
      try {
        const props: Record<string, JsonSchemaNode> = {};
        const required: string[] = [];
        const symbols = checker.getPropertiesOfType(type);
        if (symbols.length > MAX_PROPS) return fail(node, `object has ${symbols.length} properties, over the ${MAX_PROPS} cap`);
        if (symbols.length === 0) return fail(node, 'ask<T> object type has no resolvable properties (is it an alias to unknown/any?)');
        for (const sym of symbols) {
          const name = String(sym.getName());
          if (name.startsWith('_')) continue;
          const propNode = sym.declarations?.[0] ?? node;
          const propType = checker.getTypeOfSymbolAtLocation(sym, node);
          const optional = (sym.flags & ts.SymbolFlags.Optional) !== 0;
          const propSchema = fromType(propType, propNode, depth + 1);
          if (!propSchema) return null;
          // JSDoc on the property → field description (summary doc comment).
          const docParts = sym.getDocumentationComment(checker).map((p) => p.text).join('');
          if (docParts.trim()) propSchema.description = docParts.trim();
          props[name] = propSchema;
          if (!optional) required.push(name);
        }
        const schema: JsonSchemaNode = { type: 'object', properties: props, additionalProperties: false };
        if (required.length > 0) schema.required = required;
        return schema;
      } finally {
        seen.delete(type);
      }
    }

    if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
      return fail(node, 'ask<T> must use a concrete interface/type alias, not any/unknown');
    }
    if (type.flags & ts.TypeFlags.Never || type.flags & ts.TypeFlags.Void) {
      return fail(node, 'ask<T> type resolves to never/void');
    }
    return fail(node, `unsupported ask<T> type: ${checker.typeToString(type)}`);
  }
}

/** Wrap a synthesized schema as the full payload sent to the subagent. */
export function asAskSchema(schema: JsonSchemaNode | Record<string, unknown>): Record<string, unknown> {
  return { name: 'structured_result', strict: true, schema } as Record<string, unknown>;
}
