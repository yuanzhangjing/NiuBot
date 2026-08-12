import { runCommand } from "./command.js";

/** 屏幕/休眠相关状态，/awake status 附加展示。 */
export interface DisplayStatus {
  platform: NodeJS.Platform;
  /** macOS：当前控制台会话是否锁屏 */
  screenLocked?: boolean;
  /** macOS：锁屏时间（本地时间字符串，仅锁屏时有值） */
  lockedAtText?: string;
  /** 系统空闲时长（秒，无输入操作的时间） */
  idleSeconds?: number;
  /** 显示器休眠延迟（分钟；0 表示永不） */
  displaySleepMinutes?: number;
  /** 系统休眠延迟（分钟；0 表示永不） */
  systemSleepMinutes?: number;
  /** 屏保延迟（秒；未单独设置时为空） */
  screensaverIdleSeconds?: number;
  /** 持有「阻止显示器休眠」断言的进程数 */
  displaySleepAssertions?: number;
  /** 持有「阻止系统休眠」断言的进程数 */
  systemSleepAssertions?: number;
}

/** 采集平台屏幕/休眠状态；不支持的平台或全部命令失败时返回 undefined。 */
export async function collectDisplayStatus(
  platform: NodeJS.Platform = process.platform,
): Promise<DisplayStatus | undefined> {
  if (platform === "darwin") return collectMacOsDisplayStatus();
  if (platform === "win32") return collectWindowsDisplayStatus();
  return undefined;
}

async function collectMacOsDisplayStatus(): Promise<DisplayStatus> {
  const status: DisplayStatus = { platform: "darwin" };
  const [registry, hid, pmsetCustom, assertions, screensaver] = await Promise.all([
    safeCommand("ioreg", ["-n", "Root", "-d1"]),
    safeCommand("ioreg", ["-c", "IOHIDSystem"]),
    safeCommand("pmset", ["-g", "custom"]),
    safeCommand("pmset", ["-g", "assertions"]),
    safeCommand("defaults", ["read", "com.apple.screensaver", "idleTime"]),
  ]);

  if (registry) {
    const lockedMatch = registry.match(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/);
    if (lockedMatch) {
      status.screenLocked = lockedMatch[1] === "Yes";
      const lockedAt = registry.match(/"CGSSessionScreenLockedTime"\s*=\s*(\d+)/)?.[1];
      if (status.screenLocked && lockedAt) {
        status.lockedAtText = formatUnixTime(Number(lockedAt));
      }
    }
  }

  if (hid) {
    const idleNs = hid.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
    if (idleNs) status.idleSeconds = Math.floor(Number(idleNs) / 1_000_000_000);
  }

  if (pmsetCustom) {
    status.displaySleepMinutes = parsePmsetMinutes(pmsetCustom, "displaysleep");
    status.systemSleepMinutes = parsePmsetMinutes(pmsetCustom, "sleep");
  }

  if (assertions) {
    status.displaySleepAssertions = parseAssertionCount(assertions, "PreventUserIdleDisplaySleep");
    status.systemSleepAssertions = parseAssertionCount(assertions, "PreventSystemSleep");
  }

  if (screensaver !== undefined) {
    const idleSeconds = Number(screensaver.trim());
    if (Number.isFinite(idleSeconds)) status.screensaverIdleSeconds = idleSeconds;
  }

  return status;
}

async function collectWindowsDisplayStatus(): Promise<DisplayStatus> {
  const status: DisplayStatus = { platform: "win32" };
  const [video, standby] = await Promise.all([
    safeCommand("powercfg", ["/q", "SCHEME_CURRENT", "SUB_VIDEO", "VIDEOIDLE"]),
    safeCommand("powercfg", ["/q", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"]),
  ]);
  if (video) status.displaySleepMinutes = parsePowerCfgMinutes(video);
  if (standby) status.systemSleepMinutes = parsePowerCfgMinutes(standby);
  return status;
}

async function safeCommand(command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runCommand(command, args, { timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 });
    return result.stdout;
  } catch {
    return undefined;
  }
}

/** 解析 pmset -g custom 里的 "displaysleep 10" 这类键（分钟；0 = 永不）。 */
function parsePmsetMinutes(output: string, key: string): number | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s+(\\d+)`, "m"));
  if (!match) return undefined;
  return Number(match[1]);
}

/** 解析 pmset -g assertions 摘要段 "   PreventUserIdleDisplaySleep    0" 的数量。 */
function parseAssertionCount(output: string, name: string): number | undefined {
  const match = output.match(new RegExp(`^\\s*${name}\\s+(\\d+)`, "m"));
  if (!match) return undefined;
  return Number(match[1]);
}

/** 解析 powercfg /q 的 "当前交流电源设置索引: 0x00000258"（秒 → 分钟；0 = 永不）。支持中文/英文系统输出。 */
function parsePowerCfgMinutes(output: string): number | undefined {
  const match = output.match(/当前[^:]*设置索引:\s*(0x[0-9a-fA-F]+)/)
    ?? output.match(/(?:Current|AC|DC)[^\n]*Setting Index:\s*(0x[0-9a-fA-F]+)/i);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1], 16);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.round(seconds / 60);
}

function formatUnixTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把屏幕状态格式化为卡片友好文本；没有任何可用信息时返回空串。 */
export function formatDisplayStatus(status: DisplayStatus | undefined): string {
  if (!status) return "";
  const lines: string[] = [];
  if (status.screenLocked !== undefined) {
    lines.push(`🔒 锁屏：<font color='${status.screenLocked ? "red" : "green"}'>${status.screenLocked ? "是" : "否"}</font>${status.lockedAtText ? `（${status.lockedAtText} 锁定）` : ""}`);
  }
  if (status.idleSeconds !== undefined) {
    lines.push(`⏱ 空闲时长：<font color='orange'>${formatDuration(status.idleSeconds)}</font>`);
  }
  if (status.displaySleepMinutes !== undefined) {
    lines.push(`🖥 显示器休眠：<font color='${status.displaySleepMinutes === 0 ? "grey" : "blue"}'>${status.displaySleepMinutes === 0 ? "关闭（永不）" : `${status.displaySleepMinutes} 分钟`}</font>`);
  }
  if (status.systemSleepMinutes !== undefined) {
    lines.push(`🛌 系统休眠：<font color='${status.systemSleepMinutes === 0 ? "grey" : "blue"}'>${status.systemSleepMinutes === 0 ? "关闭（永不）" : `${status.systemSleepMinutes} 分钟`}</font>`);
  }
  if (status.screensaverIdleSeconds !== undefined) {
    lines.push(`🎬 屏保延迟：<font color='blue'>${status.screensaverIdleSeconds === 0 ? "关闭" : `${status.screensaverIdleSeconds} 秒`}</font>`);
  }
  if (status.displaySleepAssertions !== undefined) {
    lines.push(`🛡 防显示器休眠断言：<font color='${status.displaySleepAssertions > 0 ? "orange" : "grey"}'>${status.displaySleepAssertions} 个进程持有</font>`);
  }
  if (status.systemSleepAssertions !== undefined) {
    lines.push(`🛡 防系统休眠断言：<font color='${status.systemSleepAssertions > 0 ? "orange" : "grey"}'>${status.systemSleepAssertions} 个进程持有</font>`);
  }
  if (lines.length === 0) return "";
  return `\n\n---\n📱 **屏幕状态**\n${lines.join("\n")}`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return "少于 1 分钟";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}
