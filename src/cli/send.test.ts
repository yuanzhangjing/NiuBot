import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSend, resolveSendFilePaths } from "./send.js";

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
});

describe("handleSend", () => {
  it("sends each repeated --file value as a separate file request", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-send-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "api.sock");
    const bodies: Array<{ chat_id: string; file_path: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.end("{}");
        if (bodies.length === 2) {
          server.close();
          receivedResolve();
        }
      });
    });

    let receivedResolve!: () => void;
    const received = new Promise<void>((resolve) => {
      receivedResolve = resolve;
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    vi.stubEnv("NIUBOT_HOME", tempDir);
    vi.stubEnv("NIUBOT_API_SOCKET", socketPath);
    let loggedResolve!: () => void;
    const logged = new Promise<void>((resolve) => {
      loggedResolve = resolve;
    });
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      if (message === "2 files sent.") loggedResolve();
    });

    handleSend(["--file", "eval-cases.yaml", "--file", "eval-cases-report.md"], "c1", parseArgs);

    await received;
    await logged;

    expect(bodies).toEqual([
      { chat_id: "c1", file_path: path.resolve("eval-cases.yaml") },
      { chat_id: "c1", file_path: path.resolve("eval-cases-report.md") },
    ]);
    expect(log).toHaveBeenCalledWith("2 files sent.");
  });
});
