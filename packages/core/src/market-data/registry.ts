import type { MarketDataProvider, ProviderCapabilities } from '@veltrixeye/contracts';

export interface RegisteredProviderInfo {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
}

/**
 * Runtime registry of market-data providers.
 *
 * M1 ships with an EMPTY registry: no provider is implemented yet (that is
 * M2+). The registry, its lifecycle and the registration API exist now so
 * that adding a provider later is a matter of:
 *
 *   1. creating `packages/providers/<name>` implementing MarketDataProvider
 *      (provider-specific symbols, rate limiting and licensing stay INSIDE),
 *   2. registering it here at boot: registry.register(provider),
 *   3. inserting a row into data_providers (and instrument mappings).
 *
 * The domain (strategy engine, scanner, backtester) resolves data access
 * through this registry and the contracts interfaces — never through a
 * concrete provider. See docs/provider-abstraction.md.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, MarketDataProvider>();

  register(provider: MarketDataProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): MarketDataProvider | undefined {
    return this.providers.get(id);
  }

  list(): RegisteredProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: p.capabilities,
    }));
  }

  get size(): number {
    return this.providers.size;
  }
}

/** The default registry: empty at M1. Future provider packages register here. */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}
