/**
 * Task-attribute model routing — the Thinking/Flash dual track (Issue #151; ZCode-inspired). The router picks the HEAD of the
 * failover chain per ask; it sits on top of the existing
 * providerRegistry + buildFailoverChain + RetryOrchestrator/AIMD reliability
 * chain and replaces none of it.
 *
 * Routing inputs, in priority order:
 *   1. an explicit actor provider (`agent(name, { provider })` — the
 *      compile-time approved run shape wins outright, exactly as before);
 *   2. an explicit actor tier (`agent(name, { tier: 'fast' | 'deep' })`);
 *   3. task attributes: a schema-validated ask or a prompt at/above
 *      `deepPromptThreshold` chars routes deep, everything else fast;
 *   4. configuration: the per-tier option, then the AI_WORKFLOW_DEEP_PROVIDER
 *      / AI_WORKFLOW_FAST_PROVIDER env vars; with neither configured the tier
 *      resolves to the registry default (a no-op — behavior identical to the
 *      pre-router engine).
 *
 * The router runs per ask and is deterministic given the same inputs; replayed
 * asks never reach it (journal short-circuit), so resume is unaffected.
 */
import { domainError } from '../domain/errors.js';
import { providerRegistry } from './provider.js';

export type ProviderTier = 'fast' | 'deep';

export interface RouterOptions {
  /** Provider id for the fast tier (env: AI_WORKFLOW_FAST_PROVIDER). */
  fastProvider?: string;
  /** Provider id for the deep tier (env: AI_WORKFLOW_DEEP_PROVIDER). */
  deepProvider?: string;
  /** Prompts at or above this many characters route deep (default 6000). */
  deepPromptThreshold?: number;
}

/** Task-size watermark for the attribute-based track split. */
export const DEFAULT_DEEP_PROMPT_THRESHOLD = 6000;

/**
 * Resolve a persona model binding (Issue #38 D8-③, canonical 9011 parity):
 * "providerId/modelId" pins the provider part (must be registered);
 * "modelId" resolves through the run's model directory (modelId → providerId),
 * falling back to the provider self-map (every registered provider id is a
 * model of the same name). An optional "$level" suffix is tolerated and
 * stripped. Unresolved → AgentError (the run fails at actor creation, before
 * any ask can spend tokens).
 */
export function resolveModelToProvider(modelId: string, directory?: Readonly<Record<string, string>>): string {
  const dollar = modelId.indexOf('$');
  const base = dollar >= 0 ? modelId.slice(0, dollar) : modelId;
  const fail = () => {
    return domainError('AgentError', `model "${modelId}" does not resolve against the run's model directory — use "providerId/modelId" with a registered provider, an entry of the modelDirectory option, or a registered provider id`,
      { details: { model: modelId, directory: Object.keys(directory ?? {}), registeredProviders: providerRegistry.list() } });
  };
  if (base === '') throw fail();
  const slash = base.indexOf('/');
  if (slash >= 0) {
    const providerId = base.slice(0, slash);
    if (!providerRegistry.list().includes(providerId)) throw fail();
    return providerId;
  }
  const mapped = directory?.[base];
  if (mapped !== undefined) {
    if (!providerRegistry.list().includes(mapped)) throw fail();
    return mapped;
  }
  if (providerRegistry.list().includes(base)) return base;
  throw fail();
}

function envProviderFor(tier: ProviderTier): string | undefined {
  const raw = tier === 'deep' ? process.env.AI_WORKFLOW_DEEP_PROVIDER : process.env.AI_WORKFLOW_FAST_PROVIDER;
  return raw === undefined || raw === '' ? undefined : raw;
}

export function resolveRoutedProvider(input: {
  /** The actor's resolved model provider (persona model binding — Issue #38).
   *  Resolved at actor creation against the run's model directory; wins over
   *  provider/tier per the canonical precedence (persona model binding first). */
  actorModelProvider?: string;
  /** The actor's explicit provider literal, when the script declared one. */
  actorProvider?: string;
  /** The actor's explicit tier literal, when the script declared one. */
  tier?: ProviderTier;
  /** Whether the ask carries a JSON schema (schema-validated asks route deep). */
  hasSchema: boolean;
  /** The ask prompt length in characters. */
  promptLength: number;
  options?: RouterOptions;
}): string {
  if (input.actorModelProvider) return input.actorModelProvider;
  if (input.actorProvider) return input.actorProvider;
  const options = input.options ?? {};
  const threshold = options.deepPromptThreshold ?? DEFAULT_DEEP_PROMPT_THRESHOLD;
  const tier = input.tier ?? (input.hasSchema || input.promptLength >= threshold ? 'deep' : 'fast');
  const configured = (tier === 'deep' ? options.deepProvider : options.fastProvider) ?? envProviderFor(tier);
  if (configured === undefined) return providerRegistry.get().id;
  if (!providerRegistry.list().includes(configured)) {
    throw domainError(
      'AgentError',
      `model-router: configured ${tier}-tier provider "${configured}" is not registered — registered providers: ${providerRegistry.list().join(', ')}`,
      { details: { tier, provider: configured, registeredProviders: providerRegistry.list() } },
    );
  }
  return configured;
}
