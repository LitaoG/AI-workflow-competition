/**
 * Pre-dispatch JSON Schema lint (canonical parity: `agent({schema})` is validated
 * BEFORE a subagent is spawned, so an unusable contract never costs a model call).
 *
 * The design distinguishes two classes :
 *   - invalid: the value is not a usable JSON Schema at all;
 *   - unsatisfiable: a well-formed schema no instance can satisfy (e.g. a
 *     required key that `additionalProperties:false` simultaneously forbids).
 *
 * This module implements the subset the facade compiler can synthesize plus the
 * `$ref` form `json-schema-zod.ts` already understands. Unknown keywords are
 * ignored (permissive) so a future raw-schema surface is not rejected for using
 * a keyword this engine simply does not consume.
 */

export interface SchemaLintIssue {
  kind: 'invalid' | 'unsatisfiable';
  /** Dotted path to the offending subschema, e.g. `properties.items`. */
  path: string;
  message: string;
}

interface LintContext {
  root: Record<string, unknown>;
  /** Refs on the current expansion path — a cycle is not an error by itself. */
  seenRefs: Set<string>;
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(path: string, segment: string): string {
  return path ? `${path}.${segment}` : segment;
}

/** Loose runtime check for the enum × type consistency test below. */
function valueMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return true;
  }
}

function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  if (ref === '#') return root;
  const defs =
    isPlainObject(root.definitions) ? root.definitions : isPlainObject(root.$defs) ? root.$defs : undefined;
  if (ref.startsWith('#/definitions/')) return defs?.[ref.slice('#/definitions/'.length)];
  if (ref.startsWith('#/$defs/')) return defs?.[ref.slice('#/$defs/'.length)];
  return undefined;
}

/**
 * Lint one schema value. Returns every issue found (invalid first, then
 * unsatisfiable) — callers take the first of each class.
 */
export function lintJsonSchema(schema: unknown): SchemaLintIssue[] {
  if (!isPlainObject(schema)) {
    return [{ kind: 'invalid', path: '', message: 'schema must be a JSON object' }];
  }
  return check(schema, '', { root: schema, seenRefs: new Set() });
}

function check(node: unknown, path: string, ctx: LintContext): SchemaLintIssue[] {
  if (!isPlainObject(node)) {
    return [{ kind: 'invalid', path, message: 'schema must be a JSON object' }];
  }

  const issues: SchemaLintIssue[] = [];
  const invalid = (p: string, message: string): void => {
    issues.push({ kind: 'invalid', path: p, message });
  };
  const unsatisfiable = (p: string, message: string): void => {
    issues.push({ kind: 'unsatisfiable', path: p, message });
  };

  if (node.$ref !== undefined) {
    if (typeof node.$ref !== 'string' || node.$ref === '') {
      invalid(at(path, '$ref'), '$ref must be a non-empty string');
      return issues;
    }
    if (ctx.seenRefs.has(node.$ref)) return issues; // recursive reference: not an error
    const target = resolveRef(node.$ref, ctx.root);
    if (target === undefined) {
      invalid(at(path, '$ref'), `unresolved $ref "${node.$ref}" — no such definition`);
      return issues;
    }
    ctx.seenRefs.add(node.$ref);
    issues.push(...check(target, path, ctx));
    ctx.seenRefs.delete(node.$ref);
    return issues;
  }

  // enum: non-empty, JSON primitives only, and consistent with the declared type.
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum)) {
      invalid(at(path, 'enum'), 'enum must be an array');
    } else if (node.enum.length === 0) {
      unsatisfiable(at(path, 'enum'), 'enum is empty — no value can satisfy it');
    } else if (!node.enum.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      invalid(at(path, 'enum'), 'enum members must be JSON primitives');
    }
  }

  const declaredTypes = readTypes(node, path, invalid);
  if (declaredTypes !== null && node.enum !== undefined && Array.isArray(node.enum) && node.enum.length > 0 && declaredTypes.length > 0) {
    const satisfiable = node.enum.some((v) => declaredTypes.some((t) => valueMatchesType(t, v)));
    if (!satisfiable) {
      unsatisfiable(
        at(path, 'enum'),
        `enum members (${node.enum.map((v) => JSON.stringify(v)).join(', ')}) do not match the declared type (${declaredTypes.join(' | ')})`,
      );
    }
  }

  // anyOf: unsatisfiable only when EVERY branch is unsatisfiable; any structural
  // invalid branch is surfaced (a broken branch cannot be relied on).
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf)) {
      invalid(at(path, 'anyOf'), 'anyOf must be an array');
    } else if (node.anyOf.length === 0) {
      unsatisfiable(at(path, 'anyOf'), 'anyOf is empty — no value can satisfy it');
    } else {
      const branches = node.anyOf.map((branch, i) => check(branch, `${at(path, 'anyOf')}[${i}]`, ctx));
      const branchInvalid = branches.flatMap((b) => b.filter((i) => i.kind === 'invalid'));
      if (branchInvalid.length > 0) {
        issues.push(...branchInvalid);
      } else if (branches.every((b) => b.length > 0 && b.every((i) => i.kind === 'unsatisfiable'))) {
        unsatisfiable(at(path, 'anyOf'), 'every anyOf branch is unsatisfiable');
      }
    }
  }

  // properties: recurse into each.
  let propertyNames: Set<string> | undefined;
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      invalid(at(path, 'properties'), 'properties must be an object');
    } else {
      propertyNames = new Set(Object.keys(node.properties));
      for (const [name, sub] of Object.entries(node.properties)) {
        issues.push(...check(sub, `${at(path, 'properties')}.${name}`, ctx));
      }
    }
  }

  // items: recurse when present. Draft-07 tuple form is an ARRAY of per-position
  // schemas (what schema-synth emits for tuples); the single-schema form covers
  // every element. Both are valid — check() must accept the array form or every
  // tuple-typed ask would be refused at dispatch time (issue #126 F6).
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      node.items.forEach((sub, i) => issues.push(...check(sub, `${at(path, 'items')}[${i}]`, ctx)));
    } else {
      issues.push(...check(node.items, at(path, 'items'), ctx));
    }
  }
  if (node.additionalItems !== undefined && isPlainObject(node.additionalItems)) {
    issues.push(...check(node.additionalItems, at(path, 'additionalItems'), ctx));
  }

  // Bounds: a minItems larger than maxItems (or larger than the tuple length)
  // admits no instance.
  const readCount = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const minItems = readCount(node.minItems);
  const maxItems = readCount(node.maxItems);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    unsatisfiable(path, `minItems (${minItems}) is greater than maxItems (${maxItems}) — no array can satisfy it`);
  }
  if (minItems !== undefined && Array.isArray(node.items) && minItems > node.items.length) {
    const hasOpenTail =
      isPlainObject(node.additionalItems) || node.additionalItems === true || node.additionalItems === undefined;
    if (!hasOpenTail) {
      unsatisfiable(
        path,
        `minItems (${minItems}) is greater than the tuple length (${node.items.length}) and additionalItems forbids extra elements — no array can satisfy it`,
      );
    }
  }

  // required: array of strings; a required key that additionalProperties:false
  // forbids is the canonical "no output can satisfy this schema" case.
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || !node.required.every((r) => typeof r === 'string')) {
      invalid(at(path, 'required'), 'required must be an array of strings');
    } else if (
      node.additionalProperties === false &&
      (declaredTypes === null || declaredTypes.length === 0 || declaredTypes.includes('object'))
    ) {
      const missing = node.required.filter((r) => !(propertyNames ?? new Set<string>()).has(r));
      if (missing.length > 0) {
        unsatisfiable(
          path,
          `required ${missing.length === 1 ? 'property' : 'properties'} ${missing.map((m) => `"${m}"`).join(', ')} ` +
            'are not declared in properties, and additionalProperties is false — no object can satisfy it',
        );
      }
    }
  }

  return issues;
}

/** Normalize/validate `type`. Returns [] when absent, null when invalid. */
function readTypes(
  node: Record<string, unknown>,
  path: string,
  invalid: (path: string, message: string) => void,
): string[] | null {
  const type = node.type;
  if (type === undefined) return [];
  if (typeof type === 'string') {
    if (!JSON_TYPES.has(type)) {
      invalid(at(path, 'type'), `unknown type "${type}"`);
      return null;
    }
    return [type];
  }
  if (!Array.isArray(type) || type.length === 0) {
    invalid(at(path, 'type'), 'type must be a string or a non-empty array of strings');
    return null;
  }
  for (const t of type) {
    if (typeof t !== 'string' || !JSON_TYPES.has(t)) {
      invalid(at(path, 'type'), `unknown type ${JSON.stringify(t)}`);
      return null;
    }
  }
  return type as string[];
}