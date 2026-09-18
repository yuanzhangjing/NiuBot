/**
 * lark-cli（飞书官方 CLI）集成（身份与安装）。
 *
 * - 注册/校验 Bot 身份 profile（非交互；appSecret 只走 stdin，不落日志、不进会话环境）；
 * - 检测 lark-cli，缺失时用官方安装器安装（带节流）。
 *
 * 使用入口是 `nbt feishu <args>`（../cli/feishu.ts）：由它准备身份并以该身份执行；
 * 身份环境变量只在那个子进程里生效，不进入会话环境。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../logger.js";
import { runCommand, type CommandResult } from "./command.js";

const log = createLogger("lark-cli");

export type LarkBrand = "feishu" | "lark";

/** 注册 profile 所需的最小 Bot 身份信息（来自 BotConfig）。 */
export interface LarkCliBotIdentity {
  /** Bot 配置 id；同时作为 lark-cli profile 名，与 NIUBOT_BOT_NAME 一致 */
  id: string;
  appId: string;
  appSecret: string;
  brand?: LarkBrand;
}

export interface LarkCliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type LarkCliRunner = (
  file: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
) => LarkCliRunResult | Promise<LarkCliRunResult>;

export interface LarkCliOptions {
  homeDir?: string;
  runner?: LarkCliRunner;
}

export const DEFAULT_LARK_BRAND: LarkBrand = "feishu";

const RUN_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 300_000;
/** 子进程输出上限（安装器会刷大量 spinner 帧，只用于诊断，不需要全量）。 */
const MAX_CAPTURED_OUTPUT = 1024 * 1024;
/** 自动安装失败/未生效后的重试间隔，避免每次重启都跑一遍网络安装。 */
const INSTALL_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
const INSTALL_MARKER = ".niubot-install-attempt";

/** 官方安装命令：二进制 + 官方 skills 一并安装。 */
export const LARK_CLI_INSTALL_COMMAND = "npx -y @larksuite/cli@latest install";

/** 默认执行器：复用平台 runCommand（Windows shim 解析、超时杀进程树、输出上限都现成）。 */
async function defaultRunner(
  file: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): Promise<LarkCliRunResult> {
  try {
    const result = await runCommand(file, args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: MAX_CAPTURED_OUTPUT,
      throwOnNonZero: false,
    });
    return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const failure = err as Error & { result?: CommandResult };
    return {
      status: failure.result?.exitCode ?? null,
      stdout: failure.result?.stdout ?? "",
      stderr: failure.result?.stderr ?? failure.message,
      error: failure as NodeJS.ErrnoException,
    };
  }
}

export function larkCliConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".lark-cli", "config.json");
}

function installMarkerPath(homeDir: string): string {
  return path.join(homeDir, ".lark-cli", INSTALL_MARKER);
}

/** 距上次安装尝试不足重试窗口时跳过（成功安装后这里不会被读到）。 */
export function shouldAttemptLarkInstall(homeDir: string, now: number = Date.now()): boolean {
  try {
    const stat = fs.statSync(installMarkerPath(homeDir));
    return now - stat.mtimeMs >= INSTALL_RETRY_WINDOW_MS;
  } catch {
    return true;
  }
}

export function recordLarkInstallAttempt(homeDir: string, now: number = Date.now()): void {
  try {
    const marker = installMarkerPath(homeDir);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    if (fs.existsSync(marker)) fs.utimesSync(marker, new Date(now), new Date(now));
    else fs.writeFileSync(marker, String(now));
  } catch {
    // 标记写入失败不影响主流程
  }
}

export interface LarkCliProfileEntry {
  name?: string;
  appId?: string;
  brand?: string;
  defaultAs?: string;
}

/** 容错解析 lark-cli 配置文件（结构：{ apps: [{ name, appId, appSecret, brand, defaultAs, users }] }）。 */
export function parseLarkCliProfiles(raw: string): LarkCliProfileEntry[] {
  try {
    const parsed = JSON.parse(raw) as { apps?: unknown };
    if (!Array.isArray(parsed.apps)) return [];
    return parsed.apps
      .filter((app): app is Record<string, unknown> => Boolean(app) && typeof app === "object")
      .map((app) => ({
        name: typeof app["name"] === "string" ? app["name"] : undefined,
        appId: typeof app["appId"] === "string" ? app["appId"] : undefined,
        brand: typeof app["brand"] === "string" ? app["brand"] : undefined,
        defaultAs: typeof app["defaultAs"] === "string" ? app["defaultAs"] : undefined,
      }));
  } catch {
    return [];
  }
}

export function readLarkCliProfiles(homeDir: string = os.homedir()): LarkCliProfileEntry[] {
  try {
    const file = larkCliConfigPath(homeDir);
    if (!fs.existsSync(file)) return [];
    return parseLarkCliProfiles(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** profile 缺失或 appId 变化才需要重建；已存在的 profile 保留操作方选择的 brand。 */
export function needsLarkProfileInit(profiles: LarkCliProfileEntry[], bot: LarkCliBotIdentity): boolean {
  const existing = profiles.find((profile) => profile.name === bot.id);
  return !existing || existing.appId !== bot.appId;
}

export function buildLarkProfileInitArgs(bot: LarkCliBotIdentity): string[] {
  return [
    "config",
    "init",
    "--app-id",
    bot.appId,
    "--app-secret-stdin",
    "--name",
    bot.id,
    "--brand",
    bot.brand ?? DEFAULT_LARK_BRAND,
  ];
}

/**
 * 把 profile 的默认身份固定为 bot。
 * 即使机器上有人执行过 auth login，Bot 的调用也不应该悄悄换成用户身份。
 */
export function needsLarkDefaultAs(profiles: LarkCliProfileEntry[], bot: LarkCliBotIdentity): boolean {
  const existing = profiles.find((profile) => profile.name === bot.id);
  return existing?.defaultAs !== "bot";
}

export function buildLarkDefaultAsArgs(bot: LarkCliBotIdentity): string[] {
  return ["config", "default-as", "bot", "--profile", bot.id];
}

function resolveRunner(deps: LarkCliOptions): LarkCliRunner {
  return deps.runner ?? defaultRunner;
}

/** 读取 lark-cli 版本；未安装返回 undefined。 */
export async function readLarkCliVersion(deps: LarkCliOptions = {}): Promise<string | undefined> {
  const result = await resolveRunner(deps)("lark-cli", ["--version"], { timeoutMs: RUN_TIMEOUT_MS });
  if (result.error || result.status !== 0) return undefined;
  const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(`${result.stdout} ${result.stderr}`);
  return match?.[1] ?? "unknown";
}

/** 注册单个 Bot 的 profile 并把默认身份钉为 bot。appSecret 只经 stdin 传递，不进入日志。 */
export async function ensureLarkProfile(
  bot: LarkCliBotIdentity,
  deps: LarkCliOptions = {},
): Promise<"present" | "created" | "failed"> {
  const homeDir = deps.homeDir ?? os.homedir();
  const runner = resolveRunner(deps);
  const needsInit = needsLarkProfileInit(readLarkCliProfiles(homeDir), bot);
  if (needsInit) {
    const result = await runner("lark-cli", buildLarkProfileInitArgs(bot), {
      input: bot.appSecret,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      log.warn("lark-cli profile init failed", {
        bot: bot.id,
        status: result.status,
        error: result.error?.code ?? result.error?.message,
        stderr: result.stderr.trim().slice(0, 200),
      });
      return "failed";
    }
  }
  if (needsInit || needsLarkDefaultAs(readLarkCliProfiles(homeDir), bot)) {
    const result = await runner("lark-cli", buildLarkDefaultAsArgs(bot), { timeoutMs: RUN_TIMEOUT_MS });
    if (result.error || result.status !== 0) {
      log.warn("lark-cli default-as bot failed", {
        bot: bot.id,
        status: result.status,
        error: result.error?.code ?? result.error?.message,
        stderr: result.stderr.trim().slice(0, 200),
      });
    }
  }
  return needsInit ? "created" : "present";
}

/** 安装 lark-cli（官方安装命令，同时安装官方 skills）。 */
export async function installLarkCli(deps: LarkCliOptions = {}): Promise<boolean> {
  log.info("installing lark-cli", { command: LARK_CLI_INSTALL_COMMAND });
  const result = await resolveRunner(deps)("npx", ["-y", "@larksuite/cli@latest", "install"], {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    log.warn("lark-cli install failed", {
      status: result.status,
      error: result.error?.code ?? result.error?.message,
      stderr: result.stderr.trim().slice(0, 200),
    });
    return false;
  }
  return true;
}

/** 是否允许自动安装（默认允许；NIUBOT_LARK_CLI_AUTO_INSTALL=0/false/off 关闭）。 */
export function larkAutoInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["NIUBOT_LARK_CLI_AUTO_INSTALL"]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/**
 * 清掉从父进程继承下来的 lark-cli 身份变量。
 *
 * 历史版本会向会话注入 LARKSUITE_CLI_*，而会话 → restart worker → 新引擎的进程继承
 * 会让它们跨重启一直传给后续所有会话：直连 lark-cli 的调用会因此落到别的 Bot 身份上。
 * 身份现在只由 `nbt feishu` 在单次调用的子进程里设置，引擎环境不应保留这些变量。
 */
export function stripInheritedLarkIdentityEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith("LARKSUITE_CLI_")) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}
