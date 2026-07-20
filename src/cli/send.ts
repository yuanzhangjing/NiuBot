/**
 * CLI: send — send messages and files via IPC to the running daemon.
 */

import path from "node:path";
import { localApiRequest } from "../local-api/client.js";
import { resolveSessionBotEndpoint, type LocalIpcEndpoint } from "../platform/ipc.js";

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
  return [fileFlag === "true" ? (positional[0] ?? "") : fileFlag];
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

  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }

  // Send file
  const filePaths = resolveSendFilePaths(args, positional, flags);
  if (filePaths !== undefined) {
    if (filePaths.length === 0 || filePaths.some((filePath) => !filePath)) {
      console.error("Usage: nbt send --file <path> [--file <path> ...]");
      process.exit(1);
    }
    const endpoint = resolveSendEndpoint();
    (async () => {
      for (const filePath of filePaths) {
        const absPath = path.resolve(filePath);
        await ipcRequest(endpoint, "/send-file", { chat_id: targetChatId, file_path: absPath }, 120_000);
      }
      console.log(filePaths.length === 1 ? "File sent." : `${filePaths.length} files sent.`);
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
      console.error("Usage: nbt send --card <header> <content>");
      process.exit(1);
    }
    const endpoint = resolveSendEndpoint();
    ipcRequest(endpoint, "/send", { chat_id: targetChatId, text: content, card_header: cardHeader }, 30_000)
      .then(() => console.log("Card sent."))
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    return;
  }

  // Send text
  const text = positional.join(" ");
  if (!text) {
    console.error("Usage: nbt send <text>");
    process.exit(1);
  }
  const endpoint = resolveSendEndpoint();
  ipcRequest(endpoint, "/send", { chat_id: targetChatId, text }, 30_000)
    .then(() => console.log("Message sent."))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

function printHelp(): void {
  console.log(`Send messages or files to the current or specified chat.

  nbt send <text>                        Text message
  nbt send --card <header> <content>     Card message
  nbt send --file <path> [--file <path> ...]
                                         Send one or more files
  nbt send --chat-id <id> <text>         Send to a specific chat`);
}
