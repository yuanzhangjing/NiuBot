import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRestartCompatOptions } from "./restart-compat.js";

describe("restart compatibility entry", () => {
  it("accepts the environment emitted by public legacy restart callers", () => {
    const runtimeRoot = path.resolve("/tmp/current-package");
    const options = resolveRestartCompatOptions({
      NIUBOT_HOME: "/tmp/home",
      NIUBOT_CHAT_ID: "legacy-chat",
      NIUBOT_API_SOCKET: "/tmp/home/LegacyBot/api.sock",
    }, runtimeRoot);

    expect(options).toMatchObject({
      niubotHome: "/tmp/home",
      botName: "NiuBot",
      runtimeRoot,
      sourceDirectory: runtimeRoot,
      notifyChatId: "legacy-chat",
    });
  });

  it("prefers the current restart environment names", () => {
    const options = resolveRestartCompatOptions({
      NIUBOT_HOME: "/tmp/home",
      NIUBOT_BOT_NAME: "CurrentBot",
      NIUBOT_SOURCE_DIR: "/tmp/source",
      NIUBOT_RESTART_NOTIFY_CHAT_ID: "current-chat",
      NIUBOT_CHAT_ID: "legacy-chat",
      NIUBOT_UPDATE_VERSION: "1.2.3",
    }, "/tmp/runtime");

    expect(options).toMatchObject({
      botName: "CurrentBot",
      sourceDirectory: "/tmp/source",
      notifyChatId: "current-chat",
      updateVersion: "1.2.3",
    });
  });

  it("rejects callers without a NiuBot home", () => {
    expect(() => resolveRestartCompatOptions({}, "/tmp/runtime"))
      .toThrow(/NIUBOT_HOME is not set/);
  });
});
