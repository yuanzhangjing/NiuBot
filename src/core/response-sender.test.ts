import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlatformAdapter } from "../im/types.js";
import { ResponseSender } from "./response-sender.js";

type Call =
  | { method: "card"; chatId: string; content: string; replyToMsgId?: string }
  | { method: "text"; chatId: string; text: string }
  | { method: "reply"; chatId: string; text: string; replyToMsgId: string }
  | { method: "file"; chatId: string; filePath: string; fileName?: string };

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, ...args: unknown[]) => {
    lines.push(String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  });
  return lines;
}

function createAdapter(overrides: Partial<PlatformAdapter> = {}) {
  const calls: Call[] = [];
  const im: PlatformAdapter = {
    onMessage() {},
    async start() {},
    async stop() {},
    async sendText(chatId, text) {
      calls.push({ method: "text", chatId, text });
      return "text-msg";
    },
    async sendReply(chatId, text, replyToMsgId) {
      calls.push({ method: "reply", chatId, text, replyToMsgId });
      return "reply-msg";
    },
    async sendMarkdownCard() { return "markdown-msg"; },
    async sendCard(chatId, _header, content, _footer, replyToMsgId) {
      calls.push({ method: "card", chatId, content, replyToMsgId });
      return "card-msg";
    },
    async editMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async sendFile(chatId, filePath, fileName) {
      calls.push({ method: "file", chatId, filePath, fileName });
      return "file-msg";
    },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Admin"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
    ...overrides,
  };
  return { im, calls };
}

describe("ResponseSender", () => {
  test("logs direct send duration without response content", async () => {
    const logs = captureStdout();
    const { im } = createAdapter();
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    await expect(sender.sendCard("chat-1", "Reply", "secret reply", "footer", "msg-1"))
      .resolves.toBe("card-msg");

    const output = logs.join("");
    expect(output).toContain("[response-sender] send started method=im.sendCard chatId=chat-1");
    expect(output).toContain("hasReply=true");
    expect(output).toContain("contentLength=12");
    expect(output).toContain("timeoutMs=100");
    expect(output).toContain("[response-sender] send succeeded method=im.sendCard chatId=chat-1 platformMsgId=card-msg");
    expect(output).toContain("durationMs=");
    expect(output).not.toContain("secret reply");
  });

  test("does not call fallback when card succeeds", async () => {
    const { im, calls } = createAdapter();
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
      footer: "footer",
      replyToMsgId: "msg-1",
    });

    expect(result).toEqual({ ok: true, platformMsgId: "card-msg", method: "card" });
    expect(calls).toEqual([
      { method: "card", chatId: "chat-1", content: "hello", replyToMsgId: "msg-1" },
    ]);
  });

  test("falls back to text when card rejects", async () => {
    const { im, calls } = createAdapter({
      async sendCard(chatId, _header, content, _footer, replyToMsgId) {
        calls.push({ method: "card", chatId, content, replyToMsgId });
        throw new Error("card failed");
      },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
    });

    expect(result).toEqual({ ok: true, platformMsgId: "text-msg", method: "text" });
    expect(calls.map((call) => call.method)).toEqual(["card", "text"]);
  });

  test("logs send attempts and fallback results without response content", async () => {
    const logs = captureStdout();
    const { im } = createAdapter({
      async sendCard() { throw new Error("card failed"); },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "secret reply",
    });

    const output = logs.join("");
    expect(result).toEqual({ ok: true, platformMsgId: "text-msg", method: "text" });
    expect(output).toContain("[response-sender] send attempt method=card:create chatId=chat-1");
    expect(output).toContain("[response-sender] send failed method=card:create chatId=chat-1");
    expect(output).toContain("[response-sender] send succeeded method=text:create chatId=chat-1 platformMsgId=text-msg");
    expect(output).toContain("contentLength=12");
    expect(output).not.toContain("secret reply");
  });

  test("falls back from reply to create when reply fails", async () => {
    const { im, calls } = createAdapter({
      async sendCard(chatId, _header, content, _footer, replyToMsgId) {
        calls.push({ method: "card", chatId, content, replyToMsgId });
        if (replyToMsgId) throw new Error("reply failed");
        return "created-card-msg";
      },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
      replyToMsgId: "msg-1",
    });

    expect(result).toEqual({ ok: true, platformMsgId: "created-card-msg", method: "card" });
    expect(calls).toEqual([
      { method: "card", chatId: "chat-1", content: "hello", replyToMsgId: "msg-1" },
      { method: "card", chatId: "chat-1", content: "hello", replyToMsgId: undefined },
    ]);
  });

  test("does not retry with text when card delivery times out", async () => {
    vi.useFakeTimers();
    const { im, calls } = createAdapter({
      async sendCard(chatId, _header, content, _footer, replyToMsgId) {
        calls.push({ method: "card", chatId, content, replyToMsgId });
        return new Promise<string>(() => {});
      },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const pending = sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      uncertain: true,
      methodsTried: ["card:create"],
    });
    expect(calls.map((call) => call.method)).toEqual(["card"]);
  });

  test("returns failure instead of throwing when all methods fail", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-response-sender-test-"));
    tempDirs.push(dir);
    const { im } = createAdapter({
      async sendCard() { throw new Error("card failed"); },
      async sendText() { throw new Error("text failed"); },
      async sendFile() { throw new Error("file failed"); },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100, tempDir: dir });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: "file failed",
      methodsTried: ["card:create", "text:create", "file:create"],
    });
  });

  test("falls back to a temporary markdown file when card and text fail", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-response-sender-test-"));
    tempDirs.push(dir);
    let filePathFromSend: string | undefined;
    const { im, calls } = createAdapter({
      async sendCard() { throw new Error("card failed"); },
      async sendText() { throw new Error("text failed"); },
      async sendFile(chatId, filePath, fileName) {
        filePathFromSend = filePath;
        calls.push({ method: "file", chatId, filePath, fileName });
        return "file-msg";
      },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100, tempDir: dir });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: "hello",
      footer: "footer",
    });

    expect(result).toEqual({ ok: true, platformMsgId: "file-msg", method: "file" });
    expect(calls.map((call) => call.method)).toEqual(["file"]);
    expect(filePathFromSend).toBeDefined();
    expect(existsSync(filePathFromSend!)).toBe(false);
  });

  test("keeps long text on the existing text path so adapter file fallback still works", async () => {
    const longText = "x".repeat(12_000);
    const { im, calls } = createAdapter({
      async sendCard(chatId, _header, content, _footer, replyToMsgId) {
        calls.push({ method: "card", chatId, content, replyToMsgId });
        throw new Error("card failed");
      },
      async sendText(chatId, text) {
        calls.push({ method: "text", chatId, text });
        return "adapter-file-msg";
      },
    });
    const sender = new ResponseSender(im, { timeoutMs: 100 });

    const result = await sender.sendFinalResponse({
      chatId: "chat-1",
      header: "Reply",
      content: longText,
    });

    expect(result).toEqual({ ok: true, platformMsgId: "adapter-file-msg", method: "text" });
    expect(calls).toContainEqual({ method: "text", chatId: "chat-1", text: longText });
  });
});
