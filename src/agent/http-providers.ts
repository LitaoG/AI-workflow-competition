/**
 * Explicit opt-in dispatcher for the native HTTP model providers.
 *
 * Called once at CLI startup. The adapter modules are imported dynamically and
 * only when their credential env var is actually present, so the unconfigured
 * path (offline mock default) loads zero extra modules and dials nothing.
 *
 *   ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL / ANTHROPIC_BASE_URL) → `anthropic`
 *   OPENAI_API_KEY   (+ optional OPENAI_MODEL   / OPENAI_BASE_URL)     → `openai`
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY                          → `bedrock`
 *
 * The registry default always remains the offline mock; asks reach these
 * providers only via an explicit `providerId`.
 */

/**
 * Register every HTTP provider whose credential env var is set.
 * Returns the registry ids that were registered (in registration order).
 */
export async function configureHttpProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const ids: string[] = [];

  if (env.ANTHROPIC_API_KEY?.trim()) {
    const { configureAnthropicFromEnv } = await import('./anthropic-provider.js');
    const id = configureAnthropicFromEnv(env);
    if (id) ids.push(id);
  }

  if (env.OPENAI_API_KEY?.trim()) {
    const { configureOpenAiFromEnv } = await import('./openai-provider.js');
    const id = configureOpenAiFromEnv(env);
    if (id) ids.push(id);
  }

  if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    const { configureBedrockFromEnv } = await import('./bedrock-provider.js');
    const id = configureBedrockFromEnv(env);
    if (id) ids.push(id);
  }

  return ids;
}

/**
 * Detects credentials and registers default providers (including bedrock when AWS credentials exist).
 */
export async function createDefaultProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return await configureHttpProvidersFromEnv(env);
}
