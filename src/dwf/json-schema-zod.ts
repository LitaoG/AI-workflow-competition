/**
 * JSON Schema (the subset synthesized by schema-synth.ts) → Zod, so facade asks reuse
 * the existing repair-loop RPC in `src/agent/rpc.ts` unchanged.
 *
 * Recursive schemas: `$ref` pointers against `definitions` (or `$defs`) resolve through
 * `z.lazy`, so a self-referential anyOf schema (e.g. a tree: string | array of tree)
 * converts without infinite construction — the cycle is broken at parse time, and each
 * pointed-to definition is built once and memoized per ref.
 */
import { z } from 'zod';

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: Array<string | number>;
  additionalProperties?: boolean;
  description?: string;
  anyOf?: Schema[];
  $ref?: string;
  definitions?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
};

export function zodFromJsonSchema(root: Schema): z.ZodTypeAny {
  const definitions = new Map<string, Schema>(Object.entries(root.definitions ?? root.$defs ?? {}));
  // Built definitions by ref string — keeps a cycle from rebuilding its members on
  // every parse of every nesting level.
  const built = new Map<string, z.ZodTypeAny>();

  return fromSchema(root);

  /** Resolve one in-document pointer (`#/definitions/Name`, `#/$defs/Name`, `#`). */
  function resolveRef(ref: string): Schema | undefined {
    if (ref === '#') return root;
    const name = ref.startsWith('#/definitions/')
      ? ref.slice('#/definitions/'.length)
      : ref.startsWith('#/$defs/')
        ? ref.slice('#/$defs/'.length)
        : undefined;
    return name === undefined ? undefined : definitions.get(name);
  }

  /** The zod side of a `$ref`: lazy, so recursive definitions terminate at parse time. */
  function fromRef(ref: string): z.ZodTypeAny {
    return z.lazy(() => {
      const memo = built.get(ref);
      if (memo) return memo;
      const target = ref === '#' ? root : resolveRef(ref);
      if (!target) return z.unknown();
      const inner = fromSchema(target);
      built.set(ref, inner);
      return inner;
    });
  }

  function fromSchema(schema: Schema): z.ZodTypeAny {
    const withDescription = (inner: z.ZodTypeAny): z.ZodTypeAny =>
      schema.description ? inner.describe(schema.description) : inner;

    if (schema.$ref) return withDescription(fromRef(schema.$ref));

    if (schema.enum) {
      const allPrimitive = schema.enum.every((v) => typeof v === 'string' || typeof v === 'number');
      if (allPrimitive) {
        const literals = schema.enum.map((v) => z.literal(v as string | number));
        return withDescription(
          literals.length === 1
            ? literals[0]
            : z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
        );
      }
    }

    if (schema.anyOf) {
      const members = schema.anyOf.map((m) => fromSchema(m));
      return withDescription(members.length === 1 ? members[0] : z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
    }

    const type = schema.type;
    const types = Array.isArray(type) ? type : type ? [type] : [];

    if (types.includes('null')) {
      const withoutNull = types.filter((t) => t !== 'null');
      const inner = withoutNull.length === 1 ? fromSingle(withoutNull[0]) : z.union(withoutNull.map((t) => fromSingle(t)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      return withDescription(z.union([inner, z.null()]));
    }

    return withDescription(fromSingle(types[0] ?? 'object'));

    function fromSingle(t: string | undefined): z.ZodTypeAny {
      switch (t) {
        case 'string':
          return z.string();
        case 'number':
          return z.number();
        case 'boolean':
          return z.boolean();
        case 'null':
          return z.null();
        case 'array': {
          if (!schema.items) return z.array(z.unknown());
          return z.array(fromSchema(schema.items));
        }
        case 'object':
        default: {
          const shape: Record<string, z.ZodTypeAny> = {};
          const required = new Set(schema.required ?? []);
          for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
            shape[key] = required.has(key) ? fromSchema(propSchema) : fromSchema(propSchema).optional();
          }
          // Strip (not strict): models and mock providers may emit extra keys; strip them
          // instead of failing validation — the schema guides generation, zod narrows types.
          return z.object(shape);
        }
      }
    }
  }
}
