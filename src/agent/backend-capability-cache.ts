import type { BackendCapability } from "./backend-capability.js";

export type ProbeAllBackendCapabilities = () => Promise<BackendCapability[]>;
export type ProbeOneBackendCapability = (backend: string) => Promise<BackendCapability | undefined>;

/**
 * Keeps backend discovery responsive without making installation state permanent.
 * Refreshes are single-flight so all bot instances share one set of CLI probes.
 */
export class BackendCapabilityCache {
  private capabilities: BackendCapability[] = [];
  private readonly capabilitiesByBackend = new Map<string, BackendCapability>();
  private refreshInFlight?: Promise<BackendCapability[]>;

  constructor(
    initial: BackendCapability[],
    private readonly probeAll: ProbeAllBackendCapabilities,
    private readonly probeOne: ProbeOneBackendCapability,
  ) {
    this.replace(initial);
  }

  snapshot(): BackendCapability[] {
    return this.capabilities.map((capability) => ({ ...capability }));
  }

  get(backend: string): BackendCapability | undefined {
    const capability = this.capabilitiesByBackend.get(backend);
    return capability ? { ...capability } : undefined;
  }

  availableBackends(): string[] {
    return this.capabilities
      .filter((capability) => capability.selectable)
      .map((capability) => capability.backend);
  }

  refresh(): Promise<BackendCapability[]> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.probeAll().then((capabilities) => {
      this.replace(capabilities);
      return this.snapshot();
    });
    const guarded = refresh.finally(() => {
      if (this.refreshInFlight === guarded) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = guarded;
    return guarded;
  }

  async recheck(backend: string): Promise<BackendCapability | undefined> {
    const capability = await this.probeOne(backend);
    if (!capability) return undefined;
    this.update(capability);
    return { ...capability };
  }

  private replace(capabilities: BackendCapability[]): void {
    this.capabilities = capabilities.map((capability) => ({ ...capability }));
    this.capabilitiesByBackend.clear();
    for (const capability of this.capabilities) {
      this.capabilitiesByBackend.set(capability.backend, capability);
    }
  }

  private update(capability: BackendCapability): void {
    const next = { ...capability };
    this.capabilitiesByBackend.set(next.backend, next);
    const index = this.capabilities.findIndex((candidate) => candidate.backend === next.backend);
    if (index >= 0) this.capabilities[index] = next;
    else this.capabilities.push(next);
  }
}
