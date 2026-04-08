import { ClaudeCliBackend } from "../agent/claude-cli/backend.js";
import { CodexCliBackend } from "../agent/codex/backend.js";
import type { AgentBackend } from "../agent/types.js";
import {
  type AgentBackendType,
  type NiuBotConfig,
  type BotConfig,
  getBotLiteModel,
  getConfiguredBackend,
} from "../config.js";

export interface SummarizerBackendSelection {
  backendType: AgentBackendType;
  liteModel?: string;
}

function resolveBot(config: NiuBotConfig, botName?: string): BotConfig {
  if (botName) {
    const bot = config.bots.find((entry) => entry.name === botName);
    if (bot) return bot;
  }
  return config.bots[0]!;
}

export function resolveSummarizerBackend(
  config: NiuBotConfig,
  botName?: string,
): SummarizerBackendSelection {
  const bot = resolveBot(config, botName);
  const backendType = getConfiguredBackend(config, bot);

  return {
    backendType,
    liteModel: getBotLiteModel(config, bot, backendType),
  };
}

export function createSummarizerBackend(selection: SummarizerBackendSelection): AgentBackend {
  switch (selection.backendType) {
    case "codex":
      return new CodexCliBackend("danger-full-access", selection.liteModel);
    case "claude":
      return new ClaudeCliBackend("bypassPermissions", selection.liteModel);
  }
}
