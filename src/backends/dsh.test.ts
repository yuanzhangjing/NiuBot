import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DshBackend, { encodeProjectDir, parseAgentDefaultModel, splitModel } from "./dsh.js";
import { AgentSessionNotStartedError } from "../agent/types.js";
import { readDshTranscript } from "../session-archive/native-transcript.js";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-test-"));
  tempDirs.push(dir);
  vi.stubEnv("NIUBOT_HOME", dir);
  return dir;
}

function line(event: unknown): string {
  return JSON.stringify(event);
}

/** 在 NiuBot 管的 session 根目录下造一份原生日志 */
function writeSessionLog(home: string, cwd: string, sessionId: string, entries: unknown[]): string {
  const dir = path.join(home, "dsh", "sessions", encodeProjectDir(cwd), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

describe("DshBackend", () => {
  beforeEach(() => {
    // config.ts 会把 ~/.niubot/.env 灌进 process.env，测试里清掉部署相关变量
    vi.stubEnv("DSH_MODEL", "");
    vi.stubEnv("DSH_PROVIDER", "");
    vi.stubEnv("DSH_EXTRA_PATCH", "");
    vi.stubEnv("DSH_PROFILE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds headless json args and pipes the message through stdin", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const input = backend.buildInput(session, "hello");

    expect(input.args.slice(0, 3)).toEqual(["--profile", "headless", "--patch"]);
    expect(input.args).toContain("--json");
    expect(input.args.at(-1)).toBe("-");
    expect(input.args).not.toContain("--session-id");
    expect(input.stdin).toBe("hello");
  });

  it("resumes with --session-id when a native id exists", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = "session-abc";

    const input = backend.buildInput(session, "continue");

    expect(input.args).toContain("--session-id");
    expect(input.args[input.args.indexOf("--session-id") + 1]).toBe("session-abc");
  });

  it("writes model and effort into the patch file", () => {
    const home = tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      model: "magpie/deepseek-v4.1-flash",
      reasoningEffort: "high",
    });

    const input = backend.buildInput(session, "hi");
    const patchPath = input.args[input.args.indexOf("--patch") + 1]!;
    const patch = JSON.parse(fs.readFileSync(patchPath, "utf-8")) as Array<Record<string, any>>;

    const modelEntry = patch.find((entry) => entry["id"] === "agent-default-model");
    expect(modelEntry?.config).toEqual({
      provider: "magpie",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
    });

    const persistence = patch.find((entry) => entry["id"] === "session-persistence-jsonl");
    expect(persistence?.config).toEqual({
      root: path.join(home, "dsh", "sessions"),
      compression: "none",
    });
  });

  it("omits the model entry when no model is configured", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const input = backend.buildInput(session, "hi");
    const patch = JSON.parse(fs.readFileSync(input.args[input.args.indexOf("--patch") + 1]!, "utf-8"));

    expect(patch.some((entry: any) => entry["id"] === "agent-default-model")).toBe(false);
  });

  it("falls back to DSH_MODEL when NiuBot config has no model", () => {
    tempHome();
    vi.stubEnv("DSH_MODEL", "deepseek-v4.1-flash");
    vi.stubEnv("DSH_PROVIDER", "magpie");
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const input = backend.buildInput(session, "hi");
    const patch = JSON.parse(fs.readFileSync(input.args[input.args.indexOf("--patch") + 1]!, "utf-8"));

    expect(patch.find((entry: any) => entry["id"] === "agent-default-model")?.config).toEqual({
      provider: "magpie",
      model: "deepseek-v4.1-flash",
    });
  });

  it("keeps the profile default provider/model when only effort is configured", () => {
    tempHome();
    const backend = new DshBackend();
    // 模拟 dump-config 解析出的 profile 默认值，避免测试真的去跑 dsh
    (backend as any).profileDefaultModel = () => ({ provider: "deepseek-official", model: "deepseek-flash" });

    const session = backend.buildSession({ workingDirectory: "/tmp/workspace", reasoningEffort: "max" });
    const input = backend.buildInput(session, "hi");
    const patch = JSON.parse(fs.readFileSync(input.args[input.args.indexOf("--patch") + 1]!, "utf-8"));

    expect(patch.find((entry: any) => entry["id"] === "agent-default-model")?.config).toEqual({
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEffort: "max",
    });
  });

  it("parses a completed turn", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const parsed = backend.parseOutput([
      line({ type: "session", sessionId: "session-1", cwd: "/tmp/workspace" }),
      line({ type: "status", phase: "turn_start", turn: 1 }),
      line({ type: "status", phase: "step_start", turn: 1, step: 1 }),
      line({ type: "text", text: "中间旁白" }),
      line({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      line({ type: "status", phase: "step_start", turn: 1, step: 2 }),
      line({ type: "text", text: "最终回复" }),
      line({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } }),
      line({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }),
      line({ type: "final", text: "最终回复" }),
    ].join("\n"), session);

    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.text).toBe("最终回复");
    expect(parsed.agentSessionId).toBe("session-1");
    expect(parsed.contextTokens).toBe(23);
    expect(parsed.failed).toBeFalsy();
  });

  it("treats an error turn_end as failed even when final is present", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      line({ type: "session", sessionId: "session-2" }),
      line({
        type: "status",
        phase: "turn_end",
        turn: 1,
        reason: { kind: "error", error: { message: "provider boom", code: "X" } },
      }),
      line({ type: "final", text: "" }),
    ].join("\n"), session);

    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.failed).toBe(true);
    expect(parsed.error).toBe("provider boom");
  });

  it("reports incomplete when the stream has no final event", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      line({ type: "session", sessionId: "session-3" }),
      line({ type: "status", phase: "step_end", turn: 1, step: 1 }),
    ].join("\n"), session);

    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.incompleteReason).toContain("未正常结束");
  });

  it("surfaces a runner error event", () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(
      line({ type: "error", message: "session \"x\" does not exist" }),
      session,
    );

    expect(parsed.failed).toBe(true);
    expect(parsed.error).toContain("does not exist");
  });

  it("counts only successful compactions from the native log", () => {
    const home = tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    writeSessionLog(home, "/tmp/workspace", "session-c", [
      { type: "compaction/start", data: {} },
      { type: "compaction/end", data: {} },
      { type: "compaction/start", data: {} },
      { type: "compaction/end", data: { error: { message: "boom" } } },
    ]);

    const parsed = backend.parseOutput([
      line({ type: "session", sessionId: "session-c" }),
      line({ type: "status", phase: "turn_end", reason: { kind: "completed" } }),
      line({ type: "final", text: "ok" }),
    ].join("\n"), session);

    expect(parsed.compactCount).toBe(1);
  });

  it("reports not-started instead of a generic error when the native log is missing", async () => {
    tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = "session-missing";

    await expect((backend as any).loadSessionTranscript(session))
      .rejects.toBeInstanceOf(AgentSessionNotStartedError);
  });

  it("marks in-flight tools and compaction in activity", () => {
    const home = tempHome();
    const backend = new DshBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = "session-a";
    (backend as any).sessions.set("handle-a", session);
    writeSessionLog(home, "/tmp/workspace", "session-a", [
      { type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{\"command\":\"sleep 60\"}" } },
      { type: "compaction/start", data: {} },
    ]);

    const activity = { recentLines: [], notifyCount: 0 } as any;
    (backend as any).refreshActivity("handle-a", activity);

    expect(activity.executingTool).toBe(true);
    expect(activity.compacting).toBe(true);
    expect(activity.recentLines.length).toBeGreaterThan(0);
  });
});

describe("dsh helpers", () => {
  beforeEach(() => {
    vi.stubEnv("DSH_PROVIDER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("splits provider-qualified model names", () => {
    expect(splitModel("magpie/deepseek-v4.1-flash")).toEqual({
      provider: "magpie",
      model: "deepseek-v4.1-flash",
    });
    expect(splitModel("deepseek-v4-pro")).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
  });

  it("encodes the project directory like dsh does", () => {
    // encodeProjectDir 内部会 path.resolve：Windows 上 "/tmp/workspace" 会带上当前盘符
    // （如 D:\tmp\workspace），编码后前缀多一个 "D-"。断言跟着平台走，别写死 POSIX 结果。
    const drivePrefix = process.platform === "win32"
      ? `${path.parse(process.cwd()).root.replace(/[\\/:]/g, "")}-`
      : "";
    expect(encodeProjectDir("/tmp/workspace")).toBe(`--${drivePrefix}tmp-workspace--`);
    // 非 [A-Za-z0-9._-] 的字符按 ~XXXX 转义
    expect(encodeProjectDir("/tmp/项目 dir")).toBe(`--${drivePrefix}tmp-~9879~76EE~0020dir--`);
    // 连续分隔符折叠成一个短横线
    expect(encodeProjectDir("/tmp//a")).toBe(`--${drivePrefix}tmp-a--`);
  });

  it("reads provider and model from a composed config dump", () => {
    const dump = [
      "- id: system-prompt",
      "  name: '@deepseek-ai/dsh-system-prompt'",
      "- id: agent-default-model",
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      "  config:",
      "    provider: deepseek-official",
      "    model: deepseek-flash",
      "- id: jobs",
      "  name: '@deepseek-ai/dsh-jobs-local'",
    ].join("\n");

    expect(parseAgentDefaultModel(dump)).toEqual({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(parseAgentDefaultModel("- id: jobs")).toBeNull();
  });
});

describe("readDshTranscript", () => {
  it("keeps real user messages and skips injected context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-transcript-"));
    const file = path.join(dir, "session.v4.jsonl");
    fs.writeFileSync(file, [
      line({ type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "真实问题" }] } }),
      line({ type: "user/message", time: 2, data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "注入上下文" }] } }),
      line({ type: "assistant/message", time: 3, data: { message: { content: [{ type: "text", text: "回答" }] } } }),
      line({ type: "tool/call", time: 4, data: { callId: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" } }),
      line({ type: "tool/result", time: 5, data: { toolCallId: "c1", message: { content: [{ type: "text", text: "a.txt" }] } } }),
    ].join("\n"));

    const events = [];
    for await (const event of readDshTranscript(file, "session-1").events) events.push(event);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(events.map((event) => event.type)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(events[0]?.content).toBe("真实问题");
    expect(events[2]).toMatchObject({ name: "bash", callId: "c1" });
    expect(events[3]?.content).toBe("a.txt");
  });
});
