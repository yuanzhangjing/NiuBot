import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { FeishuAdapter } from "./adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FeishuAdapter", () => {
  test("sends text over 10 KB as a markdown file", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sentMessages: Array<{ msgType: string; content: string }> = [];
    let uploadedName = "";
    let uploadedContent = "";
    (adapter as any).client = {
      im: {
        file: {
          create: async ({ data }: any) => {
            uploadedName = data.file_name;
            for await (const chunk of data.file) uploadedContent += chunk.toString();
            return { data: { file_key: "file-key" } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sentMessages.push({ msgType: data.msg_type, content: data.content });
            return { data: { message_id: "message-id" } };
          },
        },
      },
    };
    const content = "长消息".repeat(4_000);

    const messageId = await adapter.sendText("chat-id", content);

    expect(messageId).toBe("message-id");
    expect(uploadedName).toBe("reply.md");
    expect(uploadedContent).toBe(content);
    expect(sentMessages).toEqual([{
      msgType: "file",
      content: JSON.stringify({ file_key: "file-key" }),
    }]);
  });

  test("downloads image and file messages to the configured storage directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const adapter = new FeishuAdapter("app-id", "app-secret");
    adapter.setStorageDir(dir);
    (adapter as any).client = {
      im: {
        messageResource: {
          get: async ({ params }: any) => ({
            headers: { "content-type": params.type === "image" ? "image/png" : "application/octet-stream" },
            getReadableStream: () => Readable.from(params.type === "image" ? Buffer.from("png-data") : Buffer.from("file-data")),
          }),
        },
      },
    };

    const image = await (adapter as any).parseContent(
      "image", JSON.stringify({ image_key: "img-key" }), [], "message-id",
    );
    const file = await (adapter as any).parseContent(
      "file", JSON.stringify({ file_key: "file-key", file_name: "../report.txt" }), [], "message-id",
    );

    const imagePath = image.text.replace("用户发送了一张图片，请查看：", "");
    const filePath = file.text.replace("用户发送了文件，请查看：", "");
    expect(image).toMatchObject({ contentType: "image" });
    expect(file).toMatchObject({ contentType: "file" });
    expect(imagePath).toBe(path.join(dir, "images", "img-key.png"));
    expect(filePath).toBe(path.join(dir, "files", "file-key_.._report.txt"));
    expect(readFileSync(imagePath, "utf-8")).toBe("png-data");
    expect(readFileSync(filePath, "utf-8")).toBe("file-data");
  });

  test("returns a user-facing reason when Feishu rejects an oversized file download", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const adapter = new FeishuAdapter("app-id", "app-secret");
    adapter.setStorageDir(dir);
    (adapter as any).client = {
      im: {
        messageResource: {
          get: async () => {
            throw { response: { status: "400", data: { code: 234037 } } };
          },
        },
      },
    };

    const result = await (adapter as any).parseContent(
      "file", JSON.stringify({ file_key: "file-key", file_name: "large.zip" }), [], "message-id",
    );

    expect(result).toEqual({
      text: "[文件: large.zip]",
      contentType: "file",
      downloadError: "文件超过飞书 API 100MB 下载上限",
    });
  });

  test("normalizes group mentions and marks a bot mention", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "bot-open-id";

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "message-id",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 ping" }),
        create_time: "1784479200000",
        mentions: [{
          key: "@_user_1",
          id: { open_id: "bot-open-id" },
          name: "NiuBot",
        }],
      },
      sender: { sender_id: { open_id: "user-open-id" }, sender_type: "user" },
    });

    expect(message).toMatchObject({
      chatPlatformId: "group-id",
      chatType: "group",
      contentText: "@NiuBot ping",
      botMentioned: true,
      platformMsgId: "message-id",
    });
  });
});
