import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchBotTransferWorker } from "./bot-transfer-launcher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Bot transfer worker launcher", () => {
  it("launches a detached worker with a private request and active markers", async () => {
    const root = temporaryRoot();
    const runtime = path.join(root, "runtime");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    const sentinel = path.join(root, "worker-ran");
    fs.writeFileSync(path.join(runtime, "dist", "bot-transfer-worker.js"), `
      import fs from "node:fs";
      const request = process.env.NIUBOT_BOT_TRANSFER_REQUEST;
      const value = JSON.parse(fs.readFileSync(request, "utf-8"));
      setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, value.id), 100);
    `);

    const launched = launchBotTransferWorker({
      runtimeRoot: runtime,
      request: {
        kind: "move",
        sourceHome: source,
        targetHome: target,
        botId: "Mover",
        sourceVersion: "1",
        runtime: { runtimePath: runtime, nodePath: process.execPath, version: "1" },
      },
    });

    const requestFile = path.join(path.dirname(launched.stateFile), "request.json");
    expect(fs.statSync(requestFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(source, "run", "bot-transfer-active", `${launched.id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(target, "run", "bot-transfer-active", `${launched.id}.json`))).toBe(true);
    await waitForFile(sentinel);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe(launched.id);

    expect(() => launchBotTransferWorker({
      runtimeRoot: runtime,
      request: {
        kind: "move",
        sourceHome: source,
        targetHome: target,
        botId: "Mover",
        sourceVersion: "1",
        runtime: { runtimePath: runtime, nodePath: process.execPath, version: "1" },
      },
    })).toThrow(/already active/);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-transfer-launcher-"));
  roots.push(root);
  return root;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
