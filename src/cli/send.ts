/**
 * CLI: send — send messages and files via IPC to the running daemon.
 *
 * 发送类型必须显式（--text / --card / --file）且互斥：裸位置参数不再当文本发送。
 * 写错的发文件命令（如 `nbt send file x.md`）会直接报错并给出用法，
 * 避免被静默降级成一条文本消息、模型误以为成功。
 */

import fs from "node:fs";
import path from "node:path";
import { localApiRequest } from "../local-api/client.js";
import { resolveSessionBotEndpoint, type LocalIpcEndpoint } from "../platform/ipc.js";

const SEND_USAGE = `Usage:
  nbt send --text <text>                      Send a text message
  nbt send --card <header> <content>          Send a card message
  nbt send --file <path> [--file <path> ...]  Send one or more files
  nbt send [--chat-id <id>] <type> ...        Send to a specific chat`;

const KNOWN_SEND_FLAGS = new Set(["text", "card", "file", "chat-id", "help"]);

export function resolveSendEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LocalIpcEndpoint {
  const niubotHome = env["NIUBOT_HOME"];
  if (!niubotHome) throw new Error("NIUBOT_HOME is not set. nbt must run inside a NiuBot session.");
  return resolveSessionBotEndpoint({
    niubotHome,
    botId: env["NIUBOT_BOT_NAME"],
    dbPath: env["NIUBOT_DB_PATH"],
    configuredAddress: env["NIUBOT_API_SOCKET"],
    platform,
  });
}

async function ipcRequest(
  endpoint: LocalIpcEndpoint,
  urlPath: string,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  let response;
  try {
    response = await localApiRequest(endpoint, urlPath, { method: "POST", body, timeoutMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot connect to NiuBot daemon: ${message}. Is NiuBot running?`);
  }
  if (response.statusCode >= 400) {
    throw new Error(`API error (${response.statusCode}): ${response.body}`);
  }
  return response.body;
}

export function resolveSendFilePaths(
  args: string[],
  positional: string[],
  flags: Record<string, string>,
): string[] | undefined {
  const filePaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--file") continue;
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      filePaths.push(next);
      i++;
    } else {
      filePaths.push("");
    }
  }

  if (filePaths.length > 0) return filePaths;

  const fileFlag = flags["file"];
  if (fileFlag === undefined) return undefined;
  return [fileFlag];
}

/** --text 的正文：标志值 + 多余位置参数拼接；未指定 --text 时返回 undefined。
 *  parseArgs 用 "true" 表示缺省值，与字面量 "true" 无法区分；按原始参数确认是否为字面量。 */
export function resolveSendText(
  args: string[],
  flags: Record<string, string>,
  positional: string[],
): string | undefined {
  const flagValue = flags["text"];
  if (flagValue === undefined) return undefined;
  const hasLiteralTrue = flagValue === "true" && args.some(
    (arg, index) => (arg === "--text" && args[index + 1] === "true") || arg.startsWith("--text="),
  );
  const parts = flagValue === "true" && !hasLiteralTrue ? [] : [flagValue];
  return [...parts, ...positional].join(" ").trim();
}

/** 发送参数校验：类型必须显式且互斥；--file 不接受额外位置参数。返回错误列表。 */
export function validateSendArgs(
  positional: string[],
  flags: Record<string, string>,
  hasFileFlag: boolean,
): string[] {
  const errors: string[] = [];
  const unknown = Object.keys(flags).filter((key) => !KNOWN_SEND_FLAGS.has(key));
  if (unknown.length > 0) {
    const labels = unknown.map((key) => (key.length === 1 ? `-${key}` : `--${key}`));
    errors.push(`Unknown option: ${labels.join(", ")}`);
  }
  const modeCount =
    Number(flags["text"] !== undefined) + Number(flags["card"] !== undefined) + Number(hasFileFlag);
  if (modeCount === 0) {
    errors.push("Missing send type: use --text, --card, or --file");
  } else if (modeCount > 1) {
    errors.push("Choose only one of --text, --card, or --file");
  }
  if (hasFileFlag && positional.length > 0) {
    errors.push(`Unexpected argument with --file: ${positional.join(" ")} (use repeated --file)`);
  }
  return errors;
}

/** 逐个校验目标文件存在且是普通文件；不合法直接退出（不发送任何一部分）。 */
function assertSendFile(filePath: string): string {
  const absPath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === "ENOENT"
      ? `Error: file not found: ${filePath}`
      : `Error: cannot access file: ${filePath}`);
    process.exit(1);
  }
  if (!stat.isFile()) {
    console.error(`Error: not a file: ${filePath}`);
    process.exit(1);
  }
  return absPath;
}

export function resolveSendScope(
  targetChatId: string | undefined,
  currentChatId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { scopeKey?: string; threadId?: string } {
  // 话题 scope 只在仍发往当前聊天的默认路径上继承；显式切换到另一个聊天时
  // 不能带着当前话题的 thread_id / scope_key，否则会把另一个聊天的回复锚点串错。
  if (!currentChatId || targetChatId !== currentChatId) return {};
  return {
    scopeKey: env["NIUBOT_SCOPE_KEY"] || undefined,
    threadId: env["NIUBOT_THREAD_ID"] || undefined,
  };
}

export function handleSend(
  args: string[],
  chatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? chatId;

  if (flags["help"] === "true" || positional[0] === "help") {
    printHelp();
    return;
  }

  const filePaths = resolveSendFilePaths(args, positional, flags);
  const validationErrors = validateSendArgs(positional, flags, filePaths !== undefined);
  if (validationErrors.length > 0) {
    for (const message of validationErrors) console.error(`Error: ${message}`);
    console.error(SEND_USAGE);
    process.exit(1);
  }

  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }

  const currentScope = resolveSendScope(targetChatId, chatId);

  // Send files
  if (filePaths !== undefined) {
    if (filePaths.length === 0 || filePaths.some((filePath) => !filePath)) {
      console.error("Error: --file requires a path");
      console.error(SEND_USAGE);
      process.exit(1);
    }
    const resolvedPaths = filePaths.map((filePath) => assertSendFile(filePath));
    const endpoint = resolveSendEndpoint();
    const scheduleToken = process.env["NIUBOT_SCHEDULE_TOKEN"];
    (async () => {
      for (const absPath of resolvedPaths) {
        await ipcRequest(endpoint, "/send-file", {
          chat_id: targetChatId,
          file_path: absPath,
          schedule_token: scheduleToken,
          scope_key: currentScope.scopeKey || undefined,
          thread_id: currentScope.threadId || undefined,
        }, 120_000);
        console.log(`File sent: ${absPath}`);
      }
    })()
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    return;
  }

  // Send card
  const cardHeader = flags["card"];
  if (cardHeader != null) {
    const content = positional.join(" ");
    if (!content) {
      console.error("Error: --card requires a header and content");
      console.error(SEND_USAGE);
      process.exit(1);
    }
    const endpoint = resolveSendEndpoint();
    ipcRequest(endpoint, "/send", {
      chat_id: targetChatId,
      text: content,
      card_header: cardHeader,
      schedule_token: process.env["NIUBOT_SCHEDULE_TOKEN"],
      scope_key: currentScope.scopeKey || undefined,
      thread_id: currentScope.threadId || undefined,
    }, 30_000)
      .then(() => console.log("Card sent."))
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    return;
  }

  // Send text
  const text = resolveSendText(args, flags, positional);
  if (!text) {
    console.error("Error: --text requires text");
    console.error(SEND_USAGE);
    process.exit(1);
  }
  const endpoint = resolveSendEndpoint();
  ipcRequest(endpoint, "/send", {
    chat_id: targetChatId,
    text,
    schedule_token: process.env["NIUBOT_SCHEDULE_TOKEN"],
    scope_key: currentScope.scopeKey || undefined,
    thread_id: currentScope.threadId || undefined,
  }, 30_000)
    .then(() => console.log("Text message sent."))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

function printHelp(): void {
  console.log(`Send messages or files to the current or specified chat.

${SEND_USAGE}`);
}
