import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRestartWorkerEnvironment } from "./restart-launcher.js";
import { beginRestartDebugLog, resolveRestartDebugLog } from "./restart-log.js";

describe("restart launcher", () => {
  it("uses a separate portable debug log for every restart", () => {
    expect(resolveRestartDebugLog("/tmp/home", "first/run")).toBe(
      path.join(path.resolve("/tmp/home"), "logs", "restarts", "first_run.log"),
    );
    expect(resolveRestartDebugLog("/tmp/home", "second")).not.toBe(resolveRestartDebugLog("/tmp/home", "first"));
  });
  it("appends to an existing restart log instead of erasing evidence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-log-"));
    const logFile = resolveRestartDebugLog(home, "restart-a");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "original failure\n");
    beginRestartDebugLog(logFile, "restart-a", new Date("2026-08-11T10:00:00.000Z"));
    expect(fs.readFileSync(logFile, "utf-8")).toContain("original failure");
    fs.rmSync(home, { recursive: true, force: true });
  });
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
      NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID: "launcher-only",
      KEEP_ME: "yes",
    });

    expect(env["NIUBOT_AGENT_SESSION"]).toBeUndefined();
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["NIUBOT_HOME"]).toBe(path.resolve("/tmp/home"));
    expect(env["NIUBOT_RESTART_MODE"]).toBe("npm-update");
    expect(env["NIUBOT_UPDATE_VERSION"]).toBe("1.2.3");
    expect(env["NIUBOT_RECOMMENDED_ARTIFACT_ID"]).toBeUndefined();
    expect(env["NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID"]).toBeUndefined();
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
      notifyScopeKey: "chat-a#omt_aaa",
      notifyThreadId: "omt_aaa",
      wakeReplyTo: "om-root",
      wakePrompt: "重启完成，继续之前的工作",
    });
    expect(env["NIUBOT_RESTART_WAKE_PROMPT"]).toBe("重启完成，继续之前的工作");
    expect(env["NIUBOT_RESTART_SCOPE_KEY"]).toBe("chat-a#omt_aaa");
    expect(env["NIUBOT_RESTART_THREAD_ID"]).toBe("omt_aaa");
    expect(env["NIUBOT_WAKE_REPLY_TO"]).toBe("om-root");
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
