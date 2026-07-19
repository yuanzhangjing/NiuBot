import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRestartWorkerEnvironment } from "./restart-launcher.js";

describe("restart launcher", () => {
  it("passes update inputs without leaking an agent-session guard", () => {
    const env = buildRestartWorkerEnvironment({
      niubotHome: "/tmp/home",
      botName: "NiuBot",
      runtimeRoot: "/tmp/runtime",
      sourceDirectory: "/tmp/source",
      runtimeMode: "npm-release",
      notifyChatId: "chat-a",
      updateVersion: "1.2.3",
    }, { NIUBOT_AGENT_SESSION: "session-a", KEEP_ME: "yes" });

    expect(env["NIUBOT_AGENT_SESSION"]).toBeUndefined();
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["NIUBOT_HOME"]).toBe(path.resolve("/tmp/home"));
    expect(env["NIUBOT_RESTART_MODE"]).toBe("npm-update");
    expect(env["NIUBOT_UPDATE_VERSION"]).toBe("1.2.3");
  });
});
