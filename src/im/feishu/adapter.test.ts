import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { FeishuAdapter } from "./adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("FeishuAdapter", () => {
  test("does not block Bot identity on the app creator request", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let releaseCreator: ((value: unknown) => void) | undefined;
    const creatorRequest = new Promise<unknown>((resolve) => { releaseCreator = resolve; });
    (adapter as any).client = {
      request: async () => ({ bot: { open_id: "ou-self", app_name: "NiuBot" } }),
      application: {
        application: {
          get: async () => creatorRequest,
        },
      },
    };

    await expect(adapter.getBotOpenId()).resolves.toBe("ou-self");
    releaseCreator?.({ data: { app: { owner: { open_id: "ou-owner" } } } });
  });

  test("checks the Bot @ permission on the online application version", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const calls: string[] = [];
    (adapter as any).client = {
      application: {
        application: {
          get: async () => ({ data: { app: { online_version_id: "version-1" } } }),
        },
        applicationAppVersion: {
          get: async ({ path }: any) => {
            calls.push(path.version_id);
            return {
              data: {
                app_version: {
                  scopes: [
                    { scope: "im:message.group_at_msg.include_bot:readonly" },
                  ],
                },
              },
            };
          },
        },
      },
    };

    await expect(adapter.getBotAtPermissionStatus()).resolves.toBe("granted");
    await expect(adapter.getBotAtPermissionStatus()).resolves.toBe("granted");
    expect(calls).toEqual(["version-1"]);
  });

  test("reports a missing Bot @ permission from the online application version", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).client = {
      application: {
        application: {
          get: async () => ({ data: { app: { online_version_id: "version-1" } } }),
        },
        applicationAppVersion: {
          get: async () => ({ data: { app_version: { scopes: [] } } }),
        },
      },
    };

    await expect(adapter.getBotAtPermissionStatus()).resolves.toBe("missing");
  });

  test("reports unknown when the online application permission query fails", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).client = {
      application: {
        application: {
          get: async () => { throw new Error("permission denied"); },
        },
      },
    };

    await expect(adapter.getBotAtPermissionStatus()).resolves.toBe("unknown");
  });

  test("reports message read errors from quote fetches", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => { throw { code: 99991400, message: "Lack of necessary permissions" }; },
        },
      },
    };

    await expect(adapter.getMessageContent("message-1", { chatPlatformId: "chat-1" })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test("reports message read errors when the message body is missing", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => ({ data: { items: [] } }),
        },
      },
    };

    await expect(adapter.getMessageContent("message-1", { chatPlatformId: "chat-1" })).resolves.toBeUndefined();
    expect(errors).toEqual([{ messageId: "message-1", chatPlatformId: "chat-1" }]);
  });

  test("does not report message read errors from thread probes", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => { throw { code: 99991400, message: "Lack of necessary permissions" }; },
        },
      },
    };

    await expect(adapter.getMessageThreadId("message-1", { chatPlatformId: "chat-1" })).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("reports degraded card bodies as message read errors", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => ({ data: { items: [{ body: { content: "[卡片消息]" } }] } }),
        },
      },
    };

    await expect(adapter.getMessageContent("message-1", { chatPlatformId: "chat-1" })).resolves.toBeUndefined();
    expect(errors).toEqual([{ messageId: "message-1", chatPlatformId: "chat-1" }]);
  });

  test("reports empty merge-forward responses as message read errors", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => ({ data: { items: [] } }),
        },
      },
    };

    await expect((adapter as any).parseMergeForward("message-1", { chatPlatformId: "chat-1" }))
      .resolves.toMatchObject({ rendered: "[merge_forward]" });
    expect(errors).toEqual([{ messageId: "message-1", chatPlatformId: "chat-1" }]);
  });

  test("reports message read errors from card resolution", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          get: async () => { throw { code: 99991400, message: "Lack of necessary permissions" }; },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "chat-1",
        chat_type: "group",
        message_id: "message-1",
        message_type: "interactive",
        content: "[卡片消息]",
      },
      sender: { sender_id: { open_id: "ou-user" }, sender_type: "user" },
    });

    expect(message.contentText).toBe("[卡片消息]");
    expect(errors).toEqual([{ messageId: "message-1", chatPlatformId: "chat-1" }]);
  });

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

  test("replies with a markdown file when a long reply exceeds the text threshold", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sent: Array<{ method: string; msgType: string; replyTo?: string }> = [];
    (adapter as any).client = {
      im: {
        file: {
          create: async ({ data }: any) => {
            for await (const chunk of data.file) /* drain */;
            return { data: { file_key: "file-key" } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sent.push({ method: "create", msgType: data.msg_type });
            return { data: { message_id: "created-id" } };
          },
          reply: async ({ path: replyPath, data }: any) => {
            sent.push({ method: "reply", msgType: data.msg_type, replyTo: replyPath.message_id });
            return { data: { message_id: "reply-id" } };
          },
        },
      },
    };

    const messageId = await adapter.sendReply("chat-id", "长消息".repeat(4_000), "om-user");

    expect(messageId).toBe("reply-id");
    expect(sent).toEqual([{ method: "reply", msgType: "file", replyTo: "om-user" }]);
  });

  test("lists chat history with open_id and returns chronological text", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const listed: Array<{ params: Record<string, unknown> }> = [];
    (adapter as any).botOpenId = "ou-self";
    (adapter as any).client = {
      im: {
        message: {
          list: async ({ params }: any) => {
            listed.push({ params });
            return {
              data: {
                items: [
                  {
                    message_id: "om-2",
                    msg_type: "text",
                    create_time: "2000",
                    sender: { id: "ou-cow", sender_type: "app", id_type: "open_id" },
                    body: { content: JSON.stringify({ text: "second" }) },
                  },
                  {
                    message_id: "om-1",
                    msg_type: "text",
                    create_time: "1000",
                    sender: { id: "ou-user", sender_type: "user", id_type: "open_id" },
                    body: { content: JSON.stringify({ text: "first" }) },
                  },
                ],
              },
            };
          },
        },
      },
    };

    const messages = await adapter.listChatMessages("oc-group", { limit: 20 });
    expect(listed[0]?.params).toMatchObject({
      container_id_type: "chat",
      container_id: "oc-group",
      user_id_type: "open_id",
      sort_type: "ByCreateTimeDesc",
    });
    expect(messages.map((msg) => msg.contentText)).toEqual(["first", "second"]);
  });

  test("resolves degraded cards while listing history", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const gets: unknown[] = [];
    (adapter as any).botOpenId = "ou-self";
    (adapter as any).client = {
      im: {
        message: {
          list: async () => ({
            data: {
              items: [{
                message_id: "om-history-card",
                msg_type: "interactive",
                create_time: "2000",
                sender: { id: "ou-cow", sender_type: "app", id_type: "open_id" },
                body: { content: JSON.stringify({
                  elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
                }) },
              }],
            },
          }),
          get: async (args: any) => {
            gets.push(args);
            return { data: { items: [{ body: { content: JSON.stringify({
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: "历史卡片原文" }] },
            }) } }] } };
          },
        },
      },
    };

    const messages = await adapter.listChatMessages("oc-group", { limit: 20 });

    expect(messages[0]?.contentText).toBe("历史卡片原文");
    expect(gets).toEqual([{
      path: { message_id: "om-history-card" },
      params: { card_msg_content_type: "user_card_content" },
    }]);
  });

  test("lists thread history with container_id_type=thread", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const listed: Array<{ params: Record<string, unknown> }> = [];
    (adapter as any).botOpenId = "ou-self";
    (adapter as any).client = {
      im: {
        message: {
          list: async ({ params }: any) => {
            listed.push({ params });
            return {
              data: {
                items: [{
                  message_id: "om-reply",
                  msg_type: "text",
                  create_time: "2000",
                  sender: { id: "ou-user", sender_type: "user", id_type: "open_id" },
                  body: { content: JSON.stringify({ text: "reply" }) },
                  thread_id: "omt_aaa",
                  parent_id: "om-root",
                  root_id: "om-root",
                }],
              },
            };
          },
        },
      },
    };

    const messages = await adapter.listChatMessages("oc-group", {
      limit: 20,
      threadId: "omt_aaa",
    });
    expect(listed[0]?.params).toMatchObject({
      container_id_type: "thread",
      container_id: "omt_aaa",
    });
    expect(messages[0]).toMatchObject({
      threadId: "omt_aaa",
      rootId: "om-root",
      parentPlatformMsgId: "om-root",
    });
  });

  test("returns chat metadata from chat.get", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let requestedChatId = "";
    (adapter as any).client = {
      im: {
        chat: {
          get: async ({ path }: any) => {
            requestedChatId = path.chat_id;
            return {
              data: {
                name: "Topic group",
                chat_mode: "topic",
                group_message_type: "thread",
              },
            };
          },
        },
      },
    };

    const metadata = await adapter.getChatMetadata("oc-group");
    expect(requestedChatId).toBe("oc-group");
    expect(metadata).toMatchObject({
      chatMode: "topic",
      groupMessageType: "thread",
    });
    expect(metadata?.fetchedAt).toBeGreaterThan(0);
  });

  test("sends reply_in_thread only when requested and omits it otherwise", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const replyBodies: Array<Record<string, unknown>> = [];
    (adapter as any).client = {
      im: {
        message: {
          reply: async ({ data }: any) => {
            replyBodies.push(data);
            return { data: { message_id: "reply-id" } };
          },
        },
      },
    };

    await adapter.sendReply("oc-group", "one", "om-root");
    await adapter.sendReply("oc-group", "two", "om-root", { replyInThread: true });

    expect(replyBodies).toEqual([
      { msg_type: "text", content: JSON.stringify({ text: "one" }) },
      { msg_type: "text", content: JSON.stringify({ text: "two" }), reply_in_thread: true },
    ]);
  });

  test("listChatMessages paginates incremental ASC so newest after the cursor is kept", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const listed: Array<{ params: Record<string, unknown> }> = [];
    (adapter as any).botOpenId = "ou-self";
    (adapter as any).client = {
      im: {
        message: {
          list: async ({ params }: any) => {
            listed.push({ params });
            if (!params.page_token) {
              return {
                data: {
                  items: [{
                    message_id: "om-old",
                    msg_type: "text",
                    create_time: "1000",
                    sender: { id: "ou-user", sender_type: "user", id_type: "open_id" },
                    body: { content: JSON.stringify({ text: "old" }) },
                  }],
                  has_more: true,
                  page_token: "p2",
                },
              };
            }
            return {
              data: {
                items: [{
                  message_id: "om-new",
                  msg_type: "text",
                  create_time: "2000",
                  sender: { id: "ou-cow", sender_type: "app", id_type: "open_id" },
                  body: { content: JSON.stringify({ text: "new" }) },
                }],
                has_more: false,
              },
            };
          },
        },
      },
    };

    const messages = await adapter.listChatMessages("oc-group", { sinceUnixSec: 999, limit: 1000 });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.params).toMatchObject({
      sort_type: "ByCreateTimeAsc",
      start_time: "999",
      page_size: 50,
    });
    expect(listed[1]?.params).toMatchObject({ page_token: "p2" });
    expect(messages.map((msg) => msg.contentText)).toEqual(["old", "new"]);
  });

  test("listChatMessages does not paginate the latest DESC page", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let calls = 0;
    (adapter as any).botOpenId = "ou-self";
    (adapter as any).client = {
      im: {
        message: {
          list: async () => {
            calls += 1;
            return {
              data: {
                items: [{
                  message_id: "om-latest",
                  msg_type: "text",
                  create_time: "3000",
                  sender: { id: "ou-user", sender_type: "user", id_type: "open_id" },
                  body: { content: JSON.stringify({ text: "latest" }) },
                }],
                has_more: true,
                page_token: "older",
              },
            };
          },
        },
      },
    };

    const messages = await adapter.listChatMessages("oc-group", { limit: 20 });
    expect(calls).toBe(1);
    expect(messages.map((msg) => msg.contentText)).toEqual(["latest"]);
  });

  test("listChatMessages throws when the Feishu API fails", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).client = {
      im: {
        message: {
          list: async () => {
            throw new Error("429");
          },
        },
      },
    };
    await expect(adapter.listChatMessages("oc-group")).rejects.toThrow("429");
  });

  test("reports message read errors from history sync", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          list: async () => {
            throw { code: 99991400, message: "Lack of necessary permissions" };
          },
        },
      },
    };

    await expect(adapter.listChatMessages("oc-group")).rejects.toMatchObject({ code: 99991400 });
    expect(errors).toEqual([{ chatPlatformId: "oc-group" }]);
  });

  test("reports missing non-card bodies from history sync", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const errors: Array<{ messageId?: string; chatPlatformId?: string }> = [];
    adapter.onMessageReadError((event) => {
      errors.push({ messageId: event.messageId, chatPlatformId: event.chatPlatformId });
    });
    (adapter as any).client = {
      im: {
        message: {
          list: async () => ({
            data: {
              items: [{ message_id: "message-1", msg_type: "text", sender: { id: "ou-user" } }],
            },
          }),
        },
      },
    };

    await expect(adapter.listChatMessages("oc-group")).resolves.toEqual([]);
    expect(errors).toEqual([{ messageId: "message-1", chatPlatformId: "oc-group" }]);
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

  test("replies with an image message when sendFile is given a reply target", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-feishu-adapter-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "shot.png");
    writeFileSync(imagePath, "png-bytes");

    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sent: Array<{ method: string; msgType: string; content: string; replyTo?: string }> = [];
    (adapter as any).client = {
      im: {
        image: {
          create: async ({ data }: any) => {
            for await (const chunk of data.image) /* drain */;
            return { data: { image_key: "image-key" } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sent.push({ method: "create", msgType: data.msg_type, content: data.content });
            return { data: { message_id: "created-id" } };
          },
          reply: async ({ path: replyPath, data }: any) => {
            sent.push({
              method: "reply",
              msgType: data.msg_type,
              content: data.content,
              replyTo: replyPath.message_id,
            });
            return { data: { message_id: "reply-id" } };
          },
        },
      },
    };

    const messageId = await adapter.sendFile("chat-id", imagePath, undefined, { replyToMsgId: "om-user" });

    expect(messageId).toBe("reply-id");
    expect(sent).toEqual([{
      method: "reply",
      msgType: "image",
      content: JSON.stringify({ image_key: "image-key" }),
      replyTo: "om-user",
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
      senderIsBot: false,
      platformMsgId: "message-id",
    });
  });

  test("maps topic_group to group and preserves thread/root ids", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "topic_group",
        message_id: "om-reply",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1784479200000",
        thread_id: "omt_aaa",
        root_id: "om-root",
        parent_id: "om-root",
      },
      sender: { sender_id: { open_id: "user-open-id" }, sender_type: "user" },
    });

    expect(message).toMatchObject({
      chatType: "group",
      threadId: "omt_aaa",
      rootId: "om-root",
      parentPlatformMsgId: "om-root",
    });
  });

  test("marks app senders as bots", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "bot-open-id";

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "message-id",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 at测试收到" }),
        mentions: [{
          key: "@_user_1",
          id: { open_id: "bot-open-id" },
          name: "NiuBot",
        }],
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(message).toMatchObject({
      senderPlatformId: "ou-cow",
      senderIsBot: true,
      botMentioned: true,
    });
  });

  test("fetches message identity for first-seen group mentions", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    const known = new Map<string, { isBot: boolean }>();
    adapter.setIdentityLookup((platformId) => known.get(platformId));
    let fetched = 0;
    let fetchedParams: unknown;
    (adapter as any).client = {
      im: {
        message: {
          get: async ({ params }: any) => {
            fetched += 1;
            fetchedParams = params;
            return {
              data: {
                items: [{
                  sender: { id: "ou-zen", id_type: "open_id", sender_type: "user" },
                  mentions: [
                    { key: "@_user_1", id: "cli_self", id_type: "app_id", name: "NiuBot" },
                    { key: "@_user_2", id: "cli_cow", id_type: "app_id", name: "CowBot" },
                  ],
                }],
              },
            };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-collab",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 @_user_2 讨论天气" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou-self" }, name: "NiuBot" },
          { key: "@_user_2", id: { open_id: "ou-cow" }, name: "CowBot" },
        ],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });

    expect(fetched).toBe(1);
    expect(fetchedParams).toEqual({ user_id_type: "open_id" });
    expect(message.botMentioned).toBe(true);
    expect(message.mentions).toEqual([
      { platformUserId: "ou-self", name: "NiuBot", isBot: true, isApp: true, key: "@_user_1" },
      { platformUserId: "ou-cow", name: "CowBot", isBot: false, isApp: true, key: "@_user_2" },
    ]);
  });

  test("does not remember mentions as human when GET returns no mention list", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    adapter.setIdentityLookup(() => undefined);
    let fetched = 0;
    (adapter as any).client = {
      im: {
        message: {
          get: async () => {
            fetched += 1;
            return {
              data: {
                items: [{
                  sender: { id: "ou-zen", id_type: "open_id", sender_type: "user" },
                  mentions: [],
                }],
              },
            };
          },
        },
      },
    };

    const eventFor = (messageId: string) => ({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: messageId,
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 ping" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-cow" }, name: "CowBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });

    await (adapter as any).normalize(eventFor("om-empty-1"));
    await (adapter as any).normalize(eventFor("om-empty-2"));
    expect(fetched).toBe(2);
  });

  test("does not refetch when local identity already knows the parties", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    adapter.setIdentityLookup((platformId) => {
      if (platformId === "ou-zen") return { isBot: false };
      if (platformId === "ou-cow") return { isBot: true };
      return undefined;
    });
    let fetched = 0;
    (adapter as any).client = {
      im: { message: { get: async () => { fetched += 1; return { data: { items: [] } }; } } },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-known",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 ping" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-cow" }, name: "CowBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });

    expect(fetched).toBe(0);
    expect(message.mentions?.[0]?.isApp).toBe(true);
    expect(message.senderIsBot).toBe(false);
  });

  test("classifies a card sender as a bot when the event omitted sender_type", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    adapter.setIdentityLookup(() => undefined);
    (adapter as any).client = {
      im: {
        message: {
          get: async ({ path: requestPath, params }: any) => {
            if (params?.card_msg_content_type) {
              return {
                data: {
                  items: [{
                    body: {
                      content: JSON.stringify({
                        schema: "2.0",
                        body: { elements: [{ tag: "markdown", content: "<at id=ou-self></at> ping" }] },
                      }),
                    },
                  }],
                },
              };
            }
            expect(requestPath.message_id).toBe("om-card");
            return {
              data: {
                items: [{
                  sender: { id: "cli_cow", id_type: "app_id", sender_type: "app" },
                  mentions: [{ key: "@_user_1", id: "cli_self", id_type: "app_id", name: "NiuBot" }],
                }],
              },
            };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card",
        message_type: "interactive",
        content: JSON.stringify({
          title: null,
          elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
        }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-self" }, name: "NiuBot" }],
      },
      sender: { sender_id: { open_id: "ou-cow" } },
    });

    expect(message.senderIsBot).toBe(true);
    expect(message.botMentioned).toBe(true);
    expect(message.contentText).toContain("ping");
  });

  test("keeps the inbound message when identity fetch fails", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    adapter.setIdentityLookup(() => undefined);
    (adapter as any).client = {
      im: { message: { get: async () => { throw new Error("api down"); } } },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-fail",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hi" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-cow" }, name: "CowBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });

    expect(message.contentText).toBe("@CowBot hi");
    expect(message.mentions?.[0]?.isApp).toBe(false);
  });

  test("retries identity fetch after a failure even if the user row already exists", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    const known = new Map<string, { isBot: boolean }>([["ou-cow", { isBot: false }]]);
    adapter.setIdentityLookup((platformId) => known.get(platformId));
    let fetched = 0;
    (adapter as any).client = {
      im: {
        message: {
          get: async () => {
            fetched += 1;
            if (fetched === 1) throw new Error("api down");
            return {
              data: {
                items: [{
                  sender: { id: "ou-zen", id_type: "open_id", sender_type: "user" },
                  mentions: [{ key: "@_user_1", id: "cli_cow", id_type: "app_id", name: "CowBot" }],
                }],
              },
            };
          },
        },
      },
    };

    await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-retry-1",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hi" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-cow" }, name: "CowBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });
    const recovered = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-retry-2",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hi" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-cow" }, name: "CowBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });

    expect(fetched).toBe(2);
    expect(recovered.mentions?.[0]?.isApp).toBe(true);
  });

  test("does not fetch when the sender is already a user and mentions are classified", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-self";
    adapter.setIdentityLookup(() => undefined);
    let fetched = 0;
    (adapter as any).client = {
      im: { message: { get: async () => { fetched += 1; return { data: { items: [] } }; } } },
    };

    await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-human-only",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 ping" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-self" }, name: "NiuBot" }],
      },
      sender: { sender_id: { open_id: "ou-zen" }, sender_type: "user" },
    });
    expect(fetched).toBe(0);
  });

  test("fetches original card JSON when the event payload is the upgrade placeholder", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).botOpenId = "ou-bot";
    const gets: unknown[] = [];
    (adapter as any).client = {
      im: {
        message: {
          get: async (args: any) => {
            gets.push(args);
            return {
              data: {
                items: [{
                  body: {
                    content: JSON.stringify({
                      schema: "2.0",
                      body: {
                        elements: [{
                          tag: "markdown",
                          content: "<at id=ou-bot></at> 我先抛个观点：大爆炸不是从无到有。",
                        }],
                      },
                    }),
                  },
                }],
              },
            };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card",
        message_type: "interactive",
        content: JSON.stringify({
          title: null,
          elements: [[{
            tag: "img",
            image_key: "img_fallback",
          }, {
            tag: "text",
            text: "请升级至最新版本客户端，以查看内容",
          }]],
        }),
        mentions: [{
          key: "@_user_1",
          id: { open_id: "ou-bot" },
          name: "NiuBot",
        }],
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(gets).toEqual([{
      path: { message_id: "om-card" },
      params: { card_msg_content_type: "user_card_content" },
    }]);
    expect(message).toMatchObject({
      contentType: "interactive",
      contentText: "@NiuBot 我先抛个观点：大爆炸不是从无到有。",
      botMentioned: true,
      senderIsBot: true,
    });
  });

  test("fetches original card JSON when the event content is not JSON", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const gets: unknown[] = [];
    (adapter as any).client = {
      im: {
        message: {
          get: async (args: any) => {
            gets.push(args);
            return { data: { items: [{ body: { content: JSON.stringify({
              body: { elements: [{ tag: "markdown", content: "非 JSON 事件的原文" }] },
            }) } }] } };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card-plain",
        message_type: "interactive",
        content: "[卡片消息]",
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(message.contentText).toBe("非 JSON 事件的原文");
    expect(gets).toEqual([{
      path: { message_id: "om-card-plain" },
      params: { card_msg_content_type: "user_card_content" },
    }]);
  });

  test("fetches the original card when the event has no card body", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const gets: unknown[] = [];
    (adapter as any).client = {
      im: {
        message: {
          get: async (args: any) => {
            gets.push(args);
            return { data: { items: [{ body: { content: JSON.stringify({
              body: { elements: [{ tag: "markdown", content: "无 body 事件的原文" }] },
            }) } }] } };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card-empty",
        message_type: "interactive",
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(message.contentText).toBe("无 body 事件的原文");
    expect(gets).toEqual([{
      path: { message_id: "om-card-empty" },
      params: { card_msg_content_type: "user_card_content" },
    }]);
  });

  test("resolves interactive cards nested in merge-forward messages", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const gets: unknown[] = [];
    (adapter as any).client = {
      im: {
        message: {
          get: async ({ path, params }: any) => {
            gets.push({ path, params });
            if (path.message_id === "om-forward") {
              return { data: { items: [{
                message_id: "om-card-child",
                msg_type: "interactive",
                sender: { id: "ou-cow", sender_type: "app" },
                body: { content: JSON.stringify({
                  elements: [[{ tag: "text", text: "请升级客户端" }]],
                }) },
              }] } };
            }
            return { data: { items: [{ body: { content: JSON.stringify({
              body: { elements: [{ tag: "markdown", content: "转发卡片原文" }] },
            }) } }] } };
          },
        },
      },
    };

    const result = await (adapter as any).parseMergeForward("om-forward");

    expect(result.nodes[0]?.content).toBe("转发卡片原文");
    expect(gets).toEqual([
      { path: { message_id: "om-forward" }, params: undefined },
      {
        path: { message_id: "om-card-child" },
        params: { card_msg_content_type: "user_card_content" },
      },
    ]);
  });

  test("does not refetch when the event already has schema 2.0 card text", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    let fetched = false;
    (adapter as any).client = {
      im: {
        message: {
          get: async () => {
            fetched = true;
            return { data: { items: [] } };
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card",
        message_type: "interactive",
        content: JSON.stringify({
          schema: "2.0",
          body: {
            elements: [{ tag: "markdown", content: "already here" }],
          },
        }),
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(fetched).toBe(false);
    expect(message.contentText).toBe("already here");
  });

  test("keeps a placeholder when original card fetch fails", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).client = {
      im: {
        message: {
          get: async () => {
            throw new Error("api down");
          },
        },
      },
    };

    const message = await (adapter as any).normalize({
      message: {
        chat_id: "group-id",
        chat_type: "group",
        message_id: "om-card",
        message_type: "interactive",
        content: JSON.stringify({
          title: null,
          elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
        }),
      },
      sender: { sender_id: { open_id: "ou-cow" }, sender_type: "app" },
    });

    expect(message.contentText).toBe("[卡片消息]");
  });

  test("keeps generic message content working for fetched post messages", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const gets: unknown[] = [];
    (adapter as any).client = {
      im: {
        message: {
          get: async (args: any) => {
            gets.push(args);
            return {
              data: {
                items: [{
                  body: {
                    content: JSON.stringify({
                      title: "标题",
                      content: [[
                        { tag: "text", text: "正文" },
                        { tag: "a", text: "链接", href: "https://example.com" },
                        { tag: "at", user_id: "ou-user", user_name: "用户" },
                      ]],
                    }),
                  },
                }],
              },
            };
          },
        },
      },
    };

    await expect(adapter.getMessageContent("om-post")).resolves.toBe("标题\n正文链接@用户");
    expect(gets).toEqual([{
      path: { message_id: "om-post" },
      params: { card_msg_content_type: "user_card_content" },
    }]);
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

  test("still files oversized cards when the at substring is incomplete", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    const sentMessages: Array<{ msgType: string }> = [];
    (adapter as any).client = {
      im: {
        file: {
          create: async ({ data }: any) => {
            for await (const chunk of data.file) /* drain */;
            return { data: { file_key: "file-key" } };
          },
        },
        message: {
          create: async ({ data }: any) => {
            sentMessages.push({ msgType: data.msg_type });
            return { data: { message_id: "message-id" } };
          },
        },
      },
    };

    await adapter.sendCard("chat-id", "Hi", `see <at ${"长消息".repeat(4_000)}`);

    expect(sentMessages).toEqual([{ msgType: "file" }]);
  });

  test("converts text at tags into card markdown at tags", async () => {
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

    await adapter.sendCard("chat-id", "Hi", 'ping <at user_id="ou-cow">CowBot</at>');

    const card = JSON.parse(sentContent);
    expect(card.body.elements[0].content).toBe('ping <at id="ou-cow"></at>');
  });

  test("does not fall back to a file when card content contains an at tag", async () => {
    const adapter = new FeishuAdapter("app-id", "app-secret");
    (adapter as any).client = {
      im: {
        file: {
          create: async () => {
            throw new Error("should not upload file");
          },
        },
        message: {
          create: async () => {
            throw new Error("card rejected");
          },
        },
      },
    };

    await expect(adapter.sendCard("chat-id", "Hi", 'ping <at user_id="ou-cow">CowBot</at>'))
      .rejects.toThrow("card rejected");
  });
});
