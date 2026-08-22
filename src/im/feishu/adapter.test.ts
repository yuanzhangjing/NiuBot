import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("sends image files as image messages and keeps other files as file messages", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "shot.png");
    writeFileSync(imagePath, "png-bytes");
    const textPath = path.join(dir, "notes.txt");
    writeFileSync(textPath, "text-bytes");

    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sentMessages: Array<{ msgType: string; content: string }> = [];
    let imageUploads = 0;
    let uploadedImageType = "";
    let uploadedImageBytes = "";
    let fileUploads = 0;
    (adapter as any).client = {
      im: {
        image: {
          create: async ({ data }: any) => {
            imageUploads += 1;
            uploadedImageType = data.image_type;
            for await (const chunk of data.image) uploadedImageBytes += chunk.toString();
            return { data: { image_key: "image-key" } };
          },
        },
        file: {
          create: async ({ data }: any) => {
            fileUploads += 1;
            for await (const chunk of data.file) /* drain */;
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

    await adapter.sendFile("chat-id", imagePath);
    await adapter.sendFile("chat-id", textPath);

    expect(imageUploads).toBe(1);
    expect(uploadedImageType).toBe("message");
    expect(uploadedImageBytes).toBe("png-bytes");
    expect(fileUploads).toBe(1);
    expect(sentMessages).toEqual([
      { msgType: "image", content: JSON.stringify({ image_key: "image-key" }) },
      { msgType: "file", content: JSON.stringify({ file_key: "file-key" }) },
    ]);
  });

  test("falls back to a file message for images over the 10 MB upload limit", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const bigImagePath = path.join(dir, "big.png");
    writeFileSync(bigImagePath, Buffer.alloc(10 * 1024 * 1024 + 1));

    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sentMessages: Array<{ msgType: string; content: string }> = [];
    let imageUploads = 0;
    let uploadedFileName = "";
    (adapter as any).client = {
      im: {
        image: {
          create: async () => {
            imageUploads += 1;
            return { data: { image_key: "should-not-happen" } };
          },
        },
        file: {
          create: async ({ data }: any) => {
            uploadedFileName = data.file_name;
            for await (const chunk of data.file) /* drain */;
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

    await adapter.sendFile("chat-id", bigImagePath);

    expect(imageUploads).toBe(0);
    expect(uploadedFileName).toBe("big.png");
    expect(sentMessages).toEqual([{
      msgType: "file",
      content: JSON.stringify({ file_key: "file-key" }),
    }]);
  });

  test("falls back to a file message when the image API rejects the upload", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "shot.gif");
    writeFileSync(imagePath, "gif-bytes");

    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sentMessages: Array<{ msgType: string; content: string }> = [];
    let imageUploads = 0;
    let uploadedFileName = "";
    (adapter as any).client = {
      im: {
        image: {
          create: async () => {
            imageUploads += 1;
            throw new Error("resolution exceeds limit");
          },
        },
        file: {
          create: async ({ data }: any) => {
            uploadedFileName = data.file_name;
            for await (const chunk of data.file) /* drain */;
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

    const messageId = await adapter.sendFile("chat-id", imagePath);

    expect(messageId).toBe("message-id");
    expect(imageUploads).toBe(1);
    expect(uploadedFileName).toBe("shot.gif");
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

describe("sendCard header color", () => {
  test("parses header|color syntax into card template", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let sentContent = "";
    (adapter as any).client = {
      im: {
        message: {
          create: async ({ data }: any) => {
            sentContent = data.content;
            return { data: { message_id: "card-id" } };
          },
        },
      },
    };

    await adapter.sendCard("chat-id", "防休眠|green", "✅ 防休眠：**已开启**");

    const card = JSON.parse(sentContent);
    expect(card.header.template).toBe("green");
    expect(card.header.title.content).toBe("防休眠");
    expect(card.body.elements[0].content).toBe("✅ 防休眠：**已开启**");
  });

  test("keeps default blue template for plain headers", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let sentContent = "";
    (adapter as any).client = {
      im: {
        message: {
          create: async ({ data }: any) => {
            sentContent = data.content;
            return { data: { message_id: "card-id" } };
          },
        },
      },
    };

    await adapter.sendCard("chat-id", "Help", "content");

    const card = JSON.parse(sentContent);
    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toBe("Help");
  });

  test("ignores unknown color suffix and keeps the full title", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let sentContent = "";
    (adapter as any).client = {
      im: {
        message: {
          create: async ({ data }: any) => {
            sentContent = data.content;
            return { data: { message_id: "card-id" } };
          },
        },
      },
    };

    await adapter.sendCard("chat-id", "Shell | 输出", "content");

    const card = JSON.parse(sentContent);
    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toBe("Shell | 输出");
  });
});
