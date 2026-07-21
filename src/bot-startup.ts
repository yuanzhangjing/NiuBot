import type { BotInstance } from "./bot-instance.js";
import { createLogger } from "./logger.js";
import { withTimeout } from "./core/timeout.js";

const DEFAULT_TRANSPORT_START_TIMEOUT_MS = 15_000;

export interface StartupLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const defaultLog = createLogger("bot-startup");

export async function startBotRuntime(
  bot: BotInstance,
  options: {
    transportStartTimeoutMs?: number;
    /** @deprecated use transportStartTimeoutMs */
    imStartTimeoutMs?: number;
    log?: StartupLogger;
  } = {},
): Promise<void> {
  const log = options.log ?? defaultLog;
  const transportStartTimeoutMs = options.transportStartTimeoutMs
    ?? options.imStartTimeoutMs
    ?? DEFAULT_TRANSPORT_START_TIMEOUT_MS;

  await bot.pipeline.start();
  await bot.pipeline.recover();
  await bot.transport.recover();

  await bot.apiServer.start();
  bot.cronScheduler.start();

  void startTransportInBackground(bot, log, transportStartTimeoutMs);

  log.info("bot started", { name: bot.id });
}

async function startTransportInBackground(
  bot: BotInstance,
  log: StartupLogger,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout({
      label: "transport.start",
      timeoutMs,
      fn: async () => {
        await bot.transport.start();
      },
    });
    log.info("bot transport started", { name: bot.id });
  } catch (err) {
    log.warn("bot transport start failed", { name: bot.id, error: String(err) });
  }
}
