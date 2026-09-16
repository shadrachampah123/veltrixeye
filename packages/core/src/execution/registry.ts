import type {
  ExecutionProvider,
  ExecutionProviderCapabilities,
} from '@veltrixeye/contracts';

/**
 * M8.1 — execution provider registry.
 *
 * Mirrors the market-data `ProviderRegistry` shape: adapters register at
 * boot, everything downstream resolves providers by id and never imports a
 * concrete adapter. M8.1 registers exactly ONE provider (paper), and that
 * provider refuses every trading operation — so no code path in the deployed
 * system can reach a broker, because no broker adapter exists to register.
 */
export interface RegisteredExecutionProviderInfo {
  id: string;
  name: string;
  capabilities: ExecutionProviderCapabilities;
  configured: boolean;
}

export class ExecutionProviderRegistry {
  private readonly providers = new Map<string, ExecutionProvider>();

  register(provider: ExecutionProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Execution provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ExecutionProvider | undefined {
    return this.providers.get(id);
  }

  list(): RegisteredExecutionProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: p.capabilities,
      configured: p.configured,
    }));
  }
}

/** Empty registry; boot code registers the paper provider explicitly. */
export function createExecutionProviderRegistry(): ExecutionProviderRegistry {
  return new ExecutionProviderRegistry();
}
