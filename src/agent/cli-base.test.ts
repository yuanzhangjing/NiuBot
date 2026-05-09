import { describe, expect, test } from "vitest";
import { CliAgentBackend, type BaseCliSession, type ParsedOutput } from "./cli-base.js";
import type { AgentSession, SessionConfig } from "./types.js";

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
    return { text: stdout.trim() };
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

describe("CliAgentBackend diagnostic logging", () => {
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
    const backend = new ParsedOutputBackend({ text: "", failed: true });
    const session = await backend.createSession({ workingDirectory: process.cwd() });

    await expect(backend.sendMessage(session as AgentSession, "ping")).rejects.toMatchObject({
      message: "test-cli 执行失败",
    });
  });
});
