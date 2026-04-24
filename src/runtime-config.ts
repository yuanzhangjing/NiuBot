import { type AgentBackendType, type BuiltinBackendType, DEFAULT_LITE_MODELS } from "./config.js";
import type { BotRuntimeState } from "./database/schema.js";

export interface ResolvedBotRuntimeConfig {
  backendType: AgentBackendType;
  model?: string;
  liteModel?: string;
  defaultLiteModel?: string;
}

function getBackendDefaultLiteModel(backend: AgentBackendType): string | undefined {
  return DEFAULT_LITE_MODELS[backend as BuiltinBackendType];
}

export function resolveBotRuntimeConfig(
  configBackend: string | undefined,
  runtimeState: BotRuntimeState | undefined,
  availableBackends: string[],
): ResolvedBotRuntimeConfig {
  const runtimeBackend = runtimeState?.backendType;
  const backendType = runtimeBackend && availableBackends.includes(runtimeBackend)
    ? runtimeBackend
    : configBackend && availableBackends.includes(configBackend)
      ? configBackend
      : availableBackends[0] ?? "claude";

  const defaultLiteModel = getBackendDefaultLiteModel(backendType);

  return {
    backendType,
    model: runtimeState?.model,
    liteModel: runtimeState?.liteModel ?? defaultLiteModel,
    defaultLiteModel,
  };
}
