import { type AgentBackendType, normalizeBackend } from "./config.js";
import type { BotRuntimeState } from "./database/schema.js";

export interface ResolvedBotRuntimeConfig {
  backendType: AgentBackendType;
  model?: string;
  /** 推理强度运行时选择（/effort），backend 支持时生效 */
  effort?: string;
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

  const runtimeBackend = pickBackend(runtimeState?.backendType);
  if (runtimeBackend) {
    return {
      backendType: runtimeBackend,
      model: runtimeState?.model,
      effort: runtimeState?.effort,
    };
  }

  return {
    backendType: pickBackend(configBackend)
      ?? availableBackends[0]
      ?? "claude",
  };
}
