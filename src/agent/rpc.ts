import { z } from 'zod';
import { AgentRPCClient, AgentCallOptions, LLMMessage } from '../types.js';
import { providerRegistry } from './provider.js';
import { extractJson, repairJsonString, formatZodErrors } from './schema.js';
import { SchemaValidationError } from '../core/error.js';
import { classifyFailure, backoffSleep } from '../dwf/attempt-classifier.js';

export function agent(name: string): AgentRPCClient {
  return {
    name,
    async ask<T>(prompt: string, schemaOrOptions?: any, maybeOptions?: AgentCallOptions): Promise<T> {
      let schema: any = schemaOrOptions;
      let options: AgentCallOptions | undefined = maybeOptions;

      // Handle 2-arg invocation where options is passed as 2nd arg: ask(prompt, optionsWithSchemaAndMock)
      if (
        schemaOrOptions &&
        typeof schemaOrOptions.safeParse !== 'function' &&
        (schemaOrOptions.mockResponse !== undefined || schemaOrOptions.schema !== undefined)
      ) {
        options = schemaOrOptions;
        schema = schemaOrOptions.schema;
      }

      // Fast path: explicit mock override provided
      if (options?.mockResponse !== undefined) {
        if (schema && typeof schema.parse === 'function') {
          return schema.parse(options.mockResponse);
        }
        return options.mockResponse as T;
      }

      const provider = providerRegistry.get(options?.providerId);
      const maxRetries = options?.maxRetries ?? 3;

      const systemPrompt = [
        options?.systemPrompt ?? `You are specialized agent "${name}".`,
        ...(schema
          ? [
              'You MUST respond with a single valid JSON object strictly conforming to the requested schema.',
              'Do NOT include explanations, markdown greetings, or text outside the JSON object.',
            ]
          : ['Answer in plain prose unless the task explicitly asks for structured output.']),
      ].join(' ');

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(options?.priorMessages ?? []),
        { role: 'user', content: prompt },
      ];
      const RETRY_SUFFIX_RE = /\n\n\(Retry \d+ after no progress for \d+ms — continue the task\.\)$/;

      let lastRawOutput = '';
      let lastIssues: z.ZodIssue[] = [];

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (options?.signal?.aborted) {
          throw abortError();
        }
        let response;
        try {
          const generatePromise = provider.generate({
            messages,
            temperature: options?.temperature ?? 0.0,
            maxTokens: options?.maxTokens ?? 2048,
            signal: options?.signal,
          });
          // Stall clock (Claude-parity): no progress within stallMs → transient stall.
          // The timer is always cleared (and unref'd) so a completed call does not
          // keep the process alive for the rest of the stall window.
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          response = options?.stallMs
            ? await Promise.race([
                generatePromise,
                new Promise<never>((_, reject) => {
                  stallTimer = setTimeout(() => {
                    const e = new Error(`stalled — no progress for ${options.stallMs}ms`);
                    e.name = 'StallError';
                    reject(e);
                  }, options.stallMs);
                  stallTimer.unref?.();
                }),
              ]).finally(() => {
                if (stallTimer !== undefined) {
                  clearTimeout(stallTimer);
                  stallTimer = undefined;
                }
              })
            : await generatePromise;
        } catch (err) {
          // Attempt classification + policy table (ODW): rate limits back off,
          // transient faults retry fast, auth/cancellations are fatal unless the
          // policy says otherwise. Retryable failures do NOT poison the repair
          // conversation — the same messages go back out untouched.
          const c = classifyFailure(err, attempt - 1);
          const policy = options?.retryPolicy;
          const cap = policy?.maxRetries ?? maxRetries;
          const allowed = policy?.retryOn ? policy.retryOn.includes(c.category) : c.retryable;
          if (allowed && attempt < cap) {
            // Official 2.1.316 rewrites the retried prompt with a "(retry N)"
            // marker. Do the same on the last user turn, replacing any previous
            // marker instead of accumulating it. The journal key still hashes
            // the original prompt, so replay identity is unchanged.
            if (err instanceof Error && err.name === 'StallError' && options?.stallMs) {
              const last = messages[messages.length - 1];
              if (last?.role === 'user') {
                const base = last.content.replace(RETRY_SUFFIX_RE, '');
                messages[messages.length - 1] = {
                  role: 'user',
                  content: `${base}\n\n(Retry ${attempt} after no progress for ${options.stallMs}ms — continue the task.)`,
                };
              }
            }
            await backoffSleep(policy?.backoffMs ? policy.backoffMs * 2 ** (attempt - 1) : c.backoffMs, options?.signal);
            continue;
          }
          throw err;
        }

        if (response.usage) {
          options?.onUsage?.({
            promptTokens: response.usage.promptTokens ?? 0,
            completionTokens: response.usage.completionTokens ?? 0,
            totalTokens: response.usage.totalTokens ?? 0,
          });
        }
        lastRawOutput = response.content;
        // G3 fix (facade contract): an UNTYPED ask returns the subagent's final reply
        // text as-is — no JSON demand, no repair loop. Only typed asks (schema present)
        // go through extraction/repair. The system prompt no longer forces JSON either.
        if (!schema || typeof schema.safeParse !== 'function') {
          return response.content as T;
        }
        const cleaned = extractJson(response.content);
        let parsedJson: any;

        try {
          parsedJson = JSON.parse(cleaned);
        } catch {
          try {
            parsedJson = JSON.parse(repairJsonString(cleaned));
          } catch {
            // Unparseable JSON, queue repair prompt
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content: 'Your response was not valid JSON. Please fix syntax errors (e.g. quotes, brackets) and return ONLY the valid JSON object.',
            });
            continue;
          }
        }

        if (!schema || typeof schema.safeParse !== 'function') {
          return parsedJson as T;
        }

        const validation = schema.safeParse(parsedJson);
        if (validation.success) {
          return validation.data;
        }

        lastIssues = validation.error.issues;

        // Auto-Repair Prompt injection
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            'Your JSON response failed runtime schema validation with the following errors:',
            formatZodErrors(lastIssues),
            'Please correct these specific fields and return the updated JSON object.',
          ].join('\n'),
        });
      }

      throw new SchemaValidationError(name, lastRawOutput, lastIssues, maxRetries);
    },
  };
}

function abortError(): Error {
  const e = new Error('ask cancelled');
  e.name = 'AbortError';
  return e;
}
