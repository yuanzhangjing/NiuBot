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
      environment: "production",
      notifyChatId: "chat-a",
      updateVersion: "1.2.3",
      restartId: "restart-a",
      restartStartedAt: "2026-07-30T00:00:00.000Z",
      stopAfterCompletion: true,
    }, {
      NIUBOT_AGENT_SESSION: "session-a",
      NIUBOT_RECOMMENDED_ARTIFACT_ID: "stale",
      NIUBOT_RECOMMENDED_GENERATION: "9",
      KEEP_ME: "yes",
    });

    expect(env["NIUBOT_AGENT_SESSION"]).toBeUndefined();
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["NIUBOT_HOME"]).toBe(path.resolve("/tmp/home"));
    expect(env["NIUBOT_RESTART_MODE"]).toBe("npm-update");
    expect(env["NIUBOT_UPDATE_VERSION"]).toBe("1.2.3");
    expect(env["NIUBOT_RECOMMENDED_ARTIFACT_ID"]).toBeUndefined();
    expect(env["NIUBOT_RESTART_ID"]).toBe("restart-a");
    expect(env["NIUBOT_RESTART_STARTED_AT"]).toBe("2026-07-30T00:00:00.000Z");
    expect(env["NIUBOT_ENV"]).toBe("production");
    expect(env["NIUBOT_RESTART_WAKE_PROMPT"]).toBe("");
    expect(env["NIUBOT_RESTART_STOP_AFTER_COMPLETION"]).toBe("1");
  });

  it("passes wake prompt to the restart worker", () => {
    const env = buildRestartWorkerEnvironment({
      niubotHome: "/tmp/home",
      botName: "NiuBot",
      runtimeRoot: "/tmp/runtime",
      sourceDirectory: "/tmp/source",
      notifyChatId: "chat-a",
      wakePrompt: "重启完成，继续之前的工作",
    });
    expect(env["NIUBOT_RESTART_WAKE_PROMPT"]).toBe("重启完成，继续之前的工作");
  });

  it("passes an exact recommended artifact and generation", () => {
    const env = buildRestartWorkerEnvironment({
      niubotHome: "/tmp/home",
      botName: "NiuBot",
      runtimeRoot: "/tmp/runtime",
      sourceDirectory: "/tmp/source",
      recommendedArtifactId: "release-a",
      recommendedGeneration: 7,
    });
    expect(env["NIUBOT_RESTART_MODE"]).toBe("recommended");
    expect(env["NIUBOT_RECOMMENDED_ARTIFACT_ID"]).toBe("release-a");
    expect(env["NIUBOT_RECOMMENDED_GENERATION"]).toBe("7");
  });

  it("passes an exact launcher recovery candidate without recommendation state", () => {
    const env = buildRestartWorkerEnvironment({
      niubotHome: "/tmp/home",
      botName: "NiuBot",
      runtimeRoot: "/tmp/runtime",
      sourceDirectory: "/tmp/source",
      candidateArtifactId: "candidate-a",
    });
    expect(env["NIUBOT_RESTART_MODE"]).toBe("candidate");
    expect(env["NIUBOT_CANDIDATE_ARTIFACT_ID"]).toBe("candidate-a");
    expect(env["NIUBOT_RECOMMENDED_ARTIFACT_ID"]).toBeUndefined();
  });
});
