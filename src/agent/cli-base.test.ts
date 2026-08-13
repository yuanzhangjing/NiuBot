import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CliAgentBackend, type BaseCliSession, type ParsedOutput } from "./cli-base.js";
import { getAgentStdoutLogFilePath } from "./agent-stdout-log.js";
import type { AgentSession, ExecHooks, SessionConfig } from "./types.js";

class FailingCliBackend extends CliAgentBackend<BaseCliSession> {
  command(): string {
    return "node";
  }

  buildSession(_config: SessionConfig): BaseCliSession {
    return {
      workingDirectory: process.cwd(),
      extraEnv: {},
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(_session: BaseCliSession, message: string): { args: string[]; stdin?: string } {
    return {
      args: [
        "-e",
        "process.stdout.write('Reading prompt from stdin...\\n'); process.stderr.write('No prompt provided via stdin.\\n'); process.exit(1);",
      ],
      stdin: message,
    };
  }

  parseOutput(stdout: string): ParsedOutput {
    return { text: stdout.trim(), turnCompleted: true };
  }
}

class ParsedOutputBackend extends CliAgentBackend<BaseCliSession> {
  constructor(private readonly parsed: ParsedOutput) {
    super("test-cli");
  }

  command(): string {
    return "node";
  }

  buildSession(_config: SessionConfig): BaseCliSession {
    return {
      workingDirectory: process.cwd(),
      extraEnv: {},
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(_session: BaseCliSession, _message: string): { args: string[]; stdin?: string } {
    return {
      args: ["-e", "process.stdout.write('ok');"],
    };
  }

  parseOutput(_stdout: string): ParsedOutput {
    return this.parsed;
  }
}

class ThrowingRefreshBackend extends ParsedOutputBackend {
  protected refreshActivity(): void {
    throw new Error("refresh failed");
  }
}

class ThrowingHookBackend extends ParsedOutputBackend {
  buildInput(_session: BaseCliSession, _message: string): { args: string[]; stdin?: string } {
    return {
      args: ["-e", "process.stdout.write('ok\\n');"],
    };
  }

  protected getExecHooks(): ExecHooks {
    return {
      onLine: () => {
        throw new Error("hook failed");
      },
      isComplete: (line) => line === "ok",
    };
  }
}

class MissingCliBackend extends ParsedOutputBackend {
  command(): string {
    return "__niubot_missing_backend_cli__";
  }
}

describe("CliAgentBackend diagnostic logging", () => {
  const tempHome = join(tmpdir(), `niubot-cli-base-stdout-${process.pid}`);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("preserves the real availability-check error", async () => {
    const backend = new MissingCliBackend({ text: "", turnCompleted: true });

    await expect(backend.start()).rejects.toThrow(
      "__niubot_missing_backend_cli__ CLI is not usable: Command not found: __niubot_missing_backend_cli__",
    );
  });

  test("dumps full stdout when NIUBOT_DEBUG_AGENT_STDOUT is enabled", async () => {
    vi.stubEnv("NIUBOT_HOME", tempHome);
    vi.stubEnv("NIUBOT_DEBUG_AGENT_STDOUT", "1");
    mkdirSync(join(tempHome, "logs"), { recursive: true });

    const backend = new ThrowingHookBackend({ text: "ok", turnCompleted: true });
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    (backend as any).log = {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", msg, data }),
    };
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).resolves.toMatchObject({ text: "ok" });

    const dumpLog = entries.find((entry) => entry.msg === "agent stdout dumped");
    expect(dumpLog?.data?.["reason"]).toBe("complete");
    const logPath = String(dumpLog?.data?.["logPath"]);
    expect(logPath).toBe(getAgentStdoutLogFilePath(tempHome));
    expect(readFileSync(logPath, "utf8")).toContain("ok");
  });

  test("logs stdin and stream tails when child process fails", async () => {
    const backend = new FailingCliBackend("test-cli");
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    (backend as any).log = {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", msg, data }),
    };

    const session = await backend.createSession({ workingDirectory: process.cwd() });

    // err.message is intentionally short (does not embed stderr/stdout).
    // Raw stream content is accessible via err.stderr / err.stdout.
    await expect(backend.sendMessage(session as AgentSession, "publish to npm")).rejects.toMatchObject({
      message: expect.stringMatching(/^Command failed: node \(exit 1\)$/),
      stderr: expect.stringContaining("No prompt provided via stdin"),
    });

    const startLog = entries.find((entry) => entry.msg === "spawning child process");
    expect(startLog?.data).toMatchObject({
      cmd: "node",
      stdinDefined: true,
      stdinLength: 14,
      stdinPreview: "publish to npm",
    });

    const failLog = entries.find((entry) => entry.msg === "child process failed");
    expect(failLog?.data).toMatchObject({
      code: 1,
      stdinDefined: true,
      stdinLength: 14,
      stdoutTail: "Reading prompt from stdin...",
      stderrTail: "No prompt provided via stdin.",
    });
    expect(failLog?.data?.["durationMs"]).toEqual(expect.any(Number));
  });

  test("uses a neutral backend fallback when parsed output marks failure without an error message", async () => {
    const backend = new ParsedOutputBackend({ text: "", turnCompleted: true, failed: true });
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).rejects.toMatchObject({
      message: "test-cli 执行失败",
    });
  });

  test("keeps activity readable when backend refreshActivity throws", async () => {
    const backend = new ThrowingRefreshBackend({ text: "ok", turnCompleted: true });
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    (backend as any).log = {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", msg, data }),
    };
    const session = await backend.createSession({ workingDirectory: process.cwd() });
    (backend as any).activityMap.set(session.id, {
      status: "running",
      startedAt: 1,
      lastActiveAt: 1,
      completionDetected: false,
      compacting: false,
      recentLines: [],
      notifyCount: 0,
    });

    expect(backend.getActivity(session.id)?.status).toBe("running");
    expect(entries).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "refreshActivity failed",
      data: expect.objectContaining({ sessionId: session.id, error: "Error: refresh failed" }),
    }));
  });

  test("cancelSession resets watchdog notification state immediately", async () => {
    const backend = new ParsedOutputBackend({ text: "ok", turnCompleted: true });
    const session = await backend.createSession({ workingDirectory: process.cwd() });
    (backend as any).activityMap.set(session.id, {
      status: "running",
      startedAt: 1,
      lastActiveAt: 2,
      completionDetected: false,
      compacting: false,
      recentLines: [],
      notifyCount: 1,
      lastNotifiedAt: 1000,
    });

    await backend.cancelSession(session as AgentSession);

    const activity = backend.getActivity(session.id)!;
    // /stop 后立即变 cancelled，watchdog 不再把后续输出误判为“恢复活动”
    expect(activity.status).toBe("cancelled");
    expect(activity.notifyCount).toBe(0);
    expect(activity.lastNotifiedAt).toBeUndefined();
    expect(activity.completionDetected).toBe(false);
  });

  test("does not let stdout hook errors escape readline callbacks", async () => {
    const backend = new ThrowingHookBackend({ text: "ok", turnCompleted: true });
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    (backend as any).log = {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", msg, data }),
    };
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).resolves.toMatchObject({ text: "ok" });
    expect(entries).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "stdout line hook failed",
      data: expect.objectContaining({ sessionId: session.id, error: "Error: hook failed" }),
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      level: "info",
      msg: "completion detected, resolving immediately",
      data: expect.objectContaining({ sessionId: session.id }),
    }));
  });

  test("truncates oversized stdout instead of throwing RangeError", async () => {
    const backend = new (class extends ParsedOutputBackend {
      constructor() {
        super({ text: "ok", turnCompleted: true });
      }

      buildInput(_session: BaseCliSession, _message: string): { args: string[]; stdin?: string } {
        return {
          // 先输出 40MB 数据（超过 32MB 截断阈值），最后一行输出 completion 标记
          args: ["-e", `for (let i = 0; i < 400; i++) { process.stdout.write('x'.repeat(100 * 1024) + '\\n'); } process.stdout.write('DONE\\n');`],
        };
      }

      protected getExecHooks(): ExecHooks {
        return {
          isComplete: (line) => line === "DONE",
        };
      }
    })();
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    (backend as any).log = {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", msg, data }),
    };
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).resolves.toMatchObject({ text: "ok" });
    expect(entries).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "stdout exceeded limit, truncating",
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      level: "info",
      msg: "completion detected, resolving immediately",
      data: expect.objectContaining({ stdoutTruncated: true }),
    }));
  });

  test("rejects a zero-exit turn without a terminal event and includes the last message", async () => {
    const backend = new ParsedOutputBackend({
      text: "开始修复关闭竞态",
      turnCompleted: false,
      lastMessage: "开始修复关闭竞态",
      incompleteReason: "未收到 agent_end",
    });
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).rejects.toMatchObject({
      message: "test-cli 回合异常结束：未收到 agent_end\n最后一条消息：\n开始修复关闭竞态",
    });
  });
});
