import { LLMProvider } from '../types.js';
import { MockProvider } from './mock-provider.js';

class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProviderId = 'mock';

  constructor() {
    this.register(new MockProvider());
  }

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id?: string): LLMProvider {
    const targetId = id ?? this.defaultProviderId;
    const provider = this.providers.get(targetId);
    if (!provider) {
      throw new Error(`LLM Provider "${targetId}" is not registered`);
    }
    return provider;
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Cannot set unknown provider "${id}" as default`);
    }
    this.defaultProviderId = id;
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export const providerRegistry = new ProviderRegistry();
