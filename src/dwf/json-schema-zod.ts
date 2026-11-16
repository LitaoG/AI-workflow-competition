/**
 * Moved inward to `src/agent/json-schema-zod.ts` (Issue #53): the converter is
 * layer-neutral (imports only zod), and the agent layer's mockResponse fast path
 * now needs it too — the inward dependency rule (依赖向内) forbids `src/agent`
 * from reaching into `src/dwf`. This re-export keeps every existing dwf import
 * site (ask-executor, tests) byte-identical.
 */
export { zodFromJsonSchema, isJsonSchemaShape, type JsonSchemaShape } from '../agent/json-schema-zod.js';
