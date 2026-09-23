import { spawn } from "node:child_process";
import os from "node:os";

import { loadConfig, type BotConfig } from "../config.js";
import { buildExecutableInvocation, resolveExecutable } from "../platform/executable.js";
import {
  ensureLarkProfile,
  installLarkCli,
  larkAutoInstallEnabled,
  readLarkCliVersion,
  recordLarkInstallAttempt,
  shouldAttemptLarkInstall,
  type LarkCliBotIdentity,
} from "../platform/lark-cli.js";

export type FeishuCreds = {
  botId: string;
  appId: string;
  appSecret: string;
  platformBotId?: string;
};

export function resolveCurrentBot(
  bots: BotConfig[],
  opts: { botName?: string; botProfilePath?: string; dbPath?: string },
): BotConfig {
  if (bots.length === 0) {
    throw new Error("Config error: no bots configured");
  }

  const byName = opts.botName?.trim();
  if (byName) {
    const match = bots.find((bot) => bot.id === byName);
    if (match) return match;
    throw new Error(`Config error: bot '${byName}' not found`);
  }

  if (opts.botProfilePath) {
    const match = bots.find((bot) => bot.botProfilePath === opts.botProfilePath);
    if (match) return match;
  }

  if (opts.dbPath) {
    const match = bots.find((bot) => bot.dbPath === opts.dbPath);
    if (match) return match;
  }

  if (bots.length === 1) return bots[0]!;
  throw new Error(`Config error: cannot determine current bot (${bots.map((bot) => bot.id).join(", ")})`);
}

export function formatFeishuCreds(creds: FeishuCreds): string {
  const lines = [
    `bot: ${creds.botId}`,
    `appId: ${creds.appId}`,
    `appSecret: ${creds.appSecret}`,
  ];
  if (creds.platformBotId) {
    lines.push(`platformBotId: ${creds.platformBotId}`);
  }
  return lines.join("\n");
}

export function handleFeishu(
  args: string[],
  env: {
    botName?: string;
    botProfilePath?: string;
    dbPath?: string;
    platformBotId?: string;
  },
  io: { log: (text: string) => void; error: (text: string) => void; exit: (code: number) => void } = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  },
  load: typeof loadConfig = loadConfig,
): void {
  if (args[0] === "--help" || args[0] === "help") {
    io.log(`Show this Bot's Feishu app credentials: appId / appSecret.

Usage:
  nbt feishu-creds

Use when calling Feishu Open APIs as this Bot.
Do not put appSecret in user-visible replies.`);
    return;
  }

  if (args.length > 0) {
    io.error(`Error: unknown argument: ${args[0]}`);
    io.exit(1);
    return;
  }

  try {
    const config = load();
    const bot = resolveCurrentBot(config.bots, {
      botName: env.botName,
      botProfilePath: env.botProfilePath,
      dbPath: env.dbPath,
    });
    io.log(formatFeishuCreds({
      botId: bot.id,
      appId: bot.appId,
      appSecret: bot.appSecret,
      platformBotId: env.platformBotId,
    }));
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.exit(1);
  }
}

// ─── nbt feishu：以当前 Bot 身份执行官方 lark-cli ───────────────────────────
//
// 身份的选择与准备（lark-cli profile、默认应用身份）属于 nbt 工具的职责，
// 不暴露给调用方：调用者（Agent）只写 `nbt feishu <lark-cli 参数...>`，
// 不需要知道 LARKSUITE_CLI_* 环境变量，也不需要接触 appSecret。

/** 当前 Bot 执行 lark-cli 时需要的身份环境变量（只在本进程内传给子进程）。 */
export function larkCliIdentityEnv(botId: string): Record<string, string> {
  return {
    LARKSUITE_CLI_PROFILE: botId,
    LARKSUITE_CLI_DEFAULT_AS: "bot",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
}

export type LarkCliExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

/**
 * 调用参数里显式带上 `--profile <botId>`。
 *
 * 不依赖 lark-cli 是否读取 LARKSUITE_CLI_PROFILE（不同版本行为不一致），
 * 也避免它静默回落到配置文件里的默认 profile（多 Bot 同机时默认 profile 可能属于别人）。
 * 调用方自己传了 `--profile` 时以调用方为准。
 */
export function larkCliProfileArgs(args: string[], botId: string): string[] {
  const explicit = args.some((arg) => arg === "--profile" || arg.startsWith("--profile="));
  return explicit ? args : ["--profile", botId, ...args];
}

/** 默认执行器：参数透传给 lark-cli，stdio 继承（保留交互与实时输出）。 */
export function execLarkCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const resolved = resolveExecutable("lark-cli", { env });
  if (!resolved) return Promise.reject(new Error("lark-cli not found in PATH"));
  const invocation = buildExecutableInvocation(resolved, args, { env });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export interface FeishuRunDeps {
  load?: typeof loadConfig;
  readVersion?: typeof readLarkCliVersion;
  install?: typeof installLarkCli;
  ensureProfile?: typeof ensureLarkProfile;
  autoInstallEnabled?: typeof larkAutoInstallEnabled;
  shouldAttemptInstall?: typeof shouldAttemptLarkInstall;
  exec?: LarkCliExec;
  homeDir?: string;
}

/**
 * `nbt feishu <lark-cli 参数...>`：确保 lark-cli 可用、当前 Bot 的身份已就绪，
 * 然后以该身份执行官方 CLI；退出码透传。
 */
export async function handleFeishuRun(
  args: string[],
  env: { botName?: string; botProfilePath?: string; dbPath?: string },
  io: { log: (text: string) => void; error: (text: string) => void; exit: (code: number) => void } = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  },
  deps: FeishuRunDeps = {},
): Promise<void> {
  const load = deps.load ?? loadConfig;
  try {
    const config = load();
    const bot = resolveCurrentBot(config.bots, {
      botName: env.botName,
      botProfilePath: env.botProfilePath,
      dbPath: env.dbPath,
    });
    const identity: LarkCliBotIdentity = {
      id: bot.id,
      appId: bot.appId,
      appSecret: bot.appSecret,
      brand: bot.brand,
    };

    const readVersion = deps.readVersion ?? (() => readLarkCliVersion());
    let installAttempted = false;
    let version = await readVersion();
    if (!version) {
      const autoInstall = (deps.autoInstallEnabled ?? larkAutoInstallEnabled)();
      const mayAttempt = (deps.shouldAttemptInstall ?? shouldAttemptLarkInstall)(deps.homeDir ?? os.homedir());
      if (autoInstall && mayAttempt) {
        io.error("lark-cli is not installed; installing via the official installer...");
        recordLarkInstallAttempt(deps.homeDir ?? os.homedir());
        const installed = await (deps.install ?? (() => installLarkCli()))();
        if (installed) installAttempted = true;
        version = await readVersion();
      }
    }
    if (!version) {
      io.error(installAttempted
        ? "lark-cli was installed but is still not visible in PATH; restart the shell or check PATH."
        : "lark-cli is unavailable. Install it first: npx -y @larksuite/cli@latest install");
      io.exit(1);
      return;
    }

    const state = await (deps.ensureProfile ?? ((target: LarkCliBotIdentity) => ensureLarkProfile(target)))(identity);
    if (state === "failed") {
      io.error(`failed to register the lark-cli identity for bot '${bot.id}'`);
      io.exit(1);
      return;
    }

    const exec = deps.exec ?? execLarkCli;
    const code = await exec(larkCliProfileArgs(args, bot.id), { ...process.env, ...larkCliIdentityEnv(bot.id) });
    io.exit(code);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.exit(1);
  }
}
