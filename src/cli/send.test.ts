import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSend,
  resolveSendEndpoint,
  resolveSendFilePaths,
  resolveSendScope,
  resolveSendText,
  validateSendArgs,
} from "./send.js";
import { parseArgs } from "./args.js";
import { prepareLocalIpcEndpoint, resolveBotEndpoint } from "../platform/ipc.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix = "niubot-send-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 起一个假 IPC 服务端，记录 /send、/send-file 的请求体。 */
async function startIpcServer(tempDir: string): Promise<{
  bodies: Array<Record<string, unknown>>;
}> {
  const endpoint = resolveBotEndpoint(tempDir, "TestBot");
  await prepareLocalIpcEndpoint(endpoint);
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.address, resolve);
  });
  servers.push(server);
  vi.stubEnv("NIUBOT_HOME", tempDir);
  vi.stubEnv("NIUBOT_API_SOCKET", endpoint.address);
  vi.stubEnv("NIUBOT_THREAD_ID", "");
  vi.stubEnv("NIUBOT_SCOPE_KEY", "");
  return { bodies };
}

/** 断言 handleSend 以 exit 1 结束，并返回打印到 stderr 的错误行。 */
function expectSendExit(args: string[], chatId = "c1"): string[] {
  const errors: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as (code?: number) => never);

  expect(() => handleSend(args, chatId, parseArgs)).toThrow("process.exit:1");
  errorSpy.mockRestore();
  return errors;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSendFilePaths", () => {
  it("keeps all repeated --file values in order", () => {
    const args = ["--file", "eval-cases.yaml", "--file", "eval-cases-report.md"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendFilePaths(args, positional, flags)).toEqual([
      "eval-cases.yaml",
      "eval-cases-report.md",
    ]);
  });

  it("keeps the existing single --file behavior", () => {
    const args = ["--file", "eval-cases.yaml"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendFilePaths(args, positional, flags)).toEqual(["eval-cases.yaml"]);
  });

  it("supports the --file=path form even when the path is literally true", () => {
    const args = ["--file=true"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendFilePaths(args, positional, flags)).toEqual(["true"]);
  });
});

describe("resolveSendText", () => {
  it("joins the --text value with trailing words", () => {
    const args = ["--text", "你好", "世界"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendText(args, flags, positional)).toBe("你好 世界");
  });

  it("returns undefined when --text is absent", () => {
    const args = ["file", "x.md"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendText(args, flags, positional)).toBeUndefined();
  });

  it("returns empty text for a bare --text without a value", () => {
    const args = ["--text"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendText(args, flags, positional)).toBe("");
  });

  it("keeps the literal word true as text", () => {
    const args = ["--text", "true"];
    const { positional, flags } = parseArgs(args);

    expect(resolveSendText(args, flags, positional)).toBe("true");
  });
});

describe("validateSendArgs", () => {
  it("rejects invocations without a send type", () => {
    const { positional, flags } = parseArgs(["file", "x.md"]);
    const filePaths = resolveSendFilePaths(["file", "x.md"], positional, flags);

    expect(validateSendArgs(positional, flags, filePaths !== undefined)).toContain(
      "Missing send type: use --text, --card, or --file",
    );
  });

  it("rejects unknown options", () => {
    const { positional, flags } = parseArgs(["--files", "x.md"]);

    expect(validateSendArgs(positional, flags, false)).toContain("Unknown option: --files");
  });

  it("rejects misspelled short options", () => {
    const { positional, flags } = parseArgs(["-f", "x.md"]);

    expect(validateSendArgs(positional, flags, false)).toContain("Unknown option: -f");
  });

  it("rejects multiple send types", () => {
    const { positional, flags } = parseArgs(["--text", "hi", "--file", "x.md"]);

    expect(validateSendArgs(positional, flags, true)).toContain(
      "Choose only one of --text, --card, or --file",
    );
  });

  it("rejects positional arguments with --file", () => {
    const { positional, flags } = parseArgs(["--file", "x.md", "extra"]);

    expect(validateSendArgs(positional, flags, true)).toContain(
      "Unexpected argument with --file: extra (use repeated --file)",
    );
  });

  it("accepts a valid --text invocation", () => {
    const { positional, flags } = parseArgs(["--text", "hi"]);

    expect(validateSendArgs(positional, flags, false)).toEqual([]);
  });
});

describe("resolveSendEndpoint", () => {
  it("uses the configured endpoint first", () => {
    expect(resolveSendEndpoint({
      NIUBOT_HOME: "/home/niubot",
      NIUBOT_API_SOCKET: "/custom/api.sock",
      NIUBOT_BOT_NAME: "TestBot",
    }).address).toBe("/custom/api.sock");
  });

  it("derives a Unix socket from the database directory before the bot default", () => {
    expect(resolveSendEndpoint({
      NIUBOT_HOME: "/home/niubot",
      NIUBOT_DB_PATH: "/data/custom/bot.db",
      NIUBOT_BOT_NAME: "TestBot",
    }, "linux").address).toBe("/data/custom/api.sock");
  });
});

describe("resolveSendScope", () => {
  it("carries topic scope only while sending to the current chat", () => {
    const env = {
      NIUBOT_CHAT_ID: "c1",
      NIUBOT_SCOPE_KEY: "c1#omt_aaa",
      NIUBOT_THREAD_ID: "omt_aaa",
    };

    expect(resolveSendScope("c1", "c1", env)).toEqual({
      scopeKey: "c1#omt_aaa",
      threadId: "omt_aaa",
    });
    expect(resolveSendScope("c2", "c1", env)).toEqual({});
  });
});

describe("handleSend", () => {
  it("sends a text message via --text", async () => {
    const { bodies } = await startIpcServer(makeTempDir());
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    handleSend(["--text", "你好", "世界"], "c1", parseArgs);

    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ chat_id: "c1", text: "你好 世界" });
    await vi.waitFor(() => expect(logged).toContain("Text message sent."));
  });

  it("sends every repeated --file value as a separate file request", async () => {
    const tempDir = makeTempDir();
    const first = path.join(tempDir, "eval-cases.yaml");
    const second = path.join(tempDir, "eval-cases-report.md");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    const { bodies } = await startIpcServer(tempDir);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    handleSend(["--file", first, "--file", second], "c1", parseArgs);

    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies.map((body) => body["file_path"])).toEqual([
      path.resolve(first),
      path.resolve(second),
    ]);
    expect(bodies.every((body) => body["chat_id"] === "c1")).toBe(true);
    await vi.waitFor(() => expect(logged).toEqual([
      `File sent: ${first}`,
      `File sent: ${second}`,
    ]));
  });

  it("sends a card message via --card", async () => {
    const { bodies } = await startIpcServer(makeTempDir());
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    handleSend(["--card", "标题", "内容"], "c1", parseArgs);

    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ chat_id: "c1", card_header: "标题", text: "内容" });
    await vi.waitFor(() => expect(logged).toContain("Card sent."));
  });

  it("rejects a botched file command instead of sending text", () => {
    const errors = expectSendExit(["file", "/tmp/x.md"]);

    expect(errors.join("\n")).toContain("Missing send type");
    expect(errors.join("\n")).toContain("nbt send --file <path>");
  });

  it("rejects unknown options before sending", () => {
    const errors = expectSendExit(["--files", "/tmp/x.md"]);

    expect(errors.join("\n")).toContain("Unknown option: --files");
  });

  it("rejects a bare --text without a value", () => {
    const errors = expectSendExit(["--text"]);

    expect(errors.join("\n")).toContain("--text requires text");
  });

  it("sends no file when one path in the batch is missing", () => {
    const tempDir = makeTempDir();
    const existing = path.join(tempDir, "ok.md");
    fs.writeFileSync(existing, "ok");

    const errors = expectSendExit(["--file", existing, "--file", path.join(tempDir, "missing.md")]);

    expect(errors.join("\n")).toContain("file not found");
  });

  it("rejects directories passed to --file", () => {
    const tempDir = makeTempDir();

    const errors = expectSendExit(["--file", tempDir]);

    expect(errors.join("\n")).toContain("not a file");
  });
});
