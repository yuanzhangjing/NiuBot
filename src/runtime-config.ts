import { type AgentBackendType, normalizeBackend } from "./config.js";
import type { BotRuntimeState } from "./database/schema.js";

export interface ResolvedBotRuntimeConfig {
  backendType: AgentBackendType;
  model?: string;
}

export function resolveBotRuntimeConfig(
  configBackend: string | undefined,
  runtimeState: BotRuntimeState | undefined,
  availableBackends: string[],
): ResolvedBotRuntimeConfig {
  const pickBackend = (raw: string | undefined): string | undefined => {
    const normalized = normalizeBackend(raw);
    return normalized && availableBackends.includes(normalized) ? normalized : undefined;
  };

  return {
    backendType: pickBackend(runtimeState?.backendType)
      ?? pickBackend(configBackend)
      ?? availableBackends[0]
      ?? "claude",
    model: runtimeState?.model,
  };
}
