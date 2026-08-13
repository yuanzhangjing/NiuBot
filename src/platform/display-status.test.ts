import { beforeEach, describe, expect, test, vi } from "vitest";
import { collectDisplayStatus, formatDisplayStatus } from "./display-status.js";

vi.mock("./command.js", () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from "./command.js";

const mockRunCommand = vi.mocked(runCommand);

function mockOutput(command: string, args: string[], stdout: string): void {
  mockRunCommand.mockResolvedValueOnce({ command, args, stdout, stderr: "", exitCode: 0 });
}

const MAC_REGISTRY_LOCKED = `
  "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenLockedTime"=1784991911,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserNameKey"="alice"})
`;
const MAC_REGISTRY_UNLOCKED = `
  "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=No,"kCGSSessionUserNameKey"="alice"})
`;
const MAC_HID_IDLE = `
  | |   "HIDIdleTime" = 97539380971083
`;
const MAC_PMSET_CUSTOM = `
System-wide power settings:
Currently in use:
 standby              0
 Sleep On Power Button 1
 disksleep            10
 sleep                0
 displaysleep         10
 lowpowermode         0
`;
const MAC_ASSERTIONS = `
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             2
   PreventUserIdleSystemSleep     0
`;
const WIN_VIDEO = `
电源设置 GUID: 3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e  (显示器)
  当前交流电源设置索引: 0x00000258
  当前直流电源设置索引: 0x00000258
`;
const WIN_VIDEO_EN = `
Power Setting GUID: 3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e  (Display)
  Current AC Power Setting Index: 0x00000258
  Current DC Power Setting Index: 0x00000258
`;
const WIN_STANDBY = `
电源设置 GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (睡眠)
  当前交流电源设置索引: 0x00000000
  当前直流电源设置索引: 0x00000000
`;
const WIN_SESSION_LOCKED = "LOCKED=True\r\nIDLE=3600\r\n";
const WIN_SESSION_UNLOCKED = "LOCKED=False\r\nIDLE=42\r\n";

beforeEach(() => {
  mockRunCommand.mockReset();
});

describe("collectDisplayStatus (macOS)", () => {
  test("parses locked screen, idle time, pmset settings and assertions", async () => {
    mockOutput("ioreg", ["-n", "Root", "-d1"], MAC_REGISTRY_LOCKED);
    mockOutput("ioreg", ["-c", "IOHIDSystem"], MAC_HID_IDLE);
    mockOutput("pmset", ["-g", "custom"], MAC_PMSET_CUSTOM);
    mockOutput("pmset", ["-g", "assertions"], MAC_ASSERTIONS);
    mockOutput("defaults", ["read", "com.apple.screensaver", "idleTime"], "300\n");

    const status = await collectDisplayStatus("darwin");
    expect(status).toMatchObject({
      platform: "darwin",
      screenLocked: true,
      idleSeconds: 97_539,
      displaySleepMinutes: 10,
      systemSleepMinutes: 0,
      screensaverIdleSeconds: 300,
      displaySleepAssertions: 1,
      systemSleepAssertions: 2,
    });
    expect(status?.lockedAtText).toBeTruthy();
  });

  test("tolerates command failures and unlocks", async () => {
    mockOutput("ioreg", ["-n", "Root", "-d1"], MAC_REGISTRY_UNLOCKED);
    mockRunCommand.mockRejectedValueOnce(new Error("Command exited with code 1"));
    mockRunCommand.mockRejectedValueOnce(new Error("Command exited with code 1"));
    mockRunCommand.mockRejectedValueOnce(new Error("Command exited with code 1"));

    const status = await collectDisplayStatus("darwin");
    expect(status).toMatchObject({ platform: "darwin", screenLocked: false });
    expect(status?.displaySleepMinutes).toBeUndefined();
  });
});

describe("collectDisplayStatus (Windows)", () => {
  test("parses powercfg AC/DC settings, lock state and idle time", async () => {
    mockOutput("powercfg", ["/q", "SCHEME_CURRENT", "SUB_VIDEO", "VIDEOIDLE"], WIN_VIDEO);
    mockOutput("powercfg", ["/q", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"], WIN_STANDBY);
    mockOutput("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.any(String)], WIN_SESSION_LOCKED);

    const status = await collectDisplayStatus("win32");
    expect(status).toMatchObject({
      platform: "win32",
      displaySleepMinutes: 10,
      systemSleepMinutes: 0,
      screenLocked: true,
      idleSeconds: 3600,
    });
  });

  test("parses powercfg on English systems", async () => {
    mockOutput("powercfg", ["/q", "SCHEME_CURRENT", "SUB_VIDEO", "VIDEOIDLE"], WIN_VIDEO_EN);
    mockOutput("powercfg", ["/q", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"], WIN_STANDBY);
    mockOutput("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.any(String)], WIN_SESSION_UNLOCKED);

    const status = await collectDisplayStatus("win32");
    expect(status).toMatchObject({ displaySleepMinutes: 10, screenLocked: false, idleSeconds: 42 });
  });
});

describe("collectDisplayStatus (unsupported)", () => {
  test("returns undefined for linux", async () => {
    expect(await collectDisplayStatus("linux")).toBeUndefined();
  });
});

describe("formatDisplayStatus", () => {
  test("formats available fields", () => {
    const text = formatDisplayStatus({
      platform: "darwin",
      screenLocked: true,
      lockedAtText: "08-12 14:05",
      idleSeconds: 97_539,
      displaySleepMinutes: 10,
      systemSleepMinutes: 0,
      screensaverIdleSeconds: 300,
      displaySleepAssertions: 1,
      systemSleepAssertions: 2,
    });
    expect(text).toContain("🔒 锁屏：<font color='red'>是</font>（08-12 14:05 锁定）");
    expect(text).toContain("⏱ 空闲时长：<font color='orange'>1 天 3 小时</font>");
    expect(text).toContain("🖥 显示器休眠：<font color='blue'>10 分钟</font>");
    expect(text).toContain("🛌 系统休眠：<font color='grey'>关闭（永不）</font>");
    expect(text).toContain("🎬 屏保延迟：<font color='blue'>300 秒</font>");
    expect(text).toContain("🛡 防显示器休眠断言：<font color='orange'>1 个进程持有</font>");
    expect(text).toContain("🛡 防系统休眠断言：<font color='orange'>2 个进程持有</font>");
  });

  test("returns empty string for no info and undefined", () => {
    expect(formatDisplayStatus(undefined)).toBe("");
    expect(formatDisplayStatus({ platform: "darwin" })).toBe("");
  });
});
