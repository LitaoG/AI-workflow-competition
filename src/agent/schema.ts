import { z } from 'zod';

/**
 * Extract clean JSON string from raw LLM output.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  // 1. Try markdown code block regex
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // 2. Try outermost braces { ... } or brackets [ ... ]
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.substring(firstBracket, lastBracket + 1);
  }

  return trimmed;
}

/**
 * Heuristically repair common LLM JSON flaws:
 * - Trailing commas before } or ]
 * - Single quotes instead of double quotes on keys or strings
 * - Missing quotes around alphanumeric keys
 */
export function repairJsonString(raw: string): string {
  let s = raw.trim();

  // Remove trailing commas in objects and arrays
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // Replace single-quoted string keys or values
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  // Fix unquoted alphanumeric keys: { foo: "bar" } -> { "foo": "bar" }
  s = s.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

  return s;
}

/**
 * Format Zod validation issues into clean, LLM-actionable instructions.
 */
export function formatZodErrors(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- Field "${path}": ${issue.message} (received: ${JSON.stringify((issue as any).received ?? 'undefined')})`;
    })
    .join('\n');
}

/**
 * Generate a simplified JSON Schema representation from a Zod schema to embed in prompts.
 */
export function schemaToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
  if ((schema as any).description) {
    return { description: (schema as any).description };
  }
  return { type: 'object', note: 'Conform strictly to schema specification.' };
}
