import type { BotInstance } from "./bot-instance.js";
import { createLogger } from "./logger.js";
import { withTimeout } from "./core/timeout.js";

const DEFAULT_IM_START_TIMEOUT_MS = 15_000;

export interface StartupLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const defaultLog = createLogger("bot-startup");

export async function startBotRuntime(
  bot: BotInstance,
  options: {
    imStartTimeoutMs?: number;
    log?: StartupLogger;
  } = {},
): Promise<void> {
  const log = options.log ?? defaultLog;
  const imStartTimeoutMs = options.imStartTimeoutMs ?? DEFAULT_IM_START_TIMEOUT_MS;

  await bot.pipeline.start();
  await bot.pipeline.recover();

  await bot.apiServer.start();
  bot.cronScheduler.start();

  void startImInBackground(bot, log, imStartTimeoutMs);

  log.info("bot started", { name: bot.id });
}

async function startImInBackground(
  bot: BotInstance,
  log: StartupLogger,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout({
      label: "im.start",
      timeoutMs,
      fn: async () => {
        await bot.im.start();
      },
    });
    log.info("bot im started", { name: bot.id });
  } catch (err) {
    log.warn("bot im start failed", { name: bot.id, error: String(err) });
  }
}
